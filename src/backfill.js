// Walks a sub-account's ENTIRE call history and runs it through the same
// pipeline the live poller uses (download recording, embed metadata, store)
// -- unlike the poller, which deliberately starts watching from "now" on
// first run. This exists for one reason: GHL lets accounts turn on
// auto-deleting call recordings after N days, and that setting reportedly
// can't be turned back off once enabled. Anything not captured before that
// window closes is gone for good, so this needs to run (once, or any time
// there's a gap) before telling a customer it's safe to flip that switch on.
//
// Multi-account: loops every connected GHL account (db.listAllActiveGhlAccounts(),
// same global scope src/poller.js uses) rather than just the one legacy
// GHL_API_TOKEN-configured account, using each account's own credentials via
// src/accountCredentials.js. One account's failure is caught and logged
// without aborting the whole run, same reasoning as the poller: one bad
// token or a GHL outage on one customer's connection must never stop
// another customer's backfill from finishing.
//
// Transcription is on-demand only, everywhere (see routes/api.js's POST
// /calls/:id/transcribe) -- this never triggers it either. Run it with
// node src/backfill.js (or npm run backfill), or from the admin UI's
// "Run historical backfill" button (routes/admin.js), which imports and
// calls `run` directly instead of shelling out.

require("dotenv").config();
const db = require("./db");
const accountCredentials = require("./accountCredentials");
const { processCallMessage } = require("./poller");

const PAGE_SIZE = 100;
const DELAY_MS = Number(process.env.BACKFILL_DELAY_MS || 250);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runForAccount(account, api, totals) {
  console.log(`[backfill] account ${account.id} (${account.ghlLocationId}): starting full history walk (oldest calls first)`);

  let cursor = {};
  let pageNum = 0;

  for (;;) {
    pageNum += 1;
    const conversations = await api.searchConversationsPage({
      limit: PAGE_SIZE,
      sort: "asc",
      ...cursor,
    });
    if (conversations.length === 0) break;

    console.log(`[backfill] account ${account.id}: page ${pageNum}: ${conversations.length} conversations`);

    for (const conversation of conversations) {
      totals.conversationsSeen += 1;
      let messages;
      try {
        messages = await api.listCallMessages(conversation.id);
      } catch (err) {
        console.error(`[backfill] account ${account.id}: failed to list messages for conversation ${conversation.id}:`, err);
        continue;
      }
      await sleep(DELAY_MS);

      for (const message of messages) {
        totals.callsFound += 1;
        const before = await db.getCallByGhlId(message.id);
        if (before) {
          totals.callsSkipped += 1; // already captured by a prior run or the live poller
          continue;
        }
        try {
          await processCallMessage(conversation, message, { api, ghlAccountId: account.id });
          totals.callsSaved += 1;
        } catch (err) {
          totals.callsFailed += 1;
          console.error(`[backfill] account ${account.id}: failed to process call ${message.id}:`, err);
        }
        await sleep(DELAY_MS);
      }
    }

    const last = conversations[conversations.length - 1];
    cursor = { startAfterDate: last.lastMessageDate, startAfterId: last.id };

    if (conversations.length < PAGE_SIZE) break; // short page = last page
  }
}

// tenantId scopes the account list to just that tenant -- required for
// the admin-UI-triggered path (routes/admin.js's POST /backfill), which
// must only ever touch the calling tenant's own accounts, not every
// account on the deployment. Omitted for the bare `node src/backfill.js`
// CLI invocation below, which legitimately wants everything.
//
// Throws rather than setting process.exitCode on failure -- the latter is
// a CLI-only concept (see src/tenantPurge.js's restoreTenant/purgeTenant
// for the same fix and the same reasoning): this function is also called
// from a live, long-running server process via routes/admin.js, where
// setting the process's own exit code on a per-request failure would be
// wrong. The CLI entry point at the bottom of this file still behaves
// exactly as before.
async function run({ tenantId } = {}) {
  const accounts = tenantId ? await db.listActiveGhlAccountsForTenant(tenantId) : await db.listAllActiveGhlAccounts();

  const totals = {
    conversationsSeen: 0,
    callsFound: 0,
    callsSaved: 0,
    callsSkipped: 0,
    callsFailed: 0,
  };

  let ranAny = false;
  for (const account of accounts) {
    const api = await accountCredentials.clientForAccount(account);
    if (!api.isConfigured()) continue;
    ranAny = true;
    try {
      await runForAccount(account, api, totals);
    } catch (err) {
      console.error(`[backfill] account ${account.id} (${account.ghlLocationId}): backfill failed:`, err);
    }
  }

  if (!ranAny) {
    throw new Error("no configured GHL accounts found, aborting");
  }

  console.log(
    `[backfill] done. conversations scanned: ${totals.conversationsSeen}, call messages found: ${totals.callsFound}, ` +
      `saved: ${totals.callsSaved}, already had: ${totals.callsSkipped}, failed: ${totals.callsFailed}`
  );
  return totals;
}

module.exports = { run };

// Only run immediately (and close the shared DB pool afterward) when
// invoked directly as `node src/backfill.js` -- routes/admin.js also
// imports `run` to offer this from the admin UI, and closing the pool
// there would take down the whole app's database connection.
if (require.main === module) {
  run()
    .catch((err) => {
      console.error("[backfill] fatal error:", err.message);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}
