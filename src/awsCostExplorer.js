// Real, full AWS spend across every service this account is billed for --
// EC2, RDS, VPC, tax, everything. Deliberately separate from cost_ledger
// (src/routes/operator.js's per-tenant totals): cost_ledger tracks
// specific, per-tenant-attributable usage events (a transcription job, a
// Bedrock call, a GB-month of storage), each billed to a specific tenant.
// Most of a real AWS bill isn't that -- the EC2 instance and RDS database
// cost the same whether one call or ten thousand happen, and there's no
// natural way to split "$7 of database" across tenants -- so this exists
// to show the real total bill honestly, without pretending it's
// attributable to any one account.
//
// Requires the server's own IAM role to have ce:GetCostAndUsage -- added
// and confirmed working directly against production. getCostSummary's
// forecast figure additionally needs ce:GetCostForecast, a SEPARATE
// action the same role does not yet have (confirmed directly too) --
// that one piece degrades to null with a clear reason rather than
// failing the whole summary.
//
// Cost Explorer's API only exists in us-east-1 regardless of where
// anything else runs -- hardcoded, not read from S3_REGION/BEDROCK_REGION
// like every other AWS client in this app, since this one genuinely has
// no regional equivalent. Each Cost Explorer call also costs AWS $0.01,
// and the underlying billing data itself lags up to 24h, so everything
// here is cached rather than refetched on every dashboard load -- loading
// the page ten times in an hour should cost a few cents, not tens.

const CACHE_MS = 6 * 60 * 60 * 1000; // 6h -- see the comment above on why more often buys nothing
let serviceCache = null; // { fetchedAt, data } -- getMonthToDateSpend's per-service breakdown
let summaryCache = null; // { fetchedAt, data } -- getCostSummary's four headline figures

let ceClient;
function getClient() {
  if (!ceClient) {
    const { CostExplorerClient } = require("@aws-sdk/client-cost-explorer");
    ceClient = new CostExplorerClient({ region: "us-east-1" });
  }
  return ceClient;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Throws on failure (an AccessDeniedException until the IAM policy is
// added, or any other AWS/network error) -- the caller (routes/operator.js)
// turns that into a clear, specific error response rather than ever
// showing a stale or fabricated number.
async function getMonthToDateSpend() {
  if (serviceCache && Date.now() - serviceCache.fetchedAt < CACHE_MS) {
    return serviceCache.data;
  }

  const now = new Date();
  const start = isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const end = isoDate(now);

  // Cost Explorer requires Start strictly before End -- on the 1st of the
  // month (before any usage this month has even posted yet), they'd be
  // equal, which it rejects. An empty, genuinely-accurate result for "no
  // spend recorded yet this month" rather than erroring the whole page.
  if (end <= start) {
    const empty = { start, end, services: [], total: 0 };
    serviceCache = { fetchedAt: Date.now(), data: empty };
    return empty;
  }

  const { GetCostAndUsageCommand } = require("@aws-sdk/client-cost-explorer");
  const res = await getClient().send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    })
  );

  const period = res.ResultsByTime && res.ResultsByTime[0];
  const groups = (period && period.Groups) || [];
  const services = groups
    .map((g) => ({ name: g.Keys[0], cost: Number(g.Metrics.UnblendedCost.Amount) }))
    // AWS returns a row for every service in the account's history, most
    // at exactly 0 this month -- not worth showing a long list of zeroes.
    .filter((s) => s.cost > 0.00001)
    .sort((a, b) => b.cost - a.cost);
  const total = services.reduce((sum, s) => sum + s.cost, 0);

  const data = { start, end, services, total };
  serviceCache = { fetchedAt: Date.now(), data };
  return data;
}

// Daily UnblendedCost totals (no service breakdown) over [start, end) --
// shared by getCostSummary for both "last month, same number of days" and
// "last month, whole month": one DAILY-granularity call covering the
// entire previous month costs the same $0.01 as a single MONTHLY one, and
// summing a prefix of the days client-side avoids a second real API call
// (and its own $0.01) just to get the shorter range.
async function getDailyCosts(start, end) {
  const { GetCostAndUsageCommand } = require("@aws-sdk/client-cost-explorer");
  const res = await getClient().send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: isoDate(start), End: isoDate(end) },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
    })
  );
  return (res.ResultsByTime || []).map((r) => Number(r.Total.UnblendedCost.Amount));
}

// The four headline figures AWS's own Billing console shows on its "Cost
// summary" widget -- pulled here so the same numbers are visible inside
// CallTrove itself rather than only in the AWS console. monthToDate reuses
// getMonthToDateSpend's own cache (same number, no extra charge for it).
async function getCostSummary() {
  if (summaryCache && Date.now() - summaryCache.fetchedAt < CACHE_MS) {
    return summaryCache.data;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const curMonthStart = new Date(Date.UTC(year, month, 1));
  const prevMonthStart = new Date(Date.UTC(year, month - 1, 1));
  const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // How many full days have elapsed so far this month (End is exclusive,
  // so "today" itself isn't counted yet) -- the same day-count applied to
  // last month is what AWS's own "same time period" comparison means.
  const daysElapsedThisMonth = Math.min(now.getUTCDate() - 1, daysInPrevMonth);

  const { total: monthToDate } = await getMonthToDateSpend();

  let lastMonthSamePeriod = 0;
  let lastMonthTotal = 0;
  let lastMonthSamePeriodLabel = null;
  if (daysElapsedThisMonth > 0) {
    const dailyCosts = await getDailyCosts(prevMonthStart, curMonthStart);
    lastMonthTotal = dailyCosts.reduce((sum, c) => sum + c, 0);
    lastMonthSamePeriod = dailyCosts.slice(0, daysElapsedThisMonth).reduce((sum, c) => sum + c, 0);
    const label = MONTH_NAMES[prevMonthStart.getUTCMonth()];
    lastMonthSamePeriodLabel = daysElapsedThisMonth === 1 ? `${label} 1` : `${label} 1 – ${daysElapsedThisMonth}`;
  }

  // Forecast for the rest of this month (today onward) added to
  // monthToDate (which excludes today, same boundary as above) gives
  // "total forecasted cost for current month" -- the same framing AWS's
  // own console uses. Needs ce:GetCostForecast specifically, which this
  // server's role doesn't have as of this writing -- degrades to null
  // with a clear reason rather than failing the other three real figures.
  let forecastTotal = null;
  let forecastError = null;
  try {
    const nextMonthStart = new Date(Date.UTC(year, month + 1, 1));
    const forecastStart = isoDate(now);
    const forecastEnd = isoDate(nextMonthStart);
    if (forecastEnd > forecastStart) {
      const { GetCostForecastCommand } = require("@aws-sdk/client-cost-explorer");
      const res = await getClient().send(
        new GetCostForecastCommand({
          TimePeriod: { Start: forecastStart, End: forecastEnd },
          Metric: "UNBLENDED_COST",
          Granularity: "MONTHLY",
        })
      );
      const restOfMonth = Number((res.Total && res.Total.Amount) || 0);
      forecastTotal = monthToDate + restOfMonth;
    } else {
      // Last day of the month -- nothing left to forecast.
      forecastTotal = monthToDate;
    }
  } catch (err) {
    forecastError =
      err.name === "AccessDeniedException" || /AccessDenied/i.test(err.message || "")
        ? "Forecast needs a separate permission (ce:GetCostForecast) not yet granted."
        : "Could not fetch the forecast.";
  }

  const data = { monthToDate, lastMonthSamePeriod, lastMonthSamePeriodLabel, lastMonthTotal, forecastTotal, forecastError };
  summaryCache = { fetchedAt: Date.now(), data };
  return data;
}

module.exports = { getMonthToDateSpend, getCostSummary };
