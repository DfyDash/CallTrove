// Emails support@calltrove.com the moment a cancelled tenant's grace
// period has actually elapsed (purge_at passed, no restore) -- the one
// signal that someone needs to go run the actual deletion
// (src/tenantPurge.js, deliberately still manual -- see its own comment on
// why permanent deletion never happens unattended). Without this, an
// operator has to remember to keep checking the operator panel's overdue
// list; this instead pushes the notice the moment it's true.
//
// Fires once per cancellation, not once per poll cycle -- see
// db.listTenantsReadyForPurgeUnnotified/markTenantPurgeNotified and
// schema.sql's comment on tenants.purge_notified_at. Not an absolute
// guarantee: if markTenantPurgeNotified's write fails right after a
// successful send (a DB blip), the next cycle has no way to know the email
// already went out and sends it again -- an occasional duplicate is the
// tradeoff for never silently going quiet about a tenant that's actually
// ready for deletion, which is the failure mode that would actually matter.
const db = require("./db");
const email = require("./email");
const alerting = require("./alerting");

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const SUPPORT_EMAIL = "support@calltrove.com";
const BYTES_PER_GB = 1024 ** 3;

function formatBytes(bytes) {
  if (!bytes) return "0 GB";
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

function formatWhen(date) {
  return date ? new Date(date).toUTCString() : "unknown";
}

// Every field here exists for one reason: letting whoever reads this email
// confirm, without opening the app first, that they're about to delete
// the right account. The tenant id is what actually gets typed/passed to
// the purge action -- everything else (name, owner, connected GHL
// locations, how much is being deleted) is a cross-check against it.
// Wording is deliberately plain, everyday language and short factual
// lines -- this lands in a support inbox, not a developer's terminal.
function buildEmail(tenant) {
  const subject = `CallTrove: "${tenant.name}" can now be deleted`;
  const text = `"${tenant.name}" can now be deleted. The waiting period since it was cancelled has ended, and nobody undid the cancellation.

Account ID: ${tenant.id}
Owner's email: ${tenant.ownerUsername || "(none on file)"}
Connected GoHighLevel account(s): ${tenant.ghlLocationIds && tenant.ghlLocationIds.length ? tenant.ghlLocationIds.join(", ") : "(none)"}
Storage type: ${tenant.storageTier || "standard"}

Cancelled on: ${formatWhen(tenant.cancellationRequestedAt)}
Could be deleted since: ${formatWhen(tenant.purgeAt)}

What would be deleted: ${tenant.callCount} call recording(s), about ${formatBytes(tenant.totalBytes)} of data.

To delete it: use the Delete button for this account in the operator panel, or run this on the server:
  node src/tenantPurge.js --purge ${tenant.id}

Make sure the Account ID above matches before you delete it -- this cannot be undone.`;
  return { subject, text };
}

async function pollOnce() {
  if (!email.isEnabled()) return;

  const tenants = await db.listTenantsReadyForPurgeUnnotified();
  for (const tenant of tenants) {
    let sent = false;
    try {
      const { subject, text } = buildEmail(tenant);
      await email.sendEmail({ to: SUPPORT_EMAIL, subject, text });
      sent = true;
      await db.markTenantPurgeNotified(tenant.id);
      console.log(`[tenantPurgeNotifier] notified ${SUPPORT_EMAIL} that tenant ${tenant.id} (${tenant.name}) is ready for purge`);
    } catch (err) {
      // Not marked notified on failure -- the next cycle retries it rather
      // than silently going quiet about a tenant that's sitting ready for
      // deletion. sent distinguishes the two failure points in the log: if
      // the send itself failed, the next cycle's retry is a first attempt;
      // if only marking it failed after a successful send, the next
      // cycle's retry is a (rare, harmless) duplicate email, not a missed one.
      console.error(`[tenantPurgeNotifier] failed to ${sent ? "mark as notified after sending" : "send"} for tenant ${tenant.id}:`, err);
    }
  }
}

function start() {
  if (!email.isEnabled()) {
    console.log("[tenantPurgeNotifier] disabled (RESEND_API_KEY/EMAIL_FROM_ADDRESS not configured)");
    return;
  }
  console.log(`[tenantPurgeNotifier] starting, checking every ${POLL_INTERVAL_MS / 60000}min`);
  async function cycle() {
    try {
      await pollOnce();
      alerting.recordSuccess("tenant purge notifier");
    } catch (err) {
      console.error("[tenantPurgeNotifier] poll cycle failed:", err);
      await alerting.recordFailure("tenant purge notifier", err).catch(() => {});
    }
    setTimeout(cycle, POLL_INTERVAL_MS);
  }
  cycle();
}

module.exports = { start, pollOnce, buildEmail, SUPPORT_EMAIL };
