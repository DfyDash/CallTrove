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

// Usage-cost safety net: a client whose cumulative AWS usage cost has
// overtaken the cumulative PER-USE revenue tracked for that same usage
// (see db.listTenantMargins) gets flagged promptly instead of waiting for
// a month-end reconciliation to notice -- this is the actual mechanism
// meant to catch a disproportionately high-volume account before it
// quietly erodes margin for a billing cycle or more. Deliberately NOT a
// true profit/loss check: there's no base-subscription-fee tracking in
// this system yet (see routes/admin.js's /billing comment), so this only
// ever compares AWS cost against the metered transcription/AI-summary/
// storage-overage markup -- a profitable subscriber can still trip this
// if their usage alone outpaces that markup, which is exactly why the
// alert email says so explicitly rather than calling it "unprofitable".
// Re-sent at most once per cooldown per tenant while it stays
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
  // Sub-period proration across whichever tier(s) were actually active
  // during this period -- NOT just "storageTier" (the tenant's CURRENT
  // tier, passed in only for the no-daily-history fallback below), and
  // deliberately NOT a single blended free-GB allowance applied to the
  // whole period's overall average either (an earlier version of this
  // function did that -- it's simpler but can be off by several times
  // the correct charge, since it compares the *whole month's* usage
  // against a blended ceiling instead of judging each tier's own days on
  // their own terms). Each tier's days are judged against that tier's
  // own free allowance, using the average usage during just those days,
  // then prorated to that tier's share of the period before applying its
  // $/GB-month rate -- the rate is inherently a full-month rate, so X
  // days of overage is X/totalDays of a GB-month, not a whole one. See
  // schema.sql's comment on daily_storage_snapshots.storage_tier for the
  // original bug (one tier applied to the whole period) this replaced.
  let clientRevenue;
  let effectiveRate; // day-weighted, informational only -- see below
  if (usingFallback) {
    // No daily history at all for this period -- can't prorate by day,
    // so fall back to the tenant's current tier against the whole
    // period's estimated usage, same approximation this whole branch
    // already represents. clientRevenue stays null regardless (see the
    // comment above on why a fallback figure is never a safe real charge).
    clientRevenue = null;
    effectiveRate = billingRates.storageTier(storageTier).overagePerGbMonth;
  } else {
    const byTier = await db.getStorageStatsByTierForTenantPeriod(tenantId, toDateString(periodStart), toDateString(periodEnd));
    const totalDays = byTier.reduce((sum, row) => sum + row.days, 0) || 1;
    let revenue = 0;
    let weightedRate = 0;
    for (const row of byTier) {
      const rowTier = billingRates.storageTier(row.tier);
      const gbThisTier = Number(row.avgBytes) / BYTES_PER_GB;
      const overageGbThisTier = Math.max(0, gbThisTier - rowTier.freeGB);
      const monthFraction = row.days / totalDays;
      revenue += overageGbThisTier * rowTier.overagePerGbMonth * monthFraction;
      weightedRate += rowTier.overagePerGbMonth * monthFraction;
    }
    clientRevenue = revenue;
    effectiveRate = weightedRate;
  }

  await db.recordStorageCost({
    tenantId,
    periodStart: toDateString(periodStart),
    periodEnd: toDateString(periodEnd),
    gbMonths: gb,
    awsRate: billingRates.AWS_S3_STANDARD_PER_GB_MONTH,
    awsCost,
    // A day-weighted average of whichever tier rate(s) applied -- stored
    // for display/reference only (schema.sql's cost_ledger.client_rate
    // has no other consumer that does math with it). The real charge is
    // clientRevenue above, computed per-tier, not derived from this rate.
    clientRate: effectiveRate,
    clientRevenue,
  });
}

async function checkNegativeMargins() {
  if (!email.isEnabled() || !ALERT_TO) {
    console.log("[storageCost] would check AWS-cost-vs-usage-revenue gaps, but email isn't configured (ALERT_EMAIL_TO/Resend) -- skipping");
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
        subject: `CallTrove: "${t.name}"'s AWS usage cost is outpacing its per-use revenue`,
        text: `"${t.name}"'s cumulative AWS usage cost ($${totalCost.toFixed(2)}) is higher than the per-use revenue tracked for that same usage ($${totalRevenue.toFixed(2)}) -- a gap of $${Math.abs(margin).toFixed(2)}.\n\nThis is NOT the account's overall profit or loss -- it only compares AWS cost (storage, transcription, AI summaries) against the per-use markup charged on those same things. It does not include any base subscription fee, since that isn't tracked in this system yet. A real paying customer can show up here and still be profitable overall once their subscription is counted.\n\nWhat it usually means: a genuine high-volume outlier (storage, transcription, or AI summary usage well above a typical account) or a per-use rate that needs revisiting for this client specifically.\n\nCheck Operator > Accounts > "${t.name}" for the breakdown by category.\n\nYou'll get another email like this at most once a day while the gap stays open.`,
      });
      // Only start the cooldown once the send actually succeeded -- a
      // failed send (SES throttling, network blip) should retry next
      // cycle, not go quiet on a tenant with a genuine cost-vs-revenue gap for up
      // to 24h with no email ever delivered.
      marginAlertState.set(t.id, now);
    } catch (err) {
      console.error(`[storageCost] failed to send usage-cost alert for tenant ${t.id}:`, err);
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
    console.error("[storageCost] usage-cost-vs-revenue check failed:", err);
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

module.exports = { start, runOnce, lastCompletedMonth, checkNegativeMargins, recordMonthlyCostIfDue };
