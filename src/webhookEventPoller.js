// Processes the durable queue src/routes/ghlWebhooks.js writes every
// verified GHL webhook delivery into (ghl_webhook_events), retrying
// src/webhookIngest.js's actual download/store/transcribe work on its own
// schedule rather than depending on the original request/process
// surviving. This is the only way new calls get discovered on a
// GHL-HIPAA-locked sub-account (see webhookIngest.js's header comment),
// and there is no backfill to fall back on for that account -- so an event
// that exhausts its retries here is a genuinely, permanently lost call,
// worth an immediate email regardless of how many other things are
// working fine, not folded into src/alerting.js's "3 cycles in a row"
// pattern (that's for "is this subsystem down," not "did we just lose a
// specific, irreplaceable piece of data").
const db = require("./db");
const webhookIngest = require("./webhookIngest");
const email = require("./email");
const alerting = require("./alerting");

const POLL_INTERVAL_MS = 15 * 1000;
// ~5 minutes of retrying (at 15s apart) before giving up on one event --
// long enough to ride out a transient blip (a deploy restart, a brief GHL
// or S3 hiccup) without leaving a real failure undetected for long.
const MAX_ATTEMPTS = 20;

const ALERT_TO = process.env.ALERT_EMAIL_TO;

async function alertPermanentlyFailed(event, err) {
  console.error(`[webhookEventPoller] event ${event.id} exhausted ${MAX_ATTEMPTS} attempts, giving up:`, err);
  if (!email.isEnabled() || !ALERT_TO) {
    console.error(`[webhookEventPoller] would alert on permanently failed event ${event.id} but ALERT_EMAIL_TO/Resend isn't configured`);
    return;
  }
  try {
    await email.sendEmail({
      to: ALERT_TO,
      subject: "CallTrove alert: a call from a HIPAA-locked GHL account could not be saved",
      text:
        `A GHL webhook event (id ${event.id}, messageId ${event.payload && event.payload.messageId}) failed ${MAX_ATTEMPTS} times over ` +
        `about ${Math.round((MAX_ATTEMPTS * POLL_INTERVAL_MS) / 60000)} minutes and has been given up on.\n\n` +
        `This matters more than a normal ingestion failure: this is the webhook path that exists specifically for GHL-HIPAA-locked ` +
        `accounts, which have no backfill to recover a missed call afterward. This call is very likely permanently lost.\n\n` +
        `Last error:\n${(err && err.stack) || err}\n\n` +
        `Raw payload:\n${JSON.stringify(event.payload)}`,
    });
  } catch (sendErr) {
    console.error(`[webhookEventPoller] failed to send permanent-failure alert for event ${event.id}:`, sendErr);
  }
}

async function pollOnce() {
  const events = await db.listRetryableWebhookEvents();
  for (const event of events) {
    if (event.attempts >= MAX_ATTEMPTS) continue; // already given up on and alerted; leave it for forensics
    try {
      await webhookIngest.handleEvent(event.payload);
      await db.markWebhookEventCompleted(event.id);
    } catch (err) {
      const attemptsNow = event.attempts + 1;
      await db.markWebhookEventFailed(event.id, err.message);
      if (attemptsNow >= MAX_ATTEMPTS) {
        await alertPermanentlyFailed({ ...event, attempts: attemptsNow }, err);
      } else {
        console.warn(`[webhookEventPoller] event ${event.id} failed (attempt ${attemptsNow}/${MAX_ATTEMPTS}), will retry:`, err.message);
      }
    }
  }
}

function start() {
  console.log(`[webhookEventPoller] starting, checking every ${POLL_INTERVAL_MS / 1000}s`);
  async function cycle() {
    try {
      await pollOnce();
      alerting.recordSuccess("GHL webhook ingestion");
    } catch (err) {
      console.error("[webhookEventPoller] poll cycle failed:", err);
      await alerting.recordFailure("GHL webhook ingestion", err).catch(() => {});
    }
    setTimeout(cycle, POLL_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, pollOnce };
