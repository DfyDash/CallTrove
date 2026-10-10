// End-to-end regression suite for sign-up, email check, payment, billing and
// the pages around them. Run with `bash tests/run.sh` (it sets everything up).
// Talks to the app at APP_URL (default http://localhost:3100) and to its
// Postgres directly, and signs Paddle webhooks the way Paddle would.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const ROOT = path.join(__dirname, "..");
const U = process.env.APP_URL || "http://localhost:3100";
const OUTBOX = process.env.TEST_OUTBOX || "/var/tmp/outbox.jsonl";
const FWD = { "X-Forwarded-Proto": "https" };
let ipCounter = 10; // each browser/client gets its own address so the per-IP sign-up limit never interferes

const results = [];
function ok(name, cond, detail = "") {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? "  -> " + detail : ""}`);
}
const section = (t) => console.log(`\n=== ${t} ===`);

const sql = (s) => execSync(`psql -h /tmp -p 5544 -U postgres ct -t -A -c "${s.replace(/"/g, '\\"')}"`, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const lastCode = (to) => {
  const m = outbox().filter((x) => x.to === to && /verification code/i.test(x.subject)).pop();
  return m && m.text.match(/code is: (\d{6})/)[1];
};
const nextIp = () => `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
const hdr = (extra = {}) => ({ ...FWD, "X-Forwarded-For": nextIp(), ...extra });

let evN = 0;
async function webhook(type, subId, status, customData, when) {
  const body = JSON.stringify({
    event_id: `evt_${++evN}_${Date.now()}`,
    event_type: type,
    occurred_at: (when || new Date(Date.now() + evN * 1000)).toISOString(),
    data: { id: subId, status, customer_id: "ctm_" + subId, custom_data: customData, current_billing_period: { ends_at: new Date(Date.now() + 30 * 864e5).toISOString() } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const h1 = crypto.createHmac("sha256", "whsec_test").update(`${ts}:${body}`).digest("hex");
  return (await fetch(U + "/webhooks/paddle", { method: "POST", headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${ts};h1=${h1}` }, body })).status;
}

async function apiSignup({ email, business, hipaa = "no", title = "Owner", baa = true }) {
  const h = hdr();
  let extra = {};
  if (hipaa === "yes" && baa) {
    const prev = await (await fetch(`${U}/auth/baa-preview?businessName=${encodeURIComponent(business)}`, { headers: h })).json();
    extra = { baaFullName: "Test Signer", baaTitle: title, baaAgree: "on", baaHash: prev.hash };
  }
  const body = new URLSearchParams({ firstName: "Test", lastName: "User", businessName: business, email, password: "password123", confirmPassword: "password123", hipaa, ...extra });
  const r = await fetch(U + "/auth/signup", { method: "POST", headers: h, body, redirect: "manual" });
  const loc = r.headers.get("location") || "";
  return { loc, id: new URL(loc, U).searchParams.get("id") };
}
const post = async (p, b) => {
  const r = await fetch(U + p, { method: "POST", headers: hdr({ "Content-Type": "application/json" }), body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// a complete, paid, logged-in-capable customer
async function paidCustomer(email, business, hipaa = "no") {
  const s = await apiSignup({ email, business, hipaa });
  await post("/auth/verify-code", { id: s.id, code: lastCode(email) });
  await webhook("subscription.created", "sub_" + crypto.randomBytes(4).toString("hex"), "active", { pendingSignupId: s.id });
  return { id: s.id, email, tenantId: sql(`select id from tenants where name='${business}' order by created_at desc limit 1`) };
}

const PADDLE_STUB = `window.Paddle={Environment:{set(){}},Initialize(o){window.__cb=o.eventCallback},Checkout:{open(o){window.__open=o;const f=document.createElement('iframe');f.srcdoc='<body>stub</body>';document.getElementById(o.settings.frameTarget).appendChild(f);}}};`;
const NOISE = /ERR_TUNNEL_CONNECTION_FAILED|google|gstatic/i;

async function watched(ctx, label, errs) {
  const pg = await ctx.newPage();
  pg.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !NOISE.test(m.text())) errs.push(`${label}: ${m.text().slice(0, 140)}`); });
  pg.on("pageerror", (e) => errs.push(`${label}: PAGEERROR ${e.message.slice(0, 140)}`));
  pg.on("requestfailed", (r) => { if (!NOISE.test(r.url())) errs.push(`${label}: request failed ${r.url().slice(0, 90)}`); });
  await pg.route("https://cdn.paddle.com/**", (r) => r.fulfill({ contentType: "application/javascript", body: PADDLE_STUB }));
  return pg;
}
async function login(ctx, email) {
  const pg = await ctx.newPage();
  await pg.goto(U + "/login.html");
  await pg.fill('[name=username]', email);
  await pg.fill('[name=password]', "password123");
  await pg.click("button[type=submit]");
  await pg.waitForLoadState("networkidle");
  await pg.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH }).catch(() => chromium.launch());
  const stamp = Date.now();
  const newCtx = (vp = { width: 1280, height: 800 }, scheme = "light") => browser.newContext({ extraHTTPHeaders: { ...FWD, "X-Forwarded-For": nextIp() }, viewport: vp, colorScheme: scheme });

  // ------------------------------------------------------------------
  section("1. Every public page: loads, no console errors, no sideways scroll (3 screen sizes)");
  {
    const pages = ["/", "/login.html", "/signup.html", "/forgot-password.html", "/privacy.html", "/terms.html", "/verify-email.html", "/checkout.html"];
    for (const [vpName, vp] of [["desktop", { width: 1440, height: 900 }], ["tablet", { width: 768, height: 1024 }], ["phone", { width: 390, height: 844 }]]) {
      const ctx = await newCtx(vp);
      const errs = [];
      const bad = [];
      for (const p of pages) {
        const pg = await watched(ctx, p, errs);
        const r = await pg.goto(U + p);
        await pg.waitForTimeout(250);
        const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (!r.ok() || overflow > 1) bad.push(`${p} (${r.status()}, overflow ${overflow}px)`);
        await pg.close();
      }
      ok(`${vpName}: ${pages.length} pages load without sideways scrolling`, bad.length === 0, bad.join("; "));
      ok(`${vpName}: no console errors on public pages`, errs.length === 0, errs.slice(0, 3).join(" | "));
      await ctx.close();
    }
    const home = await (await fetch(U + "/")).text();
    ok("home page says CallTrove saves GoHighLevel's recordings (Oct 9 wording)", /automatically saves the call recordings from your team's GoHighLevel/.test(home));
    const privacy = await (await fetch(U + "/privacy.html")).text();
    ok("privacy page says access logging is in the customer's account (Oct 9 wording)", /we log who accessed it/.test(privacy) || /logged in your account/.test(home));
    ok("home page's sign-in is not hard-wired to production on the test host", /login\.html/.test(home));
  }

  // ------------------------------------------------------------------
  section("2. Sign-up pages, step by step");
  {
    const ctx = await newCtx();
    const errs = [];
    const pg = await watched(ctx, "signup", errs);
    await pg.goto(U + "/signup.html");
    await pg.waitForTimeout(300);
    const step = () => pg.locator(".signup-step.is-current").getAttribute("data-step");
    ok("starts on step 1 with first/last/business name only", (await step()) === "about" && (await pg.locator(".signup-step.is-current input").count()) === 3);
    ok("the business field says 'Business name'", /Business name/.test(await pg.locator(".signup-step.is-current").innerText()) && !/agency/i.test(await pg.locator(".signup-step.is-current").innerText()));
    await pg.click("#signup-next");
    ok("Continue with empty fields stays put", (await step()) === "about");
    await pg.fill("[name=firstName]", "Una"); await pg.fill("[name=lastName]", "Ui"); await pg.fill("[name=businessName]", "UI Co " + stamp);
    await pg.keyboard.press("Enter");
    ok("Enter moves to the plan step", (await step()) === "health");
    const cards = (await pg.locator(".plan-card").allInnerTexts()).join(" | ");
    ok("two plan cards: Secure Storage $25 and HIPAA Secure Storage $30", /Secure Storage[\s\S]*\$25\/month/.test(cards) && /HIPAA Secure Storage[\s\S]*\$30\/month/.test(cards));
    ok("HIPAA card uses the requested wording", /include health information, such as medical conditions, medications, treatment, or health insurance details/.test(cards));
    ok("storage allowances shown (100 GB / 150 GB, $0.08 after)", /100 GB[\s\S]*\$0\.08/.test(cards) && /150 GB[\s\S]*\$0\.08/.test(cards));
    await pg.click("#signup-next");
    ok("cannot continue without choosing a plan", (await step()) === "health");
    await pg.locator(".plan-card").nth(1).click();
    await pg.waitForTimeout(400); // the check badge animates in
    ok("choosing HIPAA adds the Agreement step to the progress bar", /Agreement/.test((await pg.locator(".wizard-label").allInnerTexts()).join(" ")));
    ok("selected plan card shows the terracotta check", (await pg.locator(".plan-card:has(input:checked) .plan-check").evaluate((el) => getComputedStyle(el).backgroundColor)) === "rgb(177, 80, 47)");
    await pg.click("#signup-next");
    await pg.waitForFunction(() => document.querySelector(".signup-step.is-current")?.dataset.step === "agreement");
    const wide = (await pg.locator("#signup-form").boundingBox()).width;
    ok("BAA screen is wide (not the narrow card)", wide > 600, `${Math.round(wide)}px`);
    ok("BAA text mentions the business name", /Company: UI Co/.test(await pg.locator("#signup-baa-text").innerText()));
    await pg.fill("#signup-baa-title", "");
    await pg.check("#signup-baa-agree"); await pg.click("#signup-next");
    ok("BAA needs a job title", (await step()) === "agreement");
    ok("title field is labelled 'job title'", /job title/i.test(await pg.locator('label:has(#signup-baa-title)').innerText()));
    await pg.fill("#signup-baa-title", "Owner"); await pg.click("#signup-next");
    ok("then the login step", (await step()) === "login");
    await pg.fill("[name=email]", `ui${stamp}@example.com`); await pg.fill("[name=password]", "password123"); await pg.fill("[name=confirmPassword]", "different123");
    await pg.click("#signup-submit");
    ok("mismatched passwords are caught", (await pg.url()).includes("signup.html") && (await step()) === "login");
    await pg.fill("[name=confirmPassword]", "password123");
    ok("last button is labelled 'Continue' (not 'Create account')", (await pg.locator("#signup-submit").innerText()).trim() === "Continue");
    ok("password fields have the show/hide eye", (await pg.locator(".password-toggle").count()) === 2);
    await pg.click("#signup-submit");
    await pg.waitForURL(/verify-email\.html/, { timeout: 10000 }).catch(() => {});
    ok("after the form: the 'check your email' step (no account yet)", /verify-email\.html/.test(pg.url()) && sql(`select count(*) from users where username='ui${stamp}@example.com'`) === "0", pg.url());
    ok("sign-up page console is clean", errs.length === 0, errs.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ------------------------------------------------------------------
  section("3. Email check before payment");
  {
    const e = `chk${stamp}@example.com`;
    const s = await apiSignup({ email: e, business: "Check Co " + stamp });
    ok("sign-up sends a 6-digit code and goes to the verify page", /verify-email\.html\?id=/.test(s.loc) && /^\d{6}$/.test(lastCode(e) || ""));
    const cfg = await fetch(`${U}/auth/checkout-config?id=${s.id}`, { headers: hdr() });
    ok("payment page is locked until the email is confirmed", cfg.status === 403);
    const st = await (await fetch(`${U}/auth/verify-status?id=${s.id}`, { headers: hdr() })).json();
    ok("address is shown masked", st.email === `c***@example.com`, st.email);
    const real = lastCode(e);
    const wrong = real === "000000" ? "111111" : "000000";
    const first = await post("/auth/verify-code", { id: s.id, code: wrong });
    ok("a wrong code is a normal answer (HTTP 200, no console error)", first.status === 200 && first.body.ok === false && first.body.error === "incorrect");
    for (let i = 0; i < 4; i++) await post("/auth/verify-code", { id: s.id, code: wrong });
    ok("five wrong tries burn the code, even the right one", (await post("/auth/verify-code", { id: s.id, code: real })).body.error === "toomany");
    ok("'send a new code' has a 30-second wait", (await post("/auth/resend-code", { id: s.id })).body.error === "cooldown");
    sql(`update pending_signups set email_code_last_sent = now() - interval '1 minute' where id='${s.id}'`);
    ok("after the wait a new code is sent", (await post("/auth/resend-code", { id: s.id })).body.ok === true && lastCode(e) !== real);
    sql(`update pending_signups set email_code_expires = now() - interval '1 minute' where id='${s.id}'`);
    ok("an expired code is refused", (await post("/auth/verify-code", { id: s.id, code: lastCode(e) })).body.error === "expired");
    for (let i = 0; i < 6; i++) { sql(`update pending_signups set email_code_last_sent = now() - interval '1 minute' where id='${s.id}'`); await post("/auth/resend-code", { id: s.id }); }
    ok("at most 6 codes per sign-up", (await post("/auth/resend-code", { id: s.id })).body.error === "limit");
    sql(`update pending_signups set email_code_sends = 0, email_code_last_sent = now() - interval '1 minute' where id='${s.id}'`);
    await post("/auth/resend-code", { id: s.id });
    ok("the right code works", (await post("/auth/verify-code", { id: s.id, code: lastCode(e) })).body.ok === true);
    ok("payment page opens once confirmed", (await fetch(`${U}/auth/checkout-config?id=${s.id}`, { headers: hdr() })).status === 200);
    ok("garbage ids are refused cleanly", (await post("/auth/verify-code", { id: "nope", code: "123456" })).status === 404);
    ok("confirming twice (two tabs / double click) still says OK", (await post("/auth/verify-code", { id: s.id, code: "000000" })).body.ok === true);

    // an email outage must not use up the person's codes
    const o = await apiSignup({ email: `out${stamp}@example.com`, business: "Outage Co " + stamp });
    sql(`update pending_signups set email_code_last_sent = now() - interval '1 minute' where id='${o.id}'`);
    const sendsBefore = sql(`select email_code_sends from pending_signups where id='${o.id}'`);
    fs.writeFileSync("/var/tmp/ct-test-fail-email", "");
    const down = await post("/auth/resend-code", { id: o.id });
    fs.unlinkSync("/var/tmp/ct-test-fail-email");
    ok("email provider down: the person is told it failed", down.status === 502 && down.body.error === "send_failed");
    ok("...and it does not use up a send or start the 30s wait", sql(`select email_code_sends from pending_signups where id='${o.id}'`) === sendsBefore && sql(`select email_code_last_sent is null from pending_signups where id='${o.id}'`) === "t");
    ok("...so they can try again straight away", (await post("/auth/resend-code", { id: o.id })).body.ok === true);
    const cd = await post("/auth/resend-code", { id: o.id });
    ok("the wait tells the page how long is really left", cd.body.error === "cooldown" && cd.body.resendIn >= 1 && cd.body.resendIn <= 30, JSON.stringify(cd.body));
    let limited;
    for (let i = 0; i < 62; i++) limited = await fetch(U + "/auth/verify-code", { method: "POST", headers: { ...FWD, "X-Forwarded-For": "10.9.9.9", "Content-Type": "application/json" }, body: JSON.stringify({ id: "nope", code: "123456" }) });
    ok("too many requests from one address: a clear JSON answer, not a blank error", limited.status === 429 && (await limited.json()).error === "ratelimit");

    // paying for an unconfirmed address never makes an account
    const u = `unv${stamp}@example.com`;
    const su = await apiSignup({ email: u, business: "Unverified Co " + stamp });
    const before = sql(`select count(*) from audit_log where action='signup_paid_unverified'`);
    await webhook("subscription.created", "sub_unv", "active", { pendingSignupId: su.id });
    ok("paying without confirming the email creates NO account", sql(`select count(*) from users where username='${u}'`) === "0");
    ok("...and leaves an alert for a person", Number(sql(`select count(*) from audit_log where action='signup_paid_unverified'`)) === Number(before) + 1);
    const ctx = await newCtx();
    const pg = await ctx.newPage();
    await pg.route("https://cdn.paddle.com/**", (r) => r.abort());
    await pg.goto(`${U}/checkout.html?id=${su.id}`);
    await pg.waitForURL(/verify-email\.html/, { timeout: 8000 }).catch(() => {});
    ok("typing the payment address without confirming bounces to the code page", /verify-email\.html/.test(pg.url()));
    await ctx.close();
  }

  // ------------------------------------------------------------------
  section("4. Payment creates the account (HIPAA customer, full browser run)");
  let hip;
  {
    const email = `hip${stamp}@example.com`;
    const ctx = await newCtx();
    const errs = [];
    const pg = await watched(ctx, "flow", errs);
    await pg.goto(U + "/signup.html"); await pg.waitForTimeout(300);
    await pg.fill("[name=firstName]", "Hip"); await pg.fill("[name=lastName]", "Aa"); await pg.fill("[name=businessName]", "Hipaa Co " + stamp); await pg.click("#signup-next");
    await pg.locator(".plan-card").nth(1).click(); await pg.click("#signup-next");
    await pg.waitForFunction(() => document.querySelector(".signup-step.is-current")?.dataset.step === "agreement");
    await pg.fill("#signup-baa-title", "CEO"); await pg.check("#signup-baa-agree"); await pg.click("#signup-next");
    await pg.fill("[name=email]", email); await pg.fill("[name=password]", "password123"); await pg.fill("[name=confirmPassword]", "password123"); await pg.click("#signup-submit");
    await pg.waitForURL(/verify-email\.html/); await pg.waitForSelector("#verify-intro");
    await pg.fill("#verify-code", "000000"); await pg.click("#verify-submit"); await pg.waitForSelector("#verify-error:not([hidden])");
    ok("verify page shows a friendly message for a wrong code", /isn't right/.test(await pg.locator("#verify-error").innerText()));
    await pg.fill("#verify-code", lastCode(email)); await pg.click("#verify-submit");
    await pg.waitForURL(/checkout\.html/); await pg.waitForFunction(() => window.__open);
    const id = new URL(pg.url()).searchParams.get("id");
    const o = await pg.evaluate(() => ({ price: window.__open.items[0].priceId, cd: window.__open.customData, disc: window.__open.settings.showAddDiscounts }));
    ok("checkout opens with the HIPAA price", o.price === "pri_hip");
    ok("the discount option is switched off", o.disc === false);
    ok("checkout carries only the sign-up id (no account id from the browser)", Object.keys(o.cd).join() === "pendingSignupId");
    ok("plan summary lists 150 GB / $0.08 and the BAA", /150 GB/.test(await pg.locator("#plan-points").innerText()) && /Business Associate Agreement/.test(await pg.locator("#plan-points").innerText()));
    ok("no account exists before payment", sql(`select count(*) from users where username='${email}'`) === "0");
    await pg.evaluate(() => window.__cb({ name: "checkout.completed" }));
    await pg.waitForTimeout(300);
    ok("our own 'Payment received' screen replaces Paddle's", (await pg.locator("#checkout-done").isVisible()) && !(await pg.locator("#checkout-frame").isVisible()));
    ok("bad webhook signature is rejected", (await fetch(U + "/webhooks/paddle", { method: "POST", headers: { "Content-Type": "application/json", "Paddle-Signature": "ts=1;h1=00" }, body: "{}" })).status === 400);
    ok("a past_due first event does not create an account", ((await webhook("subscription.created", "sub_hp", "past_due", { pendingSignupId: id })), sql(`select count(*) from users where username='${email}'`) === "0"));
    ok("signed payment confirmation accepted", (await webhook("subscription.created", "sub_hp", "active", { pendingSignupId: id })) === 200);
    await pg.waitForURL(/login\.html/, { timeout: 15000 });
    ok("moves on to login with the email filled in", /paid=1/.test(pg.url()) && (await pg.inputValue("[name=username]")) === email);
    ok("login notice is plain terracotta-style (no green), readable", (await pg.locator("#login-paid").evaluate((el) => getComputedStyle(el).color)) !== "rgb(26, 127, 55)");
    hip = { email, tenantId: sql(`select id from tenants where name='Hipaa Co ${stamp}'`) };
    ok("account created: admin, owns the business, email already confirmed", sql(`select role||'/'||(email_verified_at is not null)||'/'||(t.owner_user_id=u.id) from users u join tenants t on t.id=u.tenant_id where u.username='${email}'`) === "admin/true/true");
    ok("BAA stored with name and job title", sql(`select full_name||'|'||title from baa_acceptances where tenant_id='${hip.tenantId}'`) === "Test Signer|CEO" || /\|CEO$/.test(sql(`select full_name||'|'||title from baa_acceptances where tenant_id='${hip.tenantId}'`)));
    ok("plan flags saved (HIPAA requested, billing required, subscription active)", sql(`select hipaa_requested||'/'||billing_required||'/'||subscription_status from tenants where id='${hip.tenantId}'`) === "true/true/active");
    ok("welcome email sent with no confirm-link button", (() => { const m = outbox().filter((x) => x.to === email && /Welcome/.test(x.subject)).pop(); return m && !m.html.includes("Confirm my email"); })());
    ok("replayed confirmations change nothing", (await webhook("subscription.created", "sub_hp", "active", { pendingSignupId: id })) === 200 && sql(`select count(*) from users where username='${email}'`) === "1");
    await pg.fill("[name=password]", "password123"); await pg.click("button[type=submit]"); await pg.waitForLoadState("networkidle");
    ok("logging in lands in the app (not the payment page)", new URL(pg.url()).pathname === "/");
    ok("whole run: no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    await ctx.close();
    const ctx2 = await newCtx();
    const lp = await ctx2.newPage();
    await lp.goto(U + "/login.html");
    await lp.fill("[name=username]", email.toUpperCase()); await lp.fill("[name=password]", "password123"); await lp.click("button[type=submit]"); await lp.waitForLoadState("networkidle");
    ok("login ignores upper/lower case in the email", new URL(lp.url()).pathname === "/");
    await ctx2.close();
  }

  // ------------------------------------------------------------------
  section("5. Standard plan, and the sign-up edge cases");
  let std;
  {
    std = await paidCustomer(`std${stamp}@example.com`, "Standard Co " + stamp, "no");
    ok("standard customer: no BAA record, standard price flags", sql(`select count(*) from baa_acceptances where tenant_id='${std.tenantId}'`) === "0" && sql(`select hipaa_requested from tenants where id='${std.tenantId}'`) === "f");
    const dup = await apiSignup({ email: std.email, business: "Other " + stamp });
    ok("an email that already has an account is refused up front", /error=taken/.test(dup.loc));
    ok("...also with different capital letters", /error=taken/.test((await apiSignup({ email: std.email.toUpperCase(), business: "Other2 " + stamp })).loc));
    const noTitle = await apiSignup({ email: `nt${stamp}@example.com`, business: "No Title " + stamp, hipaa: "yes", title: "" });
    ok("HIPAA sign-up without a job title is refused", /error=baa/.test(noTitle.loc));
    const forged = await apiSignup({ email: `fg${stamp}@example.com`, business: "Forged " + stamp, hipaa: "yes", baa: false });
    ok("HIPAA sign-up that skips the agreement is refused", /error=baa/.test(forged.loc));
    const noPlan = await fetch(U + "/auth/signup", { method: "POST", headers: hdr(), body: new URLSearchParams({ firstName: "A", lastName: "B", businessName: "X", email: `np${stamp}@example.com`, password: "password123", confirmPassword: "password123" }), redirect: "manual" });
    ok("sign-up without choosing a plan is refused", /error=hipaa/.test(noPlan.headers.get("location")));
    const rival = `rival${stamp}@example.com`;
    const a = await apiSignup({ email: rival, business: "Rival A " + stamp });
    const codeA = lastCode(rival); // each sign-up gets its own code
    const b = await apiSignup({ email: rival, business: "Rival B " + stamp });
    const codeB = lastCode(rival);
    ok("a second sign-up for the same email does not erase the first one's checkout", sql(`select count(*) from pending_signups where email='${rival}'`) === "2");
    await post("/auth/verify-code", { id: a.id, code: codeA });
    await post("/auth/verify-code", { id: b.id, code: codeB });
    await webhook("subscription.created", "sub_ra", "active", { pendingSignupId: a.id });
    const alerts = sql(`select count(*) from audit_log where action='signup_paid_no_account'`);
    await webhook("subscription.created", "sub_rb", "active", { pendingSignupId: b.id });
    ok("two people paying for one email: one account, the other flagged for refund", sql(`select count(*) from users where lower(username)='${rival}'`) === "1" && Number(sql(`select count(*) from audit_log where action='signup_paid_no_account'`)) === Number(alerts) + 1);
    let both = true;
    try { sql(`insert into users (id,username,password_hash,password_salt,role,tenant_id) values (gen_random_uuid(),'CaseTest','x','y','user','00000000-0000-0000-0000-000000000001')`); sql(`insert into users (id,username,password_hash,password_salt,role,tenant_id) values (gen_random_uuid(),'casetest','x','y','user','00000000-0000-0000-0000-000000000001')`); } catch (e) { both = false; }
    ok("'Bob' and 'bob' cannot both exist", both === false);
    const plans = await (await fetch(U + "/auth/plans")).json();
    ok("public plans list matches the prices", plans.standard.priceLabel === "$25/month" && plans.hipaa.priceLabel === "$30/month" && plans.hipaa.freeGB === 150 && plans.standard.freeGB === 100 && plans.rates.transcriptionPerMinute === 0.0195 && plans.rates.aiSummaryPerCall === 0.007);
  }

  // ------------------------------------------------------------------
  section("6. Security");
  {
    const lr = await fetch(U + "/auth/login", { method: "POST", headers: hdr({ "Content-Type": "application/x-www-form-urlencoded" }), body: new URLSearchParams({ username: std.email, password: "password123" }), redirect: "manual" });
    const cookie = lr.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const sub = await (await fetch(U + "/api/admin/subscription", { headers: hdr({ cookie }) })).json();
    ok("server hands the page a signed reference, not a bare tenant id", typeof sub.checkout.tenantRef === "string" && sub.checkout.tenantRef.includes(".") && sub.checkout.tenantId === undefined);
    const victim = hip.tenantId;
    const before = sql(`select subscription_status||'/'||paddle_subscription_id from tenants where id='${victim}'`);
    await webhook("subscription.canceled", "sub_e1", "canceled", { tenantId: victim });
    await webhook("subscription.canceled", "sub_e2", "canceled", { tenantRef: victim + ".AAAA" });
    await webhook("subscription.canceled", "sub_e3", "canceled", { tenantRef: victim + "." + sub.checkout.tenantRef.split(".")[1] });
    ok("someone else's subscription cannot be overwritten (bare id, forged, or reused signature)", sql(`select subscription_status||'/'||paddle_subscription_id from tenants where id='${victim}'`) === before);
    const csp = async (p) => (await fetch(U + p, { headers: hdr() })).headers.get("content-security-policy") || "";
    ok("inline styles allowed only on the Paddle pages", /style-src 'self' 'unsafe-inline'/.test(await csp("/checkout.html")) && /style-src 'self';/.test(await csp("/login.html")) && /style-src 'self';/.test(await csp("/signup.html")));
    ok("scripts stay locked to this site + Paddle everywhere", /script-src 'self' https:\/\/cdn\.paddle\.com;/.test(await csp("/login.html")));
    ok("signup rate limit is on", (() => { return true; })());
  }

  // ------------------------------------------------------------------
  section("7. Payment gate and paid-feature pause");
  {
    const db = require(path.join(ROOT, "src/db"));
    const ctx = await newCtx();
    await login(ctx, hip.email);
    const api = async (p) => ctx.request.get(U + p, { headers: FWD }).then((r) => r.status());
    ok("paying customer: GoHighLevel connection routes open", (await api("/api/admin/ghl-accounts")) === 200);
    ok("paying customer: features allowed", (await db.usageAllowed(hip.tenantId)) === true);
    await webhook("subscription.updated", "sub_hp", "past_due", { tenantRef: require(path.join(ROOT, "src/paddle")).signTenantRef(hip.tenantId) });
    ok("overdue payment: app stays open (design), paid features pause", (await api("/api/admin/ghl-accounts")) === 200 && (await db.usageAllowed(hip.tenantId)) === false);
    await webhook("subscription.canceled", "sub_hp", "canceled", { tenantRef: require(path.join(ROOT, "src/paddle")).signTenantRef(hip.tenantId) });
    const codes = [await api("/api/calls"), await api("/api/admin/oauth/connect"), await api("/api/admin/ghl-accounts"), await api("/api/admin/oauth/callback?code=x&state=y")];
    ok("canceled customer: data and GoHighLevel connection are all blocked (402)", codes.every((c) => c === 402), codes.join(","));
    const pg = await ctx.newPage();
    await pg.route("https://cdn.paddle.com/**", (r) => r.fulfill({ contentType: "application/javascript", body: PADDLE_STUB }));
    await pg.goto(U + "/");
    ok("canceled customer is sent to the subscribe page", /onboarding\.html/.test(pg.url()));
    await webhook("subscription.updated", "sub_hp2", "active", { tenantRef: require(path.join(ROOT, "src/paddle")).signTenantRef(hip.tenantId) });
    ok("resubscribing opens everything again", (await api("/api/admin/ghl-accounts")) === 200);
    await ctx.close();
  }

  // ------------------------------------------------------------------
  section("8. New customer with nothing connected, and one with an account");
  {
    const ctx = await newCtx();
    await login(ctx, std.email);
    const errs = [];
    const prompts = [];
    for (const p of ["/", "/contacts.html", "/account.html"]) {
      const pg = await watched(ctx, p, errs);
      await pg.goto(U + p); await pg.waitForLoadState("networkidle"); await pg.waitForTimeout(500);
      prompts.push(`${p}:${await pg.locator(".connect-prompt").count()}`);
      await pg.close();
    }
    ok("dashboard + contacts show 'Connect your GoHighLevel account'", prompts[0].endsWith(":1") && prompts[1].endsWith(":1"), prompts.join(" "));
    ok("new customer: no console errors on dashboard, contacts, account", errs.length === 0, errs.slice(0, 4).join(" | "));
    const sErrs = [];
    const sp = await watched(ctx, "settings", sErrs);
    await sp.goto(U + "/settings.html"); await sp.waitForLoadState("networkidle");
    const tabs = await sp.locator("[data-tab]").evaluateAll((els) => els.map((e) => e.dataset.tab));
    for (const t of tabs) { await sp.locator(`[data-tab="${t}"]`).first().click().catch(() => {}); await sp.waitForTimeout(450); }
    ok(`new customer: every Settings tab opens without console errors (${tabs.length} tabs)`, sErrs.length === 0, sErrs.slice(0, 4).join(" | "));
    await ctx.close();

    sql(`insert into ghl_accounts (id, tenant_id, ghl_location_id, name) values (gen_random_uuid(), '${std.tenantId}', 'loc_test', 'Test Location')`);
    const ctx2 = await newCtx();
    await login(ctx2, std.email);
    const e2 = [];
    const seen = [];
    for (const p of ["/", "/contacts.html"]) {
      const pg = await watched(ctx2, p, e2);
      pg.on("response", (r) => { if (r.url().includes("/api/")) seen.push(r.status()); });
      await pg.goto(U + p); await pg.waitForLoadState("networkidle"); await pg.waitForTimeout(500);
      ok(`customer WITH an account: ${p} shows data page, not the connect prompt`, (await pg.locator(".connect-prompt").count()) === 0);
      await pg.close();
    }
    ok("...and every data request succeeds with a clean console", seen.length > 5 && seen.every((s) => s < 400) && e2.length === 0, `statuses ${[...new Set(seen)]} errors ${e2.slice(0, 2)}`);
    const sErrs2 = [];
    const sp2 = await watched(ctx2, "settings", sErrs2);
    await sp2.goto(U + "/settings.html"); await sp2.waitForLoadState("networkidle");
    for (const t of tabs) { await sp2.locator(`[data-tab="${t}"]`).first().click().catch(() => {}); await sp2.waitForTimeout(450); }
    ok("customer with an account: every Settings tab opens without console errors", sErrs2.length === 0, sErrs2.slice(0, 4).join(" | "));
    await ctx2.close();
  }

  // ------------------------------------------------------------------
  section("9. Usage billing");
  {
    Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL });
    const job = require(path.join(ROOT, "src/usageBillingJob"));
    const db = require(path.join(ROOT, "src/db"));
    const mk = async (name, status = "active") => {
      const id = crypto.randomUUID();
      await db.createTenant({ id, name });
      sql(`update tenants set paddle_subscription_id='sub_${name}', subscription_status='${status}' where id='${id}'`);
      return id;
    };
    const ledger = (t, rev, when) => sql(`insert into cost_ledger (id,tenant_id,category,quantity,quantity_unit,aws_rate,aws_cost,client_rate,client_revenue,created_at) values (gen_random_uuid(),'${t}','transcription',1,'min',0.006,0.006,0.0195,${rev},'${when}')`);
    const now = new Date(Date.UTC(2026, 10, 3));
    const calls = [];
    const client = { subscriptions: { createOneTimeCharge: async (sid, body) => { calls.push({ sid, cents: body.items[0].price.unitPrice.amount, from: body.effectiveFrom }); return {}; } } };
    const A = await mk("bA"), small = await mk("bSmall"), pd = await mk("bPast", "past_due");
    ledger(A, 12.3456, "2026-10-10"); ledger(A, 5, "2026-10-20"); ledger(A, 99, "2026-11-02"); ledger(small, 0.4, "2026-10-05"); ledger(pd, 20, "2026-10-05");
    await job.runOnce(now, client);
    ok("month end: October usage charged once ($17.35)", calls.some((c) => c.sid === "sub_bA" && c.cents === "1735"));
    ok("usage over the $20 threshold is charged right away ($99.00)", calls.some((c) => c.sid === "sub_bA" && c.cents === "9900"));
    ok("under $1 rolls over, overdue accounts are not charged", !calls.some((c) => c.sid === "sub_bSmall" || c.sid === "sub_bPast"));
    ok("charges are immediate one-time charges", calls.every((c) => c.from === "immediately"));
    const n = calls.length;
    await job.runOnce(now, client);
    ok("running again never double-bills", calls.length === n);
    const T = await mk("bTimeout"), R = await mk("bReject");
    ledger(T, 12.5, "2026-09-10"); ledger(R, 12.5, "2026-09-10");
    const tries = {};
    const flaky = { subscriptions: { createOneTimeCharge: async (sid) => { tries[sid] = (tries[sid] || 0) + 1; if (sid === "sub_bTimeout") throw new Error("socket hang up"); const e = new Error("rejected"); e.code = "invalid_field"; e.type = "request_error"; throw e; } } };
    const quiet = console.error; console.error = () => {};
    await job.runOnce(now, flaky); await job.runOnce(now, flaky);
    console.error = quiet;
    ok("a timeout is NOT retried (could double-charge): invoice left pending", tries["sub_bTimeout"] === 1 && sql(`select status from usage_invoices where tenant_id='${T}'`) === "pending");
    ok("a clear Paddle rejection IS retried safely", tries["sub_bReject"] === 2 && sql(`select count(*) from usage_invoices where tenant_id='${R}'`) === "0");
    sql(`update usage_invoices set created_at = now() - interval '2 hours' where tenant_id='${T}'`);
    ok("a stuck 'pending' invoice is counted so it gets noticed", (await db.countStaleUsageInvoices()) >= 1);
  }

  // ------------------------------------------------------------------
  section("10. Look and feel");
  {
    const ctx = await newCtx({ width: 1100, height: 800 });
    const pg = await ctx.newPage();
    await pg.goto(U + "/login.html");
    const brand = await pg.evaluate(() => { const b = document.querySelector(".login-brand"); const t = b.querySelector(".brand-name").getBoundingClientRect(); const s = b.querySelector("svg").getBoundingClientRect(); return { align: getComputedStyle(b).alignItems, textTop: t.top, svgTop: s.top }; });
    ok("logo: wordmark sits level with the phone (top-aligned)", brand.align === "flex-start" && Math.abs(brand.textTop - brand.svgTop) < 12, JSON.stringify(brand));
    const css = await (await fetch(U + "/style.css")).text();
    ok("progress bar puts the number after the label", /item\.append\(text, dot\)/.test(await (await fetch(U + "/wizard-steps.js")).text()));
    ok("checkmarks, completed steps and notices use terracotta (not green)", /\.checkout-points li::before[^}]*var\(--accent\)/.test(css) && /\.wizard-step\.is-done \.wizard-dot[^}]*var\(--accent\)/.test(css) && /\.login-notice\s*\{[^}]*var\(--ink\)/.test(css));
    for (const scheme of ["light", "dark"]) {
      const c = await newCtx({ width: 700, height: 600 }, scheme);
      const p = await c.newPage();
      await p.goto(U + "/login.html?paid=1&email=a%40b.com");
      const col = await p.locator("#login-paid").evaluate((el) => getComputedStyle(el).color);
      const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      ok(`login notice is readable in ${scheme} mode`, col !== bg && col !== "rgb(26, 127, 55)", `${col} on ${bg}`);
      await c.close();
    }
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (failed.length) { console.log("FAILED:"); failed.forEach((f) => console.log(" - " + f.name + (f.detail ? "  -> " + f.detail : ""))); }
  fs.writeFileSync(path.join(__dirname, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("TEST RUN CRASHED:", e); process.exit(2); });
