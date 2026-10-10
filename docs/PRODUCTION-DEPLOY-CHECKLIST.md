# Production deploy checklist: self-serve signup + Paddle billing

**Status (Oct 10, 2026): built and tested on the test site. NOT on `main`, NOT on production.**
Everything below lives on the branch `claude/funny-tesla-x4d173` (31 commits ahead of
`main`). It also contains the earlier branch `claude/tender-ritchie-get9e1`. No pull request has
been opened yet. Production (EC2 `i-0c08876caa5f76f8f` "call-recording-vault" and RDS
`call-recording-vault-db-encrypted`, us-east-1, account 228749872944) is **stopped**.

Plain-language summary of what changed and what was fixed: `docs/Bugs-and-Fixes-Oct-9-10.pdf`.
Regression tests (111 checks, all passing): `bash tests/run.sh`.

---

## 1. What is waiting to go live

- Multi-step sign-up: About you, Plan (Secure Storage $25 or HIPAA Secure Storage $30), BAA (HIPAA only),
  Login (email is the username), Verify email (6-digit code), Payment.
- The account is created ONLY after Paddle confirms the first payment. Nobody gets an unpaid account.
- BAA accepted during sign-up (name + job title + checkbox), stored with the exact text version and hash.
- Paddle checkout embedded in the page; Paddle webhook (`/webhooks/paddle`) creates the account.
- Usage billing: transcription, AI summaries, cleanup, storage overage are charged to the customer's
  Paddle subscription when unpaid usage reaches $20, and after each month ends (if at least $1).
  Paid features pause if a card fails (overdue payment).
- New customers with no GoHighLevel account connected see a "Connect GoHighLevel" prompt (no errors).
- Password show/hide eye, logo alignment, terracotta (brand) checkmarks and notices.
- Fixes found in review and testing (see the PDF).

## 2. Before deploying (decisions and accounts)

- [ ] Merge the branch to `main` (open a PR; review the diff). Existing customers are NOT gated:
      `billing_required` defaults to false, so only new self-serve sign-ups need to pay.
- [ ] **Paddle LIVE account approved** (Paddle reviews the website; calltrove.com must be up).
- [ ] In the live Paddle account, recreate: the product, a **$25/month** recurring price (standard)
      and a **$30/month** recurring price (HIPAA).
- [ ] Live Paddle: **Checkout settings -> Default payment link = `https://app.calltrove.com`**
      (without this checkout shows "Something went wrong").
- [ ] Live Paddle: **Notifications -> new destination** `https://app.calltrove.com/webhooks/paddle`
      with all `subscription.*` events ticked. Copy its secret (`pdl_ntfset_...`).
- [ ] Live Paddle: **Checkout -> Styling**: button background `#B1502F`, white text; turn OFF
      "Allow buyers to add a discount code".
- [ ] **Email must work in production** (Resend key + verified sender). The sign-up email check needs it.
      With no email configured, sign-up shows "temporarily unavailable" (by design).
- [ ] Rotate the Paddle SANDBOX API key (it was pasted into a chat during testing).
- [ ] Legal sign-off on the BAA text in `src/baaText.js` (it says "name and title", which matches the form).
- [ ] Decide when to show the **Sign up** link on the public site: `public/home.js` hides it on
      `calltrove.com`, `www.calltrove.com` and `app.calltrove.com` on purpose. Change that when launching.

## 3. Deploy steps (in order)

1. Start the database first (RDS `call-recording-vault-db-encrypted`), wait until Available, then the
   server (EC2 `i-0c08876caa5f76f8f`).
2. **Take an RDS snapshot** before changing the database.
3. Deploy the code from `main` (new npm dependency: `@paddle/paddle-node-sdk`, so run `npm ci`).
4. Set these in the production `.env` (names only; get values from Paddle/Resend):
   - `PADDLE_ENV=production`
   - `PADDLE_API_KEY` (live), `PADDLE_WEBHOOK_SECRET` (live destination secret), `PADDLE_CLIENT_TOKEN` (live)
   - `PADDLE_PRICE_ID` (live $25 price), `PADDLE_PRICE_ID_HIPAA` (live $30 price)
   - `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`
   - optional: `USAGE_BILLING_THRESHOLD_USD` (default 20), `USAGE_BILLING_MIN_USD` (default 1),
     `PADDLE_PRICE_LABEL` / `PADDLE_PRICE_LABEL_HIPAA` (default "$25/month" / "$30/month")
   - **Do NOT set `SIGNUP_SKIP_EMAIL_VERIFICATION`** (test-site only switch; it turns the email check off).
5. **Run the database update: `npm run migrate`** (safe to repeat). Skipping this makes every signed-in
   page crash (this exact thing caused a 504 on the test site). It adds: `pending_signups`,
   `usage_invoices`, columns on `tenants` (hipaa_requested, billing_required, paddle_*, subscription_*) and
   `cost_ledger.usage_invoice_id`, and a case-insensitive unique index on logins
   (`users_username_lower_idx`). If the output says that index was NOT created, two logins differing only
   by capital letters already exist; fix those by hand and run the migration again.
6. Restart the app.
7. Smoke test on production (see section 4).

## 4. After deploying: smoke test

- [ ] `https://app.calltrove.com/signup.html` loads; plan step shows $25 / $30 and the storage lines.
- [ ] Real sign-up with a real email: code arrives, correct code works, payment form shows (no Paddle
      error), pay a real card (or use Paddle's live test flow), "Payment received" screen, then login works.
- [ ] Paddle dashboard -> Notifications: the webhook shows 200 responses.
- [ ] The new account exists, email confirmed, BAA recorded (HIPAA plan), first welcome email received.
- [ ] A new customer sees the "Connect GoHighLevel" prompt, with no console errors.
- [ ] Existing customers log in and see their data exactly as before (they must not be redirected to payment).
- [ ] Refund the test payment and cancel the test subscription.

## 5. After launch: watch for

- `audit_log` rows named `signup_paid_no_account` or `signup_paid_unverified`: someone paid but no account
  was created. Needs a refund or a manual fix. (Check regularly.)
- Server log line `usage invoice(s) ... 'pending' ... unknown outcome`: a usage charge may or may not have
  gone through. Check it in Paddle by hand; never bill it again blindly.
- First month-end usage charges happen on the 1st of the month (UTC), plus any time a customer's unpaid
  usage reaches $20.
- HIPAA plan customers: the operator page shows "HIPAA requested at signup". Switch their storage tier to
  HIPAA only after following `docs/hipaa-activation-checklist.md` (signed BAA, bucket checks). Until then
  they are on the standard storage tier (100 GB free instead of 150 GB).
- Unpaid, abandoned sign-ups are deleted automatically after 7 days (they never become accounts).

## 6. Known limits (decisions already made)

- An overdue payment keeps the app open but pauses transcription, AI summaries and cleanup. A canceled
  subscription locks the app (including connecting GoHighLevel) until they resubscribe.
- Calls that arrive while features are paused are not transcribed automatically later (manual "Transcribe").
- Paddle's checkout button color, success wording and discount option are set in Paddle's dashboard.
- The test site (`test.calltrove.com`) is powered off to save money; start EC2 `i-0f878bdcaf1fbd19e` to use it.
  It runs with `SIGNUP_SKIP_EMAIL_VERIFICATION=true` because it has no Resend key.

## 7. Rollback

Redeploy the previous `main` build. The database changes are additive (new tables/columns), so older code
keeps working with them; do not drop them. If a bad charge went out, refund it in Paddle.
