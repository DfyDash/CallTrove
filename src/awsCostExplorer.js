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
// Requires the server's own IAM role to have ce:GetCostAndUsage, which is
// NOT granted by default -- confirmed directly against production that
// the role (call-recording-vault-ssm-role) doesn't have it yet. This
// throws a clear AccessDeniedException until that's added; see the IAM
// policy shipped alongside this file's introduction.
//
// Cost Explorer's API only exists in us-east-1 regardless of where
// anything else runs -- hardcoded, not read from S3_REGION/BEDROCK_REGION
// like every other AWS client in this app, since this one genuinely has
// no regional equivalent. Each GetCostAndUsage call also costs AWS $0.01,
// and the underlying billing data itself lags up to 24h, so this is
// cached rather than refetched on every dashboard load -- loading the
// page ten times in an hour should cost one cent, not ten.

const CACHE_MS = 6 * 60 * 60 * 1000; // 6h -- see the comment above on why more often buys nothing
let cache = null; // { fetchedAt, data }

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

// Throws on failure (an AccessDeniedException until the IAM policy is
// added, or any other AWS/network error) -- the caller (routes/operator.js)
// turns that into a clear, specific error response rather than ever
// showing a stale or fabricated number.
async function getMonthToDateSpend() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) {
    return cache.data;
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
    cache = { fetchedAt: Date.now(), data: empty };
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
  cache = { fetchedAt: Date.now(), data };
  return data;
}

module.exports = { getMonthToDateSpend };
