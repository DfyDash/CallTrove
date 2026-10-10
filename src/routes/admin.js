const express = require("express");
const { randomUUID, randomBytes, createHash } = require("crypto");
const archiver = require("archiver");
const db = require("../db");
const ghlApi = require("../ghlApi");
const ghlOAuth = require("../ghlOAuth");
const accountCredentials = require("../accountCredentials");
const ghlAppUrl = require("../ghlAppUrl");
const { reconcileContacts, withAccountLock } = require("../contactReconcile");
const backfill = require("../backfill");
const email = require("../email");
const { getBuffer } = require("../storage");
const { sanitizeForFilename } = require("../filenames");
const { hashPassword, requireAdmin, requireAccount, requireCsrf, displayName } = require("../auth");
const { loginLimiter, limiterKey } = require("./auth");
const billingRates = require("../billingRates");
const { BAA_VERSION, buildBaaText } = require("../baaText");

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

// Typed back to confirm, same as the tenant-name-typing flow this
// replaced -- a fixed phrase instead of the account's own name since some
// tenant names are long/awkward to retype, but still short enough that it
// can't be checked off by accident. Checked here, not just client-side
// (public/settings.js already disables the button until it matches, but
// that's just UX -- this is the actual guard).
const CANCEL_CONFIRM_PHRASE = "CANCEL MY ACCOUNT";

// Mirrors src/routes/operator.js's own log() -- writing with no tenantId
// is exactly what db.listAuditLogForOperator's tenant_id IS NULL filter
// picks up (see that function's comment), so a self-service cancel/restore
// shows up on the operator's cross-tenant Activity tab the same way an
// operator-triggered one does. This is *in addition to* the normal
// tenant-scoped log() call below, not instead of it -- the tenant's own
// admin still needs to see it on their own Activity log too.
function logForOperator(req, action, message) {
  return db.logAudit({ actorId: req.session.user.id, actorUsername: req.session.user.username, action, message });
}

// GET /api/tenant/status (routes/api.js) is what actually serves status
// to the frontend -- it isn't admin-gated, since a locked-out NON-admin
// user of a canceled tenant still needs to see "contact your account
// owner" and /api/admin/* would 403 them before they got that far.

// Subscription state (written only by Paddle's signed webhooks) plus the
// public values the browser needs to open Paddle's checkout. customData
// carries the tenant id so the webhook can match the subscription back.
router.get("/subscription", async (req, res) => {
  const tenant = await db.getTenantById(req.session.user.tenantId);
  const checkout = require("../paddle").checkoutConfig();
  res.json({
    status: tenant.subscriptionStatus || null,
    periodEnd: tenant.subscriptionPeriodEnd || null,
    checkout: checkout ? { ...checkout, tenantId: tenant.id, email: req.session.user.email || null } : null,
  });
});

router.post("/tenant/cancel", requireCsrf, async (req, res) => {
  const tenant = await db.getTenantById(req.session.user.tenantId);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });
  if (tenant.ownerUserId !== req.session.user.id) {
    return res.status(403).json({ error: "only the account owner can cancel this account" });
  }
  if (req.body?.confirmPhrase !== CANCEL_CONFIRM_PHRASE) {
    return res.status(400).json({ error: `type "${CANCEL_CONFIRM_PHRASE}" to confirm` });
  }
  if (tenant.status !== "active") {
    return res.status(409).json({ error: `account is already ${tenant.status}` });
  }

  const purgeAt = new Date(Date.now() + CANCELLATION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  await db.requestTenantCancellation(tenant.id, purgeAt);
  await log(req, "tenant_cancellation_requested", `Cancellation requested for "${tenant.name}", data purge scheduled for ${purgeAt.toISOString()}`);
  await logForOperator(req, "tenant_cancelled_self_service", `Self-service cancellation by account owner for "${tenant.name}" (${tenant.id}), data purge scheduled for ${purgeAt.toISOString()}`);
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
  await logForOperator(req, "tenant_restored_self_service", `Self-service restore by account owner for "${tenant.name}" (${tenant.id})`);
  res.json({ status: "active" });
});

// --- BAA acceptance (self-serve, owner-only -- see schema.sql's comment
// on baa_acceptances for why this is gated to the owner, same bar as
// tenant cancel/restore above: it's a company-binding legal acceptance,
// not something any admin on the tenant should be able to trigger). ---

// Read-only, any admin can view the agreement text and whether it's been
// accepted -- only the accept action itself (below) is owner-gated. hash
// is returned alongside the text so the client echoes it back unmodified
// on accept, letting the server confirm the text that was actually shown
// is the exact text being agreed to (see POST /baa/accept).
router.get("/baa", async (req, res) => {
  const tenant = await db.getTenantById(req.session.user.tenantId);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });

  const text = buildBaaText({ companyName: tenant.name });
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  const acceptance = await db.getLatestBaaAcceptance(tenant.id);

  res.json({
    text,
    hash,
    version: BAA_VERSION,
    canAccept: tenant.ownerUserId === req.session.user.id,
    acceptance,
  });
});

router.post("/baa/accept", requireCsrf, async (req, res) => {
  const tenant = await db.getTenantById(req.session.user.tenantId);
  if (!tenant) return res.status(404).json({ error: "tenant not found" });
  if (tenant.ownerUserId !== req.session.user.id) {
    return res.status(403).json({ error: "only the account owner can accept the BAA" });
  }

  const fullName = (req.body?.fullName || "").trim();
  const title = (req.body?.title || "").trim();
  if (!fullName || !title) {
    return res.status(400).json({ error: "full name and title are required" });
  }
  if (req.body?.agree !== true) {
    return res.status(400).json({ error: "you must check the box to agree" });
  }

  // Recomputed server-side from the tenant's current name, never trusted
  // from the client -- confirms the signer actually agreed to the real,
  // current text, not a stale or tampered copy. confirmHash is the hash
  // GET /baa just handed the client; a mismatch means the text changed
  // (or was tampered with) between viewing and submitting.
  const text = buildBaaText({ companyName: tenant.name });
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  if (req.body?.confirmHash !== hash) {
    return res.status(409).json({ error: "the agreement text has changed since you loaded this page -- please review it again before accepting" });
  }

  const acceptance = await db.recordBaaAcceptance({
    tenantId: tenant.id,
    userId: req.session.user.id,
    fullName,
    title,
    baaVersion: BAA_VERSION,
    baaTextHash: hash,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  await log(req, "baa_accepted", `BAA accepted for "${tenant.name}" by ${fullName} (${title})`);
  res.json({ status: "accepted", acceptance });
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

// 7 days -- long enough that someone invited on a Friday isn't locked out
// by Monday, short enough that a stale, unclicked invite link doesn't sit
// valid indefinitely.
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// GHL team members not yet linked to a CallTrove login -- backs the "GHL
// team" list in Settings, next to the existing manual "Add user" form.
// Suggests a role from GHL's own admin/user flag, but POST /users/invite
// below never grants it without an admin confirming per person first --
// being a GHL admin is a different judgment call than "should see every
// recording in this account."
router.get("/ghl-users/invitable", async (req, res) => {
  const api = await ghlApiForTenant(req.session.user.tenantId);
  if (!api.isConfigured()) return res.json([]);
  let ghlUsers;
  try {
    ghlUsers = await api.listUsers();
  } catch (err) {
    console.error("[admin] failed to fetch GHL users for invite list:", err);
    return res.status(502).json({ error: "could not fetch GHL user list" });
  }
  const existing = await db.listUsers(req.session.user.tenantId);
  const takenGhlUserIds = new Set(existing.map((u) => u.ghlUserId).filter(Boolean));
  const invitable = ghlUsers
    .filter((u) => !takenGhlUserIds.has(u.id))
    .map((u) => ({
      ghlUserId: u.id,
      name: u.name,
      email: u.email,
      suggestedRole: u.role === "admin" ? "admin" : "user",
    }));
  res.json(invitable);
});

// Creates the login immediately (so the ghlUserId link and account-access
// grant exist right away) but with no usable password -- an emailed,
// one-time link is how they actually activate it (see set-password.html /
// POST /set-password in routes/auth.js), same "set your own credential,
// never have an admin invent and relay one" shape as everything else
// account-security-related in this app. The username is fixed to their
// GHL email rather than left editable, matching the existing auto-link
// convention (routes/admin.js's autoLinkGhlUsers) that a login's username
// being the same address as their GHL account is how the two get matched.
router.post("/users/invite", requireCsrf, async (req, res) => {
  const { ghlUserId, ghlUserName, email: inviteEmail, role } = req.body || {};
  if (!ghlUserId || !inviteEmail || !["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "ghlUserId, email, and a valid role are required" });
  }
  if (await db.getUserByUsername(inviteEmail)) {
    return res.status(409).json({ error: "a user with that email already exists" });
  }

  const accounts = await db.listActiveGhlAccountsForTenant(req.session.user.tenantId);
  if (!accounts.length) return res.status(400).json({ error: "no connected GHL account to invite them into" });
  const account = accounts[0];

  const rawToken = randomBytes(24).toString("hex");
  const userId = randomUUID();
  await db.createInvitedUser({
    id: userId,
    username: inviteEmail,
    role,
    ghlUserId,
    ghlUserName: ghlUserName || null,
    tenantId: req.session.user.tenantId,
    inviteTokenHash: createHash("sha256").update(rawToken).digest("hex"),
    inviteTokenExpiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
  });
  await db.grantUserAccountAccess(userId, account.id);
  await log(req, "user_invited", `Invited "${inviteEmail}" (role: ${role}, linked to GHL user ${ghlUserId})`);

  const inviteUrl = `${req.protocol}://${req.get("host")}/set-password.html?token=${rawToken}`;
  // Full name when the inviting admin has one on file: self-service
  // signup's own first/last name (see public/signup.html), or -- just as
  // reliably -- the name GHL has on file for them (see createInvitedUser).
  // Only falls back to their username (an email address) for an admin
  // created some other way that never had either.
  const inviterName = displayName(req.session.user);
  let emailSent = false;
  try {
    await email.sendEmail({
      to: inviteEmail,
      subject: "You've been added to CallTrove",
      text: `You've been added to CallTrove for ${account.name || "your team"}.\n\nSet your password to finish activating your account:\n${inviteUrl}\n\nThis link expires in 7 days.`,
      html: email.inviteEmailHtml(inviteUrl, {
        accountName: account.name,
        invitedBy: inviterName,
        requestIp: req.ip,
      }),
    });
    emailSent = true;
  } catch (err) {
    console.error("[admin] failed to send invite email:", err);
  }
  res.status(201).json({ status: "invited", emailSent, inviteUrl });
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
  const schedule = await db.getDigestSchedule(req.ghlAccountId);
  res.json({
    autoTranscribeEnabled: await db.getAutoTranscribeEnabled(req.ghlAccountId),
    aiSummaryEnabled: await db.getAiSummaryEnabled(req.ghlAccountId),
    transcriptCleanupEnabled: await db.getTranscriptCleanupEnabled(req.ghlAccountId),
    ...schedule,
  });
});

// Client-facing billing -- what this tenant is actually being charged,
// read from the same cost_ledger receipts the operator's own Cost &
// revenue tab reads, never a separate estimate (see schema.sql's
// cost_ledger comment). Tenant-wide, not scoped to one GHL account the
// way requireAccount/?accountId= routes are -- the tenant is what's
// actually billed, same scope routes/operator.js uses for its own
// cross-tenant totals.
//
// No base-subscription line here: there's no recurring base-fee billing
// mechanism in this codebase yet (no Paddle integration, no 'base'
// cost_ledger category) -- this shows only what's real today:
// transcription, AI summaries, transcript cleanup, and storage.
router.get("/billing", async (req, res) => {
  const tenantId = req.session.user.tenantId;
  const tenant = await db.getTenantById(tenantId);

  const current = await db.getTenantCurrentPeriodUsage(tenantId);

  const storedBytes = await db.getTotalStoredBytesForTenant(tenantId);
  const BYTES_PER_GB = 1024 ** 3;
  const usedGB = storedBytes / BYTES_PER_GB;
  const tier = billingRates.storageTier(tenant.storageTier);
  const freeGB = tier.freeGB;

  const [pastUsage, pastStorage] = await Promise.all([
    db.getTenantPastUsageByMonth(tenantId),
    db.getTenantPastStorageByMonth(tenantId),
  ]);

  // Combine the two differently-shaped historical queries (transcription/
  // ai_summary are per-call receipts bucketed by month; storage is
  // already one row per month) into a single per-month history, keyed by
  // the plain 'YYYY-MM-DD' string both queries already return.
  const byMonth = new Map();
  function monthEntry(month) {
    if (!byMonth.has(month)) byMonth.set(month, { month, transcriptionRevenue: 0, aiSummaryRevenue: 0, transcriptCleanupRevenue: 0, storageRevenue: 0 });
    return byMonth.get(month);
  }
  for (const row of pastUsage) {
    const entry = monthEntry(row.month);
    if (row.category === "transcription") entry.transcriptionRevenue = Number(row.revenue);
    else if (row.category === "ai_summary") entry.aiSummaryRevenue = Number(row.revenue);
    else if (row.category === "transcript_cleanup") entry.transcriptCleanupRevenue = Number(row.revenue);
  }
  for (const row of pastStorage) {
    monthEntry(row.month).storageRevenue = Number(row.revenue);
  }
  const pastMonths = [...byMonth.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((m) => ({ ...m, total: m.transcriptionRevenue + m.aiSummaryRevenue + m.transcriptCleanupRevenue + m.storageRevenue }))
    // A month that closed out at $0 everywhere (e.g. a storage entry
    // exists only because storageCostJob.js runs for every tenant every
    // month, but nothing was ever owed) has nothing worth showing --
    // skip it rather than list a row of zeroes.
    .filter((m) => m.total > 0);

  res.json({
    currentPeriod: {
      transcriptionRevenue: current.transcriptionRevenue,
      transcriptionMinutes: current.transcriptionMinutes,
      aiSummaryRevenue: current.aiSummaryRevenue,
      aiSummaryCalls: current.aiSummaryCalls,
      transcriptCleanupRevenue: current.transcriptCleanupRevenue,
      transcriptCleanupCalls: current.transcriptCleanupCalls,
      total: current.transcriptionRevenue + current.aiSummaryRevenue + current.transcriptCleanupRevenue,
    },
    storage: {
      usedGB,
      freeGB,
      remainingGB: Math.max(0, freeGB - usedGB),
      overageGB: Math.max(0, usedGB - freeGB),
      overageRate: tier.overagePerGbMonth,
    },
    pastMonths,
  });
});

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Rejected here rather than left to src/callDigestJob.js's own fallback
// (UTC, if Intl doesn't recognize the string) -- that fallback exists for
// a value already in the database somehow being bad, not as a substitute
// for validating new input at the one place it's actually written.
function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.put("/settings", requireAccount, requireCsrf, async (req, res) => {
  const body = req.body || {};
  const result = {};
  if ("autoTranscribeEnabled" in body) {
    const enabled = Boolean(body.autoTranscribeEnabled);
    await db.setAutoTranscribeEnabled(req.ghlAccountId, enabled);
    await log(req, "auto_transcribe_toggled", `Turned automatic transcription ${enabled ? "ON" : "OFF"} for account ${req.ghlAccountId}`);
    result.autoTranscribeEnabled = enabled;
  }
  if ("aiSummaryEnabled" in body) {
    const enabled = Boolean(body.aiSummaryEnabled);
    await db.setAiSummaryEnabled(req.ghlAccountId, enabled);
    await log(req, "ai_summary_toggled", `Turned per-call AI summary ${enabled ? "ON" : "OFF"} for account ${req.ghlAccountId}`);
    result.aiSummaryEnabled = enabled;
  }
  if ("transcriptCleanupEnabled" in body) {
    const enabled = Boolean(body.transcriptCleanupEnabled);
    await db.setTranscriptCleanupEnabled(req.ghlAccountId, enabled);
    await log(req, "transcript_cleanup_toggled", `Turned automatic transcript cleanup ${enabled ? "ON" : "OFF"} for account ${req.ghlAccountId}`);
    result.transcriptCleanupEnabled = enabled;
  }
  if ("digestTime1" in body || "digestTime2" in body || "digestTimezone" in body) {
    const current = await db.getDigestSchedule(req.ghlAccountId);
    const digestTime1 = "digestTime1" in body ? body.digestTime1 : current.digestTime1;
    const digestTime2 = "digestTime2" in body ? body.digestTime2 : current.digestTime2;
    const digestTimezone = "digestTimezone" in body ? body.digestTimezone : current.digestTimezone;
    if (!HHMM_RE.test(digestTime1) || !HHMM_RE.test(digestTime2)) {
      return res.status(400).json({ error: "digestTime1/digestTime2 must be 24h HH:MM" });
    }
    if (!isValidTimezone(digestTimezone)) {
      return res.status(400).json({ error: "digestTimezone is not a recognized timezone" });
    }
    await db.setDigestSchedule(req.ghlAccountId, { digestTime1, digestTime2, digestTimezone });
    await log(req, "digest_schedule_updated", `Set the analytics digest schedule to ${digestTime1} and ${digestTime2} (${digestTimezone}) for account ${req.ghlAccountId}`);
    result.digestTime1 = digestTime1;
    result.digestTime2 = digestTime2;
    result.digestTimezone = digestTimezone;
  }
  res.json(result);
});

// Express 4 doesn't catch a rejected async handler: the request would just
// hang and the error surface as an unhandled rejection. The routes below make
// GHL and database calls that can fail, so they answer with a clean 500.
function safe(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error(`[admin] ${req.method} ${req.originalUrl} failed:`, err);
      if (!res.headersSent) res.status(500).json({ error: "something went wrong -- please try again" });
    });
}

// --- Possible duplicate contacts ---
// Read-only against GHL: this only surfaces contacts that share a phone
// number. Merging happens in GHL itself (its public API has no merge call),
// so each contact carries a direct link into its GHL record.

router.get("/duplicates", requireAccount, safe(async (req, res) => {
  const [groups, account] = await Promise.all([
    db.listDuplicateContactGroups(req.ghlAccountId),
    db.getGhlAccountById(req.ghlAccountId),
  ]);
  // The legacy single-account deployment's row stores the placeholder
  // "default" -- its real location is the GHL_LOCATION_ID env var (see
  // src/ghlApi.js). No usable location means no link, not a broken one.
  const locationId = account.ghlLocationId === "default" ? process.env.GHL_LOCATION_ID || null : account.ghlLocationId;
  const base = ghlAppUrl.resolveAppBase(account);
  const ghlUrl = (contactId) =>
    locationId ? `${base}/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}` : null;
  // Only worth a GHL API call when links would otherwise go to standard GHL
  // and there's something to flag; the answer is cached (see ghlAppUrl.js).
  const suggestSettingAddress = groups.length > 0 && !account.ghlAppUrl && (await ghlAppUrl.looksWhiteLabeled(account));
  res.json({
    suggestSettingAddress,
    groups: groups.map((g) => ({
      ...g,
      contacts: g.contacts.map((c) => ({ ...c, ghlUrl: ghlUrl(c.id) })),
    })),
  });
}));

router.post("/duplicates/dismiss", requireAccount, requireCsrf, safe(async (req, res) => {
  const ids = (req.body || {}).contactIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 50 || !ids.every((id) => typeof id === "string" && id)) {
    return res.status(400).json({ error: "contactIds must be a list of 2-50 contact IDs" });
  }
  const ok = await db.dismissDuplicateGroup(ids, req.session.user.username, req.ghlAccountId);
  if (!ok) return res.status(404).json({ error: "one or more contacts not found in this account" });
  await log(req, "duplicates_dismissed", `Marked ${new Set(ids).size} contacts sharing a phone number as not duplicates`);
  res.json({ status: "dismissed" });
}));

// After merging duplicates in GHL, catch CallTrove up right now (the
// background watcher, src/mergeWatchJob.js, does the same on a timer; this
// is the "check now" button). Re-files each contact's calls to whatever
// contact GHL now holds them under -- see src/contactReconcile.js.
router.post("/duplicates/reconcile", requireAccount, requireCsrf, safe(async (req, res) => {
  const ids = (req.body || {}).contactIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 50 || !ids.every((id) => typeof id === "string" && id)) {
    return res.status(400).json({ error: "contactIds must be a list of 2-50 contact IDs" });
  }
  if (!(await db.contactsBelongToAccount(ids, req.ghlAccountId))) {
    return res.status(404).json({ error: "one or more contacts not found in this account" });
  }
  const account = await db.getGhlAccountById(req.ghlAccountId);
  const api = await accountCredentials.clientForAccount(account);
  if (!api.isConfigured()) return res.status(409).json({ error: "this account isn't connected to GHL" });
  const outcome = await withAccountLock(req.ghlAccountId, () => reconcileContacts({ api, ghlAccountId: req.ghlAccountId, contactIds: ids }));
  if (outcome.busy) return res.status(409).json({ error: "already checking this account -- give it a moment" });
  const result = outcome.value;
  if (result.callsMoved > 0) {
    await log(req, "contacts_reconciled", `Followed a GHL merge: moved ${result.callsMoved} call${result.callsMoved === 1 ? "" : "s"} and removed ${result.contactsRemoved} leftover contact${result.contactsRemoved === 1 ? "" : "s"} for account ${req.ghlAccountId}`);
  }
  res.json(result);
}));

// --- Connected GHL accounts (multi-tenant: one tenant, many locations) ---

router.get("/ghl-accounts", async (req, res) => {
  const accounts = await db.listGhlAccountsForTenant(req.session.user.tenantId);
  res.json({ accounts, oauthConfigured: ghlOAuth.isConfigured() });
});

// Fuller status view for the Settings > GHL accounts management table
// (connect/disconnect/reconnect) -- deliberately a separate endpoint from
// GET /ghl-accounts above rather than that one just returning more, since
// that one also feeds the Team tab's per-user account-access checklist,
// which must only ever offer *active* accounts to grant someone access
// to. This one includes disconnected accounts too, so there's somewhere
// to see one and reconnect it, plus each account's last sync time for
// spotting a stuck/stale connection.
router.get("/ghl-accounts/status", safe(async (req, res) => {
  const accounts = await db.listGhlAccountsWithStatusForTenant(req.session.user.tenantId);
  // Flags active accounts that GHL says are white-labeled but that have no
  // GHL web address saved yet, so Settings can prompt for it.
  const withHint = await Promise.all(
    accounts.map(async (a) => {
      if (a.uninstalledAt || a.ghlAppUrl) return { ...a, suggestSettingAddress: false };
      const full = await db.getGhlAccountById(a.id);
      return { ...a, suggestSettingAddress: await ghlAppUrl.looksWhiteLabeled(full) };
    })
  );
  res.json({ accounts: withHint, oauthConfigured: ghlOAuth.isConfigured() });
}));

// Saves (or clears, with an empty value) the web address this account's
// admins log into GHL at -- what the "Open in GHL" links point to. See
// src/ghlAppUrl.js for why it's entered rather than detected.
router.put("/ghl-accounts/:id/app-url", requireCsrf, safe(async (req, res) => {
  const account = await db.getGhlAccountById(req.params.id);
  if (!account || account.tenantId !== req.session.user.tenantId) {
    return res.status(404).json({ error: "account not found" });
  }
  const result = ghlAppUrl.normalizeAppUrl((req.body || {}).appUrl);
  if (!result.ok) return res.status(400).json({ error: result.error });
  await db.setGhlAppUrl(account.id, result.url);
  await log(
    req,
    "ghl_app_url_updated",
    result.url ? `Set the GHL web address for location "${account.ghlLocationId}" to ${result.url}` : `Cleared the GHL web address for location "${account.ghlLocationId}" (back to standard GHL)`
  );
  res.json({ appUrl: result.url });
}));

// Stops syncing this location -- the poller only ever loops active
// accounts (see listAllActiveGhlAccounts) -- without deleting anything
// it's already brought in; recordings, contacts, and calls all keep their
// ghl_account_id exactly as they are. Reconnecting afterward (same
// location, via "Connect"/"Reconnect", both of which just send the admin
// through GHL's own OAuth picker -- see GET /oauth/connect below) is
// recognized as the same account by the OAuth callback, matched on GHL's
// own location ID rather than this row's id, so it cleanly re-attaches to
// the same history instead of orphaning it the way the tenant-ownership
// bug this followed did.
router.post("/ghl-accounts/:id/disconnect", requireCsrf, async (req, res) => {
  const account = await db.getGhlAccountById(req.params.id);
  if (!account || account.tenantId !== req.session.user.tenantId) {
    return res.status(404).json({ error: "account not found" });
  }
  const disconnected = await db.disconnectGhlAccount(account.id);
  if (!disconnected) {
    return res.status(409).json({ error: "already disconnected" });
  }
  await log(req, "ghl_account_disconnected", `Disconnected GHL location "${account.ghlLocationId}"`);
  res.json({ status: "disconnected" });
});

// Redirects into GHL's own "choose a location, then authorize" screen.
// The random state is stashed on the session and checked back on the
// callback below -- standard OAuth CSRF protection (stops a forged
// callback from linking an attacker-chosen account into this tenant).
router.get("/oauth/connect", (req, res) => {
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
router.get("/oauth/callback", async (req, res) => {
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

  // GHL's OAuth token exchange never includes a friendly business name --
  // only the raw locationId -- so this is fetched separately, right after
  // getting a working access token for this specific location. Best
  // effort: a lookup failure here shouldn't block the connection itself,
  // just falls back to the raw ID same as before.
  const locationClient = ghlApi.forAccount({ apiToken: tokens.access_token, locationId });
  const locationName = await locationClient.getLocationName().catch(() => null);

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
    if (locationName) await db.updateGhlAccountName(existing.id, locationName);
    await log(req, "ghl_account_reconnected", `Reconnected GHL location "${locationId}"`);
  } else {
    await db.createGhlAccount({
      id: randomUUID(),
      tenantId: req.session.user.tenantId,
      ghlLocationId: locationId,
      name: locationName || locationId,
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

// A bounded range (today/week/month presets, or any explicit custom range
// under a month) gets daily bars -- fine-grained enough to be useful, few
// enough to read. Year and All-time (open-ended: no dateFrom/dateTo at all)
// get monthly bars instead -- 365+ daily bars would be unreadable, and
// that's the same by-month granularity the client-facing Coverage report's
// own month-chart already uses.
function trendGranularityFor(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return "month";
  const spanDays = (new Date(dateTo) - new Date(dateFrom)) / 86400000;
  return spanDays > 31 ? "month" : "day";
}

// "Call report" -- per-rep volume/quality leaderboard. dateFrom/dateTo scope
// the totals to the tab's selected preset; the trend now follows that same
// range (see trendGranularityFor above) instead of always being a fixed
// trailing-7-day window regardless of what's selected elsewhere on the tab.
router.get("/call-report", async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const granularity = trendGranularityFor(dateFrom, dateTo);
  const [reps, trendRows, dispositionRows] = await Promise.all([
    db.getCallReportByRep(req.session.user.tenantId, { dateFrom, dateTo }),
    db.getCallReportTrend(req.session.user.tenantId, { dateFrom, dateTo, granularity }),
    db.getCallReportDispositionsByRep(req.session.user.tenantId, { dateFrom, dateTo }),
  ]);

  const trend = {};
  if (granularity === "day") {
    // Bounded range -- fill every day so a genuine zero-call day reads as
    // "no calls" rather than "chart didn't load". No explicit dateTo (e.g.
    // "today") defaults the end to today, matching the leaderboard's own
    // reportPresetRange on the client.
    const start = dateFrom ? new Date(`${dateFrom}T00:00:00`) : new Date();
    const end = dateTo ? new Date(`${dateTo}T00:00:00`) : new Date();
    const buckets = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      buckets.push(d.toISOString().slice(0, 10));
    }
    for (const rep of reps) {
      trend[rep.id] = buckets.map((bucket) => {
        const match = trendRows.find((r) => r.id === rep.id && r.bucket === bucket);
        return { bucket, count: match ? match.count : 0 };
      });
    }
  } else {
    // Open-ended (All time) or a year-plus span -- don't force-fill every
    // possible month back to whenever the tenant's first call happened; a
    // gap here is a normal, unremarkable quiet month, not the "did this
    // even load" ambiguity a gap in the last few days would be.
    for (const rep of reps) {
      trend[rep.id] = trendRows.filter((r) => r.id === rep.id).map((r) => ({ bucket: r.bucket, count: r.count }));
    }
  }

  const dispositionsByRep = {};
  for (const row of dispositionRows) {
    if (!dispositionsByRep[row.id]) dispositionsByRep[row.id] = [];
    dispositionsByRep[row.id].push({ disposition: row.disposition, count: row.count });
  }

  res.json({ reps, trend, trendGranularity: granularity, dispositionsByRep });
});

// Latest twice-daily digest snapshot for the selected account -- see
// src/callDigestJob.js. null when the job hasn't run for this account yet
// (just connected, or it has transcription on and was never eligible),
// not an error -- the client renders an empty state either way.
router.get("/call-digest", requireAccount, async (req, res) => {
  const digest = await db.getLatestCallDigest(req.ghlAccountId);
  res.json({ digest });
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

// Bulk export -- everyone's recordings (optionally date- or contact-
// filtered) as one streamed ZIP, not one-by-one. Two use cases share this
// route: getting a full copy of everything before an account is canceled
// and its storage purged (date-filtered or unfiltered), and -- with
// contactId -- answering one individual's HIPAA rights request (access,
// amendment, accounting of disclosures) within the BAA's 10 business day
// window, complete with transcripts, not just audio, so there's nothing
// left to assemble by hand. Streams straight to the response as each file
// is read (archiver + one getBuffer() at a time) rather than buffering
// the whole export in memory or on disk first.
router.get("/download-all", async (req, res) => {
  const { dateFrom, dateTo, contactId } = req.query;
  const calls = await db.listAllCallsWithRecordings(req.session.user.tenantId, { dateFrom, dateTo, contactId });

  await log(
    req,
    "bulk_export",
    `Started bulk export of ${calls.length} call recording${calls.length === 1 ? "" : "s"}` +
      (dateFrom || dateTo ? ` (${dateFrom || "…"} to ${dateTo || "…"})` : "") +
      (contactId ? ` for contact ${contactId}` : "")
  );

  // Named after the contact specifically for a contact-scoped export --
  // whoever receives this ZIP (the admin requesting it, or whoever they
  // hand it to for an individual-rights response) shouldn't have to open
  // it just to confirm whose data is inside. Falls back to the generic
  // name if no calls matched (nothing to read a contact name from) or the
  // contact has neither a name nor phone on file.
  const contactLabel = contactId && calls[0] ? sanitizeForFilename(calls[0].contactName || calls[0].contactPhone || "") : "";
  const zipName = contactLabel
    ? `calltrove-export-${contactLabel}-${new Date().toISOString().slice(0, 10)}.zip`
    : `calltrove-export-${new Date().toISOString().slice(0, 10)}.zip`;
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
    // call.id.slice(0, 8) makes the filename unique on its own (a UUID
    // collision in the first 8 hex chars is astronomically unlikely), no
    // separate collision-tracking needed. Computed before the recording
    // fetch below, not after -- the transcript append must not be skipped
    // just because the recording read happened to fail (a transient S3
    // issue has nothing to do with whether the transcript, independently
    // stored in the DB, is available).
    const ext = call.storageKey.split(".").pop();
    const who = sanitizeForFilename(call.contactName || call.contactPhone || "unknown");
    const date = call.occurredAt ? new Date(call.occurredAt).toISOString().slice(0, 10) : "unknown-date";
    const baseName = `${who}/${date}_${call.direction || "call"}_${call.id.slice(0, 8)}`;

    let recordingIncluded = false;
    try {
      const buffer = await getBuffer(call.storageKey, call.storageTier);
      if (buffer) {
        archive.append(buffer, { name: `${baseName}.${ext}` });
        recordingIncluded = true;
      }
    } catch (err) {
      console.error(`[admin] skipping recording for call ${call.id} in export, couldn't read it:`, err);
    }

    // Alongside the audio, not a separate pass -- a complete individual-
    // rights response needs the transcript too, not just the recording.
    // Nothing added for a call with no transcript (never transcribed, or
    // transcription failed) -- an empty placeholder file would just be
    // noise with nothing it's actually standing in for.
    const transcriptIncluded = !!call.transcript;
    if (transcriptIncluded) {
      archive.append(call.transcript, { name: `${baseName}_transcript.txt` });
    }

    // Per-call PHI access trail for a contact-scoped export only -- this
    // is specifically what answers a HIPAA "accounting of disclosures"
    // request (45 CFR 164.528): a record of exactly which of this
    // person's recordings/transcripts actually went into a given
    // disclosure, not just the summary count the audit log entry above
    // has. Not written for the plain tenant-wide backup export -- that's
    // not a disclosure to or about any one individual.
    if (contactId) {
      // Best effort, like the cost-ledger writes elsewhere in this app
      // (e.g. transcriptionPoller.js) -- a logging failure here must not
      // abort the export itself. Headers and some ZIP bytes may already
      // be streamed to the client by this point in the loop; a thrown
      // error here would just hang or truncate the download with no
      // error the admin could even see, for what would otherwise be a
      // perfectly good export.
      try {
        await db.logPhiAccess({
          userId: req.session.user.id,
          username: req.session.user.username,
          action: "bulk_export_included",
          callId: call.id,
          success: recordingIncluded || transcriptIncluded,
          denialReason: recordingIncluded || transcriptIncluded ? null : "recording and transcript both unavailable",
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          tenantId: req.session.user.tenantId,
        });
      } catch (err) {
        console.error(`[admin] failed to log PHI access for call ${call.id} during contact export:`, err);
      }
    }
  }

  await archive.finalize();
});

module.exports = router;
