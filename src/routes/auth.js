const express = require("express");
const { randomBytes, randomUUID, createHash } = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const totp = require("../totp");
const emailOtp = require("../emailOtp");
const email = require("../email");
const { verifyPassword, hashPassword, sessionUser } = require("../auth");
const { BAA_VERSION, buildBaaText } = require("../baaText");

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

// Same brute-force target as loginLimiter above (a forgot-password request
// is unauthenticated too), keyed the same way -- by username, not IP, for
// the identical reasoning: an attacker just switches IPs to dodge an IP
// limit, and IP-keying would let one mistaken/malicious requester lock out
// everyone else on the same network from resetting their own password.
const forgotPasswordLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.username ? limiterKey(req.body.username) : req.ip),
});

// Guessing protection on the reset code itself -- same shape as mfaLimiter
// above (a 6-digit code, keyed by the pending user id so switching IPs
// doesn't reset the budget), reused rather than sharing mfaLimiter's key
// space: a password-reset attempt and a login-MFA attempt are different
// actions and shouldn't share one attempt budget against the same user id.
const resetPasswordLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.pendingPasswordResetUserId) || req.ip,
});

const resetPasswordResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.pendingPasswordResetUserId) || req.ip,
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
async function sendLoginEmailOtp(user, requestIp, baseUrl) {
  try {
    const recentCount = await db.countRecentEmailOtpCodes(user.id, "login", 15);
    if (recentCount >= 5) return;
    const code = emailOtp.generateCode();
    await db.createEmailOtpCode(user.id, "login", emailOtp.hashCode(code), emailOtp.expiresAt());
    await email.sendEmail({
      to: user.email,
      subject: "Your CallTrove sign-in code",
      text: `Your CallTrove sign-in code is: ${code}\n\nThis code expires in 10 minutes. Never share it with anyone. If you didn't try to sign in, your password may be compromised -- change it as soon as you can.`,
      html: email.otpCodeEmailHtml(code, {
        heading: "Your sign-in code",
        explain: "Someone used your email address and password to sign in to CallTrove, and needs this code to finish.",
        securityNote: "Didn't try to sign in? Your password may be compromised -- change it as soon as you can.",
        requestIp,
        baseUrl,
      }),
    });
  } catch (err) {
    console.error("[email-otp] failed to send login code:", err);
  }
}

// Same shape as sendLoginEmailOtp above (own DB-backed send cap, own purpose
// so a reset code can never double as a login code, swallows a transient
// send failure rather than breaking the request) -- separate function
// because the two happen on different unauthenticated flows with different
// wording, not because the mechanics differ.
async function sendPasswordResetEmailOtp(user, requestIp, baseUrl) {
  try {
    const recentCount = await db.countRecentEmailOtpCodes(user.id, "password_reset", 15);
    if (recentCount >= 5) return;
    const code = emailOtp.generateCode();
    await db.createEmailOtpCode(user.id, "password_reset", emailOtp.hashCode(code), emailOtp.expiresAt());
    await email.sendEmail({
      to: user.email,
      subject: "Your CallTrove password reset code",
      text: `Your CallTrove password reset code is: ${code}\n\nThis code expires in 10 minutes. Never share it with anyone. Didn't request this? You don't need to do anything -- your password won't change unless this code is used.`,
      html: email.otpCodeEmailHtml(code, {
        heading: "Reset your password",
        explain: "You or someone else asked to reset the password on this CallTrove account.",
        securityNote: "Didn't request this? You don't need to do anything -- your password won't change unless this code is used.",
        requestIp,
        baseUrl,
      }),
    });
  } catch (err) {
    console.error("[email-otp] failed to send password reset code:", err);
  }
}

// Shared by /login (no MFA configured) and /login-mfa (MFA step passed) --
// the actual point at which a session becomes a real logged-in session.
async function completeLogin(req, user) {
  req.session.pendingMfaUserId = undefined;
  req.session.user = sessionUser(user);
  req.session.csrfToken = randomBytes(24).toString("hex");
}

router.post("/login", express.urlencoded({ extended: false }), loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = username ? await db.getUserByUsername(username) : null;
  // A user invited via routes/admin.js's POST /users/invite has no
  // password yet (null hash/salt) until they redeem their link -- calling
  // verifyPassword on that would throw (scrypt needs a real salt), and
  // "wrong password" would be a misleading message anyway.
  if (user && !user.passwordHash) {
    return res.redirect("/login.html?error=pending");
  }
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
    await sendLoginEmailOtp(user, req.ip, `${req.protocol}://${req.get("host")}`);
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

  await sendLoginEmailOtp(user, req.ip, `${req.protocol}://${req.get("host")}`);
  res.redirect("/login-mfa-email.html?sent=1");
});

// Self-service password reset, entry point. Deliberately gives the same
// response (redirect to the code-entry page) whether or not the username
// exists or has a verified email on file -- an attacker probing for valid
// usernames via this form learns nothing from the response either way,
// same anti-enumeration reasoning as the dummy-hash comparison on /login
// above. If the account doesn't qualify, this just silently doesn't send
// anything and pendingPasswordResetUserId is left unset, so a follow-up
// code submission fails the same way an expired/wrong one would.
router.post("/forgot-password", express.urlencoded({ extended: false }), forgotPasswordLimiter, async (req, res) => {
  const username = ((req.body || {}).username || "").trim();
  if (username) {
    const user = await db.getUserByUsername(username);
    if (user && user.email && user.emailVerifiedAt) {
      req.session.pendingPasswordResetUserId = user.id;
      await sendPasswordResetEmailOtp(user, req.ip, `${req.protocol}://${req.get("host")}`);
    }
  }
  res.redirect("/reset-password.html?sent=1");
});

router.post("/reset-password", express.urlencoded({ extended: false }), resetPasswordLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingPasswordResetUserId;
  if (!pendingUserId) return res.redirect("/forgot-password.html");

  const { code, password, confirmPassword } = req.body || {};
  if (!password || password !== confirmPassword) {
    return res.redirect("/reset-password.html?error=mismatch");
  }
  if (password.length < 8) {
    return res.redirect("/reset-password.html?error=tooshort");
  }

  const submitted = (code || "").trim();
  const ok = /^\d{6}$/.test(submitted) && (await db.consumeEmailOtpCode(pendingUserId, "password_reset", emailOtp.hashCode(submitted)));
  if (!ok) {
    return res.redirect("/reset-password.html?error=code");
  }

  const { hash, salt } = hashPassword(password);
  await db.updateUser(pendingUserId, { passwordHash: hash, passwordSalt: salt });
  req.session.pendingPasswordResetUserId = undefined;
  res.redirect("/login.html?reset=1");
});

router.post("/reset-password/resend", resetPasswordResendLimiter, async (req, res) => {
  const pendingUserId = req.session.pendingPasswordResetUserId;
  if (!pendingUserId) return res.redirect("/forgot-password.html");

  const user = await db.getUserById(pendingUserId);
  if (!user || !user.email) {
    req.session.pendingPasswordResetUserId = undefined;
    return res.redirect("/forgot-password.html");
  }

  await sendPasswordResetEmailOtp(user, req.ip, `${req.protocol}://${req.get("host")}`);
  res.redirect("/reset-password.html?sent=1");
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
// The BAA text a HIPAA signup is shown before their account exists. Built
// from the business name they typed, same as the in-app version, and the
// hash is echoed back on signup so the server can confirm the exact text
// that was displayed is what got accepted.
const baaPreviewLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
router.get("/baa-preview", baaPreviewLimiter, (req, res) => {
  const businessName = String(req.query.businessName || "").trim().slice(0, 200);
  if (!businessName) return res.status(400).json({ error: "business name required" });
  const text = buildBaaText({ companyName: businessName });
  res.json({ text, hash: createHash("sha256").update(text, "utf8").digest("hex"), version: BAA_VERSION });
});

router.post("/signup", express.urlencoded({ extended: false }), signupLimiter, async (req, res) => {
  const firstName = ((req.body || {}).firstName || "").trim();
  const lastName = ((req.body || {}).lastName || "").trim();
  const businessName = ((req.body || {}).businessName || "").trim();
  const address = ((req.body || {}).email || "").trim().toLowerCase();
  // The email IS the login: same value as the username, so there is one
  // thing to remember and nothing to collide on but the email itself.
  const username = address;
  const { password, confirmPassword } = req.body || {};
  const hipaaAnswer = (req.body || {}).hipaa;

  if (hipaaAnswer !== "yes" && hipaaAnswer !== "no") {
    return res.redirect("/signup.html?error=hipaa");
  }
  // A HIPAA signup accepts the BAA as part of creating the account: the
  // signer's name, the box ticked, and the hash of the exact text shown.
  const baaFullName = (((req.body || {}).baaFullName) || "").trim();
  const baaTitle = (((req.body || {}).baaTitle) || "").trim();
  const baaText = buildBaaText({ companyName: businessName });
  const baaHash = createHash("sha256").update(baaText, "utf8").digest("hex");
  if (hipaaAnswer === "yes") {
    if (!baaFullName || !baaTitle || (req.body || {}).baaAgree !== "on" || (req.body || {}).baaHash !== baaHash) {
      return res.redirect("/signup.html?error=baa");
    }
  }
  if (!firstName || !lastName || !businessName || !username || !address || !password) {
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
  // Signing up needs somewhere to take payment: no account is ever created
  // for someone who hasn't paid.
  if (!require("../paddle").billingEnabled()) {
    return res.redirect("/signup.html?error=unavailable");
  }

  // The email is confirmed with a code BEFORE payment (see schema.sql's
  // pending_signups comment). Without working email we can't confirm anything,
  // so sign-up is closed -- unless the operator has explicitly switched the
  // check off for a test site.
  const skipEmailCheck = process.env.SIGNUP_SKIP_EMAIL_VERIFICATION === "true";
  if (!skipEmailCheck && !email.isEnabled()) {
    return res.redirect("/signup.html?error=unavailable");
  }

  const pendingId = randomUUID();
  const { hash, salt } = hashPassword(password);
  await db.createPendingSignup({
    id: pendingId,
    firstName,
    lastName,
    businessName,
    email: address,
    passwordHash: hash,
    passwordSalt: salt,
    hipaaRequested: hipaaAnswer === "yes",
    baaFullName: hipaaAnswer === "yes" ? baaFullName : null,
    baaTitle: hipaaAnswer === "yes" ? baaTitle : null,
    baaTextHash: hipaaAnswer === "yes" ? baaHash : null,
    baaVersion: hipaaAnswer === "yes" ? BAA_VERSION : null,
    baaIp: req.ip,
    baaUserAgent: req.get("user-agent"),
    emailCheckSkipped: skipEmailCheck,
  });
  if (skipEmailCheck) return res.redirect(`/checkout.html?id=${pendingId}`);
  const sent = await sendSignupCode(pendingId, address, req);
  if (!sent || !sent.ok) return res.redirect("/signup.html?error=emailsend");
  res.redirect(`/verify-email.html?id=${pendingId}`);
});

async function sendSignupCode(pendingId, address, req) {
  const code = emailOtp.generateCode();
  const issued = await db.issuePendingEmailCode(pendingId, emailOtp.hashCode(code), emailOtp.expiresAt());
  if (!issued.ok) return issued;
  try {
    await email.sendEmail({
      to: address,
      subject: "Your CallTrove verification code",
      text: `Your CallTrove verification code is: ${code}\n\nEnter it to continue signing up. It expires in 10 minutes. If you didn't try to sign up, you can ignore this email.`,
      html: email.otpCodeEmailHtml(code, {
        heading: "Verify your email",
        explain: "Enter this code to continue signing up for CallTrove.",
        securityNote: "Didn't try to sign up? You can ignore this email -- nothing happens unless the code is used.",
        requestIp: req.ip,
        baseUrl: `${req.protocol}://${req.get("host")}`,
      }),
    });
  } catch (err) {
    console.error("[signup] failed to send verification code:", err);
    await db.revertPendingEmailCode(pendingId).catch(() => {});
    return { ok: false, reason: "send_failed" };
  }
  return { ok: true };
}

// Prices shown on the sign-up pages before anyone commits to anything.
router.get("/plans", (req, res) => {
  const paddleModule = require("../paddle");
  const billingRates = require("../billingRates");
  const plan = (hipaa) => {
    const tier = billingRates.storageTier(hipaa ? "hipaa" : "standard");
    const checkout = paddleModule.checkoutConfig(hipaa);
    return { priceLabel: checkout ? checkout.priceLabel : null, freeGB: tier.freeGB, overagePerGbMonth: tier.overagePerGbMonth };
  };
  res.json({
    standard: plan(false),
    hipaa: plan(true),
    rates: { transcriptionPerMinute: billingRates.CLIENT_TRANSCRIPTION_PER_MINUTE, aiSummaryPerCall: billingRates.CLIENT_AI_SUMMARY_PER_CALL },
  });
});

// Public checkout details for a waiting sign-up (the id is an unguessable
// UUID the browser was just redirected with). Says nothing about the
// password or anything else they entered beyond what the page displays.
const checkoutLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get("/checkout-config", checkoutLimiter, async (req, res) => {
  const id = String(req.query.id || "");
  const pending = UUID_RE.test(id) ? await db.getPendingSignup(id) : null;
  if (!pending) return res.status(404).json({ error: "not found" });
  if (pending.consumedTenantId) return res.json({ ready: true });
  if (!pending.emailOk) return res.status(403).json({ needsVerification: true });
  const paddleModule = require("../paddle");
  const billingRates = require("../billingRates");
  const checkout = paddleModule.checkoutConfig(pending.hipaaRequested);
  if (!checkout) return res.status(503).json({ error: "billing not configured" });
  const tier = billingRates.storageTier(pending.hipaaRequested ? "hipaa" : "standard");
  res.json({
    ready: false,
    hipaaRequested: pending.hipaaRequested,
    checkout: { ...checkout, pendingSignupId: pending.id, email: pending.email },
    storage: { freeGB: tier.freeGB, overagePerGbMonth: tier.overagePerGbMonth },
    rates: { transcriptionPerMinute: billingRates.CLIENT_TRANSCRIPTION_PER_MINUTE, aiSummaryPerCall: billingRates.CLIENT_AI_SUMMARY_PER_CALL },
  });
});

// --- confirming the email before payment ---

function maskEmail(address) {
  const [name, domain] = String(address).split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}
const secondsUntilResend = (last) => (last ? Math.max(0, 30 - Math.floor((Date.now() - new Date(last).getTime()) / 1000)) : 0);

router.get("/verify-status", checkoutLimiter, async (req, res) => {
  const id = String(req.query.id || "");
  const pending = UUID_RE.test(id) ? await db.getPendingSignup(id) : null;
  if (!pending) return res.status(404).json({ error: "not found" });
  res.json({
    verified: pending.emailOk || !!pending.consumedTenantId,
    email: maskEmail(pending.email),
    hipaaRequested: pending.hipaaRequested,
    resendIn: secondsUntilResend(pending.emailCodeLastSent),
  });
});

const verifyCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: "ratelimit" }),
});

router.post("/verify-code", verifyCodeLimiter, express.json(), async (req, res) => {
  const id = String((req.body || {}).id || "");
  const code = String((req.body || {}).code || "").trim();
  if (!UUID_RE.test(id)) return res.status(404).json({ error: "not found" });
  // A wrong code is ordinary user input, not a failed request: answer 200 so
  // it doesn't show up as a network error in the browser console.
  if (!/^\d{6}$/.test(code)) return res.json({ ok: false, error: "incorrect" });
  const result = await db.checkPendingEmailCode(id, emailOtp.hashCode(code));
  if (result === "ok") return res.json({ ok: true });
  res.status(result === "missing" ? 404 : 200).json({ ok: false, error: result });
});

router.post("/resend-code", verifyCodeLimiter, express.json(), async (req, res) => {
  const id = String((req.body || {}).id || "");
  const pending = UUID_RE.test(id) ? await db.getPendingSignup(id) : null;
  if (!pending || pending.consumedTenantId || pending.emailOk) return res.status(404).json({ error: "not found" });
  const sent = await sendSignupCode(id, pending.email, req);
  if (sent && sent.ok) return res.json({ ok: true, resendIn: 30 });
  if (sent && sent.reason === "cooldown") return res.json({ ok: false, error: "cooldown", resendIn: Math.max(1, secondsUntilResend(pending.emailCodeLastSent)) });
  if (sent && sent.reason === "limit") return res.json({ ok: false, error: "limit" });
  res.status(502).json({ error: "send_failed" });
});

router.get("/checkout-status", checkoutLimiter, async (req, res) => {
  const id = String(req.query.id || "");
  const pending = UUID_RE.test(id) ? await db.getPendingSignup(id) : null;
  if (!pending) return res.status(404).json({ error: "not found" });
  res.json({ ready: !!pending.consumedTenantId });
});

// Same brute-force shape as mfaLimiter above -- keyed by the token itself
// (unguessable, 192 bits of randomness) rather than IP, so it can't be
// dodged by switching IPs, and multiple invitees redeeming links from the
// same office IP never share a budget.
const setPasswordLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.token) || req.ip,
});

// Read-only check the set-password page calls on load (public/set-password.js)
// so someone with an already-used or expired link finds out immediately,
// rather than typing a password just to be told "invalid" on submit.
router.get("/set-password/validate", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ valid: false });
  const user = await db.getUserByInviteTokenHash(createHash("sha256").update(token).digest("hex"));
  res.json({ valid: !!user, username: user ? user.username : null });
});

// Activates an account created by routes/admin.js's POST /users/invite --
// the token stands in for a password on this one request only (there's no
// session yet), and db.redeemInviteToken re-checks its hash and expiry
// itself so the same link can never be redeemed twice even under a race.
router.post("/set-password", express.urlencoded({ extended: false }), setPasswordLimiter, async (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  if (!token) return res.redirect("/login.html?error=1");
  if (!password || password !== confirmPassword) {
    return res.redirect(`/set-password.html?token=${encodeURIComponent(token)}&error=mismatch`);
  }
  if (password.length < 8) {
    return res.redirect(`/set-password.html?token=${encodeURIComponent(token)}&error=tooshort`);
  }

  const { hash, salt } = hashPassword(password);
  const ok = await db.redeemInviteToken(createHash("sha256").update(token).digest("hex"), hash, salt);
  if (!ok) {
    return res.redirect("/set-password.html?error=invalid");
  }
  res.redirect("/login.html?activated=1");
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
