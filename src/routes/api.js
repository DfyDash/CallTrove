const express = require("express");
const db = require("../db");
const { getPlayback, getBuffer } = require("../storage");
const transcription = require("../transcription");
const { requireCsrf, requireAccount } = require("../auth");

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
  const { username, role, ghlUserId, tenantId, accountIds } = req.session.user;
  // The switcher's own data: every account this login can pick between,
  // with names (accountIds on the session is just the id list used for
  // fast per-request validation in requireAccount).
  const accounts = await db.listAccessibleAccounts(req.session.user.id, role, tenantId);
  const tenant = await db.getTenantById(tenantId);
  res.json({
    username,
    role,
    ghlUserId,
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
