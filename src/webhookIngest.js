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
// per GHL's own docs), and the payload doesn't carry a reliable channel
// discriminator to filter on up front, so a message that isn't actually a
// call is detected by downloadRecording() simply failing (expected, not
// an error) rather than by inspecting the payload.
//
// This only covers calls from here forward -- it has no way to catch up on
// anything that happened while a location was HIPAA-locked before this
// existed, or while this webhook wasn't yet registered. That's still a real
// gap; this just stops it from growing for new calls on such accounts.
const { randomUUID } = require("crypto");
const db = require("./db");
const accountCredentials = require("./accountCredentials");
const { saveRecording } = require("./storage");
const { embedMetadata } = require("./audioMetadata");
const { getRealDurationSeconds } = require("./audioDuration");
const transcription = require("./transcription");

async function handleEvent(payload) {
  if (payload.type !== "InboundMessage" && payload.type !== "OutboundMessage") return;

  const { messageId, conversationId, contactId, locationId } = payload;
  if (!messageId || !contactId || !locationId) {
    console.warn(`[webhookIngest] missing required fields in payload (type=${payload.type}), skipping`);
    return;
  }

  const account = await db.getActiveGhlAccountByLocationId(locationId);
  if (!account) {
    console.warn(`[webhookIngest] no active account for location ${locationId}, ignoring`);
    return;
  }

  const api = await accountCredentials.clientForAccount(account);
  if (!api.isConfigured()) return;

  let recording;
  try {
    recording = await api.downloadRecording(messageId);
  } catch (err) {
    // The expected outcome for every non-call message this webhook also
    // fires for (SMS, email, chat) -- not logged as an error.
    return;
  }

  let conversationInfo = null;
  try {
    const result = await api.searchConversationsForContact(contactId);
    conversationInfo = (result.conversations || []).find((c) => c.id === conversationId) || result.conversations[0] || null;
  } catch (err) {
    console.error(`[webhookIngest] could not look up conversation info for contact ${contactId}:`, err.message);
  }

  const name = (conversationInfo && (conversationInfo.fullName || conversationInfo.contactName)) || null;
  const phone = (conversationInfo && conversationInfo.phone) || null;
  const direction = payload.type === "InboundMessage" ? "inbound" : "outbound";
  const occurredAt = payload.dateAdded ? new Date(payload.dateAdded) : new Date();

  await db.upsertContact({ contactId, name, phone, ghlAccountId: account.id });

  const callRowId = randomUUID();
  const inserted = await db.insertCall({
    id: callRowId,
    ghlCallId: messageId,
    contactId,
    direction,
    durationSeconds: null,
    occurredAt,
    sourceRecordingUrl: null,
    rawPayload: payload,
    handledById: null,
    handledByName: null,
    disposition: null,
    ghlAccountId: account.id,
  });
  if (!inserted) return; // already ingested (duplicate webhook delivery, or the poller got there first)

  try {
    const extension = recording.contentType.includes("wav") ? "wav" : "mp3";
    const durationSeconds = await getRealDurationSeconds(recording.buffer, recording.contentType);
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
    console.log(`[webhookIngest] stored recording for call ${messageId} via webhook (account ${account.id})`);

    if (transcription.isEnabled() && (await db.getAutoTranscribeEnabled(account.id))) {
      try {
        await transcription.startJob(callRowId, taggedBuffer, extension, account.storageTier);
        await db.markTranscriptionPending(callRowId);
      } catch (err) {
        console.error(`[webhookIngest] failed to start auto-transcription for call ${messageId}:`, err);
      }
    }
  } catch (err) {
    console.error(`[webhookIngest] failed to store recording for call ${messageId}:`, err);
    await db.markCallFailed(callRowId);
  }
}

module.exports = { handleEvent };
