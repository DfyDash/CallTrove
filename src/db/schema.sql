-- CallTrove schema (prototype phase).
-- No encryption-at-rest / access-control columns yet -- that's phase 2 (HIPAA).

CREATE TABLE IF NOT EXISTS contacts (
  ghl_contact_id  TEXT PRIMARY KEY,
  name            TEXT,
  phone           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id                    UUID PRIMARY KEY,
  ghl_call_id           TEXT UNIQUE NOT NULL,
  ghl_contact_id        TEXT NOT NULL REFERENCES contacts(ghl_contact_id),
  direction             TEXT,
  duration_seconds      INTEGER,
  occurred_at           TIMESTAMPTZ,
  source_recording_url  TEXT,
  storage_key           TEXT,
  recording_status      TEXT NOT NULL DEFAULT 'pending',
  raw_payload           JSONB,
  handled_by_id         TEXT,
  handled_by_name       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADD COLUMN IF NOT EXISTS so re-running this migration against a database
-- that already had the old calls/contacts tables (before handled_by_* or
-- the users table existed) still brings it up to date, not just fresh ones.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS handled_by_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS handled_by_name TEXT;

-- Transcription is optional (TRANSCRIPTION_ENABLED) and async (AWS Transcribe
-- jobs run in the background -- see src/transcription.js /
-- src/transcriptionPoller.js), so a call's transcript arrives well after the
-- row itself. 'none' covers both "feature is off" and "not submitted yet".
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcription_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript TEXT;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_transcription_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_transcription_status_check
  CHECK (transcription_status IN ('none', 'pending', 'completed', 'failed'));

-- GHL's own call disposition (completed / no-answer / busy / canceled /
-- voicemail / ...). Most of these never have a recording -- there was
-- nothing to record -- so the dashboard needs this to tell "no recording
-- because no one answered" apart from "no recording despite the call
-- connecting", which is the only case actually worth investigating.
-- Backfilled from raw_payload for existing rows; new rows get it directly
-- at insert time.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS disposition TEXT;
UPDATE calls SET disposition = COALESCE(raw_payload->>'status', raw_payload->'meta'->'call'->>'status')
  WHERE disposition IS NULL AND raw_payload IS NOT NULL;

CREATE INDEX IF NOT EXISTS calls_contact_idx ON calls (ghl_contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS calls_handled_by_idx ON calls (handled_by_id);
CREATE INDEX IF NOT EXISTS calls_occurred_at_idx ON calls (occurred_at DESC);

-- Dashboard login accounts. Not linked to GHL's own user system (no OAuth
-- in this phase) -- an admin creates accounts here and maps each one to the
-- GHL user identity (handled_by_id) that appears on their calls.
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  ghl_user_id    TEXT,
  ghl_user_name  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row checkpoint for the polling-based ingestion (replaces the GHL
-- webhook/workflow entirely -- see src/poller.js). Tracks the newest call
-- dateAdded already processed, so each poll only looks at what's new.
CREATE TABLE IF NOT EXISTS sync_state (
  id              INT PRIMARY KEY DEFAULT 1,
  last_synced_at  TIMESTAMPTZ,
  CONSTRAINT sync_state_single_row CHECK (id = 1)
);

-- Single-row, admin-toggleable settings (live, not env-var-gated -- flip on
-- or off without a redeploy). auto_transcribe_enabled only affects calls
-- the live poller picks up *after* it's checked -- src/poller.js checks it
-- fresh per new call, and src/backfill.js never checks it at all, so
-- historical recordings are never swept into auto-transcription by turning
-- this on.
CREATE TABLE IF NOT EXISTS app_settings (
  id                       INT PRIMARY KEY DEFAULT 1,
  auto_transcribe_enabled  BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Admin action history -- who changed what, and when. No FK to users(id):
-- entries must survive that user's account later being deleted, so
-- actor_username is captured at write time rather than joined later.
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY,
  actor_id        UUID,
  actor_username  TEXT,
  action          TEXT NOT NULL,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);

-- PHI-access log: who accessed which call's recording/transcript, when,
-- from where, how, and whether it was allowed -- see src/routes/api.js.
-- HIPAA's audit-controls rule (45 CFR 164.312(b)) expects both successful
-- and denied access attempts recorded; success=false rows are someone
-- being blocked by the RBAC check, which is itself worth a record.
-- No FK to users(id) or calls(id), same reasoning as audit_log above:
-- entries must outlive the account or (eventually) the recording they
-- reference, not disappear when either is deleted.
CREATE TABLE IF NOT EXISTS phi_access_log (
  id             UUID PRIMARY KEY,
  user_id        UUID,
  username       TEXT,
  action         TEXT NOT NULL,   -- recording_played | recording_downloaded | transcript_viewed | transcription_requested
  call_id        UUID,
  success        BOOLEAN NOT NULL,
  denial_reason  TEXT,
  ip_address     TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phi_access_log_created_at_idx ON phi_access_log (created_at DESC);
CREATE INDEX IF NOT EXISTS phi_access_log_call_id_idx ON phi_access_log (call_id);
CREATE INDEX IF NOT EXISTS phi_access_log_user_id_idx ON phi_access_log (user_id);

-- Multi-tenant foundation: one CallTrove customer (tenant) will eventually
-- be able to connect multiple GHL sub-accounts (ghl_accounts) and grant
-- individual team members access to specific ones (user_account_access,
-- the per-user "checklist"). This adds the tables/columns and backfills a
-- single default tenant + account so today's single-account deployment
-- keeps working unchanged. It deliberately does NOT yet make
-- contacts.ghl_contact_id / calls.ghl_call_id account-scoped (they stay
-- globally unique) -- that's real surgery on live tables (changing a
-- primary key and its foreign keys), not worth the risk until a second
-- GHL account is actually being connected somewhere. ghl_account_id here
-- is enough to build and test the permission-checking layer now.
CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ghl_accounts (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  ghl_location_id   TEXT NOT NULL UNIQUE,
  name              TEXT,
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ghl_accounts_tenant_idx ON ghl_accounts (tenant_id);

-- Per-user grant to one connected account. Admins bypass this table
-- entirely and see every account their tenant owns (see
-- listAccessibleAccountIds in src/db/index.js) -- it only restricts
-- non-admin users, same as the existing ghl_user_id call-scoping.
CREATE TABLE IF NOT EXISTS user_account_access (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ghl_account_id  UUID NOT NULL REFERENCES ghl_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, ghl_account_id)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ghl_account_id UUID REFERENCES ghl_accounts(id);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ghl_account_id UUID REFERENCES ghl_accounts(id);
CREATE INDEX IF NOT EXISTS contacts_ghl_account_idx ON contacts (ghl_account_id);
CREATE INDEX IF NOT EXISTS calls_ghl_account_idx ON calls (ghl_account_id);

-- Fixed, well-known IDs (rather than gen_random_uuid()) so this backfill
-- is idempotent across re-runs and so src/db/index.js can reference the
-- same default account as a fallback for ingestion code (src/poller.js,
-- src/backfill.js) that isn't multi-account-aware yet.
INSERT INTO tenants (id, name)
  SELECT '00000000-0000-0000-0000-000000000001', 'Default tenant'
  WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = '00000000-0000-0000-0000-000000000001');

INSERT INTO ghl_accounts (id, tenant_id, ghl_location_id, name)
  SELECT '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'default', 'Default account'
  WHERE NOT EXISTS (SELECT 1 FROM ghl_accounts WHERE id = '00000000-0000-0000-0000-000000000001');

UPDATE users SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE contacts SET ghl_account_id = '00000000-0000-0000-0000-000000000001' WHERE ghl_account_id IS NULL;
UPDATE calls SET ghl_account_id = '00000000-0000-0000-0000-000000000001' WHERE ghl_account_id IS NULL;

-- Every existing user gets access to the default account, so post-migration
-- everyone sees exactly what they saw before this ran.
INSERT INTO user_account_access (user_id, ghl_account_id)
  SELECT id, '00000000-0000-0000-0000-000000000001' FROM users
  ON CONFLICT DO NOTHING;

-- Append-only enforcement for both log tables above: HIPAA's audit-controls
-- guidance expects tamper-evident logs, not just "the app has no edit
-- button". This rejects UPDATE/DELETE at the database engine level
-- regardless of which credential issues it -- a real barrier, not just an
-- application-layer convention. (Full cryptographic hash-chaining / WORM
-- storage is the next step up and deliberately not built yet -- see
-- "Admin activity log" / PHI-access logging in the README.)
CREATE OR REPLACE FUNCTION reject_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_log_mutation();

DROP TRIGGER IF EXISTS phi_access_log_append_only ON phi_access_log;
CREATE TRIGGER phi_access_log_append_only
  BEFORE UPDATE OR DELETE ON phi_access_log
  FOR EACH ROW EXECUTE FUNCTION reject_log_mutation();
