// Notices contacts merged in GHL and files their calls under the surviving
// contact -- no button press needed. GHL has no merge API or webhook, so
// merging happens there and this just checks back on a timer (every minute
// by default, matching the live call poller).
//
// It's cheap enough to run that often because the first check is tiny: one
// small GHL call per contact asking "does this contact still exist?". A
// merge always removes one contact, so only a group with a missing member
// gets the heavier catch-up (listing calls and re-filing them -- see
// src/contactReconcile.js). A cycle with no merges costs one call per
// watched contact and moves nothing.
//
// What it watches: contacts that share a phone number (the same groups as
// the Possible duplicates view). Duplicates are what get merged, and the
// surviving contact keeps that number. A merge between contacts with
// DIFFERENT phone numbers isn't in a group, so it's caught later instead:
// the live poller and any "Import past calls" run re-file a call the moment
// they see it under a new contact (see processCallMessage in
// src/poller.js).
//
// Groups an admin dismissed as "not duplicates" aren't checked. At most
// MAX_GROUPS_PER_ACCOUNT groups are checked per cycle, rotating through the
// rest on later cycles, so an account with hundreds of duplicate groups
// can't flood GHL's API in one go. A group whose missing contact's calls
// couldn't be located (its survivor is outside the group) is left alone for
// a few hours rather than re-tried every minute; re-running "Import past
// calls" re-files those.
const db = require("./db");
const accountCredentials = require("./accountCredentials");
const alerting = require("./alerting");
const { reconcileContacts, withAccountLock } = require("./contactReconcile");

const CHECK_INTERVAL_MS = Math.max(1, Number(process.env.MERGE_WATCH_INTERVAL_MIN) || 1) * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000; // let startup settle before the first GHL check
const MAX_GROUPS_PER_ACCOUNT = 10;
const UNRESOLVED_RETRY_MS = 6 * 60 * 60 * 1000;

const unresolvedUntil = new Map(); // contactId -> when to try its group again

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
      const contactIds = group.contacts.map((c) => c.id);
      if (contactIds.some((id) => (unresolvedUntil.get(id) || 0) > Date.now())) continue;
      totals.groupsChecked++;

      // The cheap check: has any member disappeared from GHL?
      let anyGone = false;
      for (const contactId of contactIds) {
        totals.contactsChecked++;
        try {
          const { contactGone } = await api.searchConversationsForContact(contactId);
          if (contactGone) anyGone = true;
        } catch (err) {
          console.warn(`[mergeWatch] could not check contact ${contactId}:`, err.message);
          totals.errors++;
        }
      }
      if (!anyGone) continue;

      const result = await reconcileContacts({ api, ghlAccountId: account.id, contactIds });
      totals.callsMoved += result.callsMoved;
      totals.contactsRemoved += result.contactsRemoved;
      totals.errors += result.errors;
      if (result.callsMoved === 0 && result.contactsGone > 0 && result.errors === 0) {
        for (const id of contactIds) unresolvedUntil.set(id, Date.now() + UNRESOLVED_RETRY_MS);
      }
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

module.exports = { start, runOnce, pickGroups, isEnabled, MAX_GROUPS_PER_ACCOUNT, unresolvedUntil };
