const db = require("./db");
const transcription = require("./transcription");
const alerting = require("./alerting");
const billingRates = require("./billingRates");

// AWS Transcribe jobs are async (typically finish well within a couple
// minutes for a call-length recording), so this checks in on outstanding
// jobs rather than blocking the main call poller on them.
const POLL_INTERVAL_MS = 30 * 1000;

async function pollOnce() {
  if (!transcription.isEnabled()) return;

  const pending = await db.listPendingTranscriptions();
  for (const call of pending) {
    try {
      const result = await transcription.checkJob(call.id);
      if (result.status === "completed") {
        await db.markTranscriptionComplete(call.id, result.text, result.words);
        console.log(`[transcription] completed for call ${call.id}`);

        // Cost-ledger entry -- a permanent receipt at today's rates, not
        // recomputed later (see schema.sql's cost_ledger comment). Best
        // effort: a logging failure here shouldn't undo the transcription
        // that already succeeded, same posture as callSummaryPoller.js's
        // GHL-note-post failure not undoing a completed summary.
        try {
          const minutes = (call.durationSeconds || 0) / 60;
          const awsCost = minutes * billingRates.AWS_TRANSCRIBE_PER_MINUTE;
          const clientRevenue = minutes * billingRates.CLIENT_TRANSCRIPTION_PER_MINUTE;
          await db.recordTranscriptionCost({
            tenantId: call.tenantId,
            ghlAccountId: call.ghlAccountId,
            callId: call.id,
            minutes,
            awsRate: billingRates.AWS_TRANSCRIBE_PER_MINUTE,
            awsCost,
            clientRate: billingRates.CLIENT_TRANSCRIPTION_PER_MINUTE,
            clientRevenue,
            attempt: call.transcriptionAttempts,
          });
        } catch (ledgerErr) {
          console.error(`[transcription] completed call ${call.id} but failed to record its cost-ledger entry:`, ledgerErr);
        }
      } else if (result.status === "failed") {
        await db.markTranscriptionFailed(call.id);
        console.error(`[transcription] failed for call ${call.id}: ${result.reason}`);

        // Real AWS cost, not recoverable even though the job failed -- see
        // routes/api.js's MAX_TRANSCRIPTION_ATTEMPTS comment: each attempt
        // is a real, separately billed Transcribe job whether or not it
        // succeeds. Never bills the client (clientRate/clientRevenue null
        // -- no usable transcript came out of this attempt), but the real
        // AWS cost still needs to be visible: 2 failed retries before a
        // 3rd succeeds is 3x the real AWS cost, not 1x.
        try {
          const minutes = (call.durationSeconds || 0) / 60;
          const awsCost = minutes * billingRates.AWS_TRANSCRIBE_PER_MINUTE;
          await db.recordTranscriptionCost({
            tenantId: call.tenantId,
            ghlAccountId: call.ghlAccountId,
            callId: call.id,
            minutes,
            awsRate: billingRates.AWS_TRANSCRIBE_PER_MINUTE,
            awsCost,
            clientRate: null,
            clientRevenue: null,
            attempt: call.transcriptionAttempts,
          });
        } catch (ledgerErr) {
          console.error(`[transcription] failed call ${call.id} but failed to record its cost-ledger entry:`, ledgerErr);
        }
      }
      // still pending: leave it, checked again next cycle
    } catch (err) {
      console.error(`[transcription] error checking job for call ${call.id}:`, err);
    }
  }
}

// Reschedules itself only after the previous cycle fully finishes -- see
// src/poller.js's start() for why a fixed setInterval risks overlapping
// cycles (here, that would mean checkJob() running twice concurrently for
// the same call, racing on marking it complete/failed and cleaning up its
// transient S3 input and Transcribe job record).
function start() {
  if (!transcription.isEnabled()) {
    console.warn("[transcription] disabled (set TRANSCRIPTION_ENABLED=true plus S3_BUCKET/S3_REGION to enable)");
    return;
  }
  console.log(`[transcription] starting, checking every ${POLL_INTERVAL_MS / 1000}s`);
  async function cycle() {
    try {
      await pollOnce();
      alerting.recordSuccess("transcription");
    } catch (err) {
      console.error("[transcription] poll cycle failed:", err);
      await alerting.recordFailure("transcription", err).catch(() => {});
    }
    setTimeout(cycle, POLL_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, pollOnce };
