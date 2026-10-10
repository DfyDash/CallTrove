// Paddle billing: signed-webhook receiver + checkout config. Webhooks (not
// polling) so a subscription change lands within seconds. Nothing here
// gates the app -- it only records subscription state on the tenant.
//
// Env: PADDLE_API_KEY (server secret), PADDLE_WEBHOOK_SECRET (endpoint
// secret key), PADDLE_CLIENT_TOKEN (public, used by Paddle.js in the
// browser), PADDLE_PRICE_ID (standard plan, $25/mo), PADDLE_PRICE_ID_HIPAA
// (HIPAA plan, $30/mo), PADDLE_ENV
// ("sandbox" | "production", default sandbox).
const { Paddle, Environment } = require("@paddle/paddle-node-sdk");
const db = require("./db");

const ENV = process.env.PADDLE_ENV === "production" ? "production" : "sandbox";
const HANDLED = new Set(["subscription.created", "subscription.updated", "subscription.activated", "subscription.canceled", "subscription.paused", "subscription.resumed", "subscription.past_due", "subscription.trialing"]);

let client = null;
function paddle() {
  if (!process.env.PADDLE_API_KEY) return null;
  if (!client) client = new Paddle(process.env.PADDLE_API_KEY, { environment: ENV === "production" ? Environment.production : Environment.sandbox });
  return client;
}

// Public values the browser needs to open Paddle's hosted checkout.
// Billing is on once the client token and the standard price are set. A
// HIPAA tenant with no HIPAA price configured gets priceId null (the
// onboarding page says pricing is unavailable) rather than the wrong plan.
function billingEnabled() {
  return !!(process.env.PADDLE_CLIENT_TOKEN && process.env.PADDLE_PRICE_ID);
}
function checkoutConfig(hipaa = false) {
  if (!billingEnabled()) return null;
  const priceId = hipaa ? process.env.PADDLE_PRICE_ID_HIPAA : process.env.PADDLE_PRICE_ID;
  const priceLabel = hipaa ? process.env.PADDLE_PRICE_LABEL_HIPAA || "$30/month" : process.env.PADDLE_PRICE_LABEL || "$25/month";
  return { environment: ENV, clientToken: process.env.PADDLE_CLIENT_TOKEN, priceId: priceId || null, priceLabel };
}

async function accountForPendingSignup(pendingId, status, req) {
  const pending = await db.getPendingSignup(pendingId);
  if (!pending) return null;
  if (pending.consumedTenantId) return pending.consumedTenantId;
  if (status !== "active" && status !== "trialing") return null;
  const result = await db.createAccountFromPendingSignup(pendingId);
  if (result.status === "email_taken") {
    console.error(`[paddle] PAID BUT NO ACCOUNT: sign-up ${pendingId} paid, but ${pending.email} already has a login. Needs a manual look (refund or merge).`);
    return null;
  }
  if (result.status !== "created" && result.status !== "exists") return null;
  if (result.status === "created") {
    try {
      const email = require("./email");
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const verifyUrl = `${baseUrl}/auth/verify-email?token=${encodeURIComponent(require("./emailVerifyToken").createEmailVerifyToken(result.userId, result.email))}`;
      await email.sendEmail({
        to: result.email,
        subject: `Welcome to CallTrove, ${result.firstName}`,
        text: `Your CallTrove account is ready.\n\nFirst, confirm your email address (it lets you reset your password if you forget it): ${verifyUrl}\n\nSign in at ${baseUrl}/login.html with your email address (${result.email}).\n\nNext step: connect your GoHighLevel account from Settings so your calls start syncing.`,
        html: email.welcomeEmailHtml(result.email, { baseUrl, firstName: result.firstName, verifyUrl }),
      });
    } catch (err) {
      console.error("[paddle] account created but welcome email failed:", err.message);
    }
  }
  return result.tenantId;
}

// Express handler; mounted with express.raw() because the signature is
// computed over the exact bytes Paddle sent.
async function webhookHandler(req, res) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const sdk = paddle();
  if (!secret || !sdk) return res.status(503).json({ error: "billing not configured" });
  const signature = req.get("paddle-signature");
  if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: "bad request" });
  let valid = false;
  try {
    valid = await sdk.webhooks.isSignatureValid(req.body.toString("utf8"), secret, signature);
  } catch (err) {
    valid = false;
  }
  if (!valid) return res.status(400).json({ error: "invalid signature" });
  // Parse the raw JSON ourselves (rather than the SDK's typed event models)
  // so an unfamiliar field in a signed event can't turn into a retry loop.
  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    return res.status(400).json({ error: "bad json" });
  }
  try {
    if (event && HANDLED.has(event.event_type)) {
      const d = event.data || {};
      const cd = d.custom_data || {};
      let tenantId = cd.tenantId;
      // A brand-new sign-up: the first confirmed payment is what creates
      // the account. Later events carry the same id and map to it.
      if (!tenantId && cd.pendingSignupId && /^[0-9a-f-]{36}$/i.test(cd.pendingSignupId)) {
        tenantId = await accountForPendingSignup(cd.pendingSignupId, d.status, req);
      }
      if (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId)) {
        await db.applyPaddleSubscriptionEvent({
          eventId: event.event_id,
          eventType: event.event_type,
          occurredAt: event.occurred_at,
          tenantId,
          customerId: d.customer_id || null,
          subscriptionId: d.id,
          status: d.status,
          periodEnd: (d.current_billing_period && d.current_billing_period.ends_at) || null,
        });
      }
    }
      return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Paddle webhook failed:", err.message);
    return res.status(500).json({ error: "retry" });
  }
}

module.exports = { webhookHandler, checkoutConfig, billingEnabled, paddle, ENV };
