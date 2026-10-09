// "I merged these in GHL -- catch CallTrove up." GHL has no merge API, so
// merging happens there; this follows along afterward. For each contact in
// a duplicate group, ask GHL which conversations it CURRENTLY holds under
// that contact, then make sure every call in them is filed under that
// contact here. After a merge, the merged-away contact has no conversations
// left in GHL and the survivor holds all of them, so the calls move to the
// survivor and the emptied contact is dropped (see
// db.reassignCallToContact). Only calls GHL positively reports under a
// contact are ever moved -- a contact GHL can't be asked about, or a call
// it doesn't mention, is left exactly as it is. The same re-filing happens
// automatically whenever the poller or a backfill sees a moved call.
//
// contactsGone counts contacts GHL says no longer exist. If their calls
// weren't found under another contact in the group they stay where they
// are (the survivor may be outside the group); a backfill re-files them.
const db = require("./db");

const LIST_TIMEOUT_MS = 30 * 1000;

// The HTTP status behind an error from the GHL client, if it has one.
function statusOf(err) {
  if (err && err.status) return err.status;
  const m = /status (\d{3})/.exec((err && err.message) || "");
  return m ? Number(m[1]) : null;
}

// Gives up waiting after ms. The underlying call can't be cancelled, so it's
// left to finish on its own -- with its outcome swallowed, because an
// abandoned promise that later rejects would otherwise surface as an
// unhandled rejection.
function withTimeout(promise, ms, what) {
  promise.catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function reconcileContacts({ api, ghlAccountId, contactIds, listTimeoutMs = LIST_TIMEOUT_MS }) {
  const result = { contactsChecked: 0, callsMoved: 0, contactsRemoved: 0, contactsGone: 0, errors: 0, rateLimited: false };
  for (const contactId of new Set(contactIds)) {
    result.contactsChecked++;
    let conversations;
    try {
      const found = await api.searchConversationsForContact(contactId);
      conversations = found.conversations;
      if (found.contactGone) result.contactsGone++;
    } catch (err) {
      console.warn(`[reconcile] could not list conversations for contact ${contactId}:`, err.message);
      result.errors++;
      if (statusOf(err) === 429) { result.rateLimited = true; return result; } // GHL says slow down -- stop, don't keep asking
      continue;
    }
    for (const conversation of conversations) {
      // GHL's answer, not the one we searched by: it's the contact that
      // owns the conversation right now.
      const ownerId = conversation.contactId || contactId;
      let messages;
      try {
        messages = await withTimeout(api.listCallMessages(conversation.id), listTimeoutMs, "listing a conversation's calls");
      } catch (err) {
        console.warn(`[reconcile] could not read conversation ${conversation.id}:`, err.message);
        result.errors++;
        if (statusOf(err) === 429) { result.rateLimited = true; return result; }
        continue;
      }
      if (messages.length === 0) continue;
      await db.upsertContact({
        contactId: ownerId,
        name: conversation.fullName || conversation.contactName || null,
        phone: conversation.phone || null,
        ghlAccountId,
      });
      for (const message of messages) {
        const fromContactId = await db.reassignCallToContact({ ghlCallId: message.id, contactId: ownerId, ghlAccountId });
        if (fromContactId) {
          result.callsMoved++;
          if (!(await db.contactExists(fromContactId))) result.contactsRemoved++;
        }
      }
    }
  }
  return result;
}

// One catch-up per account at a time, shared by the button and the
// background watcher (src/mergeWatchJob.js): each makes several GHL API
// calls per contact, and two at once would only double that. Returns
// { busy: true } without running fn if one is already going.
const running = new Set();

async function withAccountLock(accountId, fn) {
  if (running.has(accountId)) return { busy: true };
  running.add(accountId);
  try {
    return { busy: false, value: await fn() };
  } finally {
    running.delete(accountId);
  }
}

module.exports = { reconcileContacts, withAccountLock, statusOf, withTimeout };
