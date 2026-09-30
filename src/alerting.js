// Central failure tracking + email alerting for every background job,
// plus a safety net for anything unexpected app-wide (server.js's
// uncaughtException/unhandledRejection handlers). One place a caller
// reports "this subsystem just failed" or "this subsystem just
// succeeded" -- the actual alerting decision (whether this rises to an
// email, and how often to re-send while it stays broken) lives here, not
// scattered across every poller.
//
// In-memory per-subsystem state, not persisted -- a deploy/restart
// starting everyone fresh is the right behavior anyway (a restart is
// itself often the fix). A single transient error (one bad API call, one
// network blip) is normal and expected in every one of these jobs
// already -- only a streak of FAILURE_THRESHOLD consecutive failures at
// the whole-cycle level is treated as "this subsystem is actually down",
// not one call/transcription/digest failing on its own (those are
// already caught and logged individually without aborting the cycle,
// same as before this module existed).

const email = require("./email");

const FAILURE_THRESHOLD = 3;
// Once alerted, don't re-send on every subsequent failure while it stays
// broken -- at most once per hour, so a persistent outage is still
// visible without flooding the inbox.
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const ALERT_TO = process.env.ALERT_EMAIL_TO;

function isEnabled() {
  return email.isEnabled() && !!ALERT_TO;
}

// What breaking actually means, in plain language -- "X is failing" with
// a raw stack trace isn't enough to know how urgent it is or what to
// check first. Keyed by the exact subsystem string each caller passes
// (poller.js, transcriptionPoller.js, callSummaryPoller.js,
// callDigestJob.js, server.js's unhandledRejection handler); a subsystem
// not listed here (new code that hasn't been given its own entry yet)
// falls back to a generic note rather than the email silently omitting
// this section.
const IMPACT_BY_SUBSYSTEM = {
  "call ingestion (poller)":
    "New calls from GHL have stopped being detected entirely -- nothing new will show up in Contacts, Dashboard, or Call report until this is fixed. No data is being lost permanently (GHL still has it), but it won't appear here until ingestion resumes; anything that happened during the outage can be brought in afterward with Settings > Import past calls.",
  transcription:
    "New recordings are not being transcribed. Recordings themselves are unaffected and still play/download normally -- only the text transcript is delayed. Nothing is lost; queued recordings will transcribe automatically once this recovers.",
  "call summary (AI)":
    "AI-generated call summaries aren't being posted as notes on contacts. Recordings and transcripts are unaffected. Not urgent -- summaries resume automatically once this recovers, nothing is lost in the meantime.",
  "analytics digest":
    "The twice-daily Analytics Digest (Settings > Call report) has stopped updating for accounts without transcription on. Call data itself is unaffected and nothing is lost -- this is a reporting feature only, so the impact is a stale/missing digest, not missing calls.",
  "unhandled app errors":
    "An unexpected error occurred somewhere in the app outside the normal background jobs -- the specific impact depends on what triggered it. Worth logging into the app directly to confirm nothing else looks broken.",
};
const DEFAULT_IMPACT = "No specific impact note has been written for this subsystem yet -- worth checking the app directly to see what's actually affected.";

const state = new Map(); // subsystem -> { count, lastAlertAt, alerted }

async function recordFailure(subsystem, err) {
  const s = state.get(subsystem) || { count: 0, lastAlertAt: 0, alerted: false };
  s.count += 1;
  state.set(subsystem, s);

  if (s.count < FAILURE_THRESHOLD) return;
  if (Date.now() - s.lastAlertAt < ALERT_COOLDOWN_MS) return;

  s.lastAlertAt = Date.now();
  s.alerted = true;
  await sendAlert(subsystem, s.count, err);
}

// Clears the failure streak -- called on every clean cycle, not just
// after a prior failure, so a subsystem that's never failed is simply a
// no-op here. Sends a one-time "recovered" email only if this subsystem
// had actually alerted before, so a normally-healthy job succeeding
// doesn't generate any mail at all.
function recordSuccess(subsystem) {
  const s = state.get(subsystem);
  if (!s) return;
  const wasAlerted = s.alerted;
  state.delete(subsystem);
  if (wasAlerted) {
    sendRecovered(subsystem).catch((err) => console.error(`[alerting] failed to send recovery email for "${subsystem}":`, err));
  }
}

async function sendAlert(subsystem, count, err) {
  if (!isEnabled()) {
    console.error(`[alerting] would alert on "${subsystem}" (${count} consecutive failures) but ALERT_EMAIL_TO/Resend isn't configured:`, err);
    return;
  }
  const impact = IMPACT_BY_SUBSYSTEM[subsystem] || DEFAULT_IMPACT;
  try {
    await email.sendEmail({
      to: ALERT_TO,
      subject: `CallTrove alert: ${subsystem} is failing`,
      text: `${subsystem} has failed ${count} times in a row.\n\nWhat this affects:\n${impact}\n\nMost recent error:\n${(err && err.stack) || err}\n\nYou'll get one more email like this if it's still broken an hour from now, and one when it recovers.`,
    });
  } catch (sendErr) {
    console.error(`[alerting] failed to send alert email for "${subsystem}":`, sendErr);
  }
}

async function sendRecovered(subsystem) {
  if (!isEnabled()) return;
  await email.sendEmail({
    to: ALERT_TO,
    subject: `CallTrove: ${subsystem} recovered`,
    text: `${subsystem} succeeded again after previously failing repeatedly.`,
  });
}

module.exports = { recordFailure, recordSuccess, isEnabled };
