const db = require("./db");
const callSummary = require("./callSummary");
const accountCredentials = require("./accountCredentials");

// Bedrock responses land well within a few seconds, but this still polls
// rather than calling inline from transcriptionPoller.js -- keeps a
// Bedrock/GHL failure from ever blocking or crashing the transcription
// cycle itself, same isolation reasoning transcriptionPoller.js has for
// staying separate from the main call-ingestion poller.
const POLL_INTERVAL_MS = 30 * 1000;

// Same purpose as transcription_attempts/MAX_TRANSCRIPTION_ATTEMPTS: bounds
// the worst case (a DB write failing right after a successful, billable
// Bedrock call, which would otherwise leave the row 'pending' and get
// re-billed every cycle) to at most this many Bedrock calls per call, ever.
const MAX_SUMMARY_ATTEMPTS = 3;

async function pollOnce() {
  if (!callSummary.isEnabled()) return;

  const pending = await db.listPendingCallSummaries();
  for (const call of pending) {
    if (call.attempts >= MAX_SUMMARY_ATTEMPTS) {
      await db.markSummaryFailed(call.id);
      console.error(`[callSummary] call ${call.id} hit ${call.attempts} attempts -- giving up, not retrying`);
      continue;
    }
    try {
      await db.incrementSummaryAttempts(call.id);
      const { summary, analysis } = await callSummary.summarizeTranscript(call.transcript);
      await db.markSummaryComplete(call.id, summary, analysis);
      console.log(`[callSummary] summarized call ${call.id}`);

      try {
        const account = await db.getGhlAccountById(call.ghlAccountId);
        const client = await accountCredentials.clientForAccount(account);
        await client.addContactNote(call.contactId, `CallTrove call summary:\n\n${summary}`);
        await db.markGhlNoteWritten(call.id);
      } catch (noteErr) {
        // Summary itself is saved either way (visible in CallTrove's own
        // UI) -- failing to post it to GHL as a note is logged but doesn't
        // undo the completed summary or get retried automatically
        // (ghl_note_written_at simply stays null).
        console.error(`[callSummary] summarized call ${call.id} but failed to post GHL note:`, noteErr);
      }
    } catch (err) {
      await db.markSummaryFailed(call.id).catch(() => {});
      console.error(`[callSummary] failed to summarize call ${call.id}:`, err);
    }
  }
}

function start() {
  if (!callSummary.isEnabled()) {
    console.warn("[callSummary] disabled (set CALL_SUMMARY_ENABLED=true plus BEDROCK_MODEL_ID/BEDROCK_REGION to enable)");
    return;
  }
  console.log(`[callSummary] starting, checking every ${POLL_INTERVAL_MS / 1000}s`);
  async function cycle() {
    try {
      await pollOnce();
    } catch (err) {
      console.error("[callSummary] poll cycle failed:", err);
    }
    setTimeout(cycle, POLL_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, pollOnce };
