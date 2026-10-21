// Handles a verified GHL InboundMessage/OutboundMessage webhook event --
// the route around GHL's own CONVERSATIONS_HIPAA_RESTRICTED lock on
// conversations/{id}/messages (confirmed 2026-10-21 against a real
// HIPAA-mode sub-account). That REST endpoint is what src/poller.js uses
// to *discover* new calls, and GHL blocks it outright once a location has
// its own HIPAA mode on -- but downloading a recording by messageId is
// NOT blocked, and this webhook hands over a real messageId directly, so
// ingestion never needs the blocked endpoint at all for calls that arrive
// this way.
//
// Every conversation channel fires this webhook (SMS, email, chat, calls --
// per GHL's own docs). The payload does carry messageType/messageTypeId
// (confirmed live 2026-10-21: "CALL" / 1, matching ghlApi.js's own
// CALL_MESSAGE_TYPE), so that's checked first as a cheap filter -- but it's
// not trusted as the *only* signal, in case some payload variant omits it:
// anything not positively ruled out that way still falls through to
// downloadRecording() actually failing (expected, not an error) as the
// fallback detection.
//
// This only covers calls from here forward -- it has no way to catch up on
// anything that happened while a location was HIPAA-locked before this
// existed, or while this webhook wasn't yet registered. That's still a real
// gap; this just stops it from growing for new calls on such accounts.
//
// Called from src/webhookEventPoller.js, never directly from the route --
// GHL doesn't retry a failed webhook delivery (confirmed: only HTTP 429
// gets retried; anything else is permanently dropped on GHL's side with no
// notice to us), and there's no backfill to fall back on for this account,
// so a transient failure here (network blip, a DB hiccup, a mid-request
// restart) must be retryable from a durable record, not just logged and
// dropped. That's why this throws on anything retryable instead of
// swallowing it -- the poller decides how many times to try again and
// when to give up, this function just does one attempt and reports how it
// went. It's written so a retry picks up exactly where the last attempt
// left off: a call row already existing but not yet 'stored' means "redo
// the download/store step," not "already handled, skip."
const { randomUUID } = require("crypto");
const db = require("./db");
const accountCredentials = require("./accountCredentials");
const { saveRecording } = require("./storage");
const { embedMetadata } = require("./audioMetadata");
const { getRealDurationSeconds } = require("./audioDuration");
const transcription = require("./transcription");
const customVocabulary = require("./customVocabulary");

// Outcomes: "stored" (a call was saved, or already had been), "ignored"
// (not a call-relevant event, or a channel/account issue that retrying
// won't fix). Anything else is a thrown error, meaning "worth retrying."
async function handleEvent(payload) {
  if (payload.type !== "InboundMessage" && payload.type !== "OutboundMessage") return { outcome: "ignored", reason: "not a call-relevant event type" };

  const { messageId, conversationId, contactId, locationId } = payload;
  if (!messageId || !contactId || !locationId) {
    return { outcome: "ignored", reason: "missing required fields in payload" };
  }

  if (payload.messageType && payload.messageType !== "CALL" && payload.messageTypeId !== 1) {
    return { outcome: "ignored", reason: `not a call message (messageType=${payload.messageType})` };
  }

  const account = await db.getActiveGhlAccountByLocationId(locationId);
  if (!account) {
    return { outcome: "ignored", reason: `no active account for location ${locationId}` };
  }

  const api = await accountCredentials.clientForAccount(account);
  if (!api.isConfigured()) return { outcome: "ignored", reason: "account not configured" };

  const existing = await db.getCallByGhlId(messageId);
  if (existing && existing.recordingStatus === "stored") {
    return { outcome: "stored", reason: "already stored from a prior attempt" };
  }

  let recording;
  try {
    recording = await api.downloadRecording(messageId);
  } catch (err) {
    if (!existing) {
      // First time seeing this messageId, and it has no recording -- the
      // expected outcome for every non-call message this webhook also
      // fires for (SMS, email, chat), not an error. If a call row already
      // exists for it, though, we know it's a real call that previously
      // downloaded fine (that's how the row got created) -- treat this as
      // retryable, since the recording presumably isn't gone for good.
      return { outcome: "ignored", reason: "no recording (likely a non-call message)" };
    }
    throw err;
  }

  let conversationInfo = null;
  try {
    const result = await api.searchConversationsForContact(contactId);
    const conversations = result.conversations || [];
    conversationInfo = conversations.find((c) => c.id === conversationId) || conversations[0] || null;
  } catch (err) {
    console.error(`[webhookIngest] could not look up conversation info for contact ${contactId}:`, err.message);
  }

  const name = (conversationInfo && (conversationInfo.fullName || conversationInfo.contactName)) || null;
  const phone = (conversationInfo && conversationInfo.phone) || null;
  // direction/disposition/handledById/ghlDurationSeconds all come straight
  // off the webhook payload itself (confirmed live 2026-10-21: it carries
  // userId, callStatus/status, callDuration, direction -- far more than the
  // 4 fields this was originally built against). Falls back to inferring
  // direction from the event type only for a payload variant that omits it.
  const direction = payload.direction || (payload.type === "InboundMessage" ? "inbound" : "outbound");
  const disposition = payload.callStatus || payload.status || null;
  const handledById = payload.userId || null;
  const handledByName = handledById ? await api.getUserName(handledById).catch(() => null) : null;
  const ghlDurationSeconds = typeof payload.callDuration === "number" ? payload.callDuration : null;
  const occurredAt = payload.dateAdded ? new Date(payload.dateAdded) : new Date();

  const callRowId = existing ? existing.id : randomUUID();
  if (!existing) {
    await db.upsertContact({ contactId, name, phone, ghlAccountId: account.id });
    const inserted = await db.insertCall({
      id: callRowId,
      ghlCallId: messageId,
      contactId,
      direction,
      durationSeconds: ghlDurationSeconds,
      occurredAt,
      sourceRecordingUrl: null,
      rawPayload: payload,
      handledById,
      handledByName,
      disposition,
      ghlAccountId: account.id,
    });
    // Lost the ON CONFLICT (ghl_call_id) race to some other insert of the
    // same messageId between the existing-row check above and this write --
    // callRowId was never actually written, so proceeding would upload a
    // recording nothing in the calls table ever references, and
    // markCallStored below would silently match zero rows. Same situation
    // src/poller.js's processCallMessage already guards against; this just
    // needed the same check.
    if (!inserted) return { outcome: "stored", reason: "lost insert race for this messageId" };
  }

  const extension = recording.contentType.includes("wav") ? "wav" : "mp3";
  // Measured from the actual recording bytes, same reasoning as
  // src/poller.js's processCallMessage -- GHL's own self-reported duration
  // isn't always settled yet, so it's only the fallback, never preferred
  // over what the audio itself says.
  const durationSeconds = (await getRealDurationSeconds(recording.buffer, recording.contentType)) ?? ghlDurationSeconds;
  const taggedBuffer = embedMetadata(recording.buffer, extension, {
    occurredAt,
    direction,
    durationSeconds,
    contactName: name,
    phone,
    timezone: await api.getAccountTimezone(),
  });
  const key = `${contactId}/${callRowId}.${extension}`;
  await saveRecording(key, taggedBuffer, account.tenantId, account.storageTier);
  await db.markCallStored(callRowId, key, durationSeconds, taggedBuffer.length, account.storageTier);
  await db.setAccountLastWebhookCallAt(account.id, new Date()).catch((err) => {
    // Informational only -- never block storing the actual call over this.
    console.error(`[webhookIngest] failed to record last_webhook_call_at for account ${account.id}:`, err);
  });
  console.log(`[webhookIngest] stored recording for call ${messageId} via webhook (account ${account.id})`);

  if (transcription.isEnabled() && (await db.getAutoTranscribeEnabled(account.id))) {
    try {
      const vocabularyName = await customVocabulary.readyVocabularyNameFor(account.id).catch(() => null);
      await transcription.startJob(callRowId, taggedBuffer, extension, account.storageTier, vocabularyName);
      await db.markTranscriptionPending(callRowId);
    } catch (err) {
      // Not retried at this level -- the call itself is safely stored
      // either way, and src/transcriptionPoller.js's own retry/alerting
      // covers transcription specifically. Failing the whole webhook event
      // over a transcription-kickoff error would re-run the (already
      // successful) download/store step for nothing.
      console.error(`[webhookIngest] failed to start auto-transcription for call ${messageId}:`, err);
    }
  }

  return { outcome: "stored" };
}

module.exports = { handleEvent };
