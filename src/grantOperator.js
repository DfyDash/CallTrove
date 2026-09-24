// Deliberately a manual operator action, same reasoning as
// src/tenantPurge.js -- granting a login the power to see and delete every
// client's data should never be a UI toggle or a self-service action a
// compromised session or a route bug could trigger. A human runs this by
// hand, once, against one specific username.
//
// Usage:
//   node src/grantOperator.js --list
//   node src/grantOperator.js --grant <username>
//   node src/grantOperator.js --revoke <username>
require("dotenv").config();
const db = require("./db");

async function listOperators() {
  const { rows } = await db.pool.query(
    `SELECT username, is_operator AS "isOperator" FROM users WHERE is_operator = true ORDER BY username`
  );
  if (rows.length === 0) {
    console.log("No users currently have operator access.");
    return;
  }
  console.log(`${rows.length} user(s) with operator access:`);
  for (const r of rows) console.log(`  ${r.username}`);
}

async function setOperator(username, isOperator) {
  const user = await db.getUserByUsername(username);
  if (!user) {
    console.error(`No user found with username ${username}`);
    process.exitCode = 1;
    return;
  }
  await db.pool.query(`UPDATE users SET is_operator = $2 WHERE id = $1`, [user.id, isOperator]);
  console.log(`${username} ${isOperator ? "granted" : "no longer has"} operator access.`);
}

module.exports = { listOperators, setOperator };

if (require.main === module) {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args[0] === "--list") {
      await listOperators();
    } else if (args[0] === "--grant" && args[1]) {
      await setOperator(args[1], true);
    } else if (args[0] === "--revoke" && args[1]) {
      await setOperator(args[1], false);
    } else {
      console.log(
        "Usage:\n" +
          "  node src/grantOperator.js --list\n" +
          "  node src/grantOperator.js --grant <username>\n" +
          "  node src/grantOperator.js --revoke <username>"
      );
      process.exitCode = 1;
    }
  };
  run()
    .catch((err) => {
      console.error("[grantOperator] fatal error:", err);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}
