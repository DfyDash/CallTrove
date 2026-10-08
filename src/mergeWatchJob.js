// Notices contacts merged in GHL and files their calls under the surviving
// contact -- no button press needed. GHL has no merge API or webhook, so
// merging happens there and this just checks back on a timer.
//
// What it watches: contacts that share a phone number (the same groups as
// the Possible duplicates view). Duplicates are what get merged, and the
// surviving contact keeps that number, so a merged pair shows up as a
// member GHL no longer has plus a survivor holding the extra calls. Each
// cycle re-asks GHL about those contacts only (a few API calls per contact)
// rather than sweeping every contact. A merge between contacts with
// DIFFERENT phone numbers isn't in a group, so it's caught later instead:
// the live poller and any "Import past calls" run re-file a call the moment
// they see it under a new contact (see processCallMessage in
// src/poller.js).
//
// Groups an admin dismissed as "not duplicates" aren't checked. At most
// MAX_GROUPS_PER_ACCOUNT groups are checked per cycle, rotating through the
// rest on later cycles, so an account with hundreds of duplicate groups
// can't flood GHL's API in one go.
const db = require("./db");
const accountCredentials = require("./accountCredentials");
const alerting = require("./alerting");
const { reconcileContacts, withAccountLock } = require("./contactReconcile");

const CHECK_INTERVAL_MS = Math.max(1, Number(process.env.MERGE_WATCH_INTERVAL_MIN) || 15) * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // let startup settle before the first GHL sweep
const MAX_GROUPS_PER_ACCOUNT = 20;

const nextGroupIndex = new Map(); // accountId -> where the next cycle resumes

function isEnabled() {
  return process.env.MERGE_WATCH_ENABLED !== "false";
}

// Picks up to `max` groups, continuing from where the last cycle stopped
// and wrapping around, so every group gets its turn.
function pickGroups(accountId, groups, max) {
  const start = (nextGroupIndex.get(accountId) || 0) % groups.length;
  const count = Math.min(max, groups.length);
  const picked = [];
  for (let i = 0; i < count; i++) picked.push(groups[(start + i) % groups.length]);
  nextGroupIndex.set(accountId, (start + count) % groups.length);
  return picked;
}

async function checkAccount(account, maxGroups) {
  const totals = { groupsChecked: 0, contactsChecked: 0, callsMoved: 0, contactsRemoved: 0, errors: 0 };
  const groups = await db.listDuplicateContactGroups(account.id);
  if (groups.length === 0) return totals;
  const api = await accountCredentials.clientForAccount(account);
  if (!api.isConfigured()) return totals;

  const outcome = await withAccountLock(account.id, async () => {
    for (const group of pickGroups(account.id, groups, maxGroups)) {
      const result = await reconcileContacts({ api, ghlAccountId: account.id, contactIds: group.contacts.map((c) => c.id) });
      totals.groupsChecked++;
      totals.contactsChecked += result.contactsChecked;
      totals.callsMoved += result.callsMoved;
      totals.contactsRemoved += result.contactsRemoved;
      totals.errors += result.errors;
    }
  });
  if (outcome.busy) return totals; // a manual check is already running; next cycle covers it

  if (totals.callsMoved > 0) {
    const message = `Noticed a merge in GHL: moved ${totals.callsMoved} call${totals.callsMoved === 1 ? "" : "s"} to the surviving contact and removed ${totals.contactsRemoved} leftover contact${totals.contactsRemoved === 1 ? "" : "s"} for account ${account.id}`;
    console.log(`[mergeWatch] ${message}`);
    await db.logAudit({ actorId: null, actorUsername: "system", action: "contacts_reconciled_auto", message, tenantId: account.tenantId });
  }
  return totals;
}

async function runOnce({ maxGroups = MAX_GROUPS_PER_ACCOUNT } = {}) {
  const accounts = await db.listAllActiveGhlAccounts();
  let contactsChecked = 0;
  let errors = 0;
  for (const account of accounts) {
    // One account's failure (an expired token, a GHL outage) must never
    // stop the others from being checked -- same rule as the poller.
    try {
      const totals = await checkAccount(account, maxGroups);
      contactsChecked += totals.contactsChecked;
      errors += totals.errors;
    } catch (err) {
      console.error(`[mergeWatch] account ${account.id} (${account.ghlLocationId}) check failed:`, err);
      errors++;
      contactsChecked++;
    }
  }
  // Everything asked about GHL failed: that's an outage or a credential
  // problem, not "no merges" -- let the cycle report it to alerting.
  if (contactsChecked > 0 && errors >= contactsChecked) {
    throw new Error(`every GHL check failed this cycle (${errors} of ${contactsChecked})`);
  }
}

function start() {
  if (!isEnabled()) {
    console.log("[mergeWatch] disabled (MERGE_WATCH_ENABLED=false)");
    return;
  }
  console.log(`[mergeWatch] starting, checking duplicate contacts for GHL merges every ${CHECK_INTERVAL_MS / 60000}min`);
  async function cycle() {
    try {
      await runOnce();
      alerting.recordSuccess("GHL merge watcher");
    } catch (err) {
      console.error("[mergeWatch] cycle failed:", err);
      await alerting.recordFailure("GHL merge watcher", err).catch(() => {});
    }
    setTimeout(cycle, CHECK_INTERVAL_MS);
  }
  setTimeout(cycle, FIRST_RUN_DELAY_MS);
}

module.exports = { start, runOnce, pickGroups, isEnabled, MAX_GROUPS_PER_ACCOUNT };
