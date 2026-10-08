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

async function reconcileContacts({ api, ghlAccountId, contactIds }) {
  const result = { contactsChecked: 0, callsMoved: 0, contactsRemoved: 0, contactsGone: 0, errors: 0 };
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
      continue;
    }
    for (const conversation of conversations) {
      // GHL's answer, not the one we searched by: it's the contact that
      // owns the conversation right now.
      const ownerId = conversation.contactId || contactId;
      let messages;
      try {
        messages = await api.listCallMessages(conversation.id);
      } catch (err) {
        console.warn(`[reconcile] could not read conversation ${conversation.id}:`, err.message);
        result.errors++;
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

module.exports = { reconcileContacts };
