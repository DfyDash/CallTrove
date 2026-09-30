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
  try {
    await email.sendEmail({
      to: ALERT_TO,
      subject: `CallTrove alert: ${subsystem} is failing`,
      text: `${subsystem} has failed ${count} times in a row.\n\nMost recent error:\n${(err && err.stack) || err}\n\nYou'll get one more email like this if it's still broken an hour from now, and one when it recovers.`,
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
