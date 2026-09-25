const express = require("express");
const { randomBytes, randomUUID } = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const totp = require("../totp");
const emailOtp = require("../emailOtp");
const email = require("../email");
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

// Scoped to the "send me another code" button specifically -- tighter than
// mfaLimiter above (which governs guessing the code, not requesting a new
// one), so a user mashing resend can't run up the shared attempt budget.
// This is a fast, request-level backstop; countRecentEmailOtpCodes (see
// sendLoginEmailOtp below) is the real, DB-backed cap that also covers the
// initial /login-triggered send, which can't be keyed by a rate limiter at
// all (there's no pendingMfaUserId yet on that first request).
const emailOtpResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.pendingMfaUserId) || req.ip,
});

// Generates and emails a fresh login code, unless this account has already
// hit the send cap in the last 15 minutes -- the actual defense against a
// bug or an abusive retry loop flooding someone's inbox (see the user-
// facing note this was added for). Silently no-ops past the cap rather
// than erroring: a code sent earlier in the window is very likely still
// sitting in the user's inbox and still valid, so there's nothing wrong to
// report back.
// A transient SES failure (network blip, throttling, misconfiguration)
// shouldn't crash the whole login request with an unhandled rejection --
// the user just lands on the code-entry page without an email in their
// inbox yet and can hit "send a new code" once whatever was wrong clears
// up, rather than getting a raw 500 instead of a clean redirect.
async function sendLoginEmailOtp(user) {
  try {
    const recentCount = await db.countRecentEmailOtpCodes(user.id, "login", 15);
    if (recentCount >= 5) return;
    const code = emailOtp.generateCode();
    await db.createEmailOtpCode(user.id, "login", emailOtp.hashCode(code), emailOtp.expiresAt());
    await email.sendEmail({
      to: user.email,
      subject: "Your CallTrove sign-in code",
      text: `Your CallTrove sign-in code is: ${code}\n\nThis code expires in 10 minutes. If you didn't try to sign in, you can ignore this email -- your account is still secure.`,
    });
  } catch (err) {
    console.error("[email-otp] failed to send login code:", err);
  }
}

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

  // Email OTP is the other self-service MFA option (see src/email.js) --
  // mutually exclusive with TOTP above by construction (enabling one
  // requires the other to already be off, see routes/api.js), so this
  // never has to ask which second factor to use.
  if (user.emailOtpEnabled) {
    req.session.pendingMfaUserId = user.id;
    await sendLoginEmailOtp(user);
    return res.redirect("/login-mfa-email.html");
  }

  await completeLogin(req, user);
  res.redirect("/");
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

router.post("/login-mfa-email", express.urlencoded({ extended: false }), mfaLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return res.redirect("/login.html");

  const user = await db.getUserById(pendingUserId);
  if (!user || !user.emailOtpEnabled || !user.email) {
    // The account's MFA was disabled (e.g. by an admin) mid-flow -- don't
    // leave the pending state around either way.
    req.session.pendingMfaUserId = undefined;
    return res.redirect("/login.html");
  }

  const submitted = (req.body.code || "").trim();
  const ok = /^\d{6}$/.test(submitted) && (await db.consumeEmailOtpCode(user.id, "login", emailOtp.hashCode(submitted)));

  if (!ok) {
    return res.redirect("/login-mfa-email.html?error=1");
  }

  await completeLogin(req, user);
  res.redirect("/");
});

router.post("/login-mfa-email/resend", emailOtpResendLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingMfaUserId;
  if (!pendingUserId) return res.redirect("/login.html");

  const user = await db.getUserById(pendingUserId);
  if (!user || !user.emailOtpEnabled || !user.email) {
    req.session.pendingMfaUserId = undefined;
    return res.redirect("/login.html");
  }

  await sendLoginEmailOtp(user);
  res.redirect("/login-mfa-email.html?sent=1");
});

// Scoped to signup specifically -- creating a tenant is a real action (new
// tenant + user rows, a welcome email), so this caps how many one IP can
// create in a window. Keyed by IP rather than username: an abuser just
// picks a fresh username every attempt, so there's no stable identity to
// key against before the account exists.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

const SIGNUP_EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Not linked from anywhere public yet -- reachable only by URL while this
// is still being tested (see public/signup.html). Creates a brand-new
// tenant with this account as its admin, owning it outright (no invite,
// no approval step). The tenant has to exist before the owning user can
// (tenant_id is a real FK on users), and the user has to exist before the
// tenant's owner_user_id can point at them (same FK the other direction) --
// so the sequence is: tenant with no owner yet, then the user, then link
// the two (db.updateTenantOwner).
router.post("/signup", express.urlencoded({ extended: false }), signupLimiter, async (req, res) => {
  const businessName = ((req.body || {}).businessName || "").trim();
  const username = ((req.body || {}).username || "").trim();
  const address = ((req.body || {}).email || "").trim().toLowerCase();
  const { password, confirmPassword } = req.body || {};

  if (!businessName || !username || !address || !password) {
    return res.redirect("/signup.html?error=missing");
  }
  if (!SIGNUP_EMAIL_FORMAT.test(address)) {
    return res.redirect("/signup.html?error=email");
  }
  if (password !== confirmPassword) {
    return res.redirect("/signup.html?error=mismatch");
  }
  if (password.length < 8) {
    return res.redirect("/signup.html?error=tooshort");
  }

  const existing = await db.getUserByUsername(username);
  if (existing) {
    return res.redirect("/signup.html?error=taken");
  }

  const tenantId = randomUUID();
  const userId = randomUUID();
  const { hash, salt } = hashPassword(password);

  await db.createTenant({ id: tenantId, name: businessName });
  await db.createUser({ id: userId, username, passwordHash: hash, passwordSalt: salt, role: "admin", tenantId });
  await db.updateTenantOwner(tenantId, userId);
  // Stored as-provided, unverified -- same shape as the self-service
  // "start email verification" flow (db.setUserPendingEmail). Proving it
  // (and optionally turning it into an MFA method) happens later, in
  // Account settings, the same way for every user regardless of how their
  // account was created.
  await db.setUserPendingEmail(userId, address);
  await db.logAudit({
    actorId: userId,
    actorUsername: username,
    action: "tenant_signup",
    message: `Signed up "${businessName}"`,
    tenantId,
  });

  try {
    await email.sendEmail({
      to: address,
      subject: "Welcome to CallTrove",
      text: `Your CallTrove account is ready. Sign in at https://app.calltrove.com/login.html with the username you chose (${username}).\n\nNext step: connect your GoHighLevel account from Settings so your calls start syncing.`,
    });
  } catch (err) {
    console.error("[signup] failed to send welcome email:", err);
  }

  const user = await db.getUserById(userId);
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
