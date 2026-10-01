// Storage history + cost -- two jobs in one cycle:
//
//   1. Daily snapshot: every cycle, record each tenant's current total
//      stored bytes as "today"'s reading (db.upsertDailyStorageSnapshot).
//      Upserted, not insert-once, so the figure stays fresh through the
//      day; once a day turns over, that day's row is never touched again
//      (see schema.sql's comment on daily_storage_snapshots).
//   2. Monthly cost: once a calendar month is fully over, write that
//      tenant's 'storage' cost_ledger entry (see schema.sql's cost_ledger
//      comment -- a permanent receipt, not a live estimate) computed from
//      the REAL daily average across that month, now that daily history
//      exists -- true to how AWS actually bills S3 (an average over the
//      month), not the single end-of-month snapshot this replaced. If no
//      daily snapshots exist for that period at all (an older month, or
//      the transition month this feature was deployed mid-way through),
//      this falls back to that same end-of-month-snapshot approximation
//      rather than writing nothing -- clearly worse data is still better
//      than no data, and it's the best this job can do without a time
//      machine.
//
// Idempotent by design, not by a separate "already ran" check: both
// db.upsertDailyStorageSnapshot (unique on tenant+date) and
// db.recordStorageCost (unique on tenant+period, see
// cost_ledger_storage_period_idx) make a repeat attempt a no-op, so this
// can simply try every tenant every cycle without tracking state of its
// own.
const db = require("./db");
const alerting = require("./alerting");
const billingRates = require("./billingRates");

// Frequent enough that "today"'s snapshot reflects something close to
// end-of-day by the time the day turns over, without checking so often
// it's needless DB churn -- this only ever has genuinely new work (a
// month closing out) once a month.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

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

async function recordTodaysSnapshot(tenantId, now) {
  const totalBytes = await db.getTotalStoredBytesForTenant(tenantId);
  await db.upsertDailyStorageSnapshot(tenantId, toDateString(now), totalBytes);
}

async function recordMonthlyCostIfDue(tenantId, periodStart, periodEnd) {
  const { avgBytes, dayCount } = await db.getAverageStoredBytesForTenantPeriod(
    tenantId,
    toDateString(periodStart),
    toDateString(periodEnd)
  );

  // dayCount > 0 means real daily history exists for this period -- use
  // its true average. Otherwise (no daily snapshots cover this month at
  // all) fall back to a current-bytes snapshot, same approximation this
  // job used before daily history existed.
  const bytesBasis = dayCount > 0 ? Number(avgBytes) : await db.getTotalStoredBytesForTenant(tenantId);

  const gb = bytesBasis / BYTES_PER_GB;
  const awsCost = gb * billingRates.AWS_S3_STANDARD_PER_GB_MONTH;
  await db.recordStorageCost({
    tenantId,
    periodStart: toDateString(periodStart),
    periodEnd: toDateString(periodEnd),
    gbMonths: gb,
    awsRate: billingRates.AWS_S3_STANDARD_PER_GB_MONTH,
    awsCost,
  });
}

async function runOnce(now = new Date()) {
  const { periodStart, periodEnd } = lastCompletedMonth(now);
  const tenantIds = await db.listAllTenantIds();

  for (const tenantId of tenantIds) {
    try {
      await recordTodaysSnapshot(tenantId, now);
    } catch (err) {
      console.error(`[storageCost] failed to record today's snapshot for tenant ${tenantId}:`, err);
    }
    try {
      await recordMonthlyCostIfDue(tenantId, periodStart, periodEnd);
    } catch (err) {
      console.error(`[storageCost] failed to record storage cost for tenant ${tenantId}:`, err);
    }
  }
}

function start() {
  console.log(`[storageCost] starting, checking every ${CHECK_INTERVAL_MS / (60 * 60 * 1000)}h (daily snapshot + completed-month cost)`);
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
