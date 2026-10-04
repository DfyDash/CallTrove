# Quarterly compliance self-assessment

Run this every quarter (BAA §1.5 — "Provider agrees to conduct regular
assessments of its compliance... Provider will make available a summary
of such assessments to Company upon Company's reasonable request"). This
document *is* that summary — fill in the Review Log at the bottom each
time, keep prior quarters rather than overwriting, and this is what gets
handed to a client if one ever invokes that clause.

This checklist is specific to CallTrove's actual stack, not generic
boilerplate — each item names the real file, table, bucket, or setting
it's checking, so a "no" is immediately actionable.

**Privacy and Security Official:** (name here) — both roles.

---

## 1. Access control

- [ ] Admin/operator access still matches who should actually have it (check the `users` table for admins per tenant, and operator status via `grantOperator.js` — operators are never self-service, confirm the list is still accurate).
- [ ] No shared logins — every real person has their own account (password hashing in `src/auth.js`, no evidence of credential sharing).
- [ ] MFA status for admin accounts reviewed, if enabled.
- [ ] A departed team member's access was actually revoked, not just "should have been."

## 2. Encryption

- [ ] Both S3 buckets (`call-recording-vault-228749872944`, `call-recording-vault-hipaa-228749872944`) still show `SSE-S3 (AES256)` default encryption — `aws s3api get-bucket-encryption`.
- [ ] Public access block still enabled on both buckets.
- [ ] RDS connection still uses `PGSSLMODE=require` in production `.env`.
- [ ] No new S3 bucket, EC2 instance, or data store was added outside this review without the same encryption standard applied.

## 3. Two-tier storage segregation (HIPAA vs. standard)

- [ ] Spot-check a few recent `calls.storage_tier` values against which tenant they belong to — confirms recordings are actually landing in the bucket matching the tenant's `tenants.storage_tier`, not just that the code exists.
- [ ] `src/transcription.js` still stages its transient upload in the *same* tier's bucket as the recording (this was a real bug, fixed and deployed — confirm it hasn't regressed).
- [ ] IAM policy on `call-recording-vault-ssm-role` still scopes `PutObject`/`GetObject`/`DeleteObject`/`PutObjectTagging` to `recordings/*` on both buckets specifically — not widened to the bucket root or `*`.
- [ ] No tenant is on the `hipaa` tier without an actual signed BAA on file for that client.

## 4. Logging & audit trail

- [ ] `audit_log` table is capturing admin/operator actions as expected (cancel, restore, purge, storage-tier changes, invites) — spot check a few recent rows.
- [ ] `phi_access_log` is capturing recording/transcript access (play, download, transcribe) with accurate success/denial reasons.
- [ ] No gap in logging coverage for anything added to the app since the last review.

## 5. Backup & recovery

- [ ] RDS automated backup retention is actually turned on and set to a real window (confirm in the RDS console — this has not been explicitly verified as of the 2026-10 review; **flag for follow-up**).
- [ ] A test restore has been performed at some point (not just assumed to work).
- [ ] `daily_storage_snapshots` / cost ledger data is intact, no gaps.

## 6. Data retention & deletion

- [ ] Purge remains manual-only — no cron/timer triggers `tenantPurge.purgeTenant` (confirmed by design; re-check nothing changed this).
- [ ] Any client that requested cancellation this quarter was actually purged after its grace period, or is still correctly in `cancellation_pending`.
- [ ] No orphaned S3 objects left behind from a purge (recordings deleted from the bucket, not just the DB row).

## 7. Subcontractors

- [ ] AWS BAA is still active and on file / accessible (covers RDS, S3, EC2, Transcribe, Bedrock).
- [ ] No new third-party subcontractor was added this quarter without its own BAA-equivalent agreement in place.

## 8. Incident review

- [ ] Any security incidents, breaches, or near-misses this quarter? If yes, were affected clients notified within the 30-day Breach Notification Period per their BAA?
- [ ] Any unusual access patterns in `phi_access_log` (denied attempts, access outside business hours, etc.) worth investigating?

---

## Review log

| Date | Reviewed by | Findings / follow-ups | Summary shareable with clients? |
|------|-------------|------------------------|----------------------------------|
| | | | |
