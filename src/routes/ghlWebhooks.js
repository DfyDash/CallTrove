// Receiver for GoHighLevel's app-level webhook events (InboundMessage/
// OutboundMessage). This is how CallTrove discovers new calls on a
// sub-account that has GHL's own HIPAA mode turned on, since
// conversations/{id}/messages -- the REST endpoint src/poller.js and
// src/backfill.js use otherwise -- returns 401
// CONVERSATIONS_HIPAA_RESTRICTED for such accounts (confirmed live against
// the DFY Troubleshoot test account on 2026-10-21), with no way to recover
// a call ever missed this way.
//
// A verified payload is written straight to the durable ghl_webhook_events
// queue (src/db/index.js) before the 200 response is even sent -- GHL
// doesn't retry a failed delivery (confirmed: only HTTP 429 gets retried;
// anything else is permanently dropped on GHL's side with no notice to
// us), so the actual download/store/transcribe work must not depend on
// this request, or this process, surviving. src/webhookEventPoller.js does
// that work from the queue, with its own retries.
//
// Mounted ahead of requireAuth/express.json in server.js, same as /auth,
// since GHL calls this unauthenticated and signature verification needs
// the raw body bytes, not JSON already parsed by Express.
const express = require("express");
const crypto = require("crypto");
const db = require("../db");

const router = express.Router();

// GoHighLevel's published Ed25519 public key for the current X-GHL-Signature
// webhook header (per HighLevel's own Webhook Integration Guide). This is
// GHL's key, not a per-app secret, so it's fine as a checked-in default --
// but it was sourced indirectly (via a third-party implementation that
// quotes it, since marketplace.gohighlevel.com isn't reachable from this
// environment) rather than copied directly from GHL's docs page. Confirm it
// against the Webhook Integration Guide and override via env if it differs.
const GHL_WEBHOOK_PUBLIC_KEY =
  process.env.GHL_WEBHOOK_PUBLIC_KEY ||
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  try {
    return crypto.verify(null, rawBody, GHL_WEBHOOK_PUBLIC_KEY, Buffer.from(signatureHeader, "base64"));
  } catch (err) {
    return false;
  }
}

// type:"*/*" so the raw bytes are captured regardless of the content-type
// GHL actually sends -- signature verification needs the exact bytes as
// sent, and a mismatch there is a likely source of false "invalid
// signature" results while this key is still unconfirmed.
router.post("/ghl", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const signature = req.get("X-GHL-Signature") || req.get("x-wh-signature");
  const verified = verifySignature(req.body, signature);
  if (!verified) {
    // Still worth knowing a delivery arrived at all without treating its
    // contents as trusted -- log only size/presence, not the parsed
    // payload, and reject rather than process it.
    console.warn(`[ghlWebhook] rejected: signature did not verify (${req.body.length} bytes, signature present=${Boolean(signature)})`);
    return res.status(401).end();
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    console.error("[ghlWebhook] could not parse payload as JSON:", err.message);
    return res.status(400).end();
  }

  console.log(
    `[ghlWebhook] received type=${payload.type} messageId=${payload.messageId} conversationId=${payload.conversationId} contactId=${payload.contactId} locationId=${payload.locationId}`
  );

  // Persist before acking, not after -- GHL won't redeliver a failed
  // request, so the one thing that must never happen is telling GHL "got
  // it" (200) and then losing the payload to a crash or a slow downstream
  // step before it's actually durable. If this INSERT itself fails, GHL
  // gets a 500 and (per their docs) just drops it -- the one failure mode
  // this can't close, since there's nowhere left to write it to.
  try {
    await db.insertWebhookEvent(crypto.randomUUID(), payload);
  } catch (err) {
    console.error(`[ghlWebhook] failed to persist event (messageId=${payload.messageId}), GHL will not retry this:`, err);
    return res.status(500).end();
  }

  res.status(200).end();
});

module.exports = router;
