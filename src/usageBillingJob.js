// Monthly usage billing, the way AWS bills us: once a calendar month (UTC)
// is over, add up what each subscribed tenant used that month (the
// client_revenue on their cost_ledger rows -- transcription, AI summaries,
// transcript cleanup, storage overage) and send it to Paddle as one
// one-time charge on their subscription. Runs hourly and is idempotent:
// ledger rows are claimed for an invoice before the Paddle call (see
// db.claimUsageForInvoice), so a repeat cycle finds nothing left to bill.
//
// Two triggers, so nobody can run up a big unpaid bill before we find out
// their card doesn't work:
//   - threshold: as soon as a tenant's unbilled usage reaches
//     USAGE_BILLING_THRESHOLD_USD (default $20), charge it now.
//   - month end: whatever is left from a finished month is charged if it
//     is at least USAGE_BILLING_MIN_USD (default $1) -- Paddle takes a fee
//     per charge, so tiny amounts roll into the next invoice.
// If a card fails, Paddle marks the subscription past_due (webhook ->
// src/paddle.js), and db.usageAllowed then pauses the paid features until
// it's paid, so what we're exposed to is about one threshold's worth.
const { randomUUID } = require("crypto");
const db = require("./db");
const paddleModule = require("./paddle");

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function usdToCents(envName, fallback) {
  const usd = Number(process.env[envName]);
  return Math.round((Number.isFinite(usd) && usd >= 0 ? usd : fallback) * 100);
}
const minCents = () => usdToCents("USAGE_BILLING_MIN_USD", 1);
const thresholdCents = () => usdToCents("USAGE_BILLING_THRESHOLD_USD", 20);

// First instant of the current UTC month: everything before it is a
// finished month.
function currentMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function periodLabel(cutoff) {
  const last = new Date(cutoff.getTime() - 1);
  return `${MONTHS[last.getUTCMonth()]} ${last.getUTCFullYear()}`;
}

function dateLabel(d) {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

async function runOnce(now = new Date(), client = paddleModule.paddle()) {
  if (!client || !paddleModule.billingEnabled()) return [];
  const monthStart = currentMonthStart(now);
  const results = [];
  // Finished months first, then anything over the threshold right now.
  const passes = [
    { cutoff: monthStart, label: periodLabel(monthStart), minCents: minCents() },
    { cutoff: now, label: `${dateLabel(now)}`, minCents: Math.max(thresholdCents(), 1) },
  ];
  for (const pass of passes) {
    for (const t of await db.listTenantsWithUnbilledUsage(pass.cutoff)) {
      const charged = await chargeTenant(client, t, pass);
      if (charged) results.push(charged);
    }
  }
  return results;
}

async function chargeTenant(client, t, { cutoff, label, minCents: min }) {
  const invoiceId = randomUUID();
  let claim;
  try {
    claim = await db.claimUsageForInvoice({ invoiceId, tenantId: t.tenantId, cutoff, periodLabel: label, minCents: min });
  } catch (err) {
    console.error(`[usageBilling] could not claim usage for tenant ${t.tenantId}:`, err);
    return null;
  }
  if (!claim) return null;
  try {
    await client.subscriptions.createOneTimeCharge(t.subscriptionId, {
      effectiveFrom: "immediately",
      onPaymentFailure: "apply_change",
      items: [
        {
          quantity: 1,
          price: {
            name: "CallTrove usage",
            description: `CallTrove usage through ${label}`,
            unitPrice: { amount: String(claim.amountCents), currencyCode: "USD" },
            product: { name: "CallTrove usage", description: "Transcription, AI summaries and storage", taxCategory: "saas" },
          },
        },
      ],
    });
  } catch (err) {
    console.error(`[usageBilling] Paddle charge failed for tenant ${t.tenantId}, will retry next cycle:`, err);
    await db.releaseUsageInvoice(invoiceId).catch((e) => console.error("[usageBilling] could not release claim:", e));
    return null;
  }
  await db.markUsageInvoiceCharged(invoiceId).catch((e) =>
    console.error(`[usageBilling] charged tenant ${t.tenantId} (invoice ${invoiceId}) but could not mark it charged -- check by hand, do NOT re-bill:`, e)
  );
  console.log(`[usageBilling] charged tenant ${t.tenantId} $${(claim.amountCents / 100).toFixed(2)} for ${label}`);
  return { tenantId: t.tenantId, amountCents: claim.amountCents };
}

function start() {
  if (!paddleModule.billingEnabled()) {
    console.log("[usageBilling] disabled (Paddle billing not configured)");
    return;
  }
  console.log("[usageBilling] starting, checking hourly (charges at the usage threshold and after each month ends)");
  const cycle = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("[usageBilling] cycle failed:", err);
    }
  };
  setTimeout(cycle, 60 * 1000);
  setInterval(cycle, CHECK_INTERVAL_MS);
}

module.exports = { start, runOnce, currentMonthStart, periodLabel };
