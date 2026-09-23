const { Pool } = require("pg");
const { randomUUID } = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
});

// Well-known IDs backfilled by schema.sql's multi-tenant migration --
// today's single deployment's one tenant/GHL account. Ingestion code
// (src/poller.js, src/backfill.js) isn't multi-account-aware yet, so
// insertCall/upsertContact fall back to this when no ghlAccountId is given,
// keeping new rows tagged consistently with the existing backfilled ones.
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_GHL_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

async function upsertContact({ contactId, name, phone, ghlAccountId }) {
  await pool.query(
    `INSERT INTO contacts (ghl_contact_id, name, phone, ghl_account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ghl_contact_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, contacts.name),
       phone = COALESCE(EXCLUDED.phone, contacts.phone),
       updated_at = now()`,
    [contactId, name || null, phone || null, ghlAccountId || DEFAULT_GHL_ACCOUNT_ID]
  );
}

async function insertCall({
  id,
  ghlCallId,
  contactId,
  direction,
  durationSeconds,
  occurredAt,
  sourceRecordingUrl,
  rawPayload,
  handledById,
  handledByName,
  disposition,
  ghlAccountId,
}) {
  const result = await pool.query(
    `INSERT INTO calls (
       id, ghl_call_id, ghl_contact_id, direction, duration_seconds,
       occurred_at, source_recording_url, recording_status, raw_payload,
       handled_by_id, handled_by_name, disposition, ghl_account_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12)
     ON CONFLICT (ghl_call_id) DO NOTHING
     RETURNING id`,
    [
      id,
      ghlCallId,
      contactId,
      direction || null,
      durationSeconds || null,
      occurredAt || null,
      sourceRecordingUrl || null,
      rawPayload || null,
      handledById || null,
      handledByName || null,
      disposition || null,
      ghlAccountId || DEFAULT_GHL_ACCOUNT_ID,
    ]
  );
  return result.rows[0] || null;
}

async function markCallStored(callId, storageKey, durationSeconds) {
  if (durationSeconds !== undefined && durationSeconds !== null) {
    await pool.query(
      `UPDATE calls SET storage_key = $2, recording_status = 'stored', duration_seconds = $3 WHERE id = $1`,
      [callId, storageKey, durationSeconds]
    );
  } else {
    await pool.query(
      `UPDATE calls SET storage_key = $2, recording_status = 'stored' WHERE id = $1`,
      [callId, storageKey]
    );
  }
}

// Calls the live poller marked 'failed' recently -- GHL sometimes hasn't
// finished processing a call's recording (or even its final duration) at
// the moment the poller first sees the message (see src/poller.js's
// retryFailedRecordings), so these are worth one more look rather than
// treated as permanently missing the way an old backfilled call is.
async function listRetryableFailedCalls(maxAgeMs, ghlAccountId) {
  const conditions = [`c.recording_status = 'failed'`, `c.occurred_at > now() - ($1 || ' milliseconds')::interval`];
  const params = [maxAgeMs];
  if (ghlAccountId) {
    params.push(ghlAccountId);
    conditions.push(`c.ghl_account_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.ghl_call_id AS "ghlCallId", c.ghl_contact_id AS "contactId", c.raw_payload AS "rawPayload",
            c.direction, c.occurred_at AS "occurredAt",
            ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE ${conditions.join(" AND ")}`,
    params
  );
  return rows;
}

// Cheap existence check for src/backfill.js -- lets it skip already-captured
// calls (from a prior run, or ones the live poller already picked up) without
// going through insertCall's conflict-and-discard path just to find out.
async function getCallByGhlId(ghlCallId) {
  const { rows } = await pool.query(`SELECT id FROM calls WHERE ghl_call_id = $1`, [ghlCallId]);
  return rows[0] || null;
}

async function markCallFailed(callId) {
  await pool.query(
    `UPDATE calls SET recording_status = 'failed' WHERE id = $1`,
    [callId]
  );
}

// The disposition captured at insert time can be stale (e.g. "ringing" for
// a call that has since completed) -- src/poller.js's retryFailedRecordings
// refreshes it whenever it re-checks a failed call, independent of whether
// a recording turned up.
async function updateCallDisposition(callId, disposition) {
  await pool.query(`UPDATE calls SET disposition = $2 WHERE id = $1`, [callId, disposition || null]);
}

// --- transcription (src/transcription.js, src/transcriptionPoller.js) ---

async function markTranscriptionPending(callId) {
  await pool.query(`UPDATE calls SET transcription_status = 'pending' WHERE id = $1`, [callId]);
}

async function markTranscriptionComplete(callId, transcript) {
  await pool.query(
    `UPDATE calls SET transcription_status = 'completed', transcript = $2 WHERE id = $1`,
    [callId, transcript]
  );
}

async function markTranscriptionFailed(callId) {
  await pool.query(`UPDATE calls SET transcription_status = 'failed' WHERE id = $1`, [callId]);
}

async function listPendingTranscriptions() {
  const { rows } = await pool.query(`SELECT id FROM calls WHERE transcription_status = 'pending'`);
  return rows;
}

// GHL's Messages API reliably includes who handled a call (unlike the
// webhook payload, which depends on the workflow body being configured
// right), so it's applied as a correction after the initial insert once
// the recording lookup returns it.
async function updateCallHandler(callId, handledById, handledByName) {
  if (!handledById) return;
  await pool.query(
    `UPDATE calls SET handled_by_id = $2, handled_by_name = $3 WHERE id = $1`,
    [callId, handledById, handledByName || null]
  );
}

// ghlUserId, when given, scopes results to contacts/calls that user
// actually handled -- the enforcement point for "users see only their own
// calls, admins see everything" (ghlUserId omitted/null means admin/no
// restriction). ghlAccountId scopes to one connected GHL account -- the
// multi-tenant boundary, checked against the requesting user's accessible
// accounts by the route before this is ever called (see routes/api.js).
async function listContacts(search, ghlUserId, ghlAccountId) {
  const conditions = [];
  const params = [];
  if (ghlAccountId) {
    params.push(ghlAccountId);
    conditions.push(`ghl_account_id = $${params.length}`);
  }
  if (ghlUserId) {
    params.push(ghlUserId);
    conditions.push(`EXISTS (SELECT 1 FROM calls c WHERE c.ghl_contact_id = contacts.ghl_contact_id AND c.handled_by_id = $${params.length})`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT ghl_contact_id AS id, name, phone
     FROM contacts
     ${where}
     ORDER BY ${search ? "name NULLS LAST" : "updated_at DESC"}
     LIMIT 50`,
    params
  );
  return rows;
}

// Unpaginated, full A-Z directory listing for the dedicated Contacts page
// -- unlike listContacts() (capped at 50, used for the sidebar's quick-jump
// search), this returns every matching contact since the page itself does
// the grouping/scrolling. Includes each contact's most recent call time so
// the page can show it without a second round trip per contact.
async function listAllContacts(ghlUserId, ghlAccountId) {
  const conditions = [];
  const params = [];
  if (ghlAccountId) {
    params.push(ghlAccountId);
    conditions.push(`ghl_account_id = $${params.length}`);
  }
  if (ghlUserId) {
    params.push(ghlUserId);
    conditions.push(`EXISTS (SELECT 1 FROM calls c WHERE c.ghl_contact_id = contacts.ghl_contact_id AND c.handled_by_id = $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT ghl_contact_id AS id, name, phone,
            (SELECT MAX(occurred_at) FROM calls c WHERE c.ghl_contact_id = contacts.ghl_contact_id) AS "lastCallAt"
     FROM contacts
     ${where}
     ORDER BY name NULLS LAST`,
    params
  );
  return rows;
}

const PAGE_SIZES = [20, 50, 100];

// The main call-search query: contactId is optional (omitted = all
// contacts), dateFrom/dateTo are 'YYYY-MM-DD' strings and inclusive of the
// whole day on both ends. ghlUserId is the same RBAC scoping used
// everywhere else (a specific user's calls, or unrestricted for admins).
function callFilterConditions({ contactId, ghlUserId, ghlAccountId, dateFrom, dateTo, disposition, direction, hasRecording }) {
  const conditions = [];
  const params = [];
  if (ghlAccountId) {
    params.push(ghlAccountId);
    conditions.push(`c.ghl_account_id = $${params.length}`);
  }
  if (contactId) {
    params.push(contactId);
    conditions.push(`c.ghl_contact_id = $${params.length}`);
  }
  if (ghlUserId) {
    params.push(ghlUserId);
    conditions.push(`c.handled_by_id = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  if (disposition) {
    params.push(disposition);
    conditions.push(`c.disposition = $${params.length}`);
  }
  if (direction) {
    params.push(direction);
    conditions.push(`c.direction = $${params.length}`);
  }
  if (hasRecording === true) {
    conditions.push(`c.storage_key IS NOT NULL`);
  } else if (hasRecording === false) {
    conditions.push(`c.storage_key IS NULL`);
  }
  return { conditions, params };
}

async function listCalls({ contactId, ghlUserId, ghlAccountId, dateFrom, dateTo, disposition, direction, hasRecording, page = 1, pageSize = 20 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 20;
  const pageNum = Math.max(1, Number(page) || 1);

  const { conditions, params } = callFilterConditions({ contactId, ghlUserId, ghlAccountId, dateFrom, dateTo, disposition, direction, hasRecording });
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM calls c ${where}`, params);
  const total = Number(countRows[0].count);

  const limitParams = [...params, size, (pageNum - 1) * size];
  const { rows } = await pool.query(
    `SELECT c.id, c.direction, c.duration_seconds AS "durationSeconds",
            c.occurred_at AS "occurredAt", c.recording_status AS "recordingStatus",
            c.disposition,
            c.storage_key IS NOT NULL AS "hasRecording", c.handled_by_name AS "handledByName",
            c.transcription_status AS "transcriptionStatus",
            c.ghl_contact_id AS "contactId", ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     ${where}
     ORDER BY c.occurred_at DESC NULLS LAST, c.created_at DESC
     LIMIT $${limitParams.length - 1} OFFSET $${limitParams.length}`,
    limitParams
  );
  return { calls: rows, total, page: pageNum, pageSize: size };
}

// Summary counts behind the dashboard's stat tiles -- same filters as
// listCalls() (so the tiles always match whatever's actually in the table
// below them), just aggregated instead of paginated.
async function getCallStats({ contactId, ghlUserId, ghlAccountId, dateFrom, dateTo, disposition, direction, hasRecording } = {}) {
  const { conditions, params } = callFilterConditions({ contactId, ghlUserId, ghlAccountId, dateFrom, dateTo, disposition, direction, hasRecording });
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound,
            count(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound,
            count(*) FILTER (WHERE c.disposition IS DISTINCT FROM 'completed')::int AS missed
     FROM calls c
     ${where}`,
    params
  );
  return rows[0];
}

// Distinct disposition values actually seen (scoped the same way as every
// other list view), for populating the Outcome filter dropdown -- GHL's
// disposition column isn't a fixed enum, so this beats hardcoding a list
// that might drift out of date.
async function listDistinctDispositions(ghlUserId, ghlAccountId) {
  const conditions = ["disposition IS NOT NULL"];
  const params = [];
  if (ghlAccountId) {
    params.push(ghlAccountId);
    conditions.push(`ghl_account_id = $${params.length}`);
  }
  if (ghlUserId) {
    params.push(ghlUserId);
    conditions.push(`handled_by_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT disposition FROM calls WHERE ${conditions.join(" AND ")} ORDER BY disposition`,
    params
  );
  return rows.map((r) => r.disposition);
}

// Per-rep call-volume/quality aggregates for the admin "Call report" tab.
// dateFrom/dateTo scope the totals to whatever preset is selected there;
// the trailing-7-day trend (below) is intentionally on its own fixed
// window instead.
async function getCallReportByRep({ dateFrom, dateTo } = {}) {
  const conditions = ["handled_by_id IS NOT NULL"];
  const params = [];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await pool.query(
    `SELECT handled_by_id AS id, handled_by_name AS name,
            count(*)::int AS total,
            CASE WHEN count(*) > 0
              THEN round(100.0 * count(*) FILTER (WHERE disposition = 'completed') / count(*))::int
              ELSE 0 END AS "completionPct",
            COALESCE(round(avg(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)), 0)::int AS "avgDurationSeconds",
            count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
            count(*) FILTER (WHERE direction = 'outbound')::int AS outbound
     FROM calls
     WHERE ${conditions.join(" AND ")}
     GROUP BY handled_by_id, handled_by_name
     ORDER BY total DESC`,
    params
  );
  return rows;
}

// Always the trailing 7 calendar days, independent of the report's own
// date-range preset -- a fixed short-term pulse check per rep.
async function getCallReportTrend() {
  const { rows } = await pool.query(
    `SELECT handled_by_id AS id, to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day,
            count(*)::int AS count
     FROM calls
     WHERE handled_by_id IS NOT NULL
       AND occurred_at >= (current_date - interval '6 days')
     GROUP BY handled_by_id, day`
  );
  return rows;
}

// Unpaginated, unlike listCalls() -- for the bulk ZIP export
// (routes/admin.js), which needs every matching row to stream, not one
// page. dateFrom/dateTo are optional, same semantics as listCalls().
async function listAllCallsWithRecordings({ dateFrom, dateTo } = {}) {
  const conditions = ["c.storage_key IS NOT NULL"];
  const params = [];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.storage_key AS "storageKey", c.occurred_at AS "occurredAt",
            c.direction, ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.occurred_at ASC NULLS LAST`,
    params
  );
  return rows;
}

// Coverage summary for the admin "Call Recording Coverage" report --
// total calls, how many actually have a recording stored, and how many
// completed calls (the ones that should have a recording) are missing
// one. A call GHL disposed as anything other than "completed" (no
// answer, busy, voicemail...) was never going to have a recording, so
// it's not counted as a gap.
async function getCoverageSummary() {
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE disposition = 'completed')::int AS completed,
       count(*) FILTER (WHERE storage_key IS NOT NULL)::int AS stored,
       count(*) FILTER (WHERE disposition = 'completed' AND storage_key IS NULL)::int AS "completedMissing"
     FROM calls`
  );
  return rows[0];
}

async function getCoverageByDisposition() {
  const { rows } = await pool.query(
    `SELECT COALESCE(disposition, '(unknown)') AS disposition, count(*)::int AS count,
            count(*) FILTER (WHERE storage_key IS NOT NULL)::int AS stored
     FROM calls
     GROUP BY disposition
     ORDER BY count DESC`
  );
  return rows;
}

// Month-by-month coverage among completed calls only -- this is what
// actually makes a systemic gap (like a GHL-side outage) visible: a steady
// stored rate that drops to near-zero for a stretch of months, rather than
// scattered one-off misses.
async function getCoverageByMonth() {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS month,
            count(*) FILTER (WHERE disposition = 'completed')::int AS completed,
            count(*) FILTER (WHERE disposition = 'completed' AND storage_key IS NOT NULL)::int AS stored
     FROM calls
     WHERE occurred_at IS NOT NULL
     GROUP BY 1
     ORDER BY 1`
  );
  return rows;
}

// The real gaps: completed calls with no recording ever stored, paginated
// the same way as listCalls().
async function listCoverageGaps({ page = 1, pageSize = 20 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 20;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM calls c WHERE c.disposition = 'completed' AND c.storage_key IS NULL`
  );
  const total = Number(countRows[0].count);

  const { rows } = await pool.query(
    `SELECT c.id, c.direction, c.occurred_at AS "occurredAt", c.recording_status AS "recordingStatus",
            c.handled_by_name AS "handledByName", c.ghl_contact_id AS "contactId",
            ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE c.disposition = 'completed' AND c.storage_key IS NULL
     ORDER BY c.occurred_at DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [size, (pageNum - 1) * size]
  );
  return { gaps: rows, total, page: pageNum, pageSize: size };
}

async function getCall(callId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.storage_key AS "storageKey", c.recording_status AS "recordingStatus",
            c.occurred_at AS "occurredAt", c.direction, c.ghl_contact_id AS "contactId",
            c.handled_by_id AS "handledById", c.transcription_status AS "transcriptionStatus",
            c.transcript, c.ghl_account_id AS "ghlAccountId", ct.name, ct.phone
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE c.id = $1`,
    [callId]
  );
  return rows[0] || null;
}

// --- users (dashboard login accounts) ---

async function createUser({ id, username, passwordHash, passwordSalt, role, ghlUserId, ghlUserName, tenantId }) {
  await pool.query(
    `INSERT INTO users (id, username, password_hash, password_salt, role, ghl_user_id, ghl_user_name, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, username, passwordHash, passwordSalt, role, ghlUserId || null, ghlUserName || null, tenantId || DEFAULT_TENANT_ID]
  );
}

async function getUserByUsername(username) {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash", password_salt AS "passwordSalt",
            role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName", tenant_id AS "tenantId"
     FROM users WHERE username = $1`,
    [username]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName", tenant_id AS "tenantId"
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function listUsers() {
  const { rows } = await pool.query(
    `SELECT id, username, role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName", created_at AS "createdAt"
     FROM users ORDER BY created_at ASC`
  );
  return rows;
}

async function updateUser(id, { role, ghlUserId, ghlUserName, passwordHash, passwordSalt }) {
  const sets = [];
  const params = [];
  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (role !== undefined) add("role", role);
  if (ghlUserId !== undefined) add("ghl_user_id", ghlUserId || null);
  if (ghlUserName !== undefined) add("ghl_user_name", ghlUserName || null);
  if (passwordHash !== undefined) add("password_hash", passwordHash);
  if (passwordSalt !== undefined) add("password_salt", passwordSalt);
  if (sets.length === 0) return;
  params.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

async function deleteUser(id) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
}

// --- tenants / ghl_accounts / user_account_access (multi-tenant) ---

async function createTenant({ id, name, ownerUserId }) {
  await pool.query(`INSERT INTO tenants (id, name, owner_user_id) VALUES ($1, $2, $3)`, [id, name, ownerUserId || null]);
}

async function getTenantById(id) {
  const { rows } = await pool.query(
    `SELECT id, name, owner_user_id AS "ownerUserId", status,
            cancellation_requested_at AS "cancellationRequestedAt",
            purge_at AS "purgeAt", canceled_at AS "canceledAt"
     FROM tenants WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// The owner-only trigger: locks the tenant's logins out (see
// requireAuth in src/auth.js, which checks this status on every
// request) and schedules the actual data purge for later rather than
// deleting anything right now -- src/tenantPurge.js is what acts on
// purgeAt once it arrives.
async function requestTenantCancellation(tenantId, purgeAt) {
  await pool.query(
    `UPDATE tenants SET status = 'cancellation_pending', cancellation_requested_at = now(), purge_at = $2
     WHERE id = $1 AND status = 'active'`,
    [tenantId, purgeAt]
  );
}

// Only works before purge_at actually arrives -- once src/tenantPurge.js
// has run, the tenant is 'canceled' and its data is gone, so there's
// nothing left to restore to.
async function restoreTenant(tenantId) {
  await pool.query(
    `UPDATE tenants SET status = 'active', cancellation_requested_at = NULL, purge_at = NULL
     WHERE id = $1 AND status = 'cancellation_pending'`,
    [tenantId]
  );
}

// What src/tenantPurge.js loops over each cycle.
async function listTenantsReadyForPurge() {
  const { rows } = await pool.query(
    `SELECT id, name FROM tenants WHERE status = 'cancellation_pending' AND purge_at <= now()`
  );
  return rows;
}

// The actual deletion, run once per tenant by src/tenantPurge.js after
// it's already deleted every call's recording from storage. Removes the
// PHI itself (contacts, calls, the connected accounts, every login) but
// deliberately leaves audit_log and phi_access_log untouched -- see the
// migration comment in schema.sql for why -- and leaves the tenants row
// itself in place, now marked 'canceled', as the permanent record that
// this tenant existed and was canceled (audit_log entries reference it
// by name, not a live foreign key, so this doesn't orphan anything).
async function purgeTenantData(tenantId) {
  // owner_user_id has to be cleared before the users row it points at can
  // be deleted -- the tenants row itself is kept (marked 'canceled'
  // below), just with nobody left to own it.
  await pool.query(`UPDATE tenants SET owner_user_id = NULL WHERE id = $1`, [tenantId]);
  await pool.query(`DELETE FROM calls WHERE ghl_account_id IN (SELECT id FROM ghl_accounts WHERE tenant_id = $1)`, [tenantId]);
  await pool.query(`DELETE FROM contacts WHERE ghl_account_id IN (SELECT id FROM ghl_accounts WHERE tenant_id = $1)`, [tenantId]);
  await pool.query(`DELETE FROM user_account_access WHERE ghl_account_id IN (SELECT id FROM ghl_accounts WHERE tenant_id = $1)`, [tenantId]);
  await pool.query(`DELETE FROM ghl_accounts WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`UPDATE tenants SET status = 'canceled', canceled_at = now() WHERE id = $1`, [tenantId]);
}

// listRetryableFailedCalls/listAllCallsWithRecordings-style helper for
// the purge job -- every stored recording's key, for a tenant about to
// be purged, so src/tenantPurge.js can delete each one from storage
// before the DB rows referencing them are gone.
async function listStorageKeysForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT storage_key AS "storageKey" FROM calls
     WHERE ghl_account_id IN (SELECT id FROM ghl_accounts WHERE tenant_id = $1) AND storage_key IS NOT NULL`,
    [tenantId]
  );
  return rows.map((r) => r.storageKey);
}

async function createGhlAccount({ id, tenantId, ghlLocationId, name, accessToken, refreshToken, tokenExpiresAt }) {
  await pool.query(
    `INSERT INTO ghl_accounts (id, tenant_id, ghl_location_id, name, access_token, refresh_token, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, tenantId, ghlLocationId, name || null, accessToken || null, refreshToken || null, tokenExpiresAt || null]
  );
}

// Looked up by location ID (not our own row id) at the OAuth callback --
// GHL only ever hands back its own location ID, so this is how a
// re-installation of an already-connected location is recognized as an
// update rather than a duplicate connection.
async function getGhlAccountByLocationId(ghlLocationId) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id AS "tenantId", ghl_location_id AS "ghlLocationId", name
     FROM ghl_accounts WHERE ghl_location_id = $1`,
    [ghlLocationId]
  );
  return rows[0] || null;
}

async function updateGhlAccountTokens(id, { accessToken, refreshToken, tokenExpiresAt }) {
  await pool.query(
    `UPDATE ghl_accounts SET access_token = $2, refresh_token = $3, token_expires_at = $4, uninstalled_at = NULL WHERE id = $1`,
    [id, accessToken || null, refreshToken || null, tokenExpiresAt || null]
  );
}

async function listGhlAccountsForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT id, ghl_location_id AS "ghlLocationId", name
     FROM ghl_accounts WHERE tenant_id = $1 AND uninstalled_at IS NULL
     ORDER BY installed_at ASC`,
    [tenantId]
  );
  return rows;
}

// The permission-checking core: what accounts can this user actually pick
// from? Admins see every account their own tenant owns (never another
// tenant's -- the WHERE tenant_id = $1 below is the isolation boundary for
// admins). Regular users are further narrowed to whatever's explicitly
// granted in user_account_access, same relationship the existing
// ghl_user_id call-scoping has to admin vs. user.
async function listAccessibleAccounts(userId, role, tenantId) {
  if (role === "admin") {
    return listGhlAccountsForTenant(tenantId);
  }
  const { rows } = await pool.query(
    `SELECT g.id, g.ghl_location_id AS "ghlLocationId", g.name
     FROM ghl_accounts g
     JOIN user_account_access a ON a.ghl_account_id = g.id
     WHERE a.user_id = $1 AND g.tenant_id = $2 AND g.uninstalled_at IS NULL
     ORDER BY g.installed_at ASC`,
    [userId, tenantId]
  );
  return rows;
}

async function grantUserAccountAccess(userId, ghlAccountId) {
  await pool.query(
    `INSERT INTO user_account_access (user_id, ghl_account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, ghlAccountId]
  );
}

async function revokeUserAccountAccess(userId, ghlAccountId) {
  await pool.query(`DELETE FROM user_account_access WHERE user_id = $1 AND ghl_account_id = $2`, [userId, ghlAccountId]);
}

// Every access grant across a tenant's users, in one query -- for the
// Team members admin screen, which needs every user's granted accounts
// at once rather than one query per user.
async function listUserAccountAccessForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT a.user_id AS "userId", a.ghl_account_id AS "ghlAccountId"
     FROM user_account_access a
     JOIN ghl_accounts g ON g.id = a.ghl_account_id
     WHERE g.tenant_id = $1`,
    [tenantId]
  );
  return rows;
}

// Every actively connected account across every tenant, with the OAuth
// token fields ingestion code needs -- what src/poller.js loops over each
// cycle. Unlike listGhlAccountsForTenant/listAccessibleAccounts (the
// permission-checking layer, always scoped to one tenant since they
// answer "what can this logged-in user see"), the poller isn't handling
// a request for any one tenant, so it needs everything at once.
async function listAllActiveGhlAccounts() {
  const { rows } = await pool.query(
    `SELECT id, tenant_id AS "tenantId", ghl_location_id AS "ghlLocationId", name,
            access_token AS "accessToken", refresh_token AS "refreshToken", token_expires_at AS "tokenExpiresAt"
     FROM ghl_accounts WHERE uninstalled_at IS NULL`
  );
  return rows;
}

// --- sync_state (poller checkpoint) ---

async function getLastSyncedAt() {
  const { rows } = await pool.query(`SELECT last_synced_at AS "lastSyncedAt" FROM sync_state WHERE id = 1`);
  return rows[0] ? rows[0].lastSyncedAt : null;
}

async function setLastSyncedAt(date) {
  await pool.query(
    `INSERT INTO sync_state (id, last_synced_at) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at`,
    [date]
  );
}

// --- account_sync_state (per-account poller checkpoint) ---
// Replaces the single-row sync_state above now that one poll cycle covers
// more than one connected GHL account -- each needs its own independent
// "newest call already processed" checkpoint. sync_state itself is left
// in place rather than dropped (a rollback safety net); src/poller.js
// just doesn't read it anymore once this ships.

async function getAccountLastSyncedAt(ghlAccountId) {
  const { rows } = await pool.query(
    `SELECT last_synced_at AS "lastSyncedAt" FROM account_sync_state WHERE ghl_account_id = $1`,
    [ghlAccountId]
  );
  return rows[0] ? rows[0].lastSyncedAt : null;
}

async function setAccountLastSyncedAt(ghlAccountId, date) {
  await pool.query(
    `INSERT INTO account_sync_state (ghl_account_id, last_synced_at) VALUES ($1, $2)
     ON CONFLICT (ghl_account_id) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at`,
    [ghlAccountId, date]
  );
}

// --- app_settings (live, admin-toggleable -- see src/poller.js) ---

async function getAutoTranscribeEnabled() {
  const { rows } = await pool.query(
    `SELECT auto_transcribe_enabled AS "autoTranscribeEnabled" FROM app_settings WHERE id = 1`
  );
  return rows[0] ? rows[0].autoTranscribeEnabled : false;
}

async function setAutoTranscribeEnabled(enabled) {
  await pool.query(`UPDATE app_settings SET auto_transcribe_enabled = $1 WHERE id = 1`, [enabled]);
}

// --- audit_log (who changed what admin setting/account, and when) ---

async function logAudit({ actorId, actorUsername, action, message }) {
  await pool.query(
    `INSERT INTO audit_log (id, actor_id, actor_username, action, message) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), actorId || null, actorUsername || null, action, message]
  );
}

async function listAuditLog({ page = 1, pageSize = 50 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM audit_log`);
  const total = Number(countRows[0].count);

  // COALESCE to the GHL name currently linked to the actor's user account,
  // falling back to the username recorded at the time (matters once that
  // link changes, or if the account has since been deleted).
  const { rows } = await pool.query(
    `SELECT l.id, l.actor_id AS "actorId", COALESCE(u.ghl_user_name, l.actor_username) AS "actorUsername",
            l.action, l.message, l.created_at AS "createdAt"
     FROM audit_log l
     LEFT JOIN users u ON u.id = l.actor_id
     ORDER BY l.created_at DESC
     LIMIT $1 OFFSET $2`,
    [size, (pageNum - 1) * size]
  );
  return { entries: rows, total, page: pageNum, pageSize: size };
}

// --- phi_access_log (who accessed which call's recording/transcript,
// when, from where, how, and whether it was allowed -- see routes/api.js) ---

async function logPhiAccess({ userId, username, action, callId, success, denialReason, ipAddress, userAgent }) {
  await pool.query(
    `INSERT INTO phi_access_log
       (id, user_id, username, action, call_id, success, denial_reason, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), userId || null, username || null, action, callId || null, success, denialReason || null, ipAddress || null, userAgent || null]
  );
}

async function listPhiAccessLog({ page = 1, pageSize = 50 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM phi_access_log`);
  const total = Number(countRows[0].count);

  // LEFT JOINs purely for display -- which contact this call belongs to,
  // and the GHL name currently linked to the accessing user's account
  // (falling back to the username recorded at the time). The log itself
  // never depends on any of these still existing.
  const { rows } = await pool.query(
    `SELECT l.id, l.user_id AS "userId", COALESCE(u.ghl_user_name, l.username) AS username,
            l.action, l.call_id AS "callId", l.success,
            l.denial_reason AS "denialReason", l.ip_address AS "ipAddress", l.user_agent AS "userAgent",
            l.created_at AS "createdAt", ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM phi_access_log l
     LEFT JOIN calls c ON c.id = l.call_id
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     LEFT JOIN users u ON u.id = l.user_id
     ORDER BY l.created_at DESC
     LIMIT $1 OFFSET $2`,
    [size, (pageNum - 1) * size]
  );
  return { entries: rows, total, page: pageNum, pageSize: size };
}

module.exports = {
  pool,
  DEFAULT_TENANT_ID,
  DEFAULT_GHL_ACCOUNT_ID,
  createTenant,
  getTenantById,
  requestTenantCancellation,
  restoreTenant,
  listTenantsReadyForPurge,
  purgeTenantData,
  listStorageKeysForTenant,
  createGhlAccount,
  getGhlAccountByLocationId,
  updateGhlAccountTokens,
  listGhlAccountsForTenant,
  listAccessibleAccounts,
  listAllActiveGhlAccounts,
  grantUserAccountAccess,
  revokeUserAccountAccess,
  listUserAccountAccessForTenant,
  upsertContact,
  insertCall,
  getCallByGhlId,
  markCallStored,
  markCallFailed,
  updateCallDisposition,
  listRetryableFailedCalls,
  markTranscriptionPending,
  markTranscriptionComplete,
  markTranscriptionFailed,
  listPendingTranscriptions,
  updateCallHandler,
  listContacts,
  listAllContacts,
  listCalls,
  getCallStats,
  listDistinctDispositions,
  getCallReportByRep,
  getCallReportTrend,
  listAllCallsWithRecordings,
  getCoverageSummary,
  getCoverageByDisposition,
  getCoverageByMonth,
  listCoverageGaps,
  getCall,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  getLastSyncedAt,
  setLastSyncedAt,
  getAccountLastSyncedAt,
  setAccountLastSyncedAt,
  getAutoTranscribeEnabled,
  setAutoTranscribeEnabled,
  logAudit,
  listAuditLog,
  logPhiAccess,
  listPhiAccessLog,
};
