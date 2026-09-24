const express = require("express");
const qrcode = require("qrcode-generator");
const db = require("../db");
const totp = require("../totp");
const { getPlayback, getBuffer } = require("../storage");
const transcription = require("../transcription");
const { requireCsrf, requireAccount, verifyPassword } = require("../auth");
const RECOVERY_CODE_COUNT = 10;

// Same rule as routes/auth.js's mfaRequiredFor -- admin/operator logins
// can't self-service their way out of the mandatory-MFA policy that
// forces them through enrollment at login in the first place.
function mfaRequiredFor(user) {
  return user.role === "admin" || user.isOperator;
}

const router = express.Router();

// See the on-demand /calls/:id/transcribe route below -- each attempt is a
// real, separately billed AWS Transcribe job whether or not it succeeds.
const MAX_TRANSCRIPTION_ATTEMPTS = 3;

// Regular users are always scoped to calls they handled -- this is the real
// security boundary and never changes based on request input. Admins see
// everything by default, but can optionally narrow the *list views* to a
// specific GHL user via ?viewAs= for monitoring/spot-checking one agent;
// that's a convenience filter, not a restriction on the admin's own access.
function listFilter(req) {
  if (req.session.user.role === "admin") return req.query.viewAs || undefined;
  return req.session.user.ghlUserId;
}

// HIPAA's audit-controls rule (45 CFR 164.312(b)) expects both successful
// and denied access attempts recorded -- a denial is itself a
// security-relevant event (someone trying to reach a call that isn't
// theirs). Scoped to actual content access (recording playback/download,
// transcript reads, transcription requests) rather than every list-view
// fetch, which is just metadata browsing, not PHI access.
function logAccess(req, { action, callId, success, denialReason }) {
  return db.logPhiAccess({
    userId: req.session.user.id,
    username: req.session.user.username,
    action,
    callId,
    success,
    denialReason,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
    tenantId: req.session.user.tenantId,
  });
}

// Reachable even while the tenant is cancellation_pending/canceled (see
// REACHABLE_WHILE_CANCELED in src/auth.js) -- account-canceled.html polls
// this to show the right message, and (for the owner) the restore
// button. isOwner decides whether that button renders at all.
router.get("/tenant/status", async (req, res) => {
  const tenant = await db.getTenantById(req.session.user.tenantId);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });
  res.json({
    name: tenant.name,
    status: tenant.status,
    purgeAt: tenant.purgeAt,
    isOwner: tenant.ownerUserId === req.session.user.id,
    // Same env var src/routes/admin.js's POST /tenant/cancel reads --
    // exposed here too so the Settings "Danger zone" copy (and this
    // status view) shows the real configured value instead of a
    // hardcoded guess that could drift from it.
    gracePeriodDays: Number(process.env.CANCELLATION_GRACE_PERIOD_DAYS || 7),
  });
});

router.get("/me", async (req, res) => {
  const { username, role, ghlUserId, tenantId, accountIds, isOperator } = req.session.user;
  // The switcher's own data: every account this login can pick between,
  // with names (accountIds on the session is just the id list used for
  // fast per-request validation in requireAccount).
  const accounts = await db.listAccessibleAccounts(req.session.user.id, role, tenantId);
  const tenant = await db.getTenantById(tenantId);
  res.json({
    username,
    role,
    ghlUserId,
    isOperator,
    accounts,
    currentAccountId: req.query.accountId && accountIds.includes(req.query.accountId) ? req.query.accountId : accountIds[0] || null,
    transcriptionEnabled: transcription.isEnabled(),
    csrfToken: req.session.csrfToken,
    // Set only during the grace period (before lockout, which requireAuth
    // enforces once purgeAt actually passes) -- lets every page show a
    // banner so nobody on the account is caught off guard by a lockout
    // they never knew was coming.
    cancellationPending: tenant && tenant.status === "cancellation_pending" ? { purgeAt: tenant.purgeAt } : null,
  });
});

// --- Authenticator-app MFA (self-service, TOTP -- see src/totp.js) ---

router.get("/account/mfa", async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  res.json({
    enabled: Boolean(user.totpEnabled),
    recoveryCodesRemaining: user.totpEnabled ? await db.countUnusedRecoveryCodes(user.id) : 0,
  });
});

// Starts (or restarts) enrollment: a fresh secret, not yet confirmed. Safe
// to call again if a user abandons the flow partway through -- it just
// overwrites the unconfirmed secret, and totp_enabled was never true.
router.post("/account/mfa/setup", requireCsrf, async (req, res) => {
  const secret = totp.generateSecret();
  await db.setUserTotpSecret(req.session.user.id, secret);
  res.json({ manualEntryKey: secret });
});

// Same-origin image, not a data: URI -- keeps the CSP's imgSrc at 'self'
// with no carve-out needed. Scoped to the calling user's own row; there's
// no id in the URL to guess or leak.
router.get("/account/mfa/qr", async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (!user.totpSecret) return res.status(404).end();

  const qr = qrcode(0, "M");
  qr.addData(totp.otpauthUrl({ secret: user.totpSecret, username: user.username }));
  qr.make();
  res.setHeader("Content-Type", "image/svg+xml");
  res.send(qr.createSvgTag(4, 0));
});

// Proves the user actually scanned the code (not just that a secret was
// generated) before flipping totp_enabled on -- see schema.sql's comment
// on totp_secret. Recovery codes are generated and returned exactly once,
// here -- only their hash is ever stored (see src/totp.js).
router.post("/account/mfa/confirm", requireCsrf, async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (!user.totpSecret) return res.status(400).json({ error: "start setup first" });

  const code = String((req.body || {}).code || "").trim();
  if (!totp.verifyTotp(user.totpSecret, code)) {
    return res.status(400).json({ error: "incorrect code" });
  }

  await db.enableUserTotp(user.id);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => totp.generateRecoveryCode());
  await db.replaceRecoveryCodes(user.id, codes.map(totp.hashRecoveryCode));
  res.json({ status: "enabled", recoveryCodes: codes });
});

// Re-requires the current password, same as change-password -- turning off
// a security control is exactly the kind of action a hijacked-but-still-
// logged-in session shouldn't be able to do on its own.
router.post("/account/mfa/disable", requireCsrf, async (req, res) => {
  const user = await db.getUserByUsername(req.session.user.username);
  if (mfaRequiredFor(user)) {
    return res.status(400).json({ error: "two-factor authentication is required for admin/operator logins and can't be turned off here -- ask another admin to do it from Team members if you've lost access" });
  }
  const password = (req.body || {}).password;
  if (!password || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return res.status(400).json({ error: "incorrect password" });
  }
  await db.disableUserTotp(user.id);
  res.json({ status: "disabled" });
});

router.post("/account/mfa/recovery-codes/regenerate", requireCsrf, async (req, res) => {
  const user = await db.getUserByUsername(req.session.user.username);
  const password = (req.body || {}).password;
  if (!password || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return res.status(400).json({ error: "incorrect password" });
  }
  if (!user.totpEnabled) return res.status(400).json({ error: "MFA is not enabled" });

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => totp.generateRecoveryCode());
  await db.replaceRecoveryCodes(user.id, codes.map(totp.hashRecoveryCode));
  res.json({ status: "regenerated", recoveryCodes: codes });
});

router.get("/contacts", requireAccount, async (req, res) => {
  // ?all=1 -- the dedicated Contacts (A-Z) page's full directory, as
  // opposed to the sidebar's capped, search-only quick-jump list.
  if (req.query.all !== undefined) {
    const contacts = await db.listAllContacts(listFilter(req), req.ghlAccountId);
    return res.json(contacts);
  }
  const contacts = await db.listContacts(req.query.search, listFilter(req), req.ghlAccountId);
  res.json(contacts);
});

router.get("/dispositions", requireAccount, async (req, res) => {
  const dispositions = await db.listDistinctDispositions(listFilter(req), req.ghlAccountId);
  res.json(dispositions);
});

// The unified call-search endpoint -- contactId is optional ("all
// contacts"), dateFrom/dateTo are optional 'YYYY-MM-DD' strings, page/
// pageSize drive pagination (20/50/100, validated in db.listCalls).
// requireAccount pins every result to exactly one connected GHL account
// (req.ghlAccountId) -- never a blend of everything the user can see --
// so switching accounts is a real data boundary, not just a UI filter.
router.get("/calls", requireAccount, async (req, res) => {
  const { contactId, dateFrom, dateTo, disposition, direction, hasRecording, page, pageSize } = req.query;
  const result = await db.listCalls({
    contactId: contactId || undefined,
    ghlUserId: listFilter(req),
    ghlAccountId: req.ghlAccountId,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    disposition: disposition || undefined,
    direction: direction || undefined,
    hasRecording: hasRecording === undefined ? undefined : hasRecording === "true",
    page,
    pageSize,
  });
  res.json(result);
});

// Stat-tile summary behind the dashboard header -- same filters as
// /calls, aggregated instead of paginated.
router.get("/calls/stats", requireAccount, async (req, res) => {
  const { contactId, dateFrom, dateTo, disposition, direction, hasRecording } = req.query;
  const stats = await db.getCallStats({
    contactId: contactId || undefined,
    ghlUserId: listFilter(req),
    ghlAccountId: req.ghlAccountId,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    disposition: disposition || undefined,
    direction: direction || undefined,
    hasRecording: hasRecording === undefined ? undefined : hasRecording === "true",
  });
  res.json(stats);
});

function buildDownloadFilename(call) {
  const ext = call.storageKey.split(".").pop();
  const who = (call.name || call.phone || call.contactId || "call").replace(/[^a-zA-Z0-9]+/g, "_");
  const date = call.occurredAt ? new Date(call.occurredAt).toISOString().slice(0, 10) : "unknown-date";
  return `${who}_${date}_${call.direction || "call"}.${ext}`;
}

router.get("/calls/:id/recording", async (req, res) => {
  const call = await db.getCall(req.params.id);
  if (!call || !call.storageKey) {
    return res.status(404).json({ error: "recording not found" });
  }

  // Enforced here too, not just in the list views -- a user must not be
  // able to fetch another user's recording just by knowing/guessing its URL.
  // Admins always have access regardless of any ?viewAs= list filter, but
  // the account check below still applies to everyone, admins included --
  // it's the multi-tenant boundary (which GHL account this call belongs
  // to), not the within-account ghlUserId one.
  const download = req.query.download !== undefined;
  if (!(req.session.user.accountIds || []).includes(call.ghlAccountId)) {
    await logAccess(req, {
      action: download ? "recording_downloaded" : "recording_played",
      callId: call.id,
      success: false,
      denialReason: "not_your_account",
    });
    return res.status(403).json({ error: "not your account" });
  }
  if (req.session.user.role !== "admin" && call.handledById !== req.session.user.ghlUserId) {
    await logAccess(req, {
      action: download ? "recording_downloaded" : "recording_played",
      callId: call.id,
      success: false,
      denialReason: "not_your_call",
    });
    return res.status(403).json({ error: "not your call" });
  }

  const filename = download ? buildDownloadFilename(call) : undefined;
  await logAccess(req, {
    action: download ? "recording_downloaded" : "recording_played",
    callId: call.id,
    success: true,
  });

  const playback = await getPlayback(call.storageKey, filename);
  if (playback.redirectUrl) {
    return res.redirect(playback.redirectUrl);
  }
  if (playback.stream) {
    if (filename) {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }
    return playback.stream.pipe(res);
  }
  return res.status(404).json({ error: "recording not found" });
});

router.get("/calls/:id/transcript", async (req, res) => {
  const call = await db.getCall(req.params.id);
  if (!call) return res.status(404).json({ error: "call not found" });

  // Same access boundaries as the recording itself.
  if (!(req.session.user.accountIds || []).includes(call.ghlAccountId)) {
    await logAccess(req, { action: "transcript_viewed", callId: call.id, success: false, denialReason: "not_your_account" });
    return res.status(403).json({ error: "not your account" });
  }
  if (req.session.user.role !== "admin" && call.handledById !== req.session.user.ghlUserId) {
    await logAccess(req, { action: "transcript_viewed", callId: call.id, success: false, denialReason: "not_your_call" });
    return res.status(403).json({ error: "not your call" });
  }

  await logAccess(req, { action: "transcript_viewed", callId: call.id, success: true });
  res.json({ status: call.transcriptionStatus, transcript: call.transcript });
});

// On-demand only -- nothing calls this automatically (see src/poller.js and
// src/backfill.js). Kicks off one call's transcription job; completion is
// picked up later by src/transcriptionPoller.js like any other job.
router.post("/calls/:id/transcribe", requireCsrf, async (req, res) => {
  if (!transcription.isEnabled()) {
    return res.status(400).json({ error: "transcription is not enabled" });
  }

  const call = await db.getCall(req.params.id);
  if (!call || !call.storageKey) {
    return res.status(404).json({ error: "recording not found" });
  }
  if (!(req.session.user.accountIds || []).includes(call.ghlAccountId)) {
    await logAccess(req, { action: "transcription_requested", callId: call.id, success: false, denialReason: "not_your_account" });
    return res.status(403).json({ error: "not your account" });
  }
  if (req.session.user.role !== "admin" && call.handledById !== req.session.user.ghlUserId) {
    await logAccess(req, { action: "transcription_requested", callId: call.id, success: false, denialReason: "not_your_call" });
    return res.status(403).json({ error: "not your call" });
  }
  if (call.transcriptionStatus === "pending" || call.transcriptionStatus === "completed") {
    return res.status(409).json({ error: `transcription already ${call.transcriptionStatus}` });
  }
  // 'failed' is deliberately retryable -- a transient AWS issue shouldn't
  // leave a call stuck forever -- but each attempt is a real, separately
  // billed Transcribe job whether or not it succeeds. Capped so a bad
  // recording (or a bug, or someone just clicking the button) can't rack
  // up an unbounded number of jobs against the same audio.
  if (call.transcriptionAttempts >= MAX_TRANSCRIPTION_ATTEMPTS) {
    return res.status(409).json({
      error: `transcription failed ${call.transcriptionAttempts} times for this call -- not retrying automatically. Contact support if this recording should transcribe.`,
    });
  }

  try {
    const buffer = await getBuffer(call.storageKey);
    const extension = call.storageKey.split(".").pop();
    await transcription.startJob(call.id, buffer, extension);
    await db.markTranscriptionPending(call.id);
    await logAccess(req, { action: "transcription_requested", callId: call.id, success: true });
    res.json({ status: "pending" });
  } catch (err) {
    console.error(`[api] failed to start transcription for call ${call.id}:`, err);
    res.status(500).json({ error: "failed to start transcription" });
  }
});

module.exports = router;
