// Monthly storage cost -- writes one cost_ledger row per tenant for each
// calendar month once it's fully over (see schema.sql's cost_ledger
// comment for why this is a permanent receipt, not a live estimate, and
// why storage specifically has no client_revenue: no storage rate has
// ever been agreed with clients, only transcription and AI summary).
//
// Approximation, stated plainly: AWS actually bills S3 storage on a
// daily-average basis across the month, but nothing in this app records
// byte-count history over time -- only "what's stored right now" (calls.
// size_bytes, summed in db.getTotalStoredBytesForTenant). So this job
// takes a snapshot of what's stored at the moment it runs (shortly after
// the month ends) and treats that as the whole month's figure. For a
// call-recording archive that's almost entirely additive (recordings
// basically only get added, not deleted, outside of a full tenant purge
// -- see src/tenantPurge.js), the snapshot right after month-end is a
// reasonable stand-in for the month's average, not an exact figure.
//
// Idempotent by design, not by a separate "already ran" check: every
// attempt to record the same tenant+period is a no-op past the first
// (cost_ledger_storage_period_idx's unique index, see
// db.recordStorageCost), so this can simply try every tenant every cycle
// without tracking state of its own. That also means a late deploy
// immediately catches up on any already-completed month it missed.
const db = require("./db");
const alerting = require("./alerting");
const billingRates = require("./billingRates");

// No need for anything finer than a few times a day -- this only ever
// has new work to do once a month, right after it turns over.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const BYTES_PER_GB = 1024 ** 3;

// The most recently fully-completed calendar month as of `now`, as a
// [periodStart, periodEnd) pair of UTC dates -- e.g. if `now` is any time
// in March, this returns February 1 through March 1.
function lastCompletedMonth(now) {
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 1, 1));
  return { periodStart, periodEnd };
}

function toDateString(d) {
  return d.toISOString().slice(0, 10);
}

async function runOnce(now = new Date()) {
  const { periodStart, periodEnd } = lastCompletedMonth(now);
  const tenantIds = await db.listAllTenantIds();

  for (const tenantId of tenantIds) {
    try {
      const totalBytes = await db.getTotalStoredBytesForTenant(tenantId);
      const gb = totalBytes / BYTES_PER_GB;
      const awsCost = gb * billingRates.AWS_S3_STANDARD_PER_GB_MONTH;
      await db.recordStorageCost({
        tenantId,
        periodStart: toDateString(periodStart),
        periodEnd: toDateString(periodEnd),
        gbMonths: gb,
        awsRate: billingRates.AWS_S3_STANDARD_PER_GB_MONTH,
        awsCost,
      });
    } catch (err) {
      console.error(`[storageCost] failed to record storage cost for tenant ${tenantId}:`, err);
    }
  }
}

function start() {
  console.log(`[storageCost] starting, checking every ${CHECK_INTERVAL_MS / (60 * 60 * 1000)}h for a completed month to record`);
  async function cycle() {
    try {
      await runOnce();
      alerting.recordSuccess("storage cost ledger");
    } catch (err) {
      console.error("[storageCost] cycle failed:", err);
      await alerting.recordFailure("storage cost ledger", err).catch(() => {});
    }
    setTimeout(cycle, CHECK_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, runOnce, lastCompletedMonth };
