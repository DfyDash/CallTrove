// One-time repair pass for the cost ledger (see schema.sql's cost_ledger
// comment), covering everything that happened before it existed:
//
//   1. calls.size_bytes -- every stored recording from before
//      src/poller.js started capturing this at save time. Backfilled via
//      a real S3 HeadObject per recording (its ContentLength), not a
//      guess -- the actual stored size is cheap to ask S3 for directly
//      without downloading the file.
//   2. Historical 'transcription'/'ai_summary' cost_ledger rows for
//      calls that already completed before this feature shipped.
//      Transcription's cost is exact (duration_seconds was always
//      tracked); AI summary's is an ESTIMATE -- Bedrock's real token
//      usage for these calls was never recorded, so this approximates it
//      from the transcript length using Claude's roughly 4-characters-
//      per-token average, rather than inventing a number with no basis
//      at all. Every row this writes is flagged backfilled = true (see
//      cost_ledger.backfilled) specifically so it's never confused with
//      a real-time entry recorded from Bedrock's actual usage.
//
// Both backfilled rate bases use TODAY's rates applied retroactively --
// the real historical rate (if it was ever different) isn't recorded
// anywhere for these older calls. That's a known limitation of
// backfilling a ledger after the fact, not something this script can fix.
//
// Usage:
//   node src/backfillCostLedger.js          -- apply
//   node src/backfillCostLedger.js --dry-run -- report only, no writes
require("dotenv").config();
const db = require("./db");
const { getPlayback } = require("./storage");
const billingRates = require("./billingRates");

// Rough, widely-cited average for English text on Claude's tokenizer --
// good enough for a backfill estimate, not precise the way a real
// tokenizer call would be (src/callSummary.js now captures the exact
// count going forward, so this rough estimate is never used for new
// calls).
const CHARS_PER_TOKEN_ESTIMATE = 4;
// Matches src/callSummary.js's SYSTEM_PROMPT roughly in length, plus the
// fixed "Transcript:\n\n" wrapper -- added to each call's own transcript
// length for the input-token estimate.
const ESTIMATED_SYSTEM_PROMPT_CHARS = 650;
// src/callSummary.js caps max_tokens at 500; real summaries rarely hit
// the cap, so this assumes a typical completion uses roughly 60% of it.
const ESTIMATED_OUTPUT_TOKENS = 300;

async function headObjectSize(storageKey) {
  // getPlayback doesn't expose a byte count for the S3 driver (it only
  // returns a presigned redirect URL, to avoid pulling the file through
  // this process) -- HeadObject directly instead, which is the cheap,
  // metadata-only way to ask S3 for an object's size without downloading
  // it. Local-disk deployments fall back to statSync.
  const { driver } = require("./storage");
  if (driver === "s3") {
    const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({ region: process.env.S3_REGION });
    const res = await client.send(
      new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `recordings/${storageKey}` })
    );
    return res.ContentLength;
  }
  const fs = require("fs");
  const path = require("path");
  const filePath = path.join(path.resolve(process.env.STORAGE_LOCAL_DIR || "./data/recordings"), storageKey);
  return fs.statSync(filePath).size;
}

async function backfillSizes({ dryRun }) {
  const { rows: calls } = await db.pool.query(
    `SELECT id, ghl_call_id AS "ghlCallId", storage_key AS "storageKey"
     FROM calls WHERE storage_key IS NOT NULL AND size_bytes IS NULL ORDER BY occurred_at ASC`
  );
  console.log(`[sizes] ${calls.length} stored recording(s) missing a size.${dryRun ? " (dry run)" : ""}`);

  let done = 0;
  let failed = 0;
  for (const call of calls) {
    try {
      const size = await headObjectSize(call.storageKey);
      if (!dryRun) {
        await db.pool.query(`UPDATE calls SET size_bytes = $2 WHERE id = $1`, [call.id, size]);
      }
      done++;
    } catch (err) {
      failed++;
      console.error(`  [skip] ${call.ghlCallId}: couldn't read size for ${call.storageKey}:`, err.message);
    }
  }
  console.log(`[sizes] done. ${done} backfilled, ${failed} skipped (unreadable).`);
}

async function backfillTranscriptionCosts({ dryRun }) {
  const { rows: calls } = await db.pool.query(
    `SELECT c.id, c.duration_seconds AS "durationSeconds", c.ghl_account_id AS "ghlAccountId", g.tenant_id AS "tenantId"
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     LEFT JOIN cost_ledger l ON l.call_id = c.id AND l.category = 'transcription'
     WHERE c.transcription_status = 'completed' AND l.id IS NULL`
  );
  console.log(`[transcription] ${calls.length} completed transcription(s) with no ledger entry yet.${dryRun ? " (dry run)" : ""}`);

  let written = 0;
  for (const call of calls) {
    const minutes = (call.durationSeconds || 0) / 60;
    const awsCost = minutes * billingRates.AWS_TRANSCRIBE_PER_MINUTE;
    const clientRevenue = minutes * billingRates.CLIENT_TRANSCRIPTION_PER_MINUTE;
    if (!dryRun) {
      await db.recordTranscriptionCost({
        tenantId: call.tenantId,
        ghlAccountId: call.ghlAccountId,
        callId: call.id,
        minutes,
        awsRate: billingRates.AWS_TRANSCRIBE_PER_MINUTE,
        awsCost,
        clientRate: billingRates.CLIENT_TRANSCRIPTION_PER_MINUTE,
        clientRevenue,
        attempt: 1,
        backfilled: true,
      });
    }
    written++;
  }
  console.log(`[transcription] done. ${written} backfilled.`);
}

async function backfillAiSummaryCosts({ dryRun }) {
  const { rows: calls } = await db.pool.query(
    `SELECT c.id, c.transcript, c.ghl_account_id AS "ghlAccountId", g.tenant_id AS "tenantId"
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     LEFT JOIN cost_ledger l ON l.call_id = c.id AND l.category = 'ai_summary'
     WHERE c.ai_summary_status = 'completed' AND l.id IS NULL`
  );
  console.log(`[ai_summary] ${calls.length} completed summary(ies) with no ledger entry yet (token counts estimated).${dryRun ? " (dry run)" : ""}`);

  let written = 0;
  for (const call of calls) {
    const transcriptChars = (call.transcript || "").length;
    const inputTokens = Math.round((transcriptChars + ESTIMATED_SYSTEM_PROMPT_CHARS) / CHARS_PER_TOKEN_ESTIMATE);
    const outputTokens = ESTIMATED_OUTPUT_TOKENS;
    const awsCost =
      (inputTokens / 1_000_000) * billingRates.AWS_BEDROCK_HAIKU_INPUT_PER_MILLION_TOKENS +
      (outputTokens / 1_000_000) * billingRates.AWS_BEDROCK_HAIKU_OUTPUT_PER_MILLION_TOKENS;
    if (!dryRun) {
      await db.recordAiSummaryCost({
        tenantId: call.tenantId,
        ghlAccountId: call.ghlAccountId,
        callId: call.id,
        inputTokens,
        outputTokens,
        awsRate: billingRates.AWS_BEDROCK_HAIKU_INPUT_PER_MILLION_TOKENS,
        awsCost,
        clientRate: billingRates.CLIENT_AI_SUMMARY_PER_CALL,
        clientRevenue: billingRates.CLIENT_AI_SUMMARY_PER_CALL,
        attempt: 1,
        backfilled: true,
      });
    }
    written++;
  }
  console.log(`[ai_summary] done. ${written} backfilled (estimated).`);
}

async function run({ dryRun = false } = {}) {
  await backfillSizes({ dryRun });
  await backfillTranscriptionCosts({ dryRun });
  await backfillAiSummaryCosts({ dryRun });
}

module.exports = { run };

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  run({ dryRun })
    .catch((err) => {
      console.error("[backfillCostLedger] fatal error:", err);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}
