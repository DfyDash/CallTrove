const express = require("express");
const { randomUUID, randomBytes } = require("crypto");
const archiver = require("archiver");
const db = require("../db");
const ghlApi = require("../ghlApi");
const ghlOAuth = require("../ghlOAuth");
const accountCredentials = require("../accountCredentials");
const backfill = require("../backfill");
const { getBuffer } = require("../storage");
const { hashPassword, requireAdmin, requireAccount, requireCsrf } = require("../auth");
const { loginLimiter, limiterKey } = require("./auth");

const router = express.Router();

router.use(requireAdmin);

function log(req, action, message) {
  return db.logAudit({ actorId: req.session.user.id, actorUsername: req.session.user.username, action, message, tenantId: req.session.user.tenantId });
}

// The GHL API client for one tenant's own connected account -- never the
// bare `ghlApi` module default, which is the legacy single static-token
// client shared by the whole deployment regardless of who's asking. Used
// wherever this file needs to call GHL on a specific admin's behalf (the
// GHL user picker below). Picks the tenant's first connected account,
// same "no account switcher for this" default every other tenant-wide
// (not per-account) admin feature already uses. Falls back to the bare
// ghlApi client only when the tenant has no connected account at all --
// isConfigured() then correctly reflects the *deployment's* legacy
// static token, not this tenant's own connection state, but that's the
// same fallback accountCredentials.clientForAccount already relies on for
// the legacy default account itself.
async function ghlApiForTenant(tenantId) {
  // listGhlAccountsForTenant doesn't select the token fields (it's the
  // display-only list for the GHL accounts tab) -- listActiveGhlAccountsForTenant
  // does, which clientForAccount needs to tell a real OAuth-connected
  // account apart from the legacy default (see its own comment).
  const accounts = await db.listActiveGhlAccountsForTenant(tenantId);
  if (!accounts.length) return ghlApi;
  return accountCredentials.clientForAccount(accounts[0]);
}

// --- Account cancellation (owner-only, grace period then purge -- see
// src/tenantPurge.js for the actual deletion, and schema.sql's
// migration comment for why status/timestamps live on tenants). ---

// No billing system exists yet to derive "whoever is paying" from, so
// tenants.owner_user_id is the stand-in: set once at tenant creation
// (backfilled to the original admin for today's single deployment).
// Deliberately a hard 403, not just hidden UI -- even another admin on
// the same tenant must not be able to cancel it.
// 7 days, not longer, specifically because the bulk export (see "Bulk
// export" above) means there's no reason someone would need weeks to
// grab a copy of everything -- unlike GHL itself, which has no
// equivalent one-click "download all my data" feature.
const CANCELLATION_GRACE_PERIOD_DAYS = Number(process.env.CANCELLATION_GRACE_PERIOD_DAYS || 7);

// GET /api/tenant/status (routes/api.js) is what actually serves status
// to the frontend -- it isn't admin-gated, since a locked-out NON-admin
// user of a canceled tenant still needs to see "contact your account
// owner" and /api/admin/* would 403 them before they got that far.

router.post("/tenant/cancel", requireCsrf, async (req, res) => {
  const tenant = await db.getTenantById(req.session.user.tenantId);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });
  if (tenant.ownerUserId !== req.session.user.id) {
    return res.status(403).json({ error: "only the account owner can cancel this account" });
  }
  if (req.body?.confirmName !== tenant.name) {
    return res.status(400).json({ error: "confirmation text did not match the account name" });
  }
  if (tenant.status !== "active") {
    return res.status(409).json({ error: `account is already ${tenant.status}` });
  }

  const purgeAt = new Date(Date.now() + CANCELLATION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  await db.requestTenantCancellation(tenant.id, purgeAt);
  await log(req, "tenant_cancellation_requested", `Cancellation requested for "${tenant.name}", data purge scheduled for ${purgeAt.toISOString()}`);
  res.json({ status: "cancellation_pending", purgeAt });
});

// Reachable even while cancellation_pending (see REACHABLE_WHILE_CANCELED
// in src/auth.js) -- this is the one action a locked-out owner still
// needs to be able to take.
router.post("/tenant/restore", requireCsrf, async (req, res) => {
  const tenant = await db.getTenantById(req.session.user.tenantId);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });
  if (tenant.ownerUserId !== req.session.user.id) {
    return res.status(403).json({ error: "only the account owner can restore this account" });
  }
  if (tenant.status !== "cancellation_pending") {
    return res.status(409).json({ error: `account is not pending cancellation (status: ${tenant.status})` });
  }

  await db.restoreTenant(tenant.id);
  await log(req, "tenant_cancellation_restored", `Cancellation reversed for "${tenant.name}"`);
  res.json({ status: "active" });
});

// Auto-links any user whose login username matches a GHL user's email
// (case-insensitively), so the common case -- login username is the
// person's email, same as in GHL -- doesn't require manually picking
// them from the dropdown. Only fills in users with no link yet; never
// overrides a link an admin already set.
async function autoLinkGhlUsers(users, api) {
  const unlinked = users.filter((u) => !u.ghlUserId);
  if (!unlinked.length || !api.isConfigured()) return users;

  let ghlUsers;
  try {
    ghlUsers = await api.listUsers();
  } catch (err) {
    console.error("[admin] could not auto-link GHL users:", err);
    return users;
  }
  const byEmail = new Map(ghlUsers.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u]));

  for (const user of unlinked) {
    const match = byEmail.get(user.username.toLowerCase());
    if (!match) continue;
    await db.updateUser(user.id, { ghlUserId: match.id, ghlUserName: match.name || match.email });
    user.ghlUserId = match.id;
    user.ghlUserName = match.name || match.email;
  }
  return users;
}

router.get("/users", async (req, res) => {
  const api = await ghlApiForTenant(req.session.user.tenantId);
  const users = await autoLinkGhlUsers(await db.listUsers(req.session.user.tenantId), api);

  // accountIds: null for an admin (they bypass the grant table and see
  // every account their tenant owns -- see db.listAccessibleAccounts),
  // otherwise the real list of connected accounts this user has been
  // explicitly granted. The Team members UI only shows the checklist for
  // the latter case.
  const grants = await db.listUserAccountAccessForTenant(req.session.user.tenantId);
  const accountIdsByUser = {};
  for (const g of grants) {
    (accountIdsByUser[g.userId] = accountIdsByUser[g.userId] || []).push(g.ghlAccountId);
  }
  const usersWithAccess = users.map((u) => ({
    ...u,
    accountIds: u.role === "admin" ? null : accountIdsByUser[u.id] || [],
  }));
  res.json(usersWithAccess);
});

// Reconciles one user's connected-account grants to exactly the given
// list (rather than one grant/revoke call per checkbox) -- simpler for
// the UI, which just posts whatever's checked. allowedIds filters out
// anything not actually owned by the admin's own tenant, so this can
// never be used to grant access into a different tenant's account.
router.put("/users/:id/account-access", requireCsrf, async (req, res) => {
  const { accountIds } = req.body || {};
  if (!Array.isArray(accountIds)) {
    return res.status(400).json({ error: "accountIds must be an array" });
  }
  const target = await db.getUserById(req.params.id);
  if (!target || target.tenantId !== req.session.user.tenantId) {
    return res.status(404).json({ error: "user not found" });
  }

  const tenantAccounts = await db.listGhlAccountsForTenant(req.session.user.tenantId);
  const allowedIds = new Set(tenantAccounts.map((a) => a.id));
  const current = await db.listAccessibleAccounts(target.id, target.role, req.session.user.tenantId);
  const currentIds = new Set(current.map((a) => a.id));
  const nextIds = new Set(accountIds.filter((id) => allowedIds.has(id)));

  for (const id of nextIds) {
    if (!currentIds.has(id)) await db.grantUserAccountAccess(target.id, id);
  }
  for (const id of currentIds) {
    if (!nextIds.has(id)) await db.revokeUserAccountAccess(target.id, id);
  }

  await log(req, "user_account_access_updated", `Updated connected-account access for "${target.username}"`);
  res.json({ status: "updated" });
});

// The real GHL user list, for populating a picker in the admin UI instead
// of requiring someone to hand-type a phoneCall.user.id value.
router.get("/ghl-users", async (req, res) => {
  const api = await ghlApiForTenant(req.session.user.tenantId);
  if (!api.isConfigured()) return res.json([]);
  try {
    const users = await api.listUsers();
    res.json(users);
  } catch (err) {
    console.error("[admin] failed to fetch GHL users:", err);
    res.status(502).json({ error: "could not fetch GHL user list" });
  }
});

router.post("/users", requireCsrf, async (req, res) => {
  const { username, password, role, ghlUserId, ghlUserName } = req.body || {};
  if (!username || !password || !["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "username, password, and a valid role are required" });
  }
  const existing = await db.getUserByUsername(username);
  if (existing) return res.status(409).json({ error: "username already taken" });

  const { hash, salt } = hashPassword(password);
  await db.createUser({
    id: randomUUID(),
    username,
    passwordHash: hash,
    passwordSalt: salt,
    role,
    ghlUserId,
    ghlUserName,
    tenantId: req.session.user.tenantId,
  });
  await log(req, "user_created", `Created user "${username}" (role: ${role})`);
  res.status(201).json({ status: "created" });
});

router.put("/users/:id", requireCsrf, async (req, res) => {
  const { role, ghlUserId, ghlUserName, password } = req.body || {};
  if (role !== undefined && !["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "invalid role" });
  }
  const target = await db.getUserById(req.params.id);
  if (!target || target.tenantId !== req.session.user.tenantId) {
    return res.status(404).json({ error: "user not found" });
  }
  const update = { role, ghlUserId, ghlUserName };
  if (password) {
    const { hash, salt } = hashPassword(password);
    update.passwordHash = hash;
    update.passwordSalt = salt;
  }
  await db.updateUser(req.params.id, update);

  // A reset should actually unlock them, not leave them waiting out the
  // login rate limit's window under their old, now-wrong password.
  if (password && target) {
    await loginLimiter.resetKey(limiterKey(target.username));
  }

  const who = target ? target.username : req.params.id;
  const changes = [];
  if (role !== undefined) changes.push(`role → ${role}`);
  if (ghlUserId !== undefined) changes.push(`GHL user → ${ghlUserName || ghlUserId || "(none)"}`);
  if (password) changes.push("password reset");
  if (changes.length) await log(req, "user_updated", `Updated user "${who}": ${changes.join(", ")}`);

  res.json({ status: "updated" });
});

router.delete("/users/:id", requireCsrf, async (req, res) => {
  if (req.params.id === req.session.user.id) {
    return res.status(400).json({ error: "cannot delete your own account while logged in as it" });
  }
  const target = await db.getUserById(req.params.id);
  if (!target || target.tenantId !== req.session.user.tenantId) {
    return res.status(404).json({ error: "user not found" });
  }
  await db.deleteUser(req.params.id);
  await log(req, "user_deleted", `Deleted user "${target ? target.username : req.params.id}"`);
  res.json({ status: "deleted" });
});

// The escape hatch for a lost authenticator device with no recovery codes
// saved -- there's no self-service email-based recovery yet (see README's
// deferred list), so without this an admin has no way to unlock a
// teammate who's otherwise fully locked out. Same "requires an admin, not
// self-service" shape as the password reset above; unlike a password
// reset, this doesn't touch the person's password at all, only their MFA
// enrollment.
router.post("/users/:id/disable-mfa", requireCsrf, async (req, res) => {
  const target = await db.getUserById(req.params.id);
  if (!target || target.tenantId !== req.session.user.tenantId) {
    return res.status(404).json({ error: "user not found" });
  }
  await db.disableUserTotp(target.id);
  await log(req, "user_mfa_disabled", `Disabled two-factor authentication for user "${target.username}" (admin override)`);
  res.json({ status: "disabled" });
});

// Live, admin-toggleable, no redeploy needed. Only affects calls the live
// poller picks up after this is read (see poller.js) -- never retroactive.
// requireAccount both resolves which account (?accountId=, validated
// against the admin's own accountIds) and rejects one they don't have
// access to -- the same boundary every other account-scoped route uses, so
// an admin on one tenant can never read or flip this for an account that
// isn't theirs.
router.get("/settings", requireAccount, async (req, res) => {
  res.json({ autoTranscribeEnabled: await db.getAutoTranscribeEnabled(req.ghlAccountId) });
});

router.put("/settings", requireAccount, requireCsrf, async (req, res) => {
  const enabled = Boolean((req.body || {}).autoTranscribeEnabled);
  await db.setAutoTranscribeEnabled(req.ghlAccountId, enabled);
  await log(req, "auto_transcribe_toggled", `Turned automatic transcription ${enabled ? "ON" : "OFF"} for account ${req.ghlAccountId}`);
  res.json({ autoTranscribeEnabled: enabled });
});

// --- Connected GHL accounts (multi-tenant: one tenant, many locations) ---

router.get("/ghl-accounts", async (req, res) => {
  const accounts = await db.listGhlAccountsForTenant(req.session.user.tenantId);
  res.json({ accounts, oauthConfigured: ghlOAuth.isConfigured() });
});

// Redirects into GHL's own "choose a location, then authorize" screen.
// The random state is stashed on the session and checked back on the
// callback below -- standard OAuth CSRF protection (stops a forged
// callback from linking an attacker-chosen account into this tenant).
router.get("/ghl-oauth/connect", (req, res) => {
  if (!ghlOAuth.isConfigured()) {
    return res.status(400).json({ error: "GHL OAuth is not configured on this deployment yet" });
  }
  const state = randomBytes(24).toString("hex");
  req.session.ghlOAuthState = state;
  res.redirect(ghlOAuth.buildAuthorizeUrl(state));
});

// Where GHL sends the browser back to after the admin approves the
// install. Tied to this tenant via req.session.user.tenantId -- whoever
// is logged into CallTrove when they click "Connect" is who the new
// account belongs to, not anything GHL itself reports (see the design
// discussion this followed: GHL's own login/account structure is
// irrelevant here, only the CallTrove session that started the flow).
router.get("/ghl-oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!state || state !== req.session.ghlOAuthState) {
    return res.status(400).send("This connection request has expired or is invalid. Please try connecting again from Settings.");
  }
  delete req.session.ghlOAuthState;
  if (!code) {
    return res.status(400).send("GHL did not return an authorization code.");
  }

  let tokens;
  try {
    tokens = await ghlOAuth.exchangeCodeForTokens(code);
  } catch (err) {
    console.error("[admin] GHL OAuth token exchange failed:", err);
    return res.status(502).send("Could not complete the connection to GHL. Please try again.");
  }

  const locationId = tokens.locationId;
  if (!locationId) {
    return res.status(400).send("GHL did not return a location for this install -- CallTrove connects one location at a time.");
  }

  const tokenFields = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
  };

  // Re-authorizing an already-connected location (a token refresh, or
  // reinstalling after an uninstall) updates it in place instead of
  // creating a duplicate ghl_accounts row for the same GHL location --
  // but only when it's already this same tenant's own account. Without
  // that check, someone with real GHL access to a location already
  // connected to a *different* tenant could silently re-point that
  // account's tokens onto their own session just by authorizing through
  // this same callback, which is a tenant-boundary break even though it
  // requires real GHL-side access to trigger.
  const existing = await db.getGhlAccountByLocationId(locationId);
  if (existing && existing.tenantId !== req.session.user.tenantId) {
    return res
      .status(409)
      .send("This GHL location is already connected to a different CallTrove account. Disconnect it there first, or contact support.");
  }
  if (existing) {
    await db.updateGhlAccountTokens(existing.id, tokenFields);
    await log(req, "ghl_account_reconnected", `Reconnected GHL location "${locationId}"`);
  } else {
    await db.createGhlAccount({
      id: randomUUID(),
      tenantId: req.session.user.tenantId,
      ghlLocationId: locationId,
      name: tokens.locationName || locationId,
      ...tokenFields,
    });
    await log(req, "ghl_account_connected", `Connected GHL location "${locationId}"`);
  }

  res.redirect("/settings.html?tab=team&connected=1");
});

// Historical backfill, on demand from the admin UI instead of someone
// having to SSH/SSM in and run `node src/backfill.js` by hand. Runs in the
// background (a full account history walk can take anywhere from under a
// minute to over an hour) -- the response returns immediately, and the
// frontend polls GET /backfill for progress. In-memory only: it doesn't
// need to survive a restart, and a restart mid-run just means the next
// run picks up where the last one left off (backfill skips calls it
// already has).
//
// Keyed by tenantId -- a single shared variable here would mean every
// tenant's Settings page showed whichever tenant's backfill happened to
// run most recently, "already running" included, regardless of whose
// accounts it actually was.
const backfillStateByTenant = new Map();
function getBackfillState(tenantId) {
  return backfillStateByTenant.get(tenantId) || { running: false, lastResult: null, lastError: null, startedAt: null, finishedAt: null };
}

router.get("/backfill", async (req, res) => {
  res.json(getBackfillState(req.session.user.tenantId));
});

router.post("/backfill", requireCsrf, async (req, res) => {
  const tenantId = req.session.user.tenantId;
  if (getBackfillState(tenantId).running) {
    return res.status(409).json({ error: "a backfill is already running" });
  }
  const state = { running: true, lastResult: null, lastError: null, startedAt: new Date(), finishedAt: null };
  backfillStateByTenant.set(tenantId, state);
  await log(req, "backfill_started", "Started a historical call backfill");

  backfill
    .run({ tenantId })
    .then(async (summary) => {
      backfillStateByTenant.set(tenantId, { ...state, running: false, lastResult: summary, finishedAt: new Date() });
      await log(
        req,
        "backfill_completed",
        `Backfill finished: ${summary.callsSaved} call${summary.callsSaved === 1 ? "" : "s"} saved, ` +
          `${summary.callsSkipped} already had, ${summary.callsFailed} failed to process ` +
          `(${summary.conversationsSeen} conversations scanned)`
      );
    })
    .catch(async (err) => {
      console.error("[admin] backfill failed:", err);
      backfillStateByTenant.set(tenantId, { ...state, running: false, lastError: err.message, finishedAt: new Date() });
      await log(req, "backfill_failed", `Backfill failed: ${err.message}`);
    });

  res.status(202).json(getBackfillState(tenantId));
});

// "Call Recording Coverage" -- storage health at a glance: how many calls
// have a recording captured vs. not, broken down by GHL's own disposition,
// plus the list of genuine gaps (completed calls with no recording -- as
// opposed to no-answer/busy/voicemail, which were never going to have one).
router.get("/coverage", async (req, res) => {
  const [summary, byDisposition, byMonth] = await Promise.all([
    db.getCoverageSummary(req.session.user.tenantId),
    db.getCoverageByDisposition(req.session.user.tenantId),
    db.getCoverageByMonth(req.session.user.tenantId),
  ]);
  res.json({ summary, byDisposition, byMonth });
});

// "Call report" -- per-rep volume/quality leaderboard. dateFrom/dateTo
// scope the totals to the tab's selected preset; the per-rep trailing-7-day
// trend is always the same fixed window regardless of that preset, so it's
// filled in here rather than left to the client to recompute.
router.get("/call-report", async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const [reps, trendRows] = await Promise.all([
    db.getCallReportByRep(req.session.user.tenantId, { dateFrom, dateTo }),
    db.getCallReportTrend(req.session.user.tenantId),
  ]);

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const trend = {};
  for (const rep of reps) {
    trend[rep.id] = days.map((day) => {
      const match = trendRows.find((r) => r.id === rep.id && r.day === day);
      return { day, count: match ? match.count : 0 };
    });
  }

  res.json({ reps, trend });
});

router.get("/coverage/gaps", async (req, res) => {
  const result = await db.listCoverageGaps(req.session.user.tenantId, { page: req.query.page, pageSize: req.query.pageSize });
  res.json(result);
});

router.get("/audit-log", async (req, res) => {
  const result = await db.listAuditLog(req.session.user.tenantId, { page: req.query.page, pageSize: req.query.pageSize });
  res.json(result);
});

// PHI-access log (who accessed which call's recording/transcript, when,
// success or denied) -- see routes/api.js. HIPAA's audit-controls rule
// expects this reviewed regularly, not just recorded, hence a real view
// rather than just rows sitting in the database.
router.get("/phi-access-log", async (req, res) => {
  const result = await db.listPhiAccessLog(req.session.user.tenantId, { page: req.query.page, pageSize: req.query.pageSize });
  res.json(result);
});

// Bulk export -- everyone's recordings (optionally date-filtered) as one
// streamed ZIP, not one-by-one. The main use case is getting a full copy
// of everything before an account is canceled and its storage purged (see
// the account-cancellation flow), but it's useful any time an admin wants
// an offline copy. Streams straight to the response as each file is read
// (archiver + one getBuffer() at a time) rather than buffering the whole
// export in memory or on disk first.
router.get("/download-all", async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const calls = await db.listAllCallsWithRecordings(req.session.user.tenantId, { dateFrom, dateTo });

  await log(
    req,
    "bulk_export",
    `Started bulk export of ${calls.length} call recording${calls.length === 1 ? "" : "s"}` +
      (dateFrom || dateTo ? ` (${dateFrom || "…"} to ${dateTo || "…"})` : "")
  );

  const zipName = `calltrove-export-${new Date().toISOString().slice(0, 10)}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  // Low compression, not zero: WAV (uncompressed PCM) still shrinks
  // meaningfully, but burning CPU trying to compress already-compressed
  // MP3s further isn't worth it on a small instance during a big export.
  const archive = archiver("zip", { zlib: { level: 1 } });
  archive.on("error", (err) => {
    console.error("[admin] zip export failed:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  for (const call of calls) {
    let buffer;
    try {
      buffer = await getBuffer(call.storageKey);
    } catch (err) {
      console.error(`[admin] skipping call ${call.id} in export, couldn't read recording:`, err);
      continue;
    }
    if (!buffer) continue;

    // call.id.slice(0, 8) makes the filename unique on its own (a UUID
    // collision in the first 8 hex chars is astronomically unlikely), no
    // separate collision-tracking needed.
    const ext = call.storageKey.split(".").pop();
    const who = (call.contactName || call.contactPhone || "unknown").replace(/[^a-zA-Z0-9]+/g, "_");
    const date = call.occurredAt ? new Date(call.occurredAt).toISOString().slice(0, 10) : "unknown-date";
    const name = `${who}/${date}_${call.direction || "call"}_${call.id.slice(0, 8)}.${ext}`;

    archive.append(buffer, { name });
  }

  await archive.finalize();
});

module.exports = router;
