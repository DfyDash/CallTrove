// Transactional email via Resend -- account-security mail only (email
// verification, OTP login codes, and similar), never marketing. Switched
// from Amazon SES: SES's production-access request was denied with no
// actionable reason given, leaving it stuck in sandbox mode (verified
// recipients only) and unusable for real user logins. Resend's free tier
// works for real recipients immediately, no approval process -- see
// .env.example's comment for the account/plan reasoning.

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS;

// CallTrove brand tokens, same values used throughout the pricing deck/doc
// this session -- kept here rather than imported from anywhere, since
// there's no shared frontend/email token file and email HTML can't load
// external CSS reliably anyway (every value below is inlined into the
// markup itself, the only thing most email clients render consistently).
const BRAND = {
  dark: "#171512",
  light: "#FAF8F3",
  cardBorder: "#E6DDC9",
  accent: "#B1502F",
  muted: "#726B5D",
};

function isEnabled() {
  return !!API_KEY && !!FROM_ADDRESS;
}

// accountName comes from the GHL account record, not something CallTrove
// controls -- escape it before it lands in HTML. inviteUrl is server-built
// (this host + a random hex token, see routes/admin.js) but gets the same
// treatment since it's still interpolated into markup.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The 6-digit code as ONE selectable text node, CallTrove-branded, styled
// with letter-spacing to read like the boxed-digit layout it replaced. No
// "copy" button: virtually every email client (Gmail, Outlook, Apple Mail)
// strips JavaScript entirely, so a button that looked clickable would just
// be dead weight that quietly does nothing -- that's a hard rendering
// constraint every client enforces, not something a cleverer button design
// gets around. Gmail's own copy-code chip isn't an exception -- it's not
// embedded in the email at all, it's a Gmail client-side feature (an
// "Information Card" iframe Gmail draws in its own UI, granted
// clipboard-write on google.com's origin) that appears when Gmail's parser
// matches a verification-code pattern in the message text. It only shows
// in Gmail, and only needs the plain-text body to read naturally (e.g.
// "code is: 123456", see routes/auth.js) -- nothing to build here.
// The code used to be split into one <td> per digit for the boxed look,
// which meant a drag-select could snag stray whitespace between cells or
// miss a digit at the boundary -- annoying on the one interaction (select
// + copy) this element exists for. Keeping the whole code in a single text
// node makes a triple-click or one drag grab exactly the six digits, no
// more, every time. explain is one line, always about *why the recipient
// is getting this email* (security context: who/what triggered it), not
// *how to use the code* -- the earlier version's "Enter this code to
// finish signing in" and "tap and hold to copy" lines got cut for saying
// the obvious; this is a different, load-bearing line: without it there's
// nothing here to tell a wary recipient this wasn't a phishing attempt.
// "Never share this code with anyone" is fixed rather than per-caller --
// it's the standard line against someone phoning a user and asking them
// to read the code back (see GitHub/Postmark examples), true for all three
// send sites the same way. securityNote is the one thing that genuinely
// differs per site: what to do if this wasn't you. For the reset and
// verify codes that's "nothing, ignore it" -- accurate, since no change
// happens without the code. For the login code it's NOT accurate: an
// unrequested sign-in code means someone already has the password, so
// that call site passes a "change your password" note instead, matching
// GitHub's own device-verification email
// (docs.github.com/en/authentication/keeping-your-account-and-data-secure/verifying-new-devices-when-signing-in).
// Table-based layout and every style inlined, since email clients
// routinely ignore <style> blocks and modern CSS (flexbox, grid) -- this
// is the one layout approach that renders consistently across all of them.
// requestIp is optional (req.ip can be undefined in odd deployment setups)
// -- shown alongside the send time in a separate "request details" row,
// the same pattern Google/GitHub/Stripe use on their sign-in-alert emails.
// It's the one piece of context in this email that isn't just an adjective
// on "someone" -- an actual, checkable fact the recipient (or, if this
// turns into a real incident, whoever's investigating) can act on, which a
// better-written sentence can't substitute for.
function formatRequestMeta(requestIp) {
  const stamp = `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
  return requestIp ? `Requested from ${escapeHtml(requestIp)} at ${stamp}` : `Requested at ${stamp}`;
}

// The full brand lockup (public/email-logo.png -- the phone-over-trove icon
// plus the "CallTrove" wordmark, same design as everywhere else in the app),
// not just the bare icon and not text redrawn in CSS. Source art is
// 948x282 (3.36:1) at high resolution so it stays sharp at 2x/3x pixel
// density despite rendering at 36px tall. Embedded as a base64 data: URI
// read once at startup, rather than a hosted <img src="{baseUrl}/...">:
// the hosted version depended on the recipient's mail provider being able
// to fetch that exact URL back from our server at render time, and in
// production that fetch was failing (Gmail showed a broken-image icon, not
// just an images-blocked placeholder) -- a data: URI has no separate fetch
// to fail, so the logo renders unconditionally, the same way the code and
// text already do. Every mainstream client we need (Gmail, Apple Mail, the
// Outlook web/mobile apps) renders data: URI images fine; only legacy
// desktop Outlook's Word engine is unreliable with them, and that client
// already can't render this table-based layout well.
const LOGO_DATA_URI = (() => {
  const bytes = fs.readFileSync(path.join(__dirname, "..", "public", "email-logo.png"));
  return `data:image/png;base64,${bytes.toString("base64")}`;
})();

function brandHeaderHtml() {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="padding-bottom:4px;"><tr>
<td style="vertical-align:middle;"><img src="${LOGO_DATA_URI}" width="121" height="36" alt="CallTrove" style="display:block;"></td>
</tr></table>`;
}

function otpCodeEmailHtml(code, { heading, explain, securityNote, requestIp, baseUrl }) {
  return `<!doctype html>
<html>
<body style="margin:0; padding:0; background:${BRAND.light}; font-family:Helvetica, Arial, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.light}; padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid ${BRAND.cardBorder}; border-radius:16px; padding:40px;">
<tr><td>${brandHeaderHtml()}</td></tr>
<tr><td style="font-size:20px; font-weight:600; color:${BRAND.dark}; padding-top:20px; padding-bottom:6px;">${heading}</td></tr>
<tr><td style="font-size:14px; color:${BRAND.muted}; line-height:1.5; padding-bottom:20px;">${explain}</td></tr>
<tr><td>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#FFFFFF; border:1px solid ${BRAND.cardBorder}; border-radius:8px; padding:14px 12px 14px 22px; text-align:center; font-family:'Courier New', monospace; font-size:28px; font-weight:700; letter-spacing:10px; color:${BRAND.dark};">${code}</td></tr></table>
</td></tr>
<tr><td style="font-size:13px; color:${BRAND.muted}; line-height:1.5; padding-top:16px;">Expires in 10 minutes. Never share this code with anyone. ${securityNote}</td></tr>
<tr><td style="font-size:12px; color:${BRAND.muted}; padding-top:14px; border-top:1px solid ${BRAND.cardBorder};">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding-top:14px; font-family:'Courier New', monospace;">${formatRequestMeta(requestIp)}</td></tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Same card as otpCodeEmailHtml, but the thing to act on is a link, not a
// code -- and unlike a JS "copy" button, a plain <a href> button is real:
// every client renders and follows it, no script required. accountName and
// invitedBy are both optional (a GHL account can be unnamed; invitedBy is
// only passed where the caller has a session to read it from) and fall
// back to something generic rather than leaving a blank in the sentence.
// requestIp/formatRequestMeta match the OTP emails' "request details" row
// -- here it's the admin's IP at invite time, not the recipient's, but the
// same reasoning applies: a checkable fact beats a better-written sentence.
function inviteEmailHtml(inviteUrl, { accountName, invitedBy, requestIp }) {
  const team = accountName ? escapeHtml(accountName) : "your team";
  const inviter = invitedBy ? escapeHtml(invitedBy) : "An admin";
  const safeUrl = escapeHtml(inviteUrl);
  // inviteUrl already carries the request's own host -- reuse its origin
  // rather than asking the caller for a separate baseUrl.
  const baseUrl = new URL(inviteUrl).origin;
  return `<!doctype html>
<html>
<body style="margin:0; padding:0; background:${BRAND.light}; font-family:Helvetica, Arial, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.light}; padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid ${BRAND.cardBorder}; border-radius:16px; padding:40px;">
<tr><td>${brandHeaderHtml()}</td></tr>
<tr><td style="font-size:20px; font-weight:600; color:${BRAND.dark}; padding-top:20px; padding-bottom:8px;">You've been added to CallTrove</td></tr>
<tr><td style="font-size:15px; color:${BRAND.muted}; line-height:1.5; padding-bottom:24px;">${inviter} added you to ${team} on CallTrove. Set a password to activate your account.</td></tr>
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${BRAND.accent}; border-radius:8px;">
<a href="${safeUrl}" style="display:inline-block; padding:14px 32px; font-size:15px; font-weight:700; color:${BRAND.light}; text-decoration:none;">Set your password</a>
</td></tr></table>
</td></tr>
<tr><td style="font-size:13px; color:${BRAND.muted}; padding-top:20px;">This link expires in 7 days. If you weren't expecting this, you can ignore this email.</td></tr>
<tr><td style="font-size:12px; color:${BRAND.muted}; padding-top:14px; border-top:1px solid ${BRAND.cardBorder};">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding-top:14px; font-family:'Courier New', monospace;">${formatRequestMeta(requestIp)}</td></tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Sent once, right after self-service signup completes (routes/auth.js's
// POST /signup, "tenant_signup" -- the plain-text-only version already
// lives there: "Your CallTrove account is ready..."). No code, no link
// token -- this is orientation, not a security action, so the primary
// action is a real button (a plain <a href>, same reasoning as
// inviteEmailHtml) instead of anything to type in, and it skips the
// request-details footer the OTP/invite emails carry (there's no request
// to attribute -- the recipient just finished creating this account
// themselves). Structure follows a GHL-style onboarding template the user
// supplied directly (subject/body with merge fields like
// {{contact.first_name}}, {{first_action_url}}, {{dashboard_url}}) rather
// than the warmer freeform copy this had before -- mapped onto what
// signup actually collects. First/last name are now real signup fields
// (public/signup.html, added specifically so this template could use
// them -- see schema.sql's users.first_name/last_name), so firstName
// fills the {{contact.first_name}}-shaped slot in the heading directly,
// rather than the businessName stand-in this used before that field
// existed. firstName is technically optional here (existing rows from
// before this column existed have none) even though the signup form
// itself requires it, so the fallback heading still covers that gap.
// {{first_action_url}} is the GoHighLevel connection step in Settings,
// since a signed-up-but-never-connected account is a dead end otherwise;
// {{dashboard_url}} is the login page.
function welcomeEmailHtml(username, { baseUrl, firstName }) {
  const safeUsername = escapeHtml(username);
  const loginUrl = escapeHtml(`${baseUrl}/login.html`);
  const connectUrl = escapeHtml(`${baseUrl}/settings.html`);
  const heading = firstName ? `Welcome to CallTrove, ${escapeHtml(firstName)}` : "Welcome to CallTrove";
  return `<!doctype html>
<html>
<body style="margin:0; padding:0; background:${BRAND.light}; font-family:Helvetica, Arial, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.light}; padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid ${BRAND.cardBorder}; border-radius:16px; padding:40px;">
<tr><td>${brandHeaderHtml()}</td></tr>
<tr><td style="font-size:20px; font-weight:600; color:${BRAND.dark}; padding-top:20px; padding-bottom:8px;">${heading}</td></tr>
<tr><td style="font-size:15px; color:${BRAND.muted}; line-height:1.5; padding-bottom:24px;">Your account is ready, and you signed up with <strong style="color:${BRAND.dark};">${safeUsername}</strong>.</td></tr>
<tr><td style="font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${BRAND.accent}; padding-bottom:12px;">Here's how to get started</td></tr>
<tr><td>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:${BRAND.light}; border:1px solid ${BRAND.cardBorder}; border-radius:8px; padding:16px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px; color:${BRAND.dark}; line-height:1.5; padding-bottom:12px;">Connect your GoHighLevel account: a guided setup walks you through it.</td>
</tr><tr><td>
<a href="${connectUrl}" style="display:inline-block; padding:10px 20px; background:${BRAND.accent}; border-radius:8px; font-size:14px; font-weight:700; color:${BRAND.light}; text-decoration:none;">Connect GoHighLevel</a>
</td></tr></table>
</td></tr></table>
</td></tr>
<tr><td style="font-size:14px; color:${BRAND.muted}; padding-top:16px;">You can sign in anytime here: <a href="${loginUrl}" style="color:${BRAND.accent};">${loginUrl}</a></td></tr>
<tr><td style="font-size:15px; color:${BRAND.dark}; line-height:1.6; padding-top:24px;">We're glad you're here.<br>The CallTrove Team</td></tr>
<tr><td style="font-size:13px; color:${BRAND.muted}; padding-top:20px; border-top:1px solid ${BRAND.cardBorder};">Didn't create this account? Contact support@calltrove.com.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

async function sendEmail({ to, subject, text, html }) {
  if (!isEnabled()) {
    throw new Error("Email sending is not configured (RESEND_API_KEY / EMAIL_FROM_ADDRESS)");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed with status ${res.status}: ${body}`);
  }
}

module.exports = { isEnabled, sendEmail, otpCodeEmailHtml, inviteEmailHtml, welcomeEmailHtml };
