const express = require("express");
const db = require("../db");
const { getPlayback, getBuffer } = require("../storage");
const transcription = require("../transcription");
const { requireCsrf } = require("../auth");

const router = express.Router();

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

router.get("/me", (req, res) => {
  const { username, role, ghlUserId } = req.session.user;
  res.json({
    username,
    role,
    ghlUserId,
    transcriptionEnabled: transcription.isEnabled(),
    csrfToken: req.session.csrfToken,
  });
});

router.get("/contacts", async (req, res) => {
  // ?all=1 -- the dedicated Contacts (A-Z) page's full directory, as
  // opposed to the sidebar's capped, search-only quick-jump list.
  if (req.query.all !== undefined) {
    const contacts = await db.listAllContacts(listFilter(req));
    return res.json(contacts);
  }
  const contacts = await db.listContacts(req.query.search, listFilter(req));
  res.json(contacts);
});

router.get("/dispositions", async (req, res) => {
  const dispositions = await db.listDistinctDispositions(listFilter(req));
  res.json(dispositions);
});

// The unified call-search endpoint -- contactId is optional ("all
// contacts"), dateFrom/dateTo are optional 'YYYY-MM-DD' strings, page/
// pageSize drive pagination (20/50/100, validated in db.listCalls).
router.get("/calls", async (req, res) => {
  const { contactId, dateFrom, dateTo, disposition, direction, hasRecording, page, pageSize } = req.query;
  const result = await db.listCalls({
    contactId: contactId || undefined,
    ghlUserId: listFilter(req),
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
router.get("/calls/stats", async (req, res) => {
  const { contactId, dateFrom, dateTo, disposition, direction, hasRecording } = req.query;
  const stats = await db.getCallStats({
    contactId: contactId || undefined,
    ghlUserId: listFilter(req),
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
  // Admins always have access regardless of any ?viewAs= list filter.
  const download = req.query.download !== undefined;
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

  // Same access boundary as the recording itself.
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
  if (req.session.user.role !== "admin" && call.handledById !== req.session.user.ghlUserId) {
    await logAccess(req, { action: "transcription_requested", callId: call.id, success: false, denialReason: "not_your_call" });
    return res.status(403).json({ error: "not your call" });
  }
  if (call.transcriptionStatus === "pending" || call.transcriptionStatus === "completed") {
    return res.status(409).json({ error: `transcription already ${call.transcriptionStatus}` });
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
