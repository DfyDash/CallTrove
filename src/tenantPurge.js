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
//   node src/tenantPurge.js --purge <tenantId>
//
// --purge deletes every stored recording for that tenant, then the DB
// rows referencing them (contacts, calls, connected GHL accounts,
// logins). audit_log and phi_access_log are never touched -- see
// schema.sql's migration comment for why those specifically have to
// survive.
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

// Throws on any refusal/error rather than console.error + process.exitCode
// -- this and purgeTenant below are called two ways: the CLI entry point
// at the bottom of this file (which catches and prints), and
// src/routes/operator.js (which catches and turns it into a JSON error
// response). process.exitCode is CLI-only concept; setting it here would
// mark the exit code of the whole long-running server process on every
// failed request, which is wrong outside a one-shot CLI invocation.
async function restoreTenant(tenantId) {
  const tenant = await db.getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`No tenant found with id ${tenantId}`);
  }
  if (tenant.status === "active") {
    return { tenant, alreadyActive: true };
  }
  if (tenant.status === "canceled") {
    throw new Error(
      `Tenant "${tenant.name}" (${tenantId}) is already marked 'canceled' -- its data may already be ` +
        `deleted. Refusing to silently flip status back to 'active', since that would be misleading if ` +
        `the purge already ran. Check calls/contacts/ghl_accounts for this tenant by hand before deciding ` +
        `what to do.`
    );
  }
  await db.restoreTenant(tenantId);
  return { tenant, alreadyActive: false };
}

async function purgeTenant(tenantId) {
  const tenant = await db.getTenantById(tenantId);
  if (!tenant) {
    throw new Error(`No tenant found with id ${tenantId}`);
  }
  if (tenant.status !== "cancellation_pending") {
    throw new Error(`Tenant "${tenant.name}" (${tenantId}) is not pending cancellation (status: ${tenant.status}) -- refusing to purge.`);
  }
  if (tenant.purgeAt && new Date(tenant.purgeAt) > new Date()) {
    throw new Error(`Tenant "${tenant.name}" (${tenantId}) is still inside its grace period (eligible ${tenant.purgeAt}) -- refusing to purge.`);
  }

  const storageKeys = await db.listStorageKeysForTenant(tenantId);
  for (const key of storageKeys) {
    try {
      await deleteRecording(key);
    } catch (err) {
      console.error(`[tenantPurge] failed to delete recording ${key}, continuing:`, err);
    }
  }

  await db.purgeTenantData(tenantId);
  return { tenant, recordingsDeleted: storageKeys.length };
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
      const result = await restoreTenant(args[1]);
      console.log(
        result.alreadyActive
          ? `Tenant "${result.tenant.name}" (${args[1]}) is already active -- nothing to do.`
          : `Tenant "${result.tenant.name}" (${args[1]}) restored to active.`
      );
    } else if (args[0] === "--purge" && args[1]) {
      console.log(`Purging tenant ${args[1]}...`);
      const result = await purgeTenant(args[1]);
      console.log(
        `Deleted ${result.recordingsDeleted} recording(s). Tenant "${result.tenant.name}" is now marked ` +
          `canceled; audit_log and phi_access_log entries were left in place.`
      );
    } else {
      console.log(
        "Usage:\n" +
          "  node src/tenantPurge.js --list\n" +
          "  node src/tenantPurge.js --status <tenantId>\n" +
          "  node src/tenantPurge.js --restore <tenantId>\n" +
          "  node src/tenantPurge.js --purge <tenantId>"
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
