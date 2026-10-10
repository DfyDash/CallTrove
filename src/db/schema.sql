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

-- Each Transcribe job is real, billable AWS cost regardless of whether it
-- ultimately succeeds -- 'failed' is deliberately retryable (a transient
-- AWS issue shouldn't leave a call stuck forever), but nothing else bounds
-- how many times a call can be resubmitted. Counted here so the on-demand
-- endpoint can cap retries instead of a bad file (or a bug, or someone just
-- clicking the retry button) racking up jobs with no limit.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcription_attempts INTEGER NOT NULL DEFAULT 0;

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
  id  INT PRIMARY KEY DEFAULT 1,
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
  action         TEXT NOT NULL,   -- recording_played | recording_downloaded | transcript_viewed | transcription_requested | transcript_edited
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

-- Cross-tenant access for the platform operator (your own agency), not any
-- client -- separate from the per-tenant 'admin' role above, which only
-- ever sees its own tenant's data no matter what. False for every user by
-- default; there is deliberately no self-service or UI way to grant this
-- to a user, only a direct DB update (see src/grantOperator.js) -- the
-- same reasoning as tenantPurge.js's CLI-only purge: granting the ability
-- to see and delete every client's data is not something a bug in a route
-- should ever be able to do on its own.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_operator BOOLEAN NOT NULL DEFAULT false;
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

-- auto_transcribe_enabled used to live as a single global row on
-- app_settings -- meaning turning it on/off for one connected account
-- silently applied to every account on the deployment. Moved onto
-- ghl_accounts itself, same as account_sync_state below, so it's actually
-- per-account. The backfill preserves whatever today's single global value
-- already was, applied to every existing account, so nobody's current
-- behavior silently changes the moment this migration runs.
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS auto_transcribe_enabled BOOLEAN NOT NULL DEFAULT false;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'auto_transcribe_enabled') THEN
    UPDATE ghl_accounts SET auto_transcribe_enabled = true
      WHERE EXISTS (SELECT 1 FROM app_settings WHERE id = 1 AND auto_transcribe_enabled = true);
    ALTER TABLE app_settings DROP COLUMN auto_transcribe_enabled;
  END IF;
END $$;

UPDATE users SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
UPDATE contacts SET ghl_account_id = '00000000-0000-0000-0000-000000000001' WHERE ghl_account_id IS NULL;
UPDATE calls SET ghl_account_id = '00000000-0000-0000-0000-000000000001' WHERE ghl_account_id IS NULL;

-- Every existing user gets access to the default account, so post-migration
-- everyone sees exactly what they saw before this ran.
INSERT INTO user_account_access (user_id, ghl_account_id)
  SELECT id, '00000000-0000-0000-0000-000000000001' FROM users
  ON CONFLICT DO NOTHING;

-- Per-account ingestion checkpoint, replacing the single-row sync_state
-- above now that one poller cycle (src/poller.js) covers more than one
-- connected GHL account -- each needs its own independent "newest call
-- already processed" watermark. sync_state itself is left in place, not
-- dropped, as a rollback safety net.
CREATE TABLE IF NOT EXISTS account_sync_state (
  ghl_account_id  UUID PRIMARY KEY REFERENCES ghl_accounts(id) ON DELETE CASCADE,
  last_synced_at  TIMESTAMPTZ
);

-- Backfill: the existing single checkpoint becomes the default account's
-- checkpoint, so today's single-account deployment doesn't re-scan its
-- entire call history on the first poll cycle after this migration ships.
INSERT INTO account_sync_state (ghl_account_id, last_synced_at)
  SELECT '00000000-0000-0000-0000-000000000001', last_synced_at FROM sync_state WHERE id = 1
  ON CONFLICT (ghl_account_id) DO NOTHING;

-- Account cancellation: owner-triggered, grace-period-then-purge. Only a
-- tenant's designated owner (the one "paying" -- see owner_user_id) can
-- cancel, matching the product decision that this isn't a generic admin
-- action. status transitions active -> cancellation_pending (set the
-- moment /api/admin/tenant/cancel is called; every login on the tenant
-- is immediately locked out of the app itself, see requireAuth in
-- src/auth.js) -> canceled (set by src/tenantPurge.js once purge_at has
-- passed, which actually deletes the tenant's recordings/contacts/calls/
-- users -- but never audit_log/phi_access_log, which HIPAA's
-- audit-controls rule expects to survive the account that generated
-- them, same reasoning as those tables already having no FK to users/
-- calls). The owner can undo a pending cancellation (restore to active)
-- any time before purge_at.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('active', 'cancellation_pending', 'canceled'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS purge_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;

-- Backfill: the existing default tenant's owner is its one admin (the
-- oldest admin account, for a deployment that somehow already has more
-- than one) -- there's no billing system yet to derive this from, so
-- this is the closest available stand-in for "whoever is paying."
UPDATE tenants SET owner_user_id = (
  SELECT id FROM users
  WHERE users.tenant_id = tenants.id AND role = 'admin'
  ORDER BY created_at ASC LIMIT 1
)
WHERE id = '00000000-0000-0000-0000-000000000001' AND owner_user_id IS NULL;

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

-- audit_log/phi_access_log were never taught about tenants at all -- every
-- admin's Activity log and PHI-access log tab showed every OTHER tenant's
-- entries too, dormant only because this deployment has had exactly one
-- tenant so far. Same reasoning as actor_username above (captured at write
-- time, not joined later, so it survives the actor being deleted): a real
-- FK to tenants(id) is safe here specifically because a tenant row is
-- never actually deleted, even after a purge (see purgeTenantData's
-- comment) -- only its data and logins are.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
ALTER TABLE phi_access_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id);
CREATE INDEX IF NOT EXISTS phi_access_log_tenant_idx ON phi_access_log (tenant_id);

-- Backfill existing rows best-effort: via the actor/accessing user's own
-- tenant first, falling back (phi_access_log only) to the tenant that owns
-- the referenced call, for the rare case the accessing user has since been
-- deleted. Anything still unresolved (a user_id/call_id that no longer
-- resolves at all) is left NULL rather than guessed. The append-only
-- triggers just created above unconditionally block UPDATE, including
-- this one-time backfill of a genuinely new column -- disabled only for
-- the three statements below, on the same connection, then immediately
-- re-enabled; nothing about an entry's recorded facts (action, message,
-- timestamps) is touched, only this new column on old rows.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only;
UPDATE audit_log l SET tenant_id = u.tenant_id
  FROM users u WHERE u.id = l.actor_id AND l.tenant_id IS NULL;
ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;

ALTER TABLE phi_access_log DISABLE TRIGGER phi_access_log_append_only;
UPDATE phi_access_log l SET tenant_id = u.tenant_id
  FROM users u WHERE u.id = l.user_id AND l.tenant_id IS NULL;
UPDATE phi_access_log l SET tenant_id = g.tenant_id
  FROM calls c JOIN ghl_accounts g ON g.id = c.ghl_account_id
  WHERE c.id = l.call_id AND l.tenant_id IS NULL;
ALTER TABLE phi_access_log ENABLE TRIGGER phi_access_log_append_only;

-- Authenticator-app MFA (TOTP, RFC 6238 -- see src/totp.js). totp_secret is
-- set as soon as enrollment starts but totp_enabled stays false until the
-- user proves they actually scanned it by submitting one real code back --
-- otherwise a typo'd QR scan or an abandoned enrollment could silently
-- leave someone locked out next login. Plain TEXT, same as ghl_accounts'
-- access_token/refresh_token -- protected by RDS encryption-at-rest, not a
-- second app-level encryption scheme this codebase doesn't use anywhere
-- else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- One-time recovery codes for when the authenticator device itself is
-- lost -- the only account-recovery path that exists today, since
-- email-based reset isn't built yet (see README's deferred list). Hashed
-- with SHA-256 rather than scrypt: these are already high-entropy random
-- tokens generated by this app, not low-entropy user-chosen passwords, so
-- there's no brute-force risk a slow KDF is defending against here.
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS totp_recovery_codes_user_idx ON totp_recovery_codes (user_id);

-- Email-based MFA (self-service, see src/email.js) -- additive to the TOTP
-- columns above, not a replacement. A user can turn on one or the other,
-- never both, so the login flow never has to ask which second factor to
-- use (see routes/auth.js's /login). email_verified_at stays NULL until
-- the pending address is proven via a code sent to it, the same
-- prove-possession-before-enabling shape as totp_secret/totp_enabled
-- above; setting a new pending email always clears both it and
-- email_otp_enabled, so a stale unverified address can never silently
-- become the MFA delivery address.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_otp_enabled BOOLEAN NOT NULL DEFAULT false;
-- Scoped to verified emails only: an unverified, just-typed-in address
-- shouldn't block anyone else from attempting to verify the same one (that
-- would both leak "is this email already in use" and let one abandoned,
-- never-confirmed entry permanently squat an address nobody ever proved
-- they own). Enforced again at verification time in application code
-- (db/index.js's verifyUserEmail), since this index alone can't stop two
-- users from separately reaching a legitimately-verified collision.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_verified_unique_idx ON users (email) WHERE email_verified_at IS NOT NULL;

-- One-time codes for both proving a new email address and for the login
-- step itself. purpose keeps the two apart, so a code issued to confirm
-- an email change can't double as a login code and vice versa. Numeric
-- and short-lived, unlike totp_recovery_codes' high-entropy tokens above
-- (an email OTP is conventionally a 6-digit code); brute-force protection
-- is the route-level rate limiter (routes/auth.js's mfaLimiter), the same
-- backstop the TOTP/recovery-code login step above already relies on,
-- rather than a per-row attempt counter.
CREATE TABLE IF NOT EXISTS email_otp_codes (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email', 'login')),
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI call summary + structured analytics (Bedrock/Claude), generated from
-- a call's transcript once transcription completes -- see
-- src/callSummary.js / src/callSummaryPoller.js. Deliberately its own
-- status column, independent of transcription_status: transcription can
-- succeed while summarization is still pending, failed, or (for calls
-- transcribed before this feature existed) never attempted at all.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_summary_status TEXT NOT NULL DEFAULT 'none';
-- Mirrors transcription_attempts' exact purpose: bounds how many times a
-- call can be (re)submitted to Bedrock. Without this, a DB write failure
-- right after a successful (billable) Bedrock call would leave the row
-- 'pending' forever, and src/callSummaryPoller.js would keep re-billing
-- the same call every poll cycle indefinitely.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_summary_attempts INTEGER NOT NULL DEFAULT 0;

-- Per-account opt-in, same pattern and same reasoning as
-- ghl_accounts.auto_transcribe_enabled: this is a billed, per-call feature
-- (see the $0.02/min + $0.01/call metered pricing this was designed
-- around), so it must default OFF and be turned on explicitly per
-- account, never enabled account-wide just because transcription itself
-- is on.
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS ai_summary_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_ai_summary_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_ai_summary_status_check
  CHECK (ai_summary_status IN ('none', 'pending', 'completed', 'failed'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_summary TEXT;
-- sentiment, outcome, topics, followUpNeeded, followUpDetails -- see
-- src/callSummary.js's prompt for the exact shape. JSONB rather than
-- separate columns since this is analytics output, not something queried
-- by individual field yet; the "Call report" analytics views can pull
-- specific keys out with ->> once there's a real reason to.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_analysis JSONB;
-- Set once the summary is actually posted as a GHL contact note --
-- distinct from ai_summary_status = 'completed' (summary generated) so a
-- GHL API failure after a successful Bedrock call doesn't require
-- re-running Bedrock just to retry the note write.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ghl_note_written_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS email_otp_codes_user_idx ON email_otp_codes (user_id, purpose);

-- Per-word confidence from Transcribe's own output (the plain `transcript`
-- column above only keeps the joined text -- this is Transcribe's
-- item-level breakdown, ordered, {type, content, confidence}, confidence
-- null for punctuation items). Lets the transcript view flag individual
-- low-confidence words instead of presenting the whole transcript as
-- equally reliable -- see public/app.js's renderTranscriptBody. Cleared
-- the moment someone edits the transcript by hand (below): a free-text
-- edit can't be reliably re-mapped to Transcribe's original word
-- boundaries, so there's nothing left to highlight against.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_words JSONB;

-- Set once the person who handled the call (or an admin -- same boundary
-- as viewing it, see routes/api.js's PUT /calls/:id/transcript) corrects
-- the transcript by hand. Denormalized here for display right next to
-- the transcript; the real, tamper-evident audit trail is the
-- "transcript_edited" row this same request adds to phi_access_log,
-- which -- unlike this column -- can't be silently overwritten by a
-- second edit.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_edited_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_edited_by TEXT;

-- Lets an admin invite a GHL team member straight from Settings ("GHL
-- team" list, src/routes/admin.js's POST /users/invite) instead of always
-- hand-typing a username and password. The row is created immediately
-- (so ghl_user_id linking and account access grants exist right away),
-- but with no usable password until the invite is redeemed -- hence
-- password_hash/password_salt dropping NOT NULL. invite_token_hash mirrors
-- email_otp_codes/totp recovery codes: only a sha256 hash is ever stored,
-- the raw token lives solely in the emailed link and is compared at
-- redemption (src/routes/auth.js's POST /set-password), and it's cleared
-- the moment a real password is set so a used or expired link can never
-- be replayed.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_salt DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_expires_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_invite_token_hash_idx ON users (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- Self-service "forgot password" (routes/auth.js's POST /forgot-password and
-- /reset-password), reusing email_otp_codes rather than a new table -- same
-- shape (a 6-digit code, short expiry, single use) as the login/verify_email
-- purposes already there, just a third value for the same column.
ALTER TABLE email_otp_codes DROP CONSTRAINT IF EXISTS email_otp_codes_purpose_check;
ALTER TABLE email_otp_codes ADD CONSTRAINT email_otp_codes_purpose_check
  CHECK (purpose IN ('verify_email', 'login', 'password_reset'));

-- Collected on self-service signup only (routes/auth.js's POST /signup) --
-- an admin invite or manual admin-created user has no form to collect
-- these from, so they stay NULL there, same as every other
-- signup-specific column above. Nullable rather than NOT NULL for the
-- same reason: existing rows created before this column existed have no
-- value to backfill. Used to personalize the welcome email
-- (email.js's welcomeEmailHtml) instead of guessing a name from the
-- account's business name or email address.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;

-- Twice-daily metadata-only call digest (src/callDigestJob.js) -- the
-- Call report tab's "Analytics Digest" section for accounts that don't
-- have transcription on (ghl_accounts.auto_transcribe_enabled = false).
-- Computed and stored on a schedule rather than live per page view,
-- specifically because narrative is a real Bedrock call: querying and
-- re-narrating on every page load would mean an LLM call (and its
-- latency) every time someone just checks the tab, instead of a bounded
-- ~2 calls/day/account. stats holds every number the UI renders (period
-- totals, comparisons, disposition breakdown, unreturned-call list,
-- 7-day trend, top reps) as one JSON blob rather than a wide table,
-- since it's write-once/read-latest and never queried by individual
-- field. narrative is nullable: a Bedrock failure (or Bedrock not
-- configured at all) still saves the real stats, just without the
-- one-line synthesis on top.
CREATE TABLE IF NOT EXISTS call_digests (
  id              UUID PRIMARY KEY,
  ghl_account_id  UUID NOT NULL REFERENCES ghl_accounts(id) ON DELETE CASCADE,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  stats           JSONB NOT NULL,
  narrative       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_digests_account_idx ON call_digests (ghl_account_id, computed_at DESC);

-- Client-configurable digest schedule -- when the twice-daily job (src/
-- callDigestJob.js) actually fires for this account, in the account's own
-- local time. Defaults (8am/8pm America/New_York) match the original
-- fixed-interval behavior so existing accounts keep working unchanged
-- until someone actually opens the new schedule editor and picks
-- something else. HH:MM (24h) rather than a TIME column: the job only
-- ever compares it against an Intl-formatted "now" string in the
-- account's timezone, never does date arithmetic on it, so there's
-- nothing a real TIME type buys here.
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS digest_time_1 TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS digest_time_2 TEXT NOT NULL DEFAULT '20:00';
-- UTC, not a guessed region -- this server's own location has no bearing
-- on where an account's actual clients are. It's just the bootstrap value
-- for the background job to use before any browser has ever reported a
-- real one; see digest_schedule_customized below for how that happens.
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS digest_timezone TEXT NOT NULL DEFAULT 'UTC';

-- Set once the timezone has been auto-detected from an admin's own
-- browser (public/settings.js, on first visit to the Call report tab) or
-- explicitly saved through the schedule editor -- whichever happens
-- first. Before that, the account is running on the UTC bootstrap value
-- above; after, it's never auto-overwritten again by a *different*
-- admin's browser opening the same settings from a different timezone --
-- from that point on it only changes when someone deliberately edits it.
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS digest_schedule_customized BOOLEAN NOT NULL DEFAULT false;

-- Cost/revenue ledger: one permanent row per billable event, written at
-- the AWS/client rate actually in effect when it happened -- never
-- recomputed later from today's rates. This is deliberate: a live
-- "transcribed minutes x today's rate" estimate (like the existing
-- estimatedTranscribeCost in routes/operator.js) silently re-prices every
-- past month the moment a rate changes, so "July's revenue" stops meaning
-- what July actually earned. A ledger entry is a receipt, not a formula.
--
-- category distinguishes the three billable things this tracks:
--   'transcription' -- one row per call, written when transcription
--     completes (src/transcriptionPoller.js). quantity = minutes
--     transcribed -- the basis for both the AWS cost (Transcribe's
--     per-minute rate) and the client revenue (the per-minute rate in
--     public/settings.html).
--   'ai_summary' -- one row per call, written when the AI summary
--     completes (src/callSummaryPoller.js). quantity = total tokens
--     (input + output, also broken out below) -- the basis for the AWS
--     cost, since Bedrock bills per token. client_revenue is instead a
--     flat rate per call regardless of token count (how this was
--     actually priced to clients), not derived from quantity.
--   'storage' -- one row per tenant per month (src/storageCostJob.js),
--     not tied to any single call -- S3 bills storage as an ongoing
--     monthly charge on whatever's stored, not a one-time event like the
--     two above. client_revenue is a safety-net overage charge only (see
--     billingRates.js's STORAGE_TIERS comment) -- $0 for a normal
--     account, since the free
--     allowance is sized well above any realistic single-location
--     account's usage; it only ever charges a genuine high-volume
--     outlier. A storage entry recorded before this policy existed has
--     client_revenue/client_rate = NULL, not 0 -- that's a real gap, not
--     "we charged nothing," since no policy existed yet to apply.
--
-- ghl_account_id is informational (which connected location this was
-- for, at the time) -- NOT kept in sync if that call's contacts/account
-- later get re-pointed (see the ghl_accounts orphaned-contacts incident
-- this followed). tenant_id is the stable scoping column every query
-- should actually filter/group on.
CREATE TABLE IF NOT EXISTS cost_ledger (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  ghl_account_id  UUID REFERENCES ghl_accounts(id),
  category        TEXT NOT NULL CHECK (category IN ('transcription', 'ai_summary', 'storage')),
  call_id         UUID REFERENCES calls(id),
  period_start    DATE,
  period_end      DATE,
  quantity        NUMERIC NOT NULL,
  quantity_unit   TEXT NOT NULL,
  aws_rate        NUMERIC NOT NULL,
  aws_cost        NUMERIC NOT NULL,
  client_rate     NUMERIC,
  client_revenue  NUMERIC,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  -- One-time backfilled entries (src/backfillCostLedger.js) use
  -- today's rates applied retroactively, since the real historical rate
  -- at the time isn't recorded anywhere for calls that predate this
  -- table -- flagged so a later reader can tell "this is a receipt from
  -- when it happened" apart from "this is a best-effort reconstruction".
  backfilled      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_ledger_tenant_idx ON cost_ledger (tenant_id, category);
CREATE INDEX IF NOT EXISTS cost_ledger_call_idx ON cost_ledger (call_id);
-- Guards storageCostJob.js's "only one entry per tenant per month"
-- invariant at the database level, not just in application code.
CREATE UNIQUE INDEX IF NOT EXISTS cost_ledger_storage_period_idx
  ON cost_ledger (tenant_id, period_start) WHERE category = 'storage';
-- Guards against double-billing the same call if a poller cycle somehow
-- runs twice (a race, a retry) -- same reasoning transcription_status/
-- ai_summary_status on calls itself is already an idempotent state
-- machine, just enforced at the ledger level too since this is money.
CREATE UNIQUE INDEX IF NOT EXISTS cost_ledger_call_category_idx
  ON cost_ledger (call_id, category) WHERE call_id IS NOT NULL;

-- Byte size of the stored recording -- captured at save time
-- (src/storage/index.js's saveRecording) going forward; existing
-- recordings are backfilled via a one-time S3 HeadObject pass (src/
-- backfillCostLedger.js) since nothing recorded this before.
-- Basis for storage cost (src/storageCostJob.js): AWS bills S3 by actual
-- bytes stored, not recording count or call duration, so there's no way
-- to derive this after the fact without asking S3 directly.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

-- Daily storage history -- lets a month's cost_ledger 'storage' entry
-- (src/storageCostJob.js) be computed from a real daily average across
-- the month, the way AWS actually bills S3, instead of the single
-- end-of-month snapshot this replaces (that approximation is still what
-- months before this table existed are priced on -- there's no way to
-- reconstruct a daily history that was never recorded, same reasoning as
-- cost_ledger's own backfilled flag for calls that predate the ledger).
-- One row per tenant per day: upserted (not insert-once), so each check
-- during that day reflects the latest reading, but a past day's row is
-- never touched again once the day has turned over -- it's that day's
-- final, locked-in figure from then on.
CREATE TABLE IF NOT EXISTS daily_storage_snapshots (
  id             UUID PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  snapshot_date  DATE NOT NULL,
  total_bytes    BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS daily_storage_snapshots_tenant_date_idx
  ON daily_storage_snapshots (tenant_id, snapshot_date);

-- Which attempt (calls.transcription_attempts / ai_summary_attempts at
-- write time) this ledger row is for. Needed because a transcription or
-- summary retry is a real, separately incurred AWS cost each time --
-- routes/api.js's on-demand /calls/:id/transcribe explicitly allows up to
-- MAX_TRANSCRIPTION_ATTEMPTS retries on the same call, and each one is
-- billed by AWS whether it succeeds or not. Without this column, a second
-- attempt on the same call_id+category would have nowhere to go (see
-- cost_ledger_call_category_idx below). NULL for the 'storage' category
-- (no concept of "attempt" there) and for rows written before this
-- column existed.
ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS attempt INTEGER;

-- Replaces cost_ledger_call_category_idx (call_id, category) -- that
-- version could only ever hold one row per call per category, so a
-- failed attempt's real AWS cost had nowhere to be recorded once a later
-- attempt succeeded (ON CONFLICT DO NOTHING would just drop it). Widening
-- to include attempt lets each distinct attempt have its own row, while
-- still guarding against the same attempt being double-billed if a
-- poller cycle somehow runs twice (the original index's actual purpose).
DROP INDEX IF EXISTS cost_ledger_call_category_idx;
CREATE UNIQUE INDEX IF NOT EXISTS cost_ledger_call_category_attempt_idx
  ON cost_ledger (call_id, category, attempt) WHERE call_id IS NOT NULL;

-- Two storage tiers, same underlying protections (every bucket this app
-- writes to carries identical encryption/access/logging config -- this
-- isn't a "more secure" vs "less secure" split). 'hipaa' buys a larger
-- free allowance and comes with a signed BAA; 'standard' is everyone's
-- default. See billingRates.js's STORAGE_TIERS for the actual free-GB/
-- overage-rate/bucket values per tier.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_tier TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_storage_tier_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_storage_tier_check
  CHECK (storage_tier IN ('standard', 'hipaa'));

-- Which tier's bucket a given recording actually lives in -- stamped at
-- save time from the tenant's storage_tier *at that moment*, not derived
-- from the tenant's current tier on every read. A tenant can move tiers
-- later; without this, every recording saved before that switch would be
-- looked up in the wrong bucket. Backfilled to 'standard' below since
-- that's the one bucket that existed before this column did.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS storage_tier TEXT;
UPDATE calls SET storage_tier = 'standard' WHERE storage_key IS NOT NULL AND storage_tier IS NULL;

-- BAA acceptance: the self-serve "accept the BAA" gate a tenant must pass
-- before it can be switched to the 'hipaa' storage tier -- mirrors how AWS
-- Artifact itself handles its own BAA (the customer's own account accepts
-- it in-app, electronically, non-negotiable, not AWS staff accepting on
-- their behalf). Only the tenant's own owner can create a row here (see
-- routes/admin.js's POST /baa/accept, gated the same way as tenant
-- cancel/restore) -- never the operator on a tenant's behalf, so the
-- signer is always attributable to a real person at the client, not
-- CallTrove staff, which is what makes this a real electronic signature
-- under the ESIGN Act rather than just an internal checkbox.
-- full_name/title are typed by the signer, not just a bare checkbox click,
-- mirroring the Print Name/Title fields on the actual signed cover page.
-- baa_version/baa_text_hash record exactly which version of src/baaText.js
-- was shown and a sha256 of its exact rendered text (including this
-- tenant's own name) at the moment of acceptance, so a later change to the
-- BAA text can never be read as retroactively covering an earlier
-- acceptance. Rows are kept permanently and never updated/deleted -- see
-- the append-only trigger below -- since a signature record that could be
-- silently edited afterward isn't a real record of consent.
--
-- user_id has NO foreign key to users(id) -- same reasoning as
-- audit_log.actor_id and phi_access_log.user_id above (captured at write
-- time, not joined later, so it survives the signer's own account being
-- deleted). This isn't optional here the way it's merely nice-to-have on
-- those two: a real production bug (caught by testing this feature after
-- deploy, not found in review) showed that a REFERENCES users(id) on an
-- append-only table is a real landmine -- the row can never be deleted or
-- have user_id nulled out, so a tenant that ever accepted the BAA could
-- never be purged at all once its users were deleted, permanently
-- breaking tenantPurge for every HIPAA tenant. tenant_id keeps its FK to
-- tenants(id), which is safe: a tenant row itself is never deleted by
-- this app, purge only removes its users/contacts/calls/accounts (see
-- audit_log's own tenant_id FK comment for the same point).
CREATE TABLE IF NOT EXISTS baa_acceptances (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  user_id         UUID NOT NULL,
  full_name       TEXT NOT NULL,
  title           TEXT NOT NULL,
  baa_version     TEXT NOT NULL,
  baa_text_hash   TEXT NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Drops the FK a first version of this migration mistakenly created, for
-- any database that already applied it before this fix -- a no-op on a
-- fresh database that never had it.
ALTER TABLE baa_acceptances DROP CONSTRAINT IF EXISTS baa_acceptances_user_id_fkey;
CREATE INDEX IF NOT EXISTS baa_acceptances_tenant_idx ON baa_acceptances (tenant_id, accepted_at DESC);

DROP TRIGGER IF EXISTS baa_acceptances_append_only ON baa_acceptances;
CREATE TRIGGER baa_acceptances_append_only
  BEFORE UPDATE OR DELETE ON baa_acceptances
  FOR EACH ROW EXECUTE FUNCTION reject_log_mutation();

-- Which storage tier was actually active on each snapshot day -- stamped
-- at write time (src/db/index.js's upsertDailyStorageSnapshot), same
-- "stamp at the moment, don't derive from today's live value" pattern as
-- calls.storage_tier. Without this, src/storageCostJob.js's monthly
-- cost_ledger entry (write-once, never correctable afterward) could only
-- apply whichever tier a tenant happened to be on when the job finally
-- ran -- so a tenant who switched from standard (100GB free) to hipaa
-- (150GB free) partway through a month would have their ENTIRE month's
-- charge computed under whichever tier they ended up on, not correctly
-- blended across the days actually spent on each. Billing isn't live
-- yet, so this never produced a wrong real charge -- caught by thinking
-- through the tier-switch scenario, not by an incident.
ALTER TABLE daily_storage_snapshots ADD COLUMN IF NOT EXISTS storage_tier TEXT;
-- Backfill for rows written before this column existed: best-effort,
-- using each tenant's CURRENT tier (there's no way to know what it
-- actually was on a past day that predates this column -- same
-- "best-effort reconstruction, not a real historical record" reasoning
-- as cost_ledger's own backfilled flag). Only touches rows this
-- migration left NULL; never overwrites a tier a later snapshot already
-- recorded for real.
UPDATE daily_storage_snapshots s SET storage_tier = t.storage_tier
  FROM tenants t WHERE t.id = s.tenant_id AND s.storage_tier IS NULL;

-- Transcript cleanup (src/transcriptCleanup.js, Bedrock) -- reconsiders
-- only the specific words AWS Transcribe itself flagged low-confidence,
-- using the surrounding context it can already see. Own status column,
-- independent of transcription_status/ai_summary_status, same reasoning
-- as ai_summary_status being independent of transcription_status: a call
-- can be transcribed with no cleanup ever attempted, or attempted and
-- failed, without that meaning anything about the transcript itself.
-- transcript_cleaned is NULL whenever nothing needed correcting (a real,
-- meaningful "checked, found nothing" result -- not the same as never
-- having run) or cleanup hasn't completed yet; the ORIGINAL transcript
-- and transcript_words are never touched by this, so a person can always
-- see the ASR engine's own first-pass output regardless of what
-- (if anything) Bedrock later suggested. transcript_cleanup_changes
-- mirrors the same {original, corrected, reason} shape Bedrock returns,
-- kept for display so a person sees exactly what changed and why,
-- never a silent rewrite.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_cleanup_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_transcript_cleanup_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_transcript_cleanup_status_check
  CHECK (transcript_cleanup_status IN ('none', 'pending', 'completed', 'failed'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_cleaned TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_cleanup_changes JSONB;
-- Mirrors transcription_attempts/ai_summary_attempts' exact purpose:
-- bounds how many times a call can be (re)submitted for cleanup, since a
-- successful Bedrock call is real billable cost whether or not it found
-- anything to fix.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_cleanup_attempts INTEGER NOT NULL DEFAULT 0;

-- Per-account opt-in, same pattern and same reasoning as
-- ghl_accounts.ai_summary_enabled: this is a billed, per-call feature, so
-- it must default OFF and be turned on explicitly per account. Once on,
-- src/transcriptCleanupPoller.js runs automatically on every completed
-- transcription for that account (see markTranscriptionComplete's own
-- CASE) -- there's no separate per-call trigger anymore.
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS transcript_cleanup_enabled BOOLEAN NOT NULL DEFAULT false;

-- New billable category alongside transcription/ai_summary/storage --
-- see src/transcriptCleanup.js and src/transcriptCleanupPoller.js.
-- Unlike transcription/ai_summary (flat or metered rates with real
-- margin), this one is billed as an exact cost pass-through: clientRevenue
-- is literally that call's own computed awsCost, no markup. Only written
-- whenever Bedrock was actually called (not when nothing was flagged --
-- that costs nothing and bills nothing).
ALTER TABLE cost_ledger DROP CONSTRAINT IF EXISTS cost_ledger_category_check;
ALTER TABLE cost_ledger ADD CONSTRAINT cost_ledger_category_check
  CHECK (category IN ('transcription', 'ai_summary', 'storage', 'transcript_cleanup'));

-- "Not duplicates" answers from the Contacts page's Possible duplicates
-- view (src/routes/admin.js, GET /duplicates). Recorded per pair, with
-- contact_a always the lesser ID, so a group where an admin dismissed
-- A+B still resurfaces if a third contact C later shows up on the same
-- phone number: A+C and B+C are new, undismissed pairs. ON DELETE CASCADE
-- so a contact that disappears (e.g. merged away in GHL) takes its
-- dismissals with it instead of blocking the delete.
CREATE TABLE IF NOT EXISTS dismissed_duplicate_pairs (
  contact_a     TEXT NOT NULL REFERENCES contacts(ghl_contact_id) ON DELETE CASCADE,
  contact_b     TEXT NOT NULL REFERENCES contacts(ghl_contact_id) ON DELETE CASCADE,
  dismissed_by  TEXT,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_a, contact_b),
  CHECK (contact_a < contact_b)
);

-- The web address this account's admins log into GHL at, for the "Open in
-- GHL" links (Contacts page's Possible duplicates view). NULL means the
-- standard app.gohighlevel.com; a white-labeled agency sets its own branded
-- domain here from Settings > GHL accounts. GHL's API exposes a brand ID
-- for white-labeled locations but not the brand's web address, so this has
-- to be entered once rather than detected.
ALTER TABLE ghl_accounts ADD COLUMN IF NOT EXISTS ghl_app_url TEXT;

-- Paddle billing (one subscription per tenant). Populated only by Paddle's
-- signed webhooks (src/paddle.js) -- nothing here gates access to the app
-- yet; it just records what Paddle says. paddle_events makes webhook
-- delivery idempotent (Paddle retries and may deliver out of order).
-- Answered at signup ("will you store health information?"). A request only:
-- the storage tier stays 'standard' until an operator confirms the BAA and
-- HIPAA bucket per docs/hipaa-activation-checklist.md.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS hipaa_requested BOOLEAN NOT NULL DEFAULT false;
-- True for accounts created through self-serve signup: the app stays closed
-- until the BAA (if HIPAA was requested) is accepted and a subscription is
-- live. Existing accounts keep the default (false) and are never gated.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paddle_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_event_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS paddle_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
