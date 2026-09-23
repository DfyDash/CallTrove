// One-time (or run-anytime-it's-useful) repair pass for calls stored
// before src/poller.js measured duration from the actual recording bytes
// (see src/audioDuration.js) -- those rows can still carry GHL's
// self-reported duration, which isn't always right (reported: a call
// showing 23s that actually played for 6s). Re-downloads each stored
// recording, measures its real duration, and corrects the row when it
// disagrees with what's stored. Read-only against everything except
// calls.duration_seconds -- never touches storage, embedded file
// metadata, or any other column.
//
// Usage:
//   node src/repairDurations.js          -- apply corrections
//   node src/repairDurations.js --dry-run -- report what would change, without writing
require("dotenv").config();
const db = require("./db");
const { getBuffer } = require("./storage");
const { getRealDurationSeconds } = require("./audioDuration");

function contentTypeFor(storageKey) {
  return storageKey.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";
}

async function run({ dryRun = false } = {}) {
  const { rows: calls } = await db.pool.query(
    `SELECT id, ghl_call_id AS "ghlCallId", storage_key AS "storageKey", duration_seconds AS "durationSeconds"
     FROM calls WHERE storage_key IS NOT NULL ORDER BY occurred_at ASC`
  );

  console.log(`Found ${calls.length} stored recording(s) to check.${dryRun ? " (dry run -- no writes)" : ""}`);

  let corrected = 0;
  let unchanged = 0;
  let unreadable = 0;

  for (const call of calls) {
    let buffer;
    try {
      buffer = await getBuffer(call.storageKey);
    } catch (err) {
      console.error(`  [skip] ${call.ghlCallId}: couldn't read ${call.storageKey} from storage:`, err.message);
      unreadable++;
      continue;
    }
    if (!buffer) {
      console.error(`  [skip] ${call.ghlCallId}: storage key ${call.storageKey} not found`);
      unreadable++;
      continue;
    }

    const real = await getRealDurationSeconds(buffer, contentTypeFor(call.storageKey));
    if (real === null) {
      console.error(`  [skip] ${call.ghlCallId}: recording didn't parse (kept existing value ${call.durationSeconds})`);
      unreadable++;
      continue;
    }

    if (real === call.durationSeconds) {
      unchanged++;
      continue;
    }

    console.log(`  [fix] ${call.ghlCallId}: ${call.durationSeconds ?? "(none)"}s -> ${real}s`);
    if (!dryRun) {
      await db.pool.query(`UPDATE calls SET duration_seconds = $2 WHERE id = $1`, [call.id, real]);
    }
    corrected++;
  }

  console.log(
    `\nDone. ${corrected} corrected, ${unchanged} already correct, ${unreadable} couldn't be read/parsed (left unchanged).`
  );
}

module.exports = { run };

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  run({ dryRun })
    .catch((err) => {
      console.error("[repairDurations] fatal error:", err);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}
