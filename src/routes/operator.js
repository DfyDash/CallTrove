// Cross-tenant operator view -- for the platform owner (your own agency),
// not any client. Every route here is gated by requireOperator (see
// src/auth.js), which is completely separate from requireAdmin: an admin
// is only ever an admin *of their own tenant*, and there is deliberately
// no self-service way for anyone to become an operator (see
// src/grantOperator.js).
const express = require("express");
const db = require("../db");
const tenantPurge = require("../tenantPurge");
const { requireOperator, requireCsrf } = require("../auth");

const router = express.Router();
router.use(requireOperator);

// Same source of truth (and same default) as routes/admin.js's self-service
// cancellation -- an operator-triggered cancellation goes through the exact
// same grace period a client cancelling themselves would get.
const CANCELLATION_GRACE_PERIOD_DAYS = Number(process.env.CANCELLATION_GRACE_PERIOD_DAYS || 7);

// AWS Transcribe standard batch pricing (see src/transcription.js) --
// env-overridable since this is a cost estimate, not a real AWS bill
// (nothing here tags actual Transcribe usage by tenant), so it should be
// easy to correct if the real rate changes or a discount tier applies.
const TRANSCRIBE_RATE_PER_MINUTE = Number(process.env.TRANSCRIBE_RATE_PER_MINUTE || 0.006);

function log(req, action, message) {
  return db.logAudit({ actorId: req.session.user.id, actorUsername: req.session.user.username, action, message });
}

// Estimated cost only -- see listTenantsForOperator's own comment for why
// shared infra (EC2/RDS) is deliberately excluded. "Profit" (this minus
// what the client actually pays) isn't shown yet -- there's no billing
// system to pull real revenue from (see README's deferred-features list).
router.get("/tenants", async (req, res) => {
  const tenants = await db.listTenantsForOperator();
  res.json(
    tenants.map((t) => ({
      ...t,
      transcribedMinutes: Math.round((t.transcribedSeconds / 60) * 10) / 10,
      estimatedTranscribeCost: Math.round((t.transcribedSeconds / 60) * TRANSCRIBE_RATE_PER_MINUTE * 100) / 100,
    }))
  );
});

router.post("/tenants/:id/cancel", requireCsrf, async (req, res) => {
  const tenant = await db.getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });
  if (tenant.status !== "active") {
    return res.status(409).json({ error: `account is already ${tenant.status}` });
  }

  const purgeAt = new Date(Date.now() + CANCELLATION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  await db.requestTenantCancellation(tenant.id, purgeAt);
  await log(req, "tenant_cancelled_by_operator", `Cancellation triggered by operator for "${tenant.name}" (${tenant.id}), data purge scheduled for ${purgeAt.toISOString()}`);
  res.json({ status: "cancellation_pending", purgeAt });
});

router.post("/tenants/:id/restore", requireCsrf, async (req, res) => {
  try {
    const result = await tenantPurge.restoreTenant(req.params.id);
    await log(req, "tenant_restored_by_operator", `Restore triggered by operator for "${result.tenant.name}" (${req.params.id})`);
    res.json({ status: "active", alreadyActive: result.alreadyActive });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// The one truly irreversible action in this whole app. Requires the exact
// phrase typed back, checked server-side -- a client-only guard is never
// enough for something this permanent (same reasoning as every other
// confirm-by-typing flow in this app, e.g. the self-service cancel form).
// tenantPurge.purgeTenant itself still refuses anything not actually
// eligible (not cancellation_pending, or still inside its grace period) --
// this confirmation phrase is an *additional* guard on top of that, not a
// replacement for it.
const PURGE_CONFIRMATION_PHRASE = "DELETE ACCOUNT";

router.post("/tenants/:id/purge", requireCsrf, async (req, res) => {
  if ((req.body || {}).confirm !== PURGE_CONFIRMATION_PHRASE) {
    return res.status(400).json({ error: `type "${PURGE_CONFIRMATION_PHRASE}" to confirm` });
  }
  try {
    const result = await tenantPurge.purgeTenant(req.params.id);
    await log(
      req,
      "tenant_purged_by_operator",
      `Tenant "${result.tenant.name}" (${req.params.id}) purged by operator -- ${result.recordingsDeleted} recording(s) deleted`
    );
    res.json({ status: "canceled", recordingsDeleted: result.recordingsDeleted });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

module.exports = router;
