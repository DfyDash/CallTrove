const express = require("express");
const { randomBytes } = require("crypto");
const rateLimit = require("express-rate-limit");
const qrcode = require("qrcode-generator");
const db = require("../db");
const totp = require("../totp");
const { verifyPassword, hashPassword, sessionUser } = require("../auth");

const router = express.Router();

// Admin and operator logins are the highest-blast-radius accounts in this
// app -- an admin sees a whole tenant's data, an operator spans every
// tenant (see README's "Operator view"). MFA is mandatory for both,
// enforced here rather than left to memory: one of these logging in
// without totp_enabled gets walked through enrollment before a real
// session exists (see /login-mfa-setup/* below), not just nagged. Regular
// staff logins stay opt-in -- see /api/account/mfa/* in routes/api.js.
function mfaRequiredFor(user) {
  return user.role === "admin" || user.isOperator;
}

const RECOVERY_CODE_COUNT = 10;

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

// Second step of a login for a user with totp_enabled -- brute-forcing a
// 6-digit code (1M possibilities) needs its own limit, separate from the
// password step's loginLimiter above. Keyed by the pending user id (set on
// the session once the password already checked out), not username/IP, so
// it can't be dodged the same way switching IPs would dodge an IP limit.
const mfaLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.pendingMfaUserId) || req.ip,
});

// Shared by /login (no MFA configured) and /login-mfa (MFA step passed) --
// the actual point at which a session becomes a real logged-in session.
async function completeLogin(req, user) {
  req.session.pendingMfaUserId = undefined;
  req.session.user = sessionUser(user);
  // accountIds is the multi-tenant permission list -- which connected GHL
  // accounts this login can pick between (see auth.js's requireAccount).
  // Computed here, once, rather than per-request, since it only changes
  // when an admin edits access or a new account is connected/removed.
  req.session.user.accountIds = (await db.listAccessibleAccounts(user.id, user.role, user.tenantId)).map((a) => a.id);
  req.session.csrfToken = randomBytes(24).toString("hex");
}

router.post("/login", express.urlencoded({ extended: false }), loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = username ? await db.getUserByUsername(username) : null;
  const valid = password ? verifyPassword(password, user ? user.passwordHash : dummyHash, user ? user.passwordSalt : dummySalt) : false;
  if (!user || !valid) {
    return res.redirect("/login.html?error=1");
  }
  await loginLimiter.resetKey(limiterKey(username));

  if (user.totpEnabled) {
    // Not logged in yet -- req.session.user is deliberately not set until
    // the second factor also checks out. This is the only thing on the
    // session at this point, so a request that never completes the MFA
    // step never gets any real access.
    req.session.pendingMfaUserId = user.id;
    return res.redirect("/login-mfa.html");
  }

  if (mfaRequiredFor(user)) {
    // Mandatory for this account, but not enrolled yet -- same
    // not-logged-in-until-the-second-factor-checks-out rule as above,
    // just with a setup step in front of it instead of an existing code.
    req.session.pendingMfaUserId = user.id;
    return res.redirect("/login-mfa-setup.html");
  }

  await completeLogin(req, user);
  res.redirect("/");
});

// --- Mandatory-MFA first-time enrollment (admin/operator logins only --
// see mfaRequiredFor above). Same pendingMfaUserId session mechanism as
// /login-mfa, and deliberately no CSRF check for the same reason that
// route has none: there's no token yet at this point in a login, only the
// session-bound pendingMfaUserId a real password check already set. ---

router.post("/login-mfa-setup/start", async (req, res) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return res.status(401).json({ error: "not in a pending login" });
  const secret = totp.generateSecret();
  await db.setUserTotpSecret(pendingUserId, secret);
  res.json({ manualEntryKey: secret });
});

// Same same-origin-SVG-not-a-data-URI reasoning as /api/account/mfa/qr.
router.get("/login-mfa-setup/qr", async (req, res) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return res.status(401).end();
  const user = await db.getUserById(pendingUserId);
  if (!user || !user.totpSecret) return res.status(404).end();

  const qr = qrcode(0, "M");
  qr.addData(totp.otpauthUrl({ secret: user.totpSecret, username: user.username }));
  qr.make();
  res.setHeader("Content-Type", "image/svg+xml");
  res.send(qr.createSvgTag(4, 0));
});

router.post("/login-mfa-setup/confirm", express.json(), mfaLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return res.status(401).json({ error: "not in a pending login" });
  const user = await db.getUserById(pendingUserId);
  if (!user || !user.totpSecret) return res.status(400).json({ error: "start setup first" });

  const code = String((req.body || {}).code || "").trim();
  if (!totp.verifyTotp(user.totpSecret, code)) {
    return res.status(400).json({ error: "incorrect code" });
  }

  await db.enableUserTotp(user.id);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => totp.generateRecoveryCode());
  await db.replaceRecoveryCodes(user.id, codes.map(totp.hashRecoveryCode));
  await completeLogin(req, user);
  res.json({ status: "enabled", recoveryCodes: codes });
});

router.post("/login-mfa", express.urlencoded({ extended: false }), mfaLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return res.redirect("/login.html");

  const user = await db.getUserById(pendingUserId);
  if (!user || !user.totpEnabled || !user.totpSecret) {
    // The account's MFA was disabled (e.g. by an admin) mid-flow -- don't
    // leave the pending state around either way.
    req.session.pendingMfaUserId = undefined;
    return res.redirect("/login.html");
  }

  const submitted = (req.body.code || "").trim();
  const isTotpFormat = /^\d{6}$/.test(submitted);
  const ok = isTotpFormat
    ? totp.verifyTotp(user.totpSecret, submitted)
    : await db.consumeRecoveryCode(user.id, totp.hashRecoveryCode(submitted));

  if (!ok) {
    return res.redirect("/login-mfa.html?error=1");
  }

  await completeLogin(req, user);
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
