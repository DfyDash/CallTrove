const db = require("./db");
const transcriptCleanup = require("./transcriptCleanup");
const alerting = require("./alerting");
const billingRates = require("./billingRates");

// Same isolation reasoning as callSummaryPoller.js: a Bedrock failure here
// never blocks or crashes the transcription cycle itself.
const POLL_INTERVAL_MS = 30 * 1000;

// Same purpose as MAX_SUMMARY_ATTEMPTS -- bounds the worst case (a DB
// write failing right after a successful, billable Bedrock call, which
// would otherwise leave the row 'pending' and get re-billed every cycle)
// to at most this many Bedrock calls per call, ever.
const MAX_CLEANUP_ATTEMPTS = 3;

async function pollOnce() {
  if (!transcriptCleanup.isEnabled()) return;

  const pending = await db.listPendingTranscriptCleanups();
  for (const call of pending) {
    if (call.attempts >= MAX_CLEANUP_ATTEMPTS) {
      await db.markTranscriptCleanupFailed(call.id);
      console.error(`[transcriptCleanup] call ${call.id} hit ${call.attempts} attempts -- giving up, not retrying`);
      continue;
    }
    try {
      await db.incrementTranscriptCleanupAttempts(call.id);
      const result = await transcriptCleanup.cleanTranscript(call.transcriptWords, { handledByName: call.handledByName });

      if (result.bedrockCalled) {
        // Cost-ledger entry -- a permanent receipt at today's rates (see
        // schema.sql's cost_ledger comment), computed from the real token
        // counts Bedrock actually billed for this call. Keyed on
        // bedrockCalled, NOT changed -- a real, billable call happens
        // whenever anything was flagged, whether or not it ultimately
        // found something worth correcting (see src/transcriptCleanup.js's
        // own comment on why). Billed the same flat per-use rate
        // regardless of outcome, same as ai_summary billing every
        // successfully summarized call regardless of its content.
        try {
          const awsCost =
            (result.inputTokens / 1_000_000) * billingRates.AWS_BEDROCK_HAIKU_INPUT_PER_MILLION_TOKENS +
            (result.outputTokens / 1_000_000) * billingRates.AWS_BEDROCK_HAIKU_OUTPUT_PER_MILLION_TOKENS;
          await db.recordTranscriptCleanupCost({
            tenantId: call.tenantId,
            ghlAccountId: call.ghlAccountId,
            callId: call.id,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            awsRate: billingRates.AWS_BEDROCK_HAIKU_INPUT_PER_MILLION_TOKENS,
            awsCost,
            clientRate: billingRates.CLIENT_TRANSCRIPT_CLEANUP_PER_USE,
            clientRevenue: billingRates.CLIENT_TRANSCRIPT_CLEANUP_PER_USE,
            // call.attempts is the count from before incrementTranscriptCleanupAttempts
            // ran above in this same cycle, so it's one behind the attempt
            // actually being billed here.
            attempt: call.attempts + 1,
          });
        } catch (ledgerErr) {
          console.error(`[transcriptCleanup] cleaned call ${call.id} but failed to record its cost-ledger entry:`, ledgerErr);
        }
      }

      await db.markTranscriptCleanupComplete(call.id, result.changed ? result.correctedText : null, result.changes);
      console.log(`[transcriptCleanup] cleaned up call ${call.id}`);
    } catch (err) {
      await db.markTranscriptCleanupFailed(call.id).catch(() => {});
      console.error(`[transcriptCleanup] failed to clean up call ${call.id}:`, err);
    }
  }
}

function start() {
  if (!transcriptCleanup.isEnabled()) {
    console.warn("[transcriptCleanup] disabled (set TRANSCRIPT_CLEANUP_ENABLED=true plus BEDROCK_MODEL_ID/BEDROCK_REGION to enable)");
    return;
  }
  console.log(`[transcriptCleanup] starting, checking every ${POLL_INTERVAL_MS / 1000}s`);
  async function cycle() {
    try {
      await pollOnce();
      alerting.recordSuccess("transcript cleanup (AI)");
    } catch (err) {
      console.error("[transcriptCleanup] poll cycle failed:", err);
      await alerting.recordFailure("transcript cleanup (AI)", err).catch(() => {});
    }
    setTimeout(cycle, POLL_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, pollOnce };
