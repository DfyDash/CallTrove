// Cross-tenant operator view -- for the platform owner (your own agency),
// not any client. Every route here is gated by requireOperator (see
// src/auth.js), which is completely separate from requireAdmin: an admin
// is only ever an admin *of their own tenant*, and there is deliberately
// no self-service way for anyone to become an operator (see
// src/grantOperator.js).
const express = require("express");
const db = require("../db");
const tenantPurge = require("../tenantPurge");
const billingRates = require("../billingRates");
const storage = require("../storage");
const awsCostExplorer = require("../awsCostExplorer");
const { requireOperator, requireCsrf } = require("../auth");

const router = express.Router();
router.use(requireOperator);

// Same source of truth (and same default) as routes/admin.js's self-service
// cancellation -- an operator-triggered cancellation goes through the exact
// same grace period a client cancelling themselves would get.
const CANCELLATION_GRACE_PERIOD_DAYS = Number(process.env.CANCELLATION_GRACE_PERIOD_DAYS || 7);

function log(req, action, message) {
  return db.logAudit({ actorId: req.session.user.id, actorUsername: req.session.user.username, action, message });
}

// pg returns NUMERIC columns as strings (they can exceed JS's safe
// integer precision) -- every cost_ledger sum from listTenantsForOperator
// needs this before any arithmetic.
function num(v) {
  return Number(v) || 0;
}

// estimatedTranscribeCost stays a live "transcribed minutes x today's
// rate" figure (shared infra like EC2/RDS is deliberately excluded, same
// as before) -- it's a quick sanity-check number, not what's shown as
// the real cost. transcriptionAwsCost/aiSummaryAwsCost/storageAwsCost/
// transcriptCleanupAwsCost and the four revenue fields are the real
// cost_ledger sums (see listTenantsForOperator's own comment): permanent
// receipts at the rate in effect when each one happened, never
// recalculated from today's rates the way the estimate is.
// totalAwsCost/totalRevenue/margin are computed here from those real
// sums -- storageRevenue is a safety-net overage charge, $0 for a normal
// account (see billingRates.js's STORAGE_TIERS comment), not a general
// storage rate. transcriptCleanupRevenue is always exactly equal to
// transcriptCleanupAwsCost (see transcriptCleanupPoller.js -- billed as
// an exact cost pass-through, no markup), so it never moves margin on
// its own, only the top-line totals.
const BYTES_PER_GB = 1024 ** 3;

router.get("/tenants", async (req, res) => {
  const tenants = await db.listTenantsForOperator();
  res.json(
    tenants.map((t) => {
      const transcriptionAwsCost = num(t.transcriptionAwsCost);
      const transcriptionRevenue = num(t.transcriptionRevenue);
      const aiSummaryAwsCost = num(t.aiSummaryAwsCost);
      const aiSummaryRevenue = num(t.aiSummaryRevenue);
      const storageAwsCost = num(t.storageAwsCost);
      const storageRevenue = num(t.storageRevenue);
      const transcriptCleanupAwsCost = num(t.transcriptCleanupAwsCost);
      const transcriptCleanupRevenue = num(t.transcriptCleanupRevenue);
      const totalAwsCost = transcriptionAwsCost + aiSummaryAwsCost + storageAwsCost + transcriptCleanupAwsCost;
      const totalRevenue = transcriptionRevenue + aiSummaryRevenue + storageRevenue + transcriptCleanupRevenue;
      return {
        ...t,
        transcribedMinutes: Math.round((t.transcribedSeconds / 60) * 10) / 10,
        estimatedTranscribeCost: Math.round((t.transcribedSeconds / 60) * billingRates.AWS_TRANSCRIBE_PER_MINUTE * 100) / 100,
        storedGB: Math.round((Number(t.storedBytes) / BYTES_PER_GB) * 100) / 100,
        transcriptionAwsCost,
        transcriptionRevenue,
        aiSummaryAwsCost,
        aiSummaryRevenue,
        storageAwsCost,
        storageRevenue,
        transcriptCleanupAwsCost,
        transcriptCleanupRevenue,
        totalAwsCost,
        totalRevenue,
        margin: totalRevenue - totalAwsCost,
      };
    })
  );
});

// The REAL full AWS bill this month, every service -- not the per-tenant
// metered total above, which only ever covers specific usage events
// (transcription, AI summary, storage, transcript cleanup) and
// deliberately excludes EC2/RDS/etc (see src/awsCostExplorer.js's own
// comment on why). Returns 503 with a clear message, not a raw AWS
// exception, when the server's IAM role hasn't been granted
// ce:GetCostAndUsage yet -- confirmed directly that it isn't by default.
router.get("/aws-spend", async (req, res) => {
  try {
    const data = await awsCostExplorer.getMonthToDateSpend();
    res.json(data);
  } catch (err) {
    if (err.name === "AccessDeniedException" || /AccessDenied/i.test(err.message || "")) {
      return res.status(503).json({ error: "This server's IAM role doesn't have Cost Explorer access yet (ce:GetCostAndUsage)." });
    }
    console.error("[operator] failed to fetch AWS Cost Explorer spend:", err);
    res.status(502).json({ error: "Could not reach AWS Cost Explorer." });
  }
});

// Every operator action across every tenant (cancel/restore/purge, each
// logged above) -- distinct from any one tenant's own Activity log tab
// (routes/admin.js's /audit-log), which never shows these since operator
// actions are deliberately written with no tenant_id (see db.logAudit's
// comment) -- they aren't that tenant's own admin doing something, and
// mixing them in would be confusing on a page the tenant's own admin can
// see. This is the only place they're visible at all.
router.get("/audit-log", async (req, res) => {
  const result = await db.listAuditLogForOperator({ page: req.query.page, pageSize: req.query.pageSize });
  res.json(result);
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
    // Logged even on failure (operator actions have no tenant_id -- see
    // db.logAudit's comment -- the tenant is still named in err.message
    // itself) so a repeatedly-failing purge leaves a real trail instead
    // of only ever surfacing in whoever's browser happened to be looking
    // when it failed. Its own try/catch: the operator must still get the
    // real 409 even if this logging call itself fails (e.g. a transient
    // DB problem -- plausible exactly when purge is already failing for
    // infra reasons), not a hung request with no response at all.
    try {
      await log(req, "tenant_purge_failed", err.message || String(err));
    } catch (logErr) {
      console.error("[operator] failed to log purge failure:", logErr);
    }
    res.status(409).json({ error: err.message });
  }
});

// Which bucket pool a tenant's recordings are saved to going forward
// (billingRates.js's STORAGE_TIERS) -- a pricing/BAA decision, so operator-
// only, same as cancel/restore/purge above. Only ever affects recordings
// saved from this point on; existing ones keep whatever tier was stamped
// on them at save time (see schema.sql's comment on calls.storage_tier),
// so this is never a data-migration trigger.
router.post("/tenants/:id/storage-tier", requireCsrf, async (req, res) => {
  const tier = (req.body || {}).tier;
  // hasOwnProperty, not `tier in STORAGE_TIERS` -- `in` also matches
  // inherited Object.prototype names ("constructor", "toString", ...),
  // which would let an invalid tier slip past this check entirely on a
  // local-disk deployment (the S3-bucket check below happens to catch it
  // on an S3 deployment, but only there) and then fail the DB's own
  // storage_tier CHECK constraint unhandled, hanging the request instead
  // of returning this 400.
  if (typeof tier !== "string" || !Object.prototype.hasOwnProperty.call(billingRates.STORAGE_TIERS, tier)) {
    return res.status(400).json({ error: `tier must be one of: ${Object.keys(billingRates.STORAGE_TIERS).join(", ")}` });
  }
  // Refuses a tier whose bucket isn't actually configured yet -- better to
  // block the switch than let the next recording for this tenant fail to
  // save because S3_BUCKET_HIPAA (or similar) was never set.
  if (storage.driver === "s3" && !billingRates.storageTier(tier).bucket) {
    return res.status(409).json({ error: `the "${tier}" tier has no S3 bucket configured -- set its bucket env var before assigning a tenant to it` });
  }

  const tenant = await db.getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });

  // Hard, server-side gate -- not negotiable, not an operator override: a
  // tenant can only move to the 'hipaa' tier once its own owner has
  // accepted the BAA themselves (routes/admin.js's POST /baa/accept,
  // self-serve, same shape as AWS's own BAA acceptance in AWS Artifact).
  // The operator enabling this tier for a tenant is not the same thing as
  // the tenant's owner having agreed to it -- those are two different
  // people, and only the owner's own acceptance counts.
  if (tier === "hipaa") {
    const acceptance = await db.getLatestBaaAcceptance(tenant.id);
    if (!acceptance) {
      return res.status(409).json({
        error: `"${tenant.name}" cannot be moved to the hipaa tier -- its owner has not accepted the BAA yet (Settings > BAA, in their own account)`,
      });
    }
  }

  if (tenant.storageTier === tier) {
    return res.json({ status: "unchanged", storageTier: tier });
  }

  const updated = await db.setTenantStorageTier(tenant.id, tier);
  await log(
    req,
    "tenant_storage_tier_changed",
    `Storage tier for "${tenant.name}" (${tenant.id}) changed from ${tenant.storageTier} to ${tier} by operator`
  );
  res.json({ status: "updated", storageTier: updated.storageTier });
});

module.exports = router;
