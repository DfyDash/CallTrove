// The last-resort escape hatch for mandatory MFA (routes/auth.js's
// mfaRequiredFor -- admin/operator logins). The web app deliberately has
// no self-service way for an admin/operator to disable their own required
// MFA (see the self-target block in routes/admin.js's /users/:id/disable-mfa),
// and that route itself needs a *different* admin in the same tenant to
// run it. If that's ever not true -- down to one admin, locked out, no
// recovery codes saved -- there is no web path back in at all. This is
// the same "a human runs this by hand, once, against one specific
// username" reasoning as src/grantOperator.js/src/tenantPurge.js, just for
// the one lockout scenario those don't cover.
//
// Usage:
//   node src/mfaAdmin.js --list
//   node src/mfaAdmin.js --disable <username>
require("dotenv").config();
const db = require("./db");

async function listMfaEnabled() {
  const { rows } = await db.pool.query(
    `SELECT username, role, is_operator AS "isOperator" FROM users WHERE totp_enabled = true ORDER BY username`
  );
  if (rows.length === 0) {
    console.log("No users currently have two-factor authentication enabled.");
    return;
  }
  console.log(`${rows.length} user(s) with two-factor authentication enabled:`);
  for (const r of rows) console.log(`  ${r.username} (${r.role}${r.isOperator ? ", operator" : ""})`);
}

async function disableMfa(username) {
  const user = await db.getUserByUsername(username);
  if (!user) {
    console.error(`No user found with username ${username}`);
    process.exitCode = 1;
    return;
  }
  if (!user.totpEnabled) {
    console.log(`${username} doesn't have two-factor authentication enabled -- nothing to do.`);
    return;
  }
  await db.disableUserTotp(user.id);
  console.log(`Two-factor authentication disabled for ${username}. They'll need to log in and set it up again next time (it's still mandatory for their role).`);
}

module.exports = { listMfaEnabled, disableMfa };

if (require.main === module) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args[0] === "--list") {
      await listMfaEnabled();
    } else if (args[0] === "--disable" && args[1]) {
      await disableMfa(args[1]);
    } else {
      console.log("Usage:\n  node src/mfaAdmin.js --list\n  node src/mfaAdmin.js --disable <username>");
      process.exitCode = 1;
    }
  };
  run()
    .catch((err) => {
      console.error("[mfaAdmin] fatal error:", err);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}
