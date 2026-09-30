const db = require("./db");
const callDigestNarrative = require("./callDigestNarrative");

// Twice a day, not tied to a specific wall-clock time -- see schema.sql's
// comment on call_digests for why this is a scheduled snapshot rather than
// computed live (the narrative is a real Bedrock call). 12h rather than a
// cron-style "8am/8pm" keeps this on the same self-rescheduling setTimeout
// pattern every other background job in this app already uses (poller.js,
// transcriptionPoller.js, callSummaryPoller.js), with no dependency on
// wall-clock alignment or the process having been up since midnight.
const RUN_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function runOnce() {
  const accounts = await db.listGhlAccountsNeedingDigest();
  for (const account of accounts) {
    try {
      const stats = await db.computeCallDigestStats(account.id);
      let narrative = null;
      if (callDigestNarrative.isEnabled()) {
        try {
          narrative = await callDigestNarrative.generateNarrative(stats);
        } catch (err) {
          // The real numbers are still worth saving even if the one-line
          // synthesis on top fails -- see schema.sql's comment on
          // call_digests.narrative being nullable.
          console.error(`[callDigest] account ${account.id} (${account.name}): narrative generation failed:`, err);
        }
      }
      await db.saveCallDigest({ ghlAccountId: account.id, stats, narrative });
      console.log(`[callDigest] computed digest for account ${account.id} (${account.name})`);
    } catch (err) {
      console.error(`[callDigest] account ${account.id} (${account.name}): failed to compute digest:`, err);
    }
  }
}

function start() {
  console.log(`[callDigest] starting, computing every ${RUN_INTERVAL_MS / 3600000}h`);
  async function cycle() {
    try {
      await runOnce();
    } catch (err) {
      console.error("[callDigest] run cycle failed:", err);
    }
    setTimeout(cycle, RUN_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, runOnce };
