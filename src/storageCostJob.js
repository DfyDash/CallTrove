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

async function recordTodaysSnapshot(tenantId, now, storageTier) {
  const totalBytes = await db.getTotalStoredBytesForTenant(tenantId);
  await db.upsertDailyStorageSnapshot(tenantId, toDateString(now), totalBytes, storageTier);
}

async function recordMonthlyCostIfDue(tenantId, storageTier, periodStart, periodEnd) {
  const { avgBytes, dayCount } = await db.getAverageStoredBytesForTenantPeriod(
    tenantId,
    toDateString(periodStart),
    toDateString(periodEnd)
  );

  // dayCount > 0 means real daily history exists for this period -- use
  // its true average. Otherwise (no daily snapshots cover this month at
  // all) fall back to a current-bytes snapshot, same approximation this
  // job used before daily history existed -- fine for awsCost (an
  // internal estimate either way), but NOT a safe basis for a real
  // client charge: "today" can be far from this past period's actual
  // average, and db.recordStorageCost is write-once (ON CONFLICT DO
  // NOTHING), so a wrong overage charge here could never be corrected
  // later. clientRevenue stays null in that case, same convention as
  // schema.sql's "pre-policy entries keep NULL (not 0)".
  const usingFallback = dayCount === 0;
  const bytesBasis = usingFallback ? await db.getTotalStoredBytesForTenant(tenantId) : Number(avgBytes);

  const gb = bytesBasis / BYTES_PER_GB;
  const awsCost = gb * billingRates.AWS_S3_STANDARD_PER_GB_MONTH;

  // Safety-net overage only, against THIS tenant's own tier (billingRates.js's
  // STORAGE_TIERS comment) -- sized well above any normal account's real
  // usage either way, so this is $0 for everyone except a genuine outlier.
  //
  // Day-weighted blend across whichever tier(s) were actually active
  // during this period -- NOT just "storageTier" (the tenant's CURRENT
  // tier, passed in only for the no-daily-history fallback below). A
  // tenant who switched tiers mid-period spent some days under one
  // tier's free-GB allowance and rate, some under the other's; applying
  // one tier to the whole period's average would misprice every day
  // spent on the other tier. See schema.sql's comment on
  // daily_storage_snapshots.storage_tier for the bug this replaced.
  let freeGB;
  let overagePerGbMonth;
  if (usingFallback) {
    // No daily history at all for this period -- can't blend by day,
    // so fall back to the tenant's current tier, same approximation
    // this whole branch already represents (clientRevenue stays null
    // regardless, per the comment above).
    const tier = billingRates.storageTier(storageTier);
    freeGB = tier.freeGB;
    overagePerGbMonth = tier.overagePerGbMonth;
  } else {
    const byTier = await db.getStorageDaysByTierForTenantPeriod(tenantId, toDateString(periodStart), toDateString(periodEnd));
    const totalDays = byTier.reduce((sum, row) => sum + row.days, 0) || 1;
    freeGB = 0;
    overagePerGbMonth = 0;
    for (const row of byTier) {
      const rowTier = billingRates.storageTier(row.tier);
      const weight = row.days / totalDays;
      freeGB += rowTier.freeGB * weight;
      overagePerGbMonth += rowTier.overagePerGbMonth * weight;
    }
  }
  const billableGB = Math.max(0, gb - freeGB);
  const clientRevenue = usingFallback ? null : billableGB * overagePerGbMonth;

  await db.recordStorageCost({
    tenantId,
    periodStart: toDateString(periodStart),
    periodEnd: toDateString(periodEnd),
    gbMonths: gb,
    awsRate: billingRates.AWS_S3_STANDARD_PER_GB_MONTH,
    awsCost,
    clientRate: overagePerGbMonth,
    clientRevenue,
  });
}

async function checkNegativeMargins() {
  if (!email.isEnabled() || !ALERT_TO) {
    console.log("[storageCost] would check negative margins, but email isn't configured (ALERT_EMAIL_TO/Resend) -- skipping");
    return;
  }
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

    try {
      await email.sendEmail({
        to: ALERT_TO,
        subject: `CallTrove alert: "${t.name}" has gone margin-negative`,
        text: `"${t.name}"'s cumulative AWS cost ($${totalCost.toFixed(2)}) has overtaken its cumulative revenue ($${totalRevenue.toFixed(2)}) -- a lifetime margin of $${margin.toFixed(2)}.\n\nWhat this means: this account is now costing more than it's bringing in, across its entire history with CallTrove. Usually means either a genuine high-volume outlier (storage, transcription, or AI summary usage well above a typical account) or a rate that needs revisiting for this client specifically.\n\nCheck Operator > Accounts > "${t.name}" for the breakdown by category.\n\nYou'll get another email like this at most once a day while it stays negative.`,
      });
      // Only start the cooldown once the send actually succeeded -- a
      // failed send (SES throttling, network blip) should retry next
      // cycle, not go quiet on a genuinely negative-margin tenant for up
      // to 24h with no email ever delivered.
      marginAlertState.set(t.id, now);
    } catch (err) {
      console.error(`[storageCost] failed to send negative-margin alert for tenant ${t.id}:`, err);
    }
  }
}

async function runOnce(now = new Date()) {
  const { periodStart, periodEnd } = lastCompletedMonth(now);
  const tenants = await db.listActiveTenants();

  for (const { id: tenantId, storageTier } of tenants) {
    try {
      await recordTodaysSnapshot(tenantId, now, storageTier);
    } catch (err) {
      console.error(`[storageCost] failed to record today's snapshot for tenant ${tenantId}:`, err);
    }
    try {
      await recordMonthlyCostIfDue(tenantId, storageTier, periodStart, periodEnd);
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
