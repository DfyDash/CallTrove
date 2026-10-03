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

// sizeBytes is the already-in-memory recording buffer's own length (see
// src/poller.js's call sites) -- cheap to capture here since nothing has
// to re-fetch or HEAD the object afterward, unlike the one-time S3
// HeadObject backfill existing recordings needed (src/scripts/
// backfillCostLedger.js) because this didn't exist before. Basis for
// storage cost (src/storageCostJob.js, schema.sql's cost_ledger comment).
async function markCallStored(callId, storageKey, durationSeconds, sizeBytes) {
  if (durationSeconds !== undefined && durationSeconds !== null) {
    await pool.query(
      `UPDATE calls SET storage_key = $2, recording_status = 'stored', duration_seconds = $3, size_bytes = $4 WHERE id = $1`,
      [callId, storageKey, durationSeconds, sizeBytes || null]
    );
  } else {
    await pool.query(
      `UPDATE calls SET storage_key = $2, recording_status = 'stored', size_bytes = $3 WHERE id = $1`,
      [callId, storageKey, sizeBytes || null]
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
  await pool.query(
    `UPDATE calls SET transcription_status = 'pending', transcription_attempts = transcription_attempts + 1 WHERE id = $1`,
    [callId]
  );
}

// ai_summary_status only moves to 'pending' when the call's own account has
// explicitly opted into ai_summary_enabled -- this is a billed, per-call
// feature (see schema.sql's comment on ai_summary_enabled), so it must
// never run just because transcription itself is on for the account.
// Checked with a subquery rather than a JOIN so this stays a single-call
// UPDATE regardless of caller.
async function markTranscriptionComplete(callId, transcript, words) {
  await pool.query(
    `UPDATE calls SET transcription_status = 'completed', transcript = $2, transcript_words = $3,
       ai_summary_status = CASE
         WHEN (SELECT ai_summary_enabled FROM ghl_accounts WHERE id = calls.ghl_account_id) THEN 'pending'
         ELSE 'none'
       END
     WHERE id = $1`,
    [callId, transcript, words ? JSON.stringify(words) : null]
  );
}

// The person who handled the call correcting Transcribe's output by hand
// (or an admin -- see routes/api.js's PUT /calls/:id/transcript for the
// permission check, same boundary as viewing it). Clears transcript_words
// since a free-text edit can no longer be mapped back to Transcribe's
// original word boundaries -- there's nothing left to highlight against.
async function updateCallTranscript(callId, transcript, editedByUsername) {
  await pool.query(
    `UPDATE calls SET transcript = $2, transcript_words = NULL,
       transcript_edited_at = now(), transcript_edited_by = $3
     WHERE id = $1`,
    [callId, transcript, editedByUsername]
  );
}

async function markTranscriptionFailed(callId) {
  await pool.query(`UPDATE calls SET transcription_status = 'failed' WHERE id = $1`, [callId]);
}

// duration_seconds/ghl_account_id/tenant_id are the cost-ledger basis
// (src/transcriptionPoller.js writes a 'transcription' row once a job
// completes -- see schema.sql's cost_ledger comment) -- joined here
// rather than looked up separately per call once it completes.
async function listPendingTranscriptions() {
  const { rows } = await pool.query(
    `SELECT c.id, c.duration_seconds AS "durationSeconds", c.ghl_account_id AS "ghlAccountId",
            c.transcription_attempts AS "transcriptionAttempts", g.tenant_id AS "tenantId"
     FROM calls c
     LEFT JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE c.transcription_status = 'pending'`
  );
  return rows;
}

// --- AI call summary (Bedrock/Claude) ---

// tenantId is the cost-ledger basis (src/callSummaryPoller.js writes an
// 'ai_summary' row once a summary completes), joined here the same way
// listPendingTranscriptions above does.
async function listPendingCallSummaries() {
  const { rows } = await pool.query(
    `SELECT c.id, c.transcript, c.ghl_contact_id AS "contactId", c.ghl_account_id AS "ghlAccountId",
            c.ai_summary_attempts AS "attempts", g.tenant_id AS "tenantId"
     FROM calls c
     LEFT JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE c.ai_summary_status = 'pending'`
  );
  return rows;
}

// Incremented before the (billable) Bedrock call is made, not after --
// same ordering as markTranscriptionPending, so an attempt is counted
// even if everything after it fails.
async function incrementSummaryAttempts(callId) {
  await pool.query(`UPDATE calls SET ai_summary_attempts = ai_summary_attempts + 1 WHERE id = $1`, [callId]);
}

async function markSummaryComplete(callId, summary, analysis) {
  await pool.query(
    `UPDATE calls SET ai_summary_status = 'completed', ai_summary = $2, ai_analysis = $3 WHERE id = $1`,
    [callId, summary, analysis ? JSON.stringify(analysis) : null]
  );
}

async function markSummaryFailed(callId) {
  await pool.query(`UPDATE calls SET ai_summary_status = 'failed' WHERE id = $1`, [callId]);
}

async function markGhlNoteWritten(callId) {
  await pool.query(`UPDATE calls SET ghl_note_written_at = now() WHERE id = $1`, [callId]);
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
// Every function below this point that queries `calls` directly (rather
// than through requireAccount's single-ghlAccountId scoping in
// routes/api.js) takes tenantId as its first argument and joins through
// ghl_accounts to enforce it -- these all went into routes/admin.js's
// tenant-wide reports (coverage, call report, bulk export), which were
// missing that scoping entirely until now: any admin could see, and the
// bulk export could download, every OTHER tenant's calls and recordings
// too. See schema.sql's tenant_id migration comment on audit_log for the
// same issue in the activity/PHI-access logs.
async function getCallReportByRep(tenantId, { dateFrom, dateTo } = {}) {
  const conditions = ["c.handled_by_id IS NOT NULL", "g.tenant_id = $1"];
  const params = [tenantId];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await pool.query(
    `SELECT c.handled_by_id AS id, c.handled_by_name AS name,
            count(*)::int AS total,
            count(*) FILTER (WHERE c.disposition = 'completed')::int AS "completedCount",
            CASE WHEN count(*) > 0
              THEN round(100.0 * count(*) FILTER (WHERE c.disposition = 'completed') / count(*))::int
              ELSE 0 END AS "completionPct",
            COALESCE(round(avg(c.duration_seconds) FILTER (WHERE c.duration_seconds IS NOT NULL)), 0)::int AS "avgDurationSeconds",
            COALESCE(sum(c.duration_seconds) FILTER (WHERE c.duration_seconds IS NOT NULL), 0)::int AS "totalDurationSeconds",
            count(*) FILTER (WHERE c.duration_seconds IS NOT NULL)::int AS "durationSampleCount",
            count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound,
            count(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY c.handled_by_id, c.handled_by_name
     ORDER BY total DESC`,
    params
  );
  return rows;
}

// Per-rep, per-disposition breakdown for the same leaderboard/date range --
// completionPct above is a single number; this is the full picture (how
// much is no-answer/busy/voicemail/etc., not just "did it complete"), same
// idea as getCoverageByDisposition but sliced by rep instead of tenant-wide.
async function getCallReportDispositionsByRep(tenantId, { dateFrom, dateTo } = {}) {
  const conditions = ["c.handled_by_id IS NOT NULL", "g.tenant_id = $1"];
  const params = [tenantId];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await pool.query(
    `SELECT c.handled_by_id AS id, COALESCE(c.disposition, '(unknown)') AS disposition, count(*)::int AS count
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY c.handled_by_id, c.disposition
     ORDER BY count DESC`,
    params
  );
  return rows;
}

// Always the trailing 7 calendar days, independent of the report's own
// date-range preset -- a fixed short-term pulse check per rep.
// granularity is computed server-side (routes/admin.js's trendGranularityFor,
// never taken directly from client input) from the same dateFrom/dateTo as
// the leaderboard, so it's safe to interpolate into date_trunc()/to_char()
// below -- it's always exactly "day" or "month", never attacker-influenced.
async function getCallReportTrend(tenantId, { dateFrom, dateTo, granularity = "day" } = {}) {
  const truncUnit = granularity === "month" ? "month" : "day";
  const bucketFormat = granularity === "month" ? "YYYY-MM" : "YYYY-MM-DD";
  const conditions = ["c.handled_by_id IS NOT NULL", "g.tenant_id = $1"];
  const params = [tenantId];
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.occurred_at >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.occurred_at < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await pool.query(
    `SELECT c.handled_by_id AS id, to_char(date_trunc('${truncUnit}', c.occurred_at), '${bucketFormat}') AS bucket,
            count(*)::int AS count
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY c.handled_by_id, bucket
     ORDER BY bucket`,
    params
  );
  return rows;
}

// --- Call digest (src/callDigestJob.js): metadata-only twice-daily report
// for accounts without transcription on. Every query below is scoped to
// one ghl_account_id and an explicit [start, end) window, computed twice
// per account per day rather than live per page view -- see schema.sql's
// comment on call_digests for why. "Rolling 24h ending at computed_at"
// rather than calendar-day: the job can run at any time of day, and a
// calendar-day window would make an 8am run's "today" almost empty.

async function callDigestWindowTotals(ghlAccountId, start, end) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE c.disposition IS DISTINCT FROM 'completed')::int AS missed,
            COALESCE(round(avg(c.duration_seconds) FILTER (WHERE c.duration_seconds IS NOT NULL)), 0)::int AS "avgDurationSeconds",
            COALESCE(max(c.duration_seconds), 0)::int AS "longestDurationSeconds"
     FROM calls c
     WHERE c.ghl_account_id = $1 AND c.occurred_at >= $2 AND c.occurred_at < $3`,
    [ghlAccountId, start, end]
  );
  return rows[0];
}

async function callDigestBusiestHour(ghlAccountId, start, end) {
  const { rows } = await pool.query(
    `SELECT extract(hour FROM c.occurred_at)::int AS hour, count(*)::int AS count
     FROM calls c
     WHERE c.ghl_account_id = $1 AND c.occurred_at >= $2 AND c.occurred_at < $3
     GROUP BY 1 ORDER BY count DESC LIMIT 1`,
    [ghlAccountId, start, end]
  );
  return rows[0] || null;
}

// completed/no-answer/voicemail are their own bucket (each was a
// meaningfully-sized slice in real data -- see the disposition audit this
// was designed from); busy/canceled/failed/ringing/null are rare enough
// to lump into "other" rather than clutter the breakdown with slivers.
async function callDigestDispositionBreakdown(ghlAccountId, start, end) {
  const { rows } = await pool.query(
    `SELECT CASE
              WHEN c.disposition = 'completed' THEN 'completed'
              WHEN c.disposition = 'no-answer' THEN 'no-answer'
              WHEN c.disposition = 'voicemail' THEN 'voicemail'
              ELSE 'other'
            END AS bucket,
            count(*)::int AS count
     FROM calls c
     WHERE c.ghl_account_id = $1 AND c.occurred_at >= $2 AND c.occurred_at < $3
     GROUP BY 1`,
    [ghlAccountId, start, end]
  );
  return rows;
}

// "Unreturned" = a missed inbound call (no-answer/voicemail) where nobody
// has called that contact back since, in either direction -- the same
// "based on outcome and callback history, not what was said" framing the
// approved mockup uses, since there's no transcript to know intent from.
// The NOT EXISTS is evaluated at query time (now), not just against the
// window -- a call from three days ago that's still nobody's most recent
// contact with that person is still genuinely unreturned today.
// conversationId comes along so src/callDigestJob.js can do a second,
// live check against GHL itself (has this contact been texted/emailed/
// noted since, not just re-called?) -- see its own comment for why that
// can't happen here: it needs a live GHL API call per candidate, which
// has no business in a pure SQL query function. limit is generous (not
// the ~5 the UI actually shows) because the job needs every real
// candidate to filter before it knows how many survive, not just enough
// to display.
async function callDigestUnreturnedCalls(ghlAccountId, start, end, limit = 50) {
  const { rows } = await pool.query(
    `SELECT c.id, c.ghl_contact_id AS "contactId", ct.name AS "contactName",
            c.disposition, c.occurred_at AS "occurredAt",
            c.raw_payload->>'conversationId' AS "conversationId"
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE c.ghl_account_id = $1
       AND c.direction = 'inbound'
       AND c.disposition IN ('no-answer', 'voicemail')
       AND c.occurred_at >= $2 AND c.occurred_at < $3
       AND NOT EXISTS (
         SELECT 1 FROM calls c2
         WHERE c2.ghl_account_id = $1 AND c2.ghl_contact_id = c.ghl_contact_id
           AND c2.occurred_at > c.occurred_at
       )
     ORDER BY c.occurred_at ASC
     LIMIT $4`,
    [ghlAccountId, start, end, limit]
  );
  return rows;
}

async function callDigestDailyVolume(ghlAccountId, start, end) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('day', c.occurred_at), 'YYYY-MM-DD') AS day, count(*)::int AS count
     FROM calls c
     WHERE c.ghl_account_id = $1 AND c.occurred_at >= $2 AND c.occurred_at < $3
     GROUP BY 1 ORDER BY 1`,
    [ghlAccountId, start, end]
  );
  return rows;
}

// Per-day missed-call rate for the trailing week, used only to decide
// whether the current window's rate is this week's best -- not rendered
// directly, so no zero-filling: a day with no calls at all just isn't a
// candidate for "best day".
async function callDigestDailyMissedRates(ghlAccountId, start, end) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('day', c.occurred_at), 'YYYY-MM-DD') AS day,
            count(*)::int AS total,
            count(*) FILTER (WHERE c.disposition IS DISTINCT FROM 'completed')::int AS missed
     FROM calls c
     WHERE c.ghl_account_id = $1 AND c.occurred_at >= $2 AND c.occurred_at < $3
     GROUP BY 1`,
    [ghlAccountId, start, end]
  );
  return rows
    .filter((r) => r.total > 0)
    .map((r) => ({ day: r.day, missedRatePct: Math.round((100 * r.missed) / r.total) }));
}

async function callDigestTopReps(ghlAccountId, start, end, limit = 5) {
  const { rows } = await pool.query(
    `SELECT c.handled_by_id AS id, c.handled_by_name AS name,
            count(*)::int AS total,
            COALESCE(round(avg(c.duration_seconds) FILTER (WHERE c.duration_seconds IS NOT NULL)), 0)::int AS "avgDurationSeconds",
            count(DISTINCT c.ghl_contact_id)::int AS "uniqueContacts"
     FROM calls c
     WHERE c.ghl_account_id = $1 AND c.handled_by_id IS NOT NULL
       AND c.occurred_at >= $2 AND c.occurred_at < $3
     GROUP BY c.handled_by_id, c.handled_by_name
     ORDER BY total DESC
     LIMIT $4`,
    [ghlAccountId, start, end, limit]
  );
  return rows;
}

// Orchestrates every query above into the one JSON blob call_digests.stats
// holds. now defaults to the real clock but is injectable for testing.
async function computeCallDigestStats(ghlAccountId, { now = new Date() } = {}) {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const prevStart = new Date(periodStart.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [current, previous, busiest, dispositionBreakdown, unreturnedCandidates, unreturnedCandidatesPrev, trend, dailyMissedRates, topReps] =
    await Promise.all([
      callDigestWindowTotals(ghlAccountId, periodStart, periodEnd),
      callDigestWindowTotals(ghlAccountId, prevStart, periodStart),
      callDigestBusiestHour(ghlAccountId, periodStart, periodEnd),
      callDigestDispositionBreakdown(ghlAccountId, periodStart, periodEnd),
      callDigestUnreturnedCalls(ghlAccountId, periodStart, periodEnd),
      callDigestUnreturnedCalls(ghlAccountId, prevStart, periodStart),
      callDigestDailyVolume(ghlAccountId, weekStart, periodEnd),
      callDigestDailyMissedRates(ghlAccountId, weekStart, periodEnd),
      callDigestTopReps(ghlAccountId, periodStart, periodEnd),
    ]);

  const missedRatePct = current.total > 0 ? Math.round((100 * current.missed) / current.total) : 0;
  const missedRatePctPrev = previous.total > 0 ? Math.round((100 * previous.missed) / previous.total) : 0;
  const isBestDayThisWeek = dailyMissedRates.length > 0 && missedRatePct <= Math.min(...dailyMissedRates.map((r) => r.missedRatePct));

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    totalCalls: current.total,
    totalCallsPrev: previous.total,
    avgDurationSeconds: current.avgDurationSeconds,
    avgDurationSecondsPrev: previous.avgDurationSeconds,
    longestDurationSeconds: current.longestDurationSeconds,
    missedRatePct,
    missedRatePctPrev,
    isBestDayThisWeek,
    busiestHour: busiest ? busiest.hour : null,
    // Not yet a final count/list -- src/callDigestJob.js still has to
    // check each candidate against GHL for a since-contacted signal
    // (text, email, note) before deciding which ones are genuinely still
    // unreturned. See its own comment for why that can't happen here.
    unreturnedCandidates: unreturnedCandidates.map((c) => ({
      contactId: c.contactId,
      contactName: c.contactName,
      disposition: c.disposition,
      occurredAt: c.occurredAt,
      conversationId: c.conversationId,
      waitMinutes: Math.round((periodEnd.getTime() - new Date(c.occurredAt).getTime()) / 60000),
    })),
    unreturnedCandidatesPrev: unreturnedCandidatesPrev.map((c) => ({
      contactId: c.contactId,
      occurredAt: c.occurredAt,
      conversationId: c.conversationId,
    })),
    dispositionBreakdown,
    trend,
    topReps,
  };
}

// One row per account per job run -- see schema.sql's comment on
// call_digests for why this is stored rather than computed live.
async function saveCallDigest({ ghlAccountId, stats, narrative }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO call_digests (id, ghl_account_id, stats, narrative) VALUES ($1, $2, $3, $4)`,
    [id, ghlAccountId, JSON.stringify(stats), narrative || null]
  );
  return id;
}

async function getLatestCallDigest(ghlAccountId) {
  const { rows } = await pool.query(
    `SELECT id, computed_at AS "computedAt", stats, narrative
     FROM call_digests
     WHERE ghl_account_id = $1
     ORDER BY computed_at DESC
     LIMIT 1`,
    [ghlAccountId]
  );
  return rows[0] || null;
}

// Only accounts that actually need the metadata-only digest -- one with
// transcription on gets the (not yet built) richer, transcript-based
// version instead, so there's no reason to spend a Bedrock call narrating
// this one for it.
// Includes the OAuth credential columns (same shape as
// listAllActiveGhlAccounts) -- src/callDigestJob.js needs a real,
// per-account accountCredentials.clientForAccount() to check GHL for a
// since-contacted signal on each unreturned-call candidate, not just the
// account id.
async function listGhlAccountsNeedingDigest() {
  const { rows } = await pool.query(
    `SELECT id, tenant_id AS "tenantId", name, ghl_location_id AS "ghlLocationId",
            access_token AS "accessToken", refresh_token AS "refreshToken", token_expires_at AS "tokenExpiresAt",
            digest_time_1 AS "digestTime1", digest_time_2 AS "digestTime2", digest_timezone AS "digestTimezone"
     FROM ghl_accounts
     WHERE uninstalled_at IS NULL AND auto_transcribe_enabled = false`
  );
  return rows;
}

async function getDigestSchedule(ghlAccountId) {
  const { rows } = await pool.query(
    `SELECT digest_time_1 AS "digestTime1", digest_time_2 AS "digestTime2", digest_timezone AS "digestTimezone",
            digest_schedule_customized AS "digestScheduleCustomized"
     FROM ghl_accounts WHERE id = $1`,
    [ghlAccountId]
  );
  return rows[0] || null;
}

// Marks the schedule customized on every call, whether it's an explicit
// save from the settings form or the one-time silent save that follows
// auto-detecting a timezone from an admin's browser (see
// public/settings.js) -- either way, the UTC bootstrap default shouldn't
// be auto-overwritten again after this.
async function setDigestSchedule(ghlAccountId, { digestTime1, digestTime2, digestTimezone }) {
  await pool.query(
    `UPDATE ghl_accounts SET digest_time_1 = $2, digest_time_2 = $3, digest_timezone = $4, digest_schedule_customized = true WHERE id = $1`,
    [ghlAccountId, digestTime1, digestTime2, digestTimezone]
  );
}

// Unpaginated, unlike listCalls() -- for the bulk ZIP export
// (routes/admin.js), which needs every matching row to stream, not one
// page. dateFrom/dateTo are optional, same semantics as listCalls().
async function listAllCallsWithRecordings(tenantId, { dateFrom, dateTo } = {}) {
  const conditions = ["c.storage_key IS NOT NULL", "g.tenant_id = $1"];
  const params = [tenantId];
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
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
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
async function getCoverageSummary(tenantId) {
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE c.disposition = 'completed')::int AS completed,
       count(*) FILTER (WHERE c.storage_key IS NOT NULL)::int AS stored,
       count(*) FILTER (WHERE c.disposition = 'completed' AND c.storage_key IS NULL)::int AS "completedMissing"
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE g.tenant_id = $1`,
    [tenantId]
  );
  return rows[0];
}

async function getCoverageByDisposition(tenantId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(c.disposition, '(unknown)') AS disposition, count(*)::int AS count,
            count(*) FILTER (WHERE c.storage_key IS NOT NULL)::int AS stored
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE g.tenant_id = $1
     GROUP BY c.disposition
     ORDER BY count DESC`,
    [tenantId]
  );
  return rows;
}

// Month-by-month coverage among completed calls only -- this is what
// actually makes a systemic gap (like a GHL-side outage) visible: a steady
// stored rate that drops to near-zero for a stretch of months, rather than
// scattered one-off misses.
async function getCoverageByMonth(tenantId) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', c.occurred_at), 'YYYY-MM') AS month,
            count(*) FILTER (WHERE c.disposition = 'completed')::int AS completed,
            count(*) FILTER (WHERE c.disposition = 'completed' AND c.storage_key IS NOT NULL)::int AS stored
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE c.occurred_at IS NOT NULL AND g.tenant_id = $1
     GROUP BY 1
     ORDER BY 1`,
    [tenantId]
  );
  return rows;
}

// The real gaps: completed calls with no recording ever stored, paginated
// the same way as listCalls().
async function listCoverageGaps(tenantId, { page = 1, pageSize = 20 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 20;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE c.disposition = 'completed' AND c.storage_key IS NULL AND g.tenant_id = $1`,
    [tenantId]
  );
  const total = Number(countRows[0].count);

  const { rows } = await pool.query(
    `SELECT c.id, c.direction, c.occurred_at AS "occurredAt", c.recording_status AS "recordingStatus",
            c.handled_by_name AS "handledByName", c.ghl_contact_id AS "contactId",
            ct.name AS "contactName", ct.phone AS "contactPhone"
     FROM calls c
     JOIN ghl_accounts g ON g.id = c.ghl_account_id
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE c.disposition = 'completed' AND c.storage_key IS NULL AND g.tenant_id = $1
     ORDER BY c.occurred_at DESC NULLS LAST
     LIMIT $2 OFFSET $3`,
    [tenantId, size, (pageNum - 1) * size]
  );
  return { gaps: rows, total, page: pageNum, pageSize: size };
}

async function getCall(callId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.storage_key AS "storageKey", c.recording_status AS "recordingStatus",
            c.occurred_at AS "occurredAt", c.direction, c.ghl_contact_id AS "contactId",
            c.handled_by_id AS "handledById", c.transcription_status AS "transcriptionStatus",
            c.transcription_attempts AS "transcriptionAttempts",
            c.transcript, c.transcript_words AS "transcriptWords",
            c.transcript_edited_at AS "transcriptEditedAt", c.transcript_edited_by AS "transcriptEditedBy",
            c.ghl_account_id AS "ghlAccountId", ct.name, ct.phone
     FROM calls c
     LEFT JOIN contacts ct ON ct.ghl_contact_id = c.ghl_contact_id
     WHERE c.id = $1`,
    [callId]
  );
  return rows[0] || null;
}

// --- users (dashboard login accounts) ---

async function createUser({ id, username, passwordHash, passwordSalt, role, ghlUserId, ghlUserName, tenantId, firstName, lastName }) {
  await pool.query(
    `INSERT INTO users (id, username, password_hash, password_salt, role, ghl_user_id, ghl_user_name, tenant_id, first_name, last_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, username, passwordHash, passwordSalt, role, ghlUserId || null, ghlUserName || null, tenantId || DEFAULT_TENANT_ID, firstName || null, lastName || null]
  );
}

// Created straight from the "GHL team" invite list (routes/admin.js's
// POST /users/invite) with no usable password yet -- only invite_token_hash
// lets them in, via getUserByInviteTokenHash/redeemInviteToken below.
async function createInvitedUser({ id, username, role, ghlUserId, ghlUserName, tenantId, inviteTokenHash, inviteTokenExpiresAt }) {
  await pool.query(
    `INSERT INTO users (id, username, role, ghl_user_id, ghl_user_name, tenant_id, invite_token_hash, invite_token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, username, role, ghlUserId || null, ghlUserName || null, tenantId || DEFAULT_TENANT_ID, inviteTokenHash, inviteTokenExpiresAt]
  );
}

// Looked up by the token's hash alone (see schema.sql's
// users_invite_token_hash_idx) -- the set-password page has nothing else
// to identify the user by until the link is actually clicked. Expired
// rows are excluded here rather than left for the caller to check, so a
// stale link reads the same as "no such invite" everywhere it's used.
async function getUserByInviteTokenHash(tokenHash) {
  const { rows } = await pool.query(
    `SELECT id, username, invite_token_expires_at AS "inviteTokenExpiresAt"
     FROM users WHERE invite_token_hash = $1 AND invite_token_expires_at > now()`,
    [tokenHash]
  );
  return rows[0] || null;
}

// Sets the real password and clears the invite token in one statement --
// re-checks the hash and expiry itself rather than trusting the caller
// already did (getUserByInviteTokenHash above), so a token can never be
// redeemed twice even under a race between two requests for the same link.
async function redeemInviteToken(tokenHash, passwordHash, passwordSalt) {
  const { rowCount } = await pool.query(
    `UPDATE users SET password_hash = $2, password_salt = $3, invite_token_hash = NULL, invite_token_expires_at = NULL
     WHERE invite_token_hash = $1 AND invite_token_expires_at > now()`,
    [tokenHash, passwordHash, passwordSalt]
  );
  return rowCount > 0;
}

async function getUserByUsername(username) {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash", password_salt AS "passwordSalt",
            role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName", tenant_id AS "tenantId",
            is_operator AS "isOperator", totp_enabled AS "totpEnabled",
            email_otp_enabled AS "emailOtpEnabled", email, email_verified_at AS "emailVerifiedAt",
            first_name AS "firstName", last_name AS "lastName"
     FROM users WHERE username = $1`,
    [username]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName", tenant_id AS "tenantId",
            is_operator AS "isOperator", totp_secret AS "totpSecret", totp_enabled AS "totpEnabled",
            email, email_verified_at AS "emailVerifiedAt", email_otp_enabled AS "emailOtpEnabled",
            first_name AS "firstName", last_name AS "lastName"
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function listUsers(tenantId) {
  const { rows } = await pool.query(
    `SELECT id, username, role, ghl_user_id AS "ghlUserId", ghl_user_name AS "ghlUserName", created_at AS "createdAt",
            totp_enabled AS "totpEnabled"
     FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId]
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

// --- Authenticator-app MFA (TOTP -- see src/totp.js) ---

// Starting (or restarting) enrollment always resets totp_enabled to false --
// it only flips true once the user proves they actually scanned it by
// confirming one real code back (see routes/api.js's /mfa/confirm).
async function setUserTotpSecret(userId, secret) {
  await pool.query(`UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2`, [secret, userId]);
}

async function enableUserTotp(userId) {
  await pool.query(`UPDATE users SET totp_enabled = true WHERE id = $1`, [userId]);
}

async function disableUserTotp(userId) {
  await pool.query(`UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM totp_recovery_codes WHERE user_id = $1`, [userId]);
}

// Regenerating replaces the whole set -- an old, unused code shouldn't stay
// valid once a fresh batch is issued, same as every other "regenerate
// recovery codes" flow (e.g. GitHub's).
async function replaceRecoveryCodes(userId, codeHashes) {
  await pool.query(`DELETE FROM totp_recovery_codes WHERE user_id = $1`, [userId]);
  const values = codeHashes.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");
  const params = codeHashes.flatMap((hash) => [randomUUID(), userId, hash]);
  await pool.query(`INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES ${values}`, params);
}

// Atomic: only succeeds once per code, so two concurrent requests racing to
// use the same recovery code can't both get in.
async function consumeRecoveryCode(userId, codeHash) {
  const { rows } = await pool.query(
    `UPDATE totp_recovery_codes SET used_at = now()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
     RETURNING id`,
    [userId, codeHash]
  );
  return rows.length > 0;
}

async function countUnusedRecoveryCodes(userId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return rows[0].count;
}

// --- Email-based MFA (self-service, additive to TOTP above -- see src/email.js) ---

// Starting (or restarting) verification always clears both email_verified_at
// and email_otp_enabled -- same reset-on-restart shape as
// setUserTotpSecret above, so a stale unverified address can never end up
// as the account's active MFA delivery address.
async function setUserPendingEmail(userId, email) {
  await pool.query(
    `UPDATE users SET email = $1, email_verified_at = NULL, email_otp_enabled = false WHERE id = $2`,
    [email, userId]
  );
}

// Returns false (and verifies nothing) if this exact address is already
// verified on a different account -- the schema's unique index would also
// catch this at the SQL level, but checking here first gives the route a
// clean way to report "someone else already verified this" instead of a
// raw constraint-violation error.
async function verifyUserEmail(userId) {
  const { rows: user } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
  if (!user[0] || !user[0].email) return false;
  const { rows: conflict } = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL AND id != $2`,
    [user[0].email, userId]
  );
  if (conflict.length > 0) return false;
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [userId]);
  return true;
}

async function enableUserEmailOtp(userId) {
  await pool.query(
    `UPDATE users SET email_otp_enabled = true WHERE id = $1 AND email_verified_at IS NOT NULL`,
    [userId]
  );
}

async function disableUserEmailOtp(userId) {
  await pool.query(`UPDATE users SET email_otp_enabled = false WHERE id = $1`, [userId]);
}

async function createEmailOtpCode(userId, purpose, codeHash, expiresAt) {
  await pool.query(
    `INSERT INTO email_otp_codes (id, user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), userId, purpose, codeHash, expiresAt]
  );
}

// Atomic and scoped to purpose, so a code issued to confirm an email
// change can't double as a login code (or vice versa) even if the hashes
// somehow matched. Expired or already-used codes never match.
async function consumeEmailOtpCode(userId, purpose, codeHash) {
  const { rows } = await pool.query(
    `UPDATE email_otp_codes SET used_at = now()
     WHERE user_id = $1 AND purpose = $2 AND code_hash = $3 AND used_at IS NULL AND expires_at > now()
     RETURNING id`,
    [userId, purpose, codeHash]
  );
  return rows.length > 0;
}

// The hard backstop against spamming someone's inbox -- checked fresh from
// the DB immediately before every send, rather than relying solely on a
// route-level rate limiter (express-rate-limit's in-memory store has no
// way to key a request that hasn't resolved a user id yet, e.g. /login's
// first hit, and a login retry loop -- a client bug or someone hammering
// the form with a known password -- shouldn't be able to fire an
// unbounded stream of emails just because each individual request "looks"
// like a fresh, allowed one). Counts codes issued in the window regardless
// of whether they were ever used.
async function countRecentEmailOtpCodes(userId, purpose, sinceMinutes) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM email_otp_codes
     WHERE user_id = $1 AND purpose = $2 AND created_at > now() - ($3 || ' minutes')::interval`,
    [userId, purpose, sinceMinutes]
  );
  return rows[0].count;
}

// --- tenants / ghl_accounts / user_account_access (multi-tenant) ---

async function createTenant({ id, name, ownerUserId }) {
  await pool.query(`INSERT INTO tenants (id, name, owner_user_id) VALUES ($1, $2, $3)`, [id, name, ownerUserId || null]);
}

// Fills in owner_user_id after the fact -- needed because the owner's user
// row has a tenant_id FK pointing back at this same tenant, so the tenant
// has to exist (with owner_user_id still null) before that user can be
// created at all. See routes/auth.js's /signup for the actual sequencing.
async function updateTenantOwner(tenantId, ownerUserId) {
  await pool.query(`UPDATE tenants SET owner_user_id = $1 WHERE id = $2`, [ownerUserId, tenantId]);
}

// For src/storageCostJob.js's monthly sweep -- every tenant whose data
// still exists to be charged storage for. A fully 'canceled' tenant has
// already been purged (src/tenantPurge.js deletes its recordings), so
// there's nothing left to bill; 'cancellation_pending' still has its data
// for the whole grace period and keeps being billed normally until then.
async function listAllTenantIds() {
  const { rows } = await pool.query(`SELECT id FROM tenants WHERE status != 'canceled'`);
  return rows.map((r) => r.id);
}

// Cumulative margin (all-time, every category) per active tenant -- the
// basis for src/storageCostJob.js's negative-margin alert. All-time, not
// month-to-date: cost_ledger is a permanent ledger, and a tenant that's
// been profitable for a year shouldn't suddenly look "negative" just
// because this month alone had a cost spike -- the alert cares whether
// the relationship with this client has gone upside-down overall, not
// about one month in isolation.
async function listTenantMargins() {
  const { rows } = await pool.query(`
    SELECT t.id, t.name,
           coalesce(sum(l.aws_cost), 0)::numeric AS "totalCost",
           coalesce(sum(l.client_revenue), 0)::numeric AS "totalRevenue"
    FROM tenants t
    LEFT JOIN cost_ledger l ON l.tenant_id = t.id
    WHERE t.status != 'canceled'
    GROUP BY t.id, t.name
  `);
  return rows;
}

// Total bytes currently stored across every call this tenant owns
// (across all its GHL accounts, active or disconnected -- disconnecting
// an account stops new syncing, not what's already stored, see routes/
// admin.js's disconnect route). The storage-cost job's basis (src/
// storageCostJob.js) -- a snapshot, not a true daily average, since
// nothing records byte-count history over time; see that job's own
// comment for why this is still a reasonable approximation here.
async function getTotalStoredBytesForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT coalesce(sum(c.size_bytes), 0)::bigint AS "totalBytes"
     FROM calls c JOIN ghl_accounts g ON g.id = c.ghl_account_id
     WHERE g.tenant_id = $1`,
    [tenantId]
  );
  return Number(rows[0].totalBytes);
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

// Cross-tenant, for src/routes/operator.js only (see requireOperator) --
// every other query in this file scopes to one tenant/account on purpose,
// this is the one deliberate exception. transcribedMinutes is what
// actually varies by client and costs real money per-minute (see
// src/transcription.js's own cost reasoning) -- shown as an estimate, not
// pulled from an actual AWS bill, since nothing here tags Transcribe usage
// by tenant. The shared EC2/RDS cost is deliberately left out: it's fixed
// overhead that doesn't grow per account, not something one client's usage
// increases, so it doesn't belong in a "which account costs the most"
// comparison.
async function listTenantsForOperator() {
  const { rows } = await pool.query(`
    SELECT
      t.id, t.name, t.status, t.created_at AS "createdAt", t.purge_at AS "purgeAt",
      u.username AS "ownerUsername",
      (SELECT count(*)::int FROM ghl_accounts ga WHERE ga.tenant_id = t.id) AS "ghlAccountCount",
      (SELECT count(*)::int FROM calls c JOIN ghl_accounts ga ON ga.id = c.ghl_account_id
         WHERE ga.tenant_id = t.id) AS "totalCalls",
      -- Same definitions as getCoverageSummary's own "completed" and
      -- "completedMissing" (the client-facing Coverage report) -- a
      -- no-answer/busy/voicemail/failed/canceled call never had a
      -- recording to begin with, so it shouldn't count as a gap.
      -- completedMissing is computed directly here, not derived from
      -- completedCalls/recordingsStored client-side -- recordingsStored
      -- below is the OVERALL stored count (it includes recordings that
      -- exist on non-completed calls, e.g. a voicemail message itself
      -- getting recorded), a different population than "completed calls
      -- specifically missing one", so subtracting one from the other
      -- would silently undercount the real gap.
      (SELECT count(*)::int FROM calls c JOIN ghl_accounts ga ON ga.id = c.ghl_account_id
         WHERE ga.tenant_id = t.id AND c.disposition = 'completed') AS "completedCalls",
      (SELECT count(*)::int FROM calls c JOIN ghl_accounts ga ON ga.id = c.ghl_account_id
         WHERE ga.tenant_id = t.id AND c.disposition = 'completed' AND c.storage_key IS NULL) AS "completedMissing",
      (SELECT count(*)::int FROM calls c JOIN ghl_accounts ga ON ga.id = c.ghl_account_id
         WHERE ga.tenant_id = t.id AND c.storage_key IS NOT NULL) AS "recordingsStored",
      (SELECT coalesce(sum(c.duration_seconds), 0)::int FROM calls c JOIN ghl_accounts ga ON ga.id = c.ghl_account_id
         WHERE ga.tenant_id = t.id AND c.transcription_status = 'completed') AS "transcribedSeconds",
      -- Real cost-ledger sums (schema.sql's cost_ledger comment) -- unlike
      -- transcribedSeconds/estimatedTranscribeCost above (a live estimate
      -- the route computes from today's rate), these are the actual
      -- recorded receipts, each at the rate that was in effect when it
      -- happened. storageRevenue is the safety-net overage charge only
      -- (billingRates.js's CLIENT_STORAGE_FREE_GB comment) -- $0 for a
      -- normal account, never a general storage rate.
      (SELECT coalesce(sum(l.aws_cost), 0)::numeric FROM cost_ledger l WHERE l.tenant_id = t.id AND l.category = 'transcription') AS "transcriptionAwsCost",
      (SELECT coalesce(sum(l.client_revenue), 0)::numeric FROM cost_ledger l WHERE l.tenant_id = t.id AND l.category = 'transcription') AS "transcriptionRevenue",
      (SELECT coalesce(sum(l.aws_cost), 0)::numeric FROM cost_ledger l WHERE l.tenant_id = t.id AND l.category = 'ai_summary') AS "aiSummaryAwsCost",
      (SELECT coalesce(sum(l.client_revenue), 0)::numeric FROM cost_ledger l WHERE l.tenant_id = t.id AND l.category = 'ai_summary') AS "aiSummaryRevenue",
      (SELECT coalesce(sum(l.aws_cost), 0)::numeric FROM cost_ledger l WHERE l.tenant_id = t.id AND l.category = 'storage') AS "storageAwsCost",
      (SELECT coalesce(sum(l.client_revenue), 0)::numeric FROM cost_ledger l WHERE l.tenant_id = t.id AND l.category = 'storage') AS "storageRevenue"
    FROM tenants t
    LEFT JOIN users u ON u.id = t.owner_user_id
    ORDER BY t.name
  `);
  return rows;
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

// Only called with a real fetched name (see src/routes/admin.js's OAuth
// callback) -- never overwrites an existing name with null on a failed
// GHL lookup.
async function updateGhlAccountName(id, name) {
  await pool.query(`UPDATE ghl_accounts SET name = $2 WHERE id = $1`, [id, name]);
}

// Self-service disconnect (src/routes/admin.js's POST /ghl-accounts/:id/
// disconnect) -- stops the ingestion poller from touching this account
// (it only ever loops listAllActiveGhlAccounts, which filters exactly
// this column) without deleting anything it already brought in:
// recordings, contacts, and calls all keep their ghl_account_id exactly
// as they are. Tokens are cleared too -- no reason to keep live GHL
// credentials around for a connection the admin just chose to end;
// reconnecting (same location) gets fresh ones anyway and is recognized
// as the same account by the OAuth callback (matched on GHL's own
// location ID, not this row's id -- see getGhlAccountByLocationId above).
// Guarded by uninstalled_at IS NULL so calling this twice is a no-op the
// caller can detect via the returned row count, not a silent re-stamp of
// the disconnect time.
async function disconnectGhlAccount(id) {
  const { rowCount } = await pool.query(
    `UPDATE ghl_accounts SET uninstalled_at = now(), access_token = NULL, refresh_token = NULL, token_expires_at = NULL
     WHERE id = $1 AND uninstalled_at IS NULL`,
    [id]
  );
  return rowCount > 0;
}

// Every account this tenant has ever connected, active or not, with
// enough status to manage the connection from Settings -- unlike
// listGhlAccountsForTenant below (active only, since that's also what
// powers the Team tab's per-user account-access checklist, where
// offering access to a disconnected account makes no sense). Without
// this, disconnecting an account would make it vanish from the UI
// entirely with no way back except OAuth-connecting blind and hoping
// GHL's own location picker is unambiguous. lastSyncedAt is the
// ingestion poller's own checkpoint (see account_sync_state below) --
// surfaced here so a stuck/stale sync is visible without having to ask
// someone to check the database.
async function listGhlAccountsWithStatusForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT g.id, g.ghl_location_id AS "ghlLocationId", g.name,
            g.installed_at AS "installedAt", g.uninstalled_at AS "uninstalledAt",
            s.last_synced_at AS "lastSyncedAt"
     FROM ghl_accounts g
     LEFT JOIN account_sync_state s ON s.ghl_account_id = g.id
     WHERE g.tenant_id = $1
     ORDER BY (g.uninstalled_at IS NOT NULL), g.installed_at ASC`,
    [tenantId]
  );
  return rows;
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

// Same shape as listAllActiveGhlAccounts, scoped to one tenant -- for
// src/backfill.js's run() when triggered from one tenant's own admin UI
// (POST /api/admin/backfill), which must only ever touch that tenant's own
// accounts. The unscoped version above stays as-is for the poller and the
// bare `node src/backfill.js` CLI invocation, both of which legitimately
// need every account regardless of tenant.
async function listActiveGhlAccountsForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id AS "tenantId", ghl_location_id AS "ghlLocationId", name,
            access_token AS "accessToken", refresh_token AS "refreshToken", token_expires_at AS "tokenExpiresAt"
     FROM ghl_accounts WHERE uninstalled_at IS NULL AND tenant_id = $1`,
    [tenantId]
  );
  return rows;
}

// Same credential shape as listAllActiveGhlAccounts, for one account by
// its own row id -- src/callSummaryPoller.js needs this to resolve a
// single call's account (via accountCredentials.clientForAccount) rather
// than looping every active account like the ingestion poller does.
async function getGhlAccountById(id) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id AS "tenantId", ghl_location_id AS "ghlLocationId", name,
            access_token AS "accessToken", refresh_token AS "refreshToken", token_expires_at AS "tokenExpiresAt"
     FROM ghl_accounts WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
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

// Per-account, not global (see schema.sql's migration comment for why this
// moved off app_settings) -- a call ingested for one GHL account must never
// be able to trigger auto-transcription because some *other* account has
// it turned on.
async function getAutoTranscribeEnabled(ghlAccountId) {
  const { rows } = await pool.query(
    `SELECT auto_transcribe_enabled AS "autoTranscribeEnabled" FROM ghl_accounts WHERE id = $1`,
    [ghlAccountId]
  );
  return rows[0] ? rows[0].autoTranscribeEnabled : false;
}

async function setAutoTranscribeEnabled(ghlAccountId, enabled) {
  await pool.query(`UPDATE ghl_accounts SET auto_transcribe_enabled = $2 WHERE id = $1`, [ghlAccountId, enabled]);
}

async function getAiSummaryEnabled(ghlAccountId) {
  const { rows } = await pool.query(
    `SELECT ai_summary_enabled AS "aiSummaryEnabled" FROM ghl_accounts WHERE id = $1`,
    [ghlAccountId]
  );
  return rows[0] ? rows[0].aiSummaryEnabled : false;
}

async function setAiSummaryEnabled(ghlAccountId, enabled) {
  await pool.query(`UPDATE ghl_accounts SET ai_summary_enabled = $2 WHERE id = $1`, [ghlAccountId, enabled]);
}

// --- cost_ledger (see schema.sql's comment on this table for why it's a
// permanent receipt per billable event, not a live recalculated
// estimate) ---

// ON CONFLICT (call_id, category, attempt) matches
// cost_ledger_call_category_attempt_idx -- a second write for the same
// call+category+attempt (a retried poller cycle checking the same job
// twice) is a silent no-op, not a double-billed row; a *different*
// attempt on the same call+category is a real new row, not a conflict.
// Every rate/cost argument is passed in already computed by the caller
// (src/transcriptionPoller.js, src/callSummaryPoller.js), which reads
// them from src/billingRates.js at write time -- this function just
// persists them, it doesn't decide what the rates are.
// attempt identifies which transcription try (calls.transcription_attempts
// at write time) this row is for -- see schema.sql's comment on the
// attempt column. A failed attempt calls this too (clientRate/clientRevenue
// null -- never bill for a job that produced nothing usable), so a call
// retried 3 times before succeeding has 3 real rows, not 1.
async function recordTranscriptionCost({ tenantId, ghlAccountId, callId, minutes, awsRate, awsCost, clientRate, clientRevenue, attempt, backfilled }) {
  await pool.query(
    `INSERT INTO cost_ledger (id, tenant_id, ghl_account_id, category, call_id, quantity, quantity_unit, aws_rate, aws_cost, client_rate, client_revenue, attempt, backfilled)
     VALUES ($1, $2, $3, 'transcription', $4, $5, 'minutes', $6, $7, $8, $9, $10, $11)
     ON CONFLICT (call_id, category, attempt) WHERE call_id IS NOT NULL DO NOTHING`,
    [randomUUID(), tenantId, ghlAccountId, callId, minutes, awsRate, awsCost, clientRate, clientRevenue, attempt, Boolean(backfilled)]
  );
}

async function recordAiSummaryCost({ tenantId, ghlAccountId, callId, inputTokens, outputTokens, awsRate, awsCost, clientRate, clientRevenue, attempt, backfilled }) {
  await pool.query(
    `INSERT INTO cost_ledger (id, tenant_id, ghl_account_id, category, call_id, quantity, quantity_unit, aws_rate, aws_cost, client_rate, client_revenue, input_tokens, output_tokens, attempt, backfilled)
     VALUES ($1, $2, $3, 'ai_summary', $4, $5, 'tokens', $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (call_id, category, attempt) WHERE call_id IS NOT NULL DO NOTHING`,
    [randomUUID(), tenantId, ghlAccountId, callId, (inputTokens || 0) + (outputTokens || 0), awsRate, awsCost, clientRate, clientRevenue, inputTokens, outputTokens, attempt, Boolean(backfilled)]
  );
}

// One row per tenant per period (src/storageCostJob.js) -- ghl_account_id
// is left NULL, since this sums bytes across every account the tenant
// owns, not any one of them (see schema.sql's cost_ledger comment).
// ON CONFLICT (tenant_id, period_start) matches
// cost_ledger_storage_period_idx -- re-running the job for a period
// that's already been billed is a no-op.
// clientRate/clientRevenue are nullable -- a storage entry recorded
// before the free-tier/overage policy existed (see billingRates.js's
// CLIENT_STORAGE_FREE_GB comment) has none, and stays that way: this is
// a receipt, so a policy that didn't exist yet when the entry was
// written is never applied to it retroactively.
async function recordStorageCost({ tenantId, periodStart, periodEnd, gbMonths, awsRate, awsCost, clientRate, clientRevenue, backfilled }) {
  await pool.query(
    `INSERT INTO cost_ledger (id, tenant_id, category, period_start, period_end, quantity, quantity_unit, aws_rate, aws_cost, client_rate, client_revenue, backfilled)
     VALUES ($1, $2, 'storage', $3, $4, $5, 'gb_months', $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, period_start) WHERE category = 'storage' DO NOTHING`,
    [randomUUID(), tenantId, periodStart, periodEnd, gbMonths, awsRate, awsCost, clientRate ?? null, clientRevenue ?? null, Boolean(backfilled)]
  );
}

// --- daily_storage_snapshots (real day-by-day history, see schema.sql's
// comment on that table for why this replaces a single end-of-month
// snapshot once enough days have accumulated) ---

// Upsert, not insert-once: src/storageCostJob.js calls this every cycle
// for "today", so the latest reading during the day keeps overwriting
// today's row -- once the day turns over, this tenant+date is never
// touched again (a later cycle is always writing a *new* day's row by
// then), which is what makes a past day's figure permanent.
async function upsertDailyStorageSnapshot(tenantId, snapshotDate, totalBytes) {
  await pool.query(
    `INSERT INTO daily_storage_snapshots (id, tenant_id, snapshot_date, total_bytes, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET total_bytes = $4, updated_at = now()`,
    [randomUUID(), tenantId, snapshotDate, totalBytes]
  );
}

// Average bytes stored across whatever daily snapshots actually exist in
// [periodStart, periodEnd) -- dayCount tells the caller how many days
// that average is based on, so src/storageCostJob.js can tell "a real
// daily average across the month" apart from "no daily history exists
// for this period at all" (an older month, or the transition month this
// feature was deployed mid-way through) and fall back accordingly.
async function getAverageStoredBytesForTenantPeriod(tenantId, periodStart, periodEnd) {
  const { rows } = await pool.query(
    `SELECT coalesce(avg(total_bytes), 0)::numeric AS "avgBytes", count(*)::int AS "dayCount"
     FROM daily_storage_snapshots
     WHERE tenant_id = $1 AND snapshot_date >= $2 AND snapshot_date < $3`,
    [tenantId, periodStart, periodEnd]
  );
  return rows[0];
}

// --- audit_log (who changed what admin setting/account, and when) ---

// tenantId is optional purely for src/tenantPurge.js/src/routes/operator.js,
// whose actions aren't scoped to any one tenant's own admin session --
// every route in routes/admin.js (the only other caller) always has a real
// tenantId from req.session.user and must pass it, so its own entries are
// never invisible to the tenant that generated them.
async function logAudit({ actorId, actorUsername, action, message, tenantId }) {
  await pool.query(
    `INSERT INTO audit_log (id, actor_id, actor_username, action, message, tenant_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), actorId || null, actorUsername || null, action, message, tenantId || null]
  );
}

// tenantId is required -- see this table's tenant_id column comment in
// schema.sql for why every admin's own Activity log was showing every
// other tenant's entries too before this existed.
async function listAuditLog(tenantId, { page = 1, pageSize = 50 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM audit_log WHERE tenant_id = $1`, [tenantId]);
  const total = Number(countRows[0].count);

  // COALESCE to the GHL name currently linked to the actor's user account,
  // falling back to the username recorded at the time (matters once that
  // link changes, or if the account has since been deleted).
  const { rows } = await pool.query(
    `SELECT l.id, l.actor_id AS "actorId", COALESCE(u.ghl_user_name, l.actor_username) AS "actorUsername",
            l.action, l.message, l.created_at AS "createdAt"
     FROM audit_log l
     LEFT JOIN users u ON u.id = l.actor_id
     WHERE l.tenant_id = $1
     ORDER BY l.created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, size, (pageNum - 1) * size]
  );
  return { entries: rows, total, page: pageNum, pageSize: size };
}

// Cross-tenant, for src/routes/operator.js only -- same reasoning as
// listTenantsForOperator.
// tenant_id IS NULL is exactly the operator-only entries (see logAudit's
// comment) -- every regular per-tenant admin action already has a
// tenant_id and belongs on that tenant's own Activity log (listAuditLog
// above), not mixed in here. Without this filter this returned every
// tenant's routine admin activity too, which is both not what this view
// is for and a real privacy overreach: an operator has no business
// browsing a specific client's day-to-day settings changes through this
// page.
async function listAuditLogForOperator({ page = 1, pageSize = 50 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM audit_log WHERE tenant_id IS NULL`);
  const total = Number(countRows[0].count);

  const { rows } = await pool.query(
    `SELECT l.id, l.actor_id AS "actorId", COALESCE(u.ghl_user_name, l.actor_username) AS "actorUsername",
            l.action, l.message, l.created_at AS "createdAt"
     FROM audit_log l
     LEFT JOIN users u ON u.id = l.actor_id
     WHERE l.tenant_id IS NULL
     ORDER BY l.created_at DESC
     LIMIT $1 OFFSET $2`,
    [size, (pageNum - 1) * size]
  );
  return { entries: rows, total, page: pageNum, pageSize: size };
}

// --- phi_access_log (who accessed which call's recording/transcript,
// when, from where, how, and whether it was allowed -- see routes/api.js) ---

async function logPhiAccess({ userId, username, action, callId, success, denialReason, ipAddress, userAgent, tenantId }) {
  await pool.query(
    `INSERT INTO phi_access_log
       (id, user_id, username, action, call_id, success, denial_reason, ip_address, user_agent, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [randomUUID(), userId || null, username || null, action, callId || null, success, denialReason || null, ipAddress || null, userAgent || null, tenantId || null]
  );
}

// tenantId is required -- see audit_log's listAuditLog for why.
async function listPhiAccessLog(tenantId, { page = 1, pageSize = 50 } = {}) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : 50;
  const pageNum = Math.max(1, Number(page) || 1);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM phi_access_log WHERE tenant_id = $1`, [tenantId]);
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
     WHERE l.tenant_id = $1
     ORDER BY l.created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, size, (pageNum - 1) * size]
  );
  return { entries: rows, total, page: pageNum, pageSize: size };
}

module.exports = {
  pool,
  DEFAULT_TENANT_ID,
  DEFAULT_GHL_ACCOUNT_ID,
  createTenant,
  updateTenantOwner,
  getTenantById,
  listAllTenantIds,
  listTenantMargins,
  getTotalStoredBytesForTenant,
  requestTenantCancellation,
  restoreTenant,
  listTenantsReadyForPurge,
  purgeTenantData,
  listStorageKeysForTenant,
  listTenantsForOperator,
  createGhlAccount,
  getGhlAccountByLocationId,
  updateGhlAccountTokens,
  updateGhlAccountName,
  disconnectGhlAccount,
  listGhlAccountsForTenant,
  listGhlAccountsWithStatusForTenant,
  listAccessibleAccounts,
  listAllActiveGhlAccounts,
  listActiveGhlAccountsForTenant,
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
  updateCallTranscript,
  markTranscriptionFailed,
  listPendingTranscriptions,
  listPendingCallSummaries,
  incrementSummaryAttempts,
  markSummaryComplete,
  markSummaryFailed,
  markGhlNoteWritten,
  getGhlAccountById,
  updateCallHandler,
  listContacts,
  listAllContacts,
  listCalls,
  getCallStats,
  listDistinctDispositions,
  getCallReportByRep,
  getCallReportDispositionsByRep,
  getCallReportTrend,
  computeCallDigestStats,
  saveCallDigest,
  getLatestCallDigest,
  listGhlAccountsNeedingDigest,
  getDigestSchedule,
  setDigestSchedule,
  listAllCallsWithRecordings,
  getCoverageSummary,
  getCoverageByDisposition,
  getCoverageByMonth,
  listCoverageGaps,
  getCall,
  createUser,
  createInvitedUser,
  getUserByInviteTokenHash,
  redeemInviteToken,
  getUserByUsername,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  setUserTotpSecret,
  enableUserTotp,
  disableUserTotp,
  replaceRecoveryCodes,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  setUserPendingEmail,
  verifyUserEmail,
  enableUserEmailOtp,
  disableUserEmailOtp,
  createEmailOtpCode,
  consumeEmailOtpCode,
  countRecentEmailOtpCodes,
  getLastSyncedAt,
  setLastSyncedAt,
  getAccountLastSyncedAt,
  setAccountLastSyncedAt,
  getAutoTranscribeEnabled,
  setAutoTranscribeEnabled,
  getAiSummaryEnabled,
  setAiSummaryEnabled,
  recordTranscriptionCost,
  recordAiSummaryCost,
  recordStorageCost,
  upsertDailyStorageSnapshot,
  getAverageStoredBytesForTenantPeriod,
  logAudit,
  listAuditLog,
  listAuditLogForOperator,
  logPhiAccess,
  listPhiAccessLog,
};
