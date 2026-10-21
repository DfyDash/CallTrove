// Advances a GHL sub-account's custom vocabulary from 'pending' to
// 'ready'/'failed' once AWS actually finishes building it --
// Create/UpdateVocabulary both return long before the vocabulary is
// usable (see src/customVocabulary.js's header comment), so this is what
// src/transcription.js's callers are really waiting on before they'll pass
// a VocabularyName to a transcription job.
const db = require("./db");
const customVocabulary = require("./customVocabulary");
const alerting = require("./alerting");

const POLL_INTERVAL_MS = 30 * 1000;

async function pollOnce() {
  if (!customVocabulary.isEnabled()) return;
  const pendingAccountIds = await db.listAccountsWithPendingVocabulary();
  for (const ghlAccountId of pendingAccountIds) {
    try {
      const status = await customVocabulary.refreshVocabularyStatus(ghlAccountId);
      if (status !== "pending") console.log(`[vocabularyPoller] account ${ghlAccountId} vocabulary is now ${status}`);
    } catch (err) {
      console.error(`[vocabularyPoller] could not check vocabulary status for account ${ghlAccountId}:`, err);
    }
  }
}

function start() {
  if (!customVocabulary.isEnabled()) {
    console.log("[vocabularyPoller] disabled (set TRANSCRIPTION_ENABLED=true plus S3_REGION to enable)");
    return;
  }
  console.log(`[vocabularyPoller] starting, checking every ${POLL_INTERVAL_MS / 1000}s`);
  async function cycle() {
    try {
      await pollOnce();
      alerting.recordSuccess("custom vocabulary build");
    } catch (err) {
      console.error("[vocabularyPoller] poll cycle failed:", err);
      await alerting.recordFailure("custom vocabulary build", err).catch(() => {});
    }
    setTimeout(cycle, POLL_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, pollOnce };
