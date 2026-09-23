// Deliberately a manual operator action, NOT a timer/cron job -- account
// deletion is permanent and irreversible, so it shouldn't be possible
// for a bug in a query (e.g. listTenantsReadyForPurge() matching more
// than intended, a timezone slip, a bad migration) to wipe out active
// customers' data on its own with nobody watching. Every actual deletion
// requires a human to type one specific tenant ID; --list/--status are
// read-only and safe to run any time.
//
// --restore is the operator-level escape hatch for the OTHER direction:
// if a bug in requireAuth's lockout check (src/auth.js) or in the
// cancel/restore web routes ever locks an account out incorrectly, this
// flips it back to 'active' directly against the database, independent
// of whether the app's own routes/session/owner-check logic is the thing
// that's broken. The self-service POST /api/admin/tenant/restore is
// still the normal path (owner, from account-canceled.html) -- this is
// specifically for when that path itself can't be trusted.
//
// Usage:
//   node src/tenantPurge.js --list
//   node src/tenantPurge.js --status <tenantId>
//   node src/tenantPurge.js --restore <tenantId>
//   node src/tenantPurge.js --purge <tenantId> [--force]
//
// --purge deletes every stored recording for that tenant, then the DB
// rows referencing them (contacts, calls, connected GHL accounts,
// logins). audit_log and phi_access_log are never touched -- see
// schema.sql's migration comment for why those specifically have to
// survive. Also refuses if any calls are still within their state-based
// retention period (src/complianceRetention.js) unless --force is given.
require("dotenv").config();
const db = require("./db");
const { deleteRecording } = require("./storage");

async function listReady() {
  const tenants = await db.listTenantsReadyForPurge();
  if (tenants.length === 0) {
    console.log("No tenants are currently eligible for purge.");
    return;
  }
  console.log(`${tenants.length} tenant(s) eligible for purge:`);
  for (const t of tenants) {
    console.log(`  ${t.id}  ${t.name}`);
  }
  console.log("\nRun `node src/tenantPurge.js --purge <tenantId>` to actually delete one.");
}

async function showStatus(tenantId) {
  const tenant = await db.getTenantById(tenantId);
  if (!tenant) {
    console.error(`No tenant found with id ${tenantId}`);
    process.exitCode = 1;
    return;
  }
  console.log(tenant);
}

async function restoreTenant(tenantId) {
  const tenant = await db.getTenantById(tenantId);
  if (!tenant) {
    console.error(`No tenant found with id ${tenantId}`);
    process.exitCode = 1;
    return;
  }
  if (tenant.status === "active") {
    console.log(`Tenant "${tenant.name}" (${tenantId}) is already active -- nothing to do.`);
    return;
  }
  if (tenant.status === "canceled") {
    console.error(
      `Tenant "${tenant.name}" (${tenantId}) is already marked 'canceled' -- its data may already be ` +
        `deleted. Refusing to silently flip status back to 'active', since that would be misleading if ` +
        `the purge already ran. Check calls/contacts/ghl_accounts for this tenant by hand before deciding ` +
        `what to do.`
    );
    process.exitCode = 1;
    return;
  }
  await db.restoreTenant(tenantId);
  console.log(`Tenant "${tenant.name}" (${tenantId}) restored to active.`);
}

async function purgeTenant(tenantId, { force = false } = {}) {
  const tenant = await db.getTenantById(tenantId);
  if (!tenant) {
    console.error(`No tenant found with id ${tenantId}`);
    process.exitCode = 1;
    return;
  }
  if (tenant.status !== "cancellation_pending") {
    console.error(`Tenant "${tenant.name}" (${tenantId}) is not pending cancellation (status: ${tenant.status}) -- refusing to purge.`);
    process.exitCode = 1;
    return;
  }
  if (tenant.purgeAt && new Date(tenant.purgeAt) > new Date()) {
    console.error(`Tenant "${tenant.name}" (${tenantId}) is still inside its grace period (eligible ${tenant.purgeAt}) -- refusing to purge.`);
    process.exitCode = 1;
    return;
  }

  // State-based records-retention (src/complianceRetention.js): calls
  // whose legally required retention window hasn't elapsed yet block a
  // normal purge outright, the same way the grace period itself does --
  // this is exactly the scenario that connects "cancellation" and
  // "retention" together, and getting it wrong means deleting records a
  // producer is legally required to still have. --force overrides this
  // for the rare legitimate case (e.g. legal counsel has actually signed
  // off, or the account's state was wrong and has since been corrected,
  // in which case re-run without --force first to get the corrected list).
  const blocked = await db.listCallsWithinRetention(tenantId);
  if (blocked.length > 0 && !force) {
    console.error(
      `Refusing to purge: ${blocked.length} call(s) for tenant "${tenant.name}" (${tenantId}) are still within ` +
        `their state-required retention period. The latest doesn't clear until ${blocked[0].retentionUntil} ` +
        `(state: ${blocked[0].state || "(none set)"}).`
    );
    console.error(`Run with --force to purge anyway (e.g. after legal sign-off), or wait for these to clear naturally.`);
    process.exitCode = 1;
    return;
  }
  if (blocked.length > 0 && force) {
    console.warn(`--force: proceeding despite ${blocked.length} call(s) still within their retention period.`);
  }

  console.log(`Purging tenant ${tenantId} (${tenant.name})...`);
  const storageKeys = await db.listStorageKeysForTenant(tenantId);
  console.log(`Deleting ${storageKeys.length} recording(s)...`);
  for (const key of storageKeys) {
    try {
      await deleteRecording(key);
    } catch (err) {
      console.error(`Failed to delete recording ${key}, continuing:`, err);
    }
  }

  await db.purgeTenantData(tenantId);
  console.log(`Done. Tenant "${tenant.name}" is now marked canceled; audit_log and phi_access_log entries were left in place.`);
}

module.exports = { listReady, showStatus, restoreTenant, purgeTenant };

if (require.main === module) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args[0] === "--list") {
      await listReady();
    } else if (args[0] === "--status" && args[1]) {
      await showStatus(args[1]);
    } else if (args[0] === "--restore" && args[1]) {
      await restoreTenant(args[1]);
    } else if (args[0] === "--purge" && args[1]) {
      await purgeTenant(args[1], { force: args.includes("--force") });
    } else {
      console.log(
        "Usage:\n" +
          "  node src/tenantPurge.js --list\n" +
          "  node src/tenantPurge.js --status <tenantId>\n" +
          "  node src/tenantPurge.js --restore <tenantId>\n" +
          "  node src/tenantPurge.js --purge <tenantId> [--force]"
      );
      process.exitCode = 1;
    }
  };
  run()
    .catch((err) => {
      console.error("[tenantPurge] fatal error:", err);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}
