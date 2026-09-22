const express = require("express");
const { randomBytes } = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { verifyPassword, hashPassword, sessionUser } = require("../auth");

const router = express.Router();

function limiterKey(username) {
  return username.trim().toLowerCase();
}

// Scoped to the login route specifically -- this is the actual
// brute-force target, not the rest of the app. Keyed by the submitted
// username, not IP: IP-keying meant one coworker mistyping their password
// a few times could lock out everyone else sharing the same office/VPN
// address, and a targeted password reset from an admin couldn't actually
// unlock the account since the counter lived against the IP, not the
// user. Username-keying also closes the standard bypass where an
// attacker just switches IPs to dodge an IP-based limit. The tradeoff:
// someone could try to lock out one specific known username from many
// IPs -- there's no published username list, guessing still takes real
// reconnaissance (naming-pattern guesses, credential-stuffing from an
// unrelated breach), and the timing side-channel that would have made
// enumeration easy is closed below (the dummy-hash comparison). Cleared
// early on a successful login or an admin password reset (see the
// /login handler below and routes/admin.js), not just left to expire on
// its own.
const loginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.username ? limiterKey(req.body.username) : req.ip),
});

// req.body.csrfToken is a hidden form field on the two classic HTML-form
// POSTs below (logout, change-password) -- they aren't fetch calls, so
// they can't set the X-CSRF-Token header the JSON API routes use instead
// (see auth.js's requireCsrf). Only enforced when there's an actual
// session to protect; an unauthenticated logout has nothing worth forging.
function csrfValid(req) {
  return Boolean(req.session.csrfToken) && req.body.csrfToken === req.session.csrfToken;
}

// A fixed dummy hash/salt, generated once at startup -- used below so a
// login attempt against a username that doesn't exist still runs the same
// expensive scrypt computation a real one would. Without this, a
// nonexistent username short-circuits and returns fast, while a real one
// always pays for the hash before failing on a wrong password -- a timing
// difference an attacker can use to enumerate valid usernames just by
// measuring response time, no leaked list required.
const { hash: dummyHash, salt: dummySalt } = hashPassword(randomBytes(32).toString("hex"));

router.post("/login", express.urlencoded({ extended: false }), loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = username ? await db.getUserByUsername(username) : null;
  const valid = password ? verifyPassword(password, user ? user.passwordHash : dummyHash, user ? user.passwordSalt : dummySalt) : false;
  if (!user || !valid) {
    return res.redirect("/login.html?error=1");
  }
  await loginLimiter.resetKey(limiterKey(username));
  req.session.user = sessionUser(user);
  // accountIds is the multi-tenant permission list -- which connected GHL
  // accounts this login can pick between (see auth.js's requireAccount).
  // Computed here, once, rather than per-request, since it only changes
  // when an admin edits access or a new account is connected/removed.
  req.session.user.accountIds = (await db.listAccessibleAccounts(user.id, user.role, user.tenantId)).map((a) => a.id);
  req.session.csrfToken = randomBytes(24).toString("hex");
  res.redirect("/");
});

router.post("/logout", express.urlencoded({ extended: false }), (req, res) => {
  if (req.session.user && !csrfValid(req)) {
    return res.redirect("/login.html?error=1");
  }
  req.session.destroy(() => res.redirect("/login.html"));
});

// Self-service change for a logged-in user -- distinct from an admin
// resetting someone else's password (that's in routes/admin.js), and
// requires knowing the current password, unlike that admin path.
router.post("/change-password", express.urlencoded({ extended: false }), async (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");
  if (!csrfValid(req)) return res.redirect("/account.html?error=csrf");

  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword !== confirmPassword) {
    return res.redirect("/account.html?error=mismatch");
  }
  if (newPassword.length < 8) {
    return res.redirect("/account.html?error=tooshort");
  }

  const user = await db.getUserByUsername(req.session.user.username);
  if (!user || !verifyPassword(currentPassword, user.passwordHash, user.passwordSalt)) {
    return res.redirect("/account.html?error=wrongcurrent");
  }

  const { hash, salt } = hashPassword(newPassword);
  await db.updateUser(user.id, { passwordHash: hash, passwordSalt: salt });
  res.redirect("/account.html?success=1");
});

module.exports = router;
module.exports.loginLimiter = loginLimiter;
module.exports.limiterKey = limiterKey;
