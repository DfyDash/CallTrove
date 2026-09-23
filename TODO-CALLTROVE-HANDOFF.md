# CallTrove — outstanding items (app-code session's view)

One-time handoff file for cross-checking against the AWS/deploy session's own list. Written from the app-code session (no AWS/DB access; works on this repo locally and via GitHub, hands deploys off to the AWS session). Not a PR — just a snapshot for comparison.

## Pending / not started

- **Account-cancellation flow, second half.** The first half exists; finishing it (actual cancellation flow, not just the admin-side pieces) was never picked back up.
- **GHL Marketplace OAuth app + SSO launch.** Packaging this as a real installable Marketplace app (OAuth install flow) instead of the current one-deployment-per-customer model.
- **True multi-tenancy.** One deployment currently serves one GHL sub-account. Multi-tenant (one deployment, many customers, isolated data via an `accounts` table) was extensively brainstormed but never built. This blocks or complicates several other items below (per-state HIPAA retention, billing, Marketplace OAuth all assume/benefit from multi-tenancy existing).
- **AI call summarization** (summaries, sentiment, coaching scores) beyond raw transcription — brainstormed (Bedrock/Comprehend), not built.
- **GHL Notes sync** — one-way sync (CallTrove → GHL Notes) recommended during brainstorming, not built.
- **Billing (Stripe, no webhooks).** Design already written up in `README.md` under "Deferred to later phases" (polling-based subscription gating via `src/billing.js`, `app_settings.subscription_status`, piggybacked on the existing poller's interval loop) — not implemented yet.
- **Forgot-password flow** (email-based) — blocked on AWS SES being set up. Today, `login.html` just points locked-out users at their admin.
- **OTP login** (second factor / login method) — email side rides on SES (same blocker as above); text side needs AWS End User Messaging SMS (the current name for what was under Amazon Pinpoint, which is being retired Oct 30, 2026 — SMS/OTP APIs continue under the new name, unaffected).

## HIPAA-tier architecture — partially specified, mostly not built

This was the subject of a long research/design conversation with the user. Status:

- **Decided (product/legal direction, not yet built):** HIPAA-tier accounts get a separate S3 bucket with Object Lock (Governance mode — deliberately not Compliance mode, to leave a legitimate authorized-override path), a no-`DeleteObject` IAM guardrail on the app's role for that bucket, signup-time opt-in, and a one-way upgrade only (no downgrade) with a mandatory legal notice. **Not built**: the bucket itself, the opt-in UI, the upgrade-only enforcement, the no-delete IAM policy.
- **Built this session, not wired in:** `src/complianceRetention.js` — given a US state code, returns how many years a producer's call recordings should stay locked (`getRetentionYears`) and computes the actual lock-expiry date anchored to when the call happened (`getRetentionUntilDate`). Sourced from a primary-source read of the NAIC's own "State Laws on Records Maintenance" chart (not a blog, not an AI summary — both were cross-checked against it this session and found wrong/unverifiable in multiple places). Confirmed figures range 3–10 years across ~27 states; every other state (including Texas, where three separate research passes produced three different, unverifiable statute citations) falls back to a 6-year default. **The file itself flags that these numbers are pending real legal verification** — do not treat them as final without an attorney or paid compliance service confirming, especially the gap states and Texas.
- **Why it's not wired in:** no per-account "state" field exists (no multi-tenant `accounts` table yet — see above), and the HIPAA-tier S3 bucket/Object Lock config doesn't exist yet (AWS-side, not something the app-code session can build).
- **Open design question, resolved in conversation but worth re-confirming with the user before building:** the user initially asked about enforcing non-deletion in application code only (no S3 Object Lock). Pushed back on this — recommended keeping Object Lock (Governance mode) as the storage-layer backstop *and* having code compute the correct per-state duration at write time, rather than relying on code alone (a code-only guard is one bug/compromised-credential away from mass deletion; Object Lock already gives the flexibility the user wanted via the Governance bypass). User's response to this specific recommendation wasn't explicitly confirmed one way or the other — worth checking where the AWS session's thinking landed.
- **S3 lifecycle: Standard → Glacier Instant Retrieval at 90 days** (skipping Standard-IA entirely) — this was on the AWS session's own list from an earlier handoff. Status unknown to this session; asked the AWS session directly and haven't received a definitive answer relayed back yet.

## Known bugs (as of last check from this session)

- Already fixed by the AWS session directly (`e11951a`, merged): play/pause icon on the dashboard's custom recording player never toggled during playback (root cause: `.hidden` as a JS property is a no-op on `<svg>`/`SVGElement`, needs `setAttribute`/`removeAttribute` instead, which works on any element type). Confirmed fixed in code; deploy status not independently verified from this session.
- No other open bugs tracked from this session as of this writing — the AWS session has been actively iterating on UI polish directly (mobile responsive layout, dashboard/settings spacing, table styling) across several of its own PRs (#7–#12) merged straight to `main`. This session hasn't independently verified all of that work; flagging so it isn't double-counted as outstanding.

## Completed this session (for reference, not action items)

Full nav-style UI redesign: sidebar navigation, dedicated Contacts (A-Z) page, tabbed Settings page (consolidating what were three separate admin/coverage/access-log pages), Call report rep leaderboard with per-rep drill-down, dashboard stat tiles and Direction/Outcome filters — plus three follow-up bug-fix rounds (Settings-page layout bleed, empty-looking zero-data trend chart, and matching the artifact's actual color palette/page-card structure instead of just isolated accent colors). All merged to `main` (PRs #1–#4, #6).
