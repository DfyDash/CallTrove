# CallTrove (Prototype)

Solves a specific, confirmed problem: GHL's downloaded call recordings carry
no embedded metadata (no timestamp, no caller info, just a GUID filename).
This app watches for completed calls in a GHL sub-account, pulls the
recording and its metadata, embeds that metadata directly into the audio
file, and stores everything in an organized, searchable, per-contact call
history with role-based access (admins see everything; regular users see
only calls they personally handled).

**Phase**: prototype. No real client/PHI data yet, and most of a HIPAA
compliance layer still isn't built (BAAs, formal compliance
documentation, retention/purge policy are deliberately phase 2 --
infrastructure encryption-at-rest is already in place, see "Security
hardening" below) -- but PHI-access and
admin-action audit logging (45 CFR 164.312(b)'s "Audit controls") is
already in, ahead of actually needing it. See "Admin activity log" and
"PHI-access log" below. This phase proves the pipeline works end to end
for one account.

## Architecture

- `src/poller.js` — polls GHL's Conversations API every 60s for new call
  messages across the whole sub-account (not a GHL workflow/webhook — see
  "Why polling, not a webhook" below), writes a `calls` row, downloads the
  recording, embeds metadata into it, and stores it.
- `src/ghlApi.js` — all GHL REST API access: listing conversations/call
  messages, downloading a recording, resolving the account's timezone and
  user list.
- `src/audioMetadata.js` — embeds call metadata (timestamp in the account's
  own timezone, direction, duration, contact) into the recording file
  itself (RIFF INFO tags for WAV, ID3v2 for MP3) — this is what actually
  solves the "no metadata" problem, not just showing it in the dashboard.
- `src/auth.js`, `src/routes/auth.js`, `src/routes/admin.js` — login
  sessions and admin-only user management (create/reset-password/delete
  accounts, map each to a GHL user for access control).
- `GET /api/contacts`, `GET /api/calls`, `GET /api/calls/:id/recording` —
  read API backing the dashboard, scoped by the logged-in user's role.
  `GET /api/calls` is the main call search: optional `contactId` (omitted =
  all contacts), optional `dateFrom`/`dateTo` (`YYYY-MM-DD`, inclusive), and
  `page`/`pageSize` (20/50/100) for pagination.
- `public/` — static dashboard (login, contact search + a paginated,
  date-filterable call search across one or all contacts, admin user
  management, change password).
- Postgres for metadata (`src/db`), pluggable storage for recordings
  (`src/storage`: local disk by default, S3 when `STORAGE_DRIVER=s3`).
- `src/transcription.js`, `src/transcriptionPoller.js` — optional call
  transcription via AWS Transcribe (`TRANSCRIPTION_ENABLED=true`), a
  meaningful undercut of GHL's own transcription fee — see "Call
  transcription" below.
- `src/backfill.js` — one-off/on-demand script that walks a sub-account's
  entire call history (the live poller deliberately doesn't) — see
  "Historical backfill" below.
- `audit_log` table, written from `src/routes/admin.js` — every admin
  setting change and user-account action, with who and when — see "Admin
  activity log" below.
- `phi_access_log` table, written from `src/routes/api.js` — who accessed
  which call's recording/transcript, when, from where, and whether it was
  allowed (including denied attempts) — see "PHI-access log" below.

Built on Node/Express/Postgres so it can move to AWS (API Gateway + Lambda
or ECS, RDS, S3) later without a re-platform — the eventual HIPAA-compliant
version will run on AWS anyway (for Bedrock/Claude access under AWS's BAA).

## Why polling, not a webhook

GHL's "Call Completed" workflow trigger has no recording-URL field at all
(confirmed against GHL's own docs), needs a hand-built JSON body with
merge tags that are easy to get wrong (field names vary by trigger/version,
and unresolved tags render as the literal string `"null"`), and requires
every customer to manually build that workflow in their own account. The
Conversations API GHL exposes already has everything needed — real message
IDs, proper ISO timestamps (no timezone ambiguity), who handled the call,
duration, direction — so this app scans it directly instead. Zero manual
GHL setup per account; more reliable than depending on a webhook body being
configured exactly right.

## Call search and filtering

The dashboard's main view is a single call search, not a fixed "pick a
contact first" flow: an optional contact filter (name/phone search in the
sidebar still works, for telling apart two contacts with the same name),
an optional date range, and pagination. Loads to **this week, all
contacts** by default so it's never empty on first load and never pulls
too much data unasked.

Date range: preset buttons (Today / This week / This month / This year)
that just fill in a From/To date pair, which can also be edited directly
for anything else — a specific month, a span of months, a prior year, any
custom range. No hard cap on how far back it can go; a full year (or more)
of results just means more pages.

Pagination is real (`LIMIT`/`OFFSET` server-side via `db.listCalls()`, not
fetch-everything-then-slice-in-the-browser) at 20/50/100 per page,
selectable in the UI. `calls_occurred_at_idx` backs the date filter so this
stays fast as history grows via `src/backfill.js`.

## Local setup

```bash
cp .env.example .env       # fill in GHL_API_TOKEN, GHL_LOCATION_ID, SESSION_SECRET
docker compose up -d       # starts local Postgres
npm install
npm run migrate            # applies src/db/schema.sql
npm run dev
```

The dashboard is served at `http://localhost:3000/`. There's no self-signup —
create the first admin account directly:

```js
node -e '
require("dotenv").config();
const { randomUUID } = require("crypto");
const db = require("./src/db");
const { hashPassword } = require("./src/auth");
(async () => {
  const { hash, salt } = hashPassword("changeme123");
  await db.createUser({ id: randomUUID(), username: "admin", passwordHash: hash, passwordSalt: salt, role: "admin" });
  await db.pool.end();
})();
'
```

Log in, then use **Manage users** to create accounts for your team, mapping
each to their GHL identity (picked from a live dropdown of GHL users) so
their calls route correctly.

## GHL setup

Generate a Private Integration token: **Settings → Private Integrations →
Create**, with scopes `conversations.readonly`, `conversations/message.readonly`,
`locations.readonly`, and `users.readonly`. Put the token and the
sub-account's Location ID in `.env`. That's it — no workflow to build, no
webhook URL to configure. The poller starts watching automatically as soon
as the server boots with those set.

## Call transcription

Optional (`TRANSCRIPTION_ENABLED=true`), via AWS Transcribe. Two ways to
trigger it, both leading to the same pipeline:

- **On-demand** — a "Transcribe" button per call in the dashboard. The
  default, and the only option until an admin turns auto-transcription on.
- **Automatic, opt-in** — a live toggle on **Manage users**
  ("Automatically transcribe new calls going forward"), backed by
  `app_settings.auto_transcribe_enabled` (no redeploy needed to flip it).
  Once on, every call the live poller picks up gets transcribed
  automatically. Critically, it's scoped to only calls picked up *after*
  it's checked: `src/poller.js` reads the setting fresh per new call, and
  `src/backfill.js` never checks it at all, so turning this on can never
  retroactively transcribe existing recordings — including anything a
  historical backfill just pulled in. That split matters in practice: grab
  a customer's full history with `src/backfill.js` first (cheap, no
  transcription), then flip auto-transcription on once they're only paying
  for what's coming in going forward.

Most calls never get relistened to, so auto-transcribing indiscriminately
means paying for a lot of transcripts nobody asked for — on-demand stays
the sane default, and the visible toggle doubles as a real cost-control
story to point to when selling this.

GHL charges $0.039/min for its own call transcription (confirmed directly
in the GHL UI); AWS Transcribe's cost is ~$0.024/min, so this alone
undercuts it, with room to price well below GHL's rate and still carry a
healthy margin.

Deepgram was the other option on the table (~$0.004/min, roughly 6x
cheaper still) but was passed over for one reason: **BAA turnaround.** AWS
will sign a BAA self-serve, in AWS Artifact, covering the whole account —
already needed for RDS/S3/EC2 once real PHI is in play. Deepgram's BAA is
sales-negotiated with no guaranteed turnaround, which is a bad position to
be in exactly when a customer is asking about HIPAA compliance. One AWS BAA
covering everything beat a cheaper per-minute rate riding on a second
vendor relationship.

Mechanically: clicking "Transcribe" hits `POST /api/calls/:id/transcribe`,
which pulls the stored recording back out (`storage.getBuffer()`, regardless
of `STORAGE_DRIVER`) and hands it to `src/transcription.js`. AWS Transcribe
only accepts audio from S3, never raw bytes, so that module uploads it to a
transient S3 key and starts an async job. Jobs aren't instant, so
`src/transcriptionPoller.js` checks outstanding jobs every 30s; on
completion the transcript text is saved to Postgres (`calls.transcript`)
and the transient S3 copy + AWS's own job record are deleted. The button
becomes a "Transcribing…" state, then a "View transcript" toggle once
ready.

The vendor call is isolated behind `src/transcription.js`'s
`isEnabled()` / `startJob()` / `checkJob()` interface specifically so
swapping providers later (Deepgram once/if its BAA process is sorted, or
anything else) only means writing a new module behind the same interface,
not touching the poller or API routes that call it.

## Admin activity log

**Manage users** has an "Activity log" section: every admin setting change
and user-account action, who did it, and when. Covers the auto-transcribe
toggle (on/off), creating a user, updating one (role change, GHL-user
mapping change, password reset — never the password itself), and deleting
one. Paginated (`audit_log`, `GET /api/admin/audit-log`), newest first.

Entries are captured with the acting admin's username at write time rather
than joined from `users` on read, so a log entry survives that admin's
account later being deleted — deleting the account that made a change
never erases the record that it happened.

This is a lightweight admin-actions trail, distinct from the PHI-access log
below (different actors — any user, not just admins — and a much higher
volume, so it gets its own page rather than crowding this one).

## PHI-access log

**/settings.html#access** (the "Access log" tab): who accessed which
call's recording or transcript, when, from where, how, and whether it was
allowed. Built against the actual requirement, researched up front rather
than guessed:

HIPAA's Security Rule "Audit controls" provision (45 CFR § 164.312(b))
requires recording and examining activity on any system that stores,
processes, or provides access to ePHI. Neither the field list nor the
storage mechanism is spelled out in the regulation itself, but HHS
guidance and compliance practice converge on a consistent shape:

- **Who, what, when, where, how, and success/failure** — logging only
  successful access isn't enough; a *denied* attempt (someone reaching for
  a call that isn't theirs) is itself a security-relevant event worth a
  record. `phi_access_log.success`/`denial_reason` capture that.
- **Retention: 6 years minimum** (45 CFR § 164.316(b)(2)(i)), from
  creation. Nothing purges these rows — there's no code path that deletes
  from this table at all, and nothing will be old enough to need purging
  for years regardless.
- **Tamper-evidence** — logs should resist modification, not just lack an
  edit button in the UI. `phi_access_log` and `audit_log` both have a
  Postgres trigger (`reject_log_mutation()`, in `src/db/schema.sql`) that
  raises on any `UPDATE`/`DELETE`, regardless of which credential issues
  it — append-only enforced at the database engine, not just an
  application-layer convention. Full cryptographic hash-chaining / WORM
  storage is the next rung up from that and deliberately not built yet:
  disproportionate for a prototype with no real PHI in it yet, and easy to
  add later without touching how entries are written now.

Scoped to actual content access — recording playback/download, transcript
reads, transcription requests (`src/routes/api.js`) — not every list-view
fetch, which is metadata browsing (call duration, direction, who handled
it), not PHI access, and would otherwise flood the log on every page load.

## Security hardening

Beyond auth/RBAC/audit logging (covered above):

- **`helmet`** — CSP restricted to `'self'` (everything's self-hosted, no
  CDNs anywhere in the app, so no `unsafe-inline`/allowlist needed),
  HSTS, and the rest of helmet's default header set.
  `crossOriginEmbedderPolicy` is explicitly off: recording playback
  redirects to a presigned S3 URL when `STORAGE_DRIVER=s3` (a different
  origin), and COEP's default would block that `<audio>` load since S3
  doesn't send back a matching `Cross-Origin-Resource-Policy` header.
- **Login rate-limiting** — `express-rate-limit` on `POST /auth/login`
  specifically, not the whole app: 5 attempts per 30 minutes, keyed by the
  submitted **username**, not IP. IP-keying meant one person mistyping
  their password could lock out every coworker sharing the same office/
  VPN address, and an admin's password reset couldn't actually unlock
  someone since the counter lived against the IP, not the account.
  Username-keying also closes the standard bypass of switching IPs to
  dodge an IP-based limit. Cleared early (`loginLimiter.resetKey()`) on a
  successful login or an admin password reset, rather than left to expire
  on its own -- a reset should actually unlock someone immediately, not
  leave them waiting out the window under their old, now-wrong password.
- **Login timing attack closed** — the login route used to short-circuit
  on a nonexistent username (skipping the password hash entirely) but
  always run the full scrypt computation for a real one before failing a
  wrong password. Measured locally: ~0ms for a nonexistent username vs.
  ~45ms for a real one -- an easily measurable gap an attacker could use
  to enumerate valid usernames purely by timing responses, no leaked list
  needed (which mattered more once the rate limiter above became
  username-keyed). Fixed by always running the same hash computation,
  against a fixed dummy hash/salt when there's no real user, so both
  cases take the same time.
- **CSRF protection** — a session-bound token issued on login, handed to
  the client via `GET /api/me`. Checked as an `X-CSRF-Token` header on
  the JSON API's mutating routes (`src/auth.js`'s `requireCsrf`), and as
  a hidden form field on the two classic HTML-form POSTs that can't set a
  custom header (`/auth/logout`, `/auth/change-password`).
- **SSH closed** — the EC2 security group no longer allows port 22 from
  anywhere; all deploys go through SSM, which never needed it open.
- **RDS automated backups** — turned on (7-day retention); was 0 before,
  meaning zero recovery path from a bad migration or bug.
- **RDS encryption-at-rest** — done. The original instance was
  unencrypted (RDS can't toggle this in place), so it was migrated by
  snapshotting the database, copying the snapshot with a KMS key, and
  restoring into a new instance (`call-recording-vault-db-encrypted`)
  during a maintenance window.

Deliberately not done yet, and why: **Multi-AZ** would roughly double the
RDS bill for a failure mode (an AWS data-center outage) that doesn't
matter much for a single-account prototype yet; worth turning on once
real customers depend on uptime.

## Bulk export

**Manage users → Export** downloads every stored recording as one ZIP
(`GET /api/admin/download-all`, optional `dateFrom`/`dateTo`), organized
by contact. Streams straight to the response via `archiver` as each file
is read (one `storage.getBuffer()` at a time) rather than buffering the
whole export in memory or on disk first, so it scales to a lot of history
without a memory spike. Logged in the admin activity log with a count of
what was included.

Nginx's default `proxy_read_timeout` (60s) was too short for a large
export, so it's bumped to 600s in `/etc/nginx/conf.d/*.conf` -- a
config-level change, not something `src/` controls.

Main use case: getting a full copy of everything before an account is
canceled and its storage purged (see "Account cancellation" below) --
but useful any time as an offline copy.

## Account cancellation

Owner-only (`tenants.owner_user_id` -- no billing system exists yet to
derive "whoever is paying" from, so this is a stand-in, backfilled to
each tenant's original admin), triggered from Settings > My account >
Danger zone by typing the account's name to confirm.

The 7-day grace period (`CANCELLATION_GRACE_PERIOD_DAYS`) is full,
unrestricted access, not a lockout countdown -- everyone on the account
keeps working normally so there's real time to export data, with a
banner (`GET /api/me`'s `cancellationPending`) making sure people
actually notice. 7 days rather than something longer specifically
because the bulk export (see "Bulk export" above) makes grabbing a full
copy of everything a one-click, minutes-long operation -- unlike GHL
itself, which has no equivalent. `src/auth.js`'s `requireAuth` computes lockout live
against `purge_at` on every request, so it takes effect the moment the
grace period actually elapses.

Actual deletion is deliberately manual, not automatic: `src/tenantPurge.js`
is a CLI (`--list` / `--status` / `--restore` / `--purge <tenantId>`) run
by hand against one named tenant at a time, specifically so a bug in a
"ready for purge" query can never delete real customer data on its own.
`--restore` also works as an operator-level override if a bug in the
self-service restore route or the lockout check itself ever locks an
account out incorrectly. Purge deletes every recording from storage plus
the referencing DB rows (contacts, calls, connected GHL accounts,
logins) but never `audit_log`/`phi_access_log` -- those specifically
have to survive the account that generated them (HIPAA's audit-controls
rule); the `tenants` row itself is kept, marked `canceled`, as the
permanent record that the tenant existed.

## Historical backfill

GHL lets sub-accounts turn on auto-deleting call recordings after N days
(default 90) to control their own storage bill, and that setting reportedly
can't be turned back off once enabled. The live poller (`src/poller.js`)
deliberately starts watching from "now" on first run rather than walking
the whole account, so on its own it wouldn't catch anything recorded before
CallTrove was installed — a real gap once a customer flips that switch on.

`src/backfill.js` (`npm run backfill`) closes that gap: it walks the
account's *entire* conversation history, oldest calls first (so if it gets
interrupted partway, whatever's closest to falling out of GHL's retention
window is already saved), through the same download/tag/store pipeline the
live poller uses. It's safe to run more than once or alongside the live
poller — `calls.ghl_call_id` is unique, so anything already captured is
just skipped.

Like everything else, it never triggers transcription — that's on-demand
only, everywhere (see "Call transcription" above). Storing the raw
backfilled recordings is essentially free (~1MB/min of audio costs a
fraction of a cent/month on S3, so backfilling years of history is a
non-issue), but transcribing all of it would not be — at AWS Transcribe's
rate, a 10,000-minute backlog is a real ~$240 one-time bill, which is
exactly why that stays a deliberate per-call click, not a side effect of
"go save everything before it's deleted."

Run this once per sub-account at onboarding, or any time before telling a
customer it's safe to turn GHL's auto-delete setting on. It can only save
what GHL still has — anything already past the deletion window before this
runs is unrecoverable.

## Definition of done for this phase

- A real call in the GHL sub-account is picked up by the poller within
  ~60 seconds, with no manual trigger.
- The recording is downloaded, tagged with metadata, and stored
  (`data/recordings/` locally, or S3).
- A `calls` row is created with accurate, complete metadata — this is the
  core proof point, since correct metadata is the entire problem being solved.
- The dashboard shows the call under the right contact with working
  playback and download, visible to the right users based on role.

## Deferred to later phases (intentionally not built yet)

- HIPAA compliance: BAAs, formal compliance documentation, formal
  retention/purge policy (audit logging itself is already built — see
  "PHI-access log" and "Admin activity log" above; infrastructure
  encryption-at-rest is already done, see "Security hardening" above).
- AI analysis of calls beyond raw transcription (summaries, sentiment,
  coaching scores).
- True multi-tenancy (one deployment serving multiple GHL sub-accounts with
  isolated data) — this prototype was one deployment per sub-account.
  **Built**: `tenants`/`ghl_accounts`/`user_account_access` tables, the
  `requireAccount` permission boundary, the account-switcher UI, both
  call-ingestion paths (the live poller and the historical backfill), and
  the admin screen for granting/revoking a specific team member's access
  to a specific connected account are all in place, tested against a real
  database, and each connected account's data is fully isolated
  end-to-end (see `src/db/schema.sql`, `src/auth.js`, `src/routes/api.js`,
  `src/routes/admin.js`, `src/poller.js`, `src/backfill.js`,
  `src/accountCredentials.js`, Settings → "Team members" and the sidebar
  dropdown in `public/app.js`/`public/contacts.js`). The one thing this
  can't do anything with yet is actually get a *second* real account
  connected — that's the GHL OAuth piece directly below.
- Formal GHL Marketplace app packaging / OAuth. **Built**: the connect
  flow itself (`src/ghlOAuth.js`, the `/api/admin/ghl-oauth/*` routes,
  the Settings → "GHL accounts" tab) — but it can't actually be used yet.
  It requires registering CallTrove as an app in GHL's Marketplace
  developer portal first (an external, one-time action on GHL's site, not
  something this codebase can do on its own) to get real
  `GHL_OAUTH_CLIENT_ID` / `GHL_OAUTH_CLIENT_SECRET` / `GHL_OAUTH_REDIRECT_URI`
  values. Until those are set, the Settings tab shows "not set up yet"
  instead of a broken Connect button.
- Email-based "forgot password" flow (needs AWS SES set up first). Today,
  users change their own password from `/account.html`, and admins reset
  anyone's from `/settings.html` -- `login.html` just points locked-out users
  at their admin. Once SES is in, add a real "Forgot password?" link/flow
  on `login.html` itself (request → emailed reset link → new password),
  replacing that admin-only fallback.
- OTP login option (a code via text or email as a second factor / login
  method). Email side rides on SES, same as forgot-password above. Text
  side needs **AWS End User Messaging SMS** -- the current name for what
  used to be under Amazon Pinpoint; Pinpoint itself is being retired
  October 30, 2026, but its SMS/voice/OTP APIs continue under this new
  name, unaffected. OTP is a named, supported use case for that service.
- Billing (Stripe, no webhooks): since this is one deployment per
  sub-account rather than multi-tenant, billing gates the whole app on a
  single subscription rather than per-user. `app_settings` gains
  `stripe_customer_id` / `subscription_status` / `subscription_checked_at`;
  a new `src/billing.js` creates Checkout Sessions and Customer Portal
  links and refreshes subscription status by polling
  `stripe.subscriptions.list()` (piggybacked on `src/poller.js`'s existing
  interval loop, capped at once an hour) instead of a webhook endpoint.
  A middleware reads the cached status from `app_settings` and returns 402
  for non-billing routes when the subscription isn't active/trialing.
  Tradeoff: a cancellation takes up to an hour to lock the app out, since
  status is polled rather than pushed.

## Moving to AWS

The storage layer already speaks S3 (`STORAGE_DRIVER=s3`, `S3_BUCKET`,
`S3_REGION`, standard AWS SDK credential chain — no code changes needed).
For the database, point `DATABASE_URL` at an RDS Postgres instance. For
compute, the Express app (poller included, since it runs in-process) can
run as-is on EC2/ECS/App Runner.
