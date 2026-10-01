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
const email = require("./email");

// Frequent enough that "today"'s snapshot reflects something close to
// end-of-day by the time the day turns over, without checking so often
// it's needless DB churn -- this only ever has genuinely new work (a
// month closing out) once a month.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const BYTES_PER_GB = 1024 ** 3;

// Negative-margin safety net: a client whose cumulative AWS cost has
// overtaken their cumulative revenue (see db.listTenantMargins) gets
// flagged promptly instead of waiting for a month-end reconciliation to
// notice -- this is the actual mechanism meant to catch a disproportionately
// high-volume account before it quietly erodes margin for a billing cycle
// or more. Re-sent at most once per cooldown per tenant while it stays
// negative, same reasoning as src/alerting.js's ALERT_COOLDOWN_MS.
const MARGIN_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const marginAlertState = new Map(); // tenantId -> last alerted timestamp
const ALERT_TO = process.env.ALERT_EMAIL_TO;

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

  // Safety-net overage only -- the free allowance (billingRates.js's
  // CLIENT_STORAGE_FREE_GB comment) is sized well above any normal
  // account's real usage, so this is $0 for everyone except a genuine
  // outlier.
  const billableGB = Math.max(0, gb - billingRates.CLIENT_STORAGE_FREE_GB);
  const clientRevenue = billableGB * billingRates.CLIENT_STORAGE_OVERAGE_PER_GB_MONTH;

  await db.recordStorageCost({
    tenantId,
    periodStart: toDateString(periodStart),
    periodEnd: toDateString(periodEnd),
    gbMonths: gb,
    awsRate: billingRates.AWS_S3_STANDARD_PER_GB_MONTH,
    awsCost,
    clientRate: billingRates.CLIENT_STORAGE_OVERAGE_PER_GB_MONTH,
    clientRevenue,
  });
}

async function checkNegativeMargins() {
  if (!email.isEnabled() || !ALERT_TO) return;
  const margins = await db.listTenantMargins();
  const now = Date.now();

  for (const t of margins) {
    const totalCost = Number(t.totalCost);
    const totalRevenue = Number(t.totalRevenue);
    const margin = totalRevenue - totalCost;
    if (margin >= 0) {
      marginAlertState.delete(t.id); // recovered -- next time it goes negative, alert fresh
      continue;
    }

    const lastAlerted = marginAlertState.get(t.id) || 0;
    if (now - lastAlerted < MARGIN_ALERT_COOLDOWN_MS) continue;
    marginAlertState.set(t.id, now);

    try {
      await email.sendEmail({
        to: ALERT_TO,
        subject: `CallTrove alert: "${t.name}" has gone margin-negative`,
        text: `"${t.name}"'s cumulative AWS cost ($${totalCost.toFixed(2)}) has overtaken its cumulative revenue ($${totalRevenue.toFixed(2)}) -- a lifetime margin of $${margin.toFixed(2)}.\n\nWhat this means: this account is now costing more than it's bringing in, across its entire history with CallTrove. Usually means either a genuine high-volume outlier (storage, transcription, or AI summary usage well above a typical account) or a rate that needs revisiting for this client specifically.\n\nCheck Operator > Accounts > "${t.name}" for the breakdown by category.\n\nYou'll get another email like this at most once a day while it stays negative.`,
      });
    } catch (err) {
      console.error(`[storageCost] failed to send negative-margin alert for tenant ${t.id}:`, err);
    }
  }
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

  try {
    await checkNegativeMargins();
  } catch (err) {
    console.error("[storageCost] negative-margin check failed:", err);
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

module.exports = { start, runOnce, lastCompletedMonth, checkNegativeMargins };
