# HIPAA tier activation checklist

Run this immediately, every time an operator switches a tenant's storage
tier to `hipaa` — not quarterly, not "eventually." This is the one-time
gate for that specific tenant, at that specific moment. (The quarterly
`compliance-self-assessment.md` is the separate, recurring, org-wide
review — this doc is per-tenant, per-activation.)

Fill in and keep the Activation Log at the bottom permanently — one row
per tenant, never overwritten. If a client ever invokes the BAA's audit
or assessment clauses, this is the record that this tenant specifically
was verified before being trusted with PHI.

---

## Before flipping the tier (blocking — do not proceed without these)

- [ ] **A signed BAA is actually on file for this specific client** — not "they probably signed one," an actual copy you can produce. This is the line compliance-self-assessment.md §3 already checks for after the fact; this is where that answer gets created.
- [ ] The client's billing/contact record confirms this is the correct legal entity named in that BAA.

## At activation

- [ ] Confirm the tenant's `tenants.storage_tier` is actually set to `hipaa` in the DB (not just requested) — `routes/operator.js`'s tier-assignment route.
- [ ] Confirm `call-recording-vault-hipaa-228749872944` still shows `SSE-S3 (AES256)` default encryption and public access block enabled (`aws s3api get-bucket-encryption` / `get-public-access-block`) — don't assume last quarter's check still holds, verify now for this activation.
- [ ] Confirm the IAM policy on `call-recording-vault-ssm-role` already covers this bucket's `recordings/*` prefix (it should, from provisioning — this just confirms nothing regressed).
- [ ] Pull one real call that's come in since the switch and confirm it actually landed in the HIPAA bucket, not the standard one (`calls.storage_tier` matches `tenants.storage_tier`, object actually present in `call-recording-vault-hipaa-228749872944`).
- [ ] Confirm `src/transcription.js`'s transient upload for this tenant's calls is staging in the HIPAA bucket, not the standard one (this was a real regression once — re-check it didn't come back).

## After activation

- [ ] Tell the client's admin their account is now on the HIPAA tier and what that means for them (export tool location, purge behavior, etc.) if they don't already know from onboarding.
- [ ] This tenant is now in scope for every future quarterly `compliance-self-assessment.md` review — no separate action needed, just confirming it won't be missed.

---

## Activation log

| Date | Tenant | Signed BAA on file? | Verified by | Notes |
|------|--------|----------------------|-------------|-------|
| | | | | |
