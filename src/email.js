// Transactional email via Resend -- account-security mail only (email
// verification, OTP login codes, and similar), never marketing. Switched
// from Amazon SES: SES's production-access request was denied with no
// actionable reason given, leaving it stuck in sandbox mode (verified
// recipients only) and unusable for real user logins. Resend's free tier
// works for real recipients immediately, no approval process -- see
// .env.example's comment for the account/plan reasoning.

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
// more, every time. Deliberately no intro paragraph or "how to copy"
// caption either -- every extra line is something to skim past before
// reaching the one thing this email is for, and the code being large,
// boxed, and alone on its own row is already the cue that it's the
// selectable part. Table-based layout and every style inlined, since email
// clients routinely ignore <style> blocks and modern CSS (flexbox, grid)
// -- this is the one layout approach that renders consistently across all
// of them.
function otpCodeEmailHtml(code, { heading }) {
  return `<!doctype html>
<html>
<body style="margin:0; padding:0; background:${BRAND.light}; font-family:Helvetica, Arial, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.light}; padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid ${BRAND.cardBorder}; border-radius:16px; padding:40px;">
<tr><td style="font-size:22px; font-weight:700; color:${BRAND.dark}; padding-bottom:4px;">Call<span style="color:${BRAND.accent};">Trove</span></td></tr>
<tr><td style="font-size:20px; font-weight:600; color:${BRAND.dark}; padding-top:20px; padding-bottom:20px;">${heading}</td></tr>
<tr><td>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#FFFFFF; border:1px solid ${BRAND.cardBorder}; border-radius:8px; padding:14px 12px 14px 22px; text-align:center; font-family:'Courier New', monospace; font-size:28px; font-weight:700; letter-spacing:10px; color:${BRAND.dark};">${code}</td></tr></table>
</td></tr>
<tr><td style="font-size:13px; color:${BRAND.muted}; padding-top:16px;">Expires in 10 minutes. Didn't request this? Ignore this email.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Same card as otpCodeEmailHtml, but the thing to act on is a link, not a
// code -- and unlike a JS "copy" button, a plain <a href> button is real:
// every client renders and follows it, no script required. accountName is
// optional (falls back to "your team") since a GHL account can be unnamed.
function inviteEmailHtml(inviteUrl, { accountName }) {
  const team = accountName ? escapeHtml(accountName) : "your team";
  const safeUrl = escapeHtml(inviteUrl);
  return `<!doctype html>
<html>
<body style="margin:0; padding:0; background:${BRAND.light}; font-family:Helvetica, Arial, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.light}; padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border:1px solid ${BRAND.cardBorder}; border-radius:16px; padding:40px;">
<tr><td style="font-size:22px; font-weight:700; color:${BRAND.dark}; padding-bottom:4px;">Call<span style="color:${BRAND.accent};">Trove</span></td></tr>
<tr><td style="font-size:20px; font-weight:600; color:${BRAND.dark}; padding-top:20px; padding-bottom:8px;">You've been added to CallTrove</td></tr>
<tr><td style="font-size:15px; color:${BRAND.muted}; line-height:1.5; padding-bottom:24px;">You're joining ${team}. Set a password to activate your account.</td></tr>
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${BRAND.accent}; border-radius:8px;">
<a href="${safeUrl}" style="display:inline-block; padding:14px 32px; font-size:15px; font-weight:700; color:${BRAND.light}; text-decoration:none;">Set your password</a>
</td></tr></table>
</td></tr>
<tr><td style="font-size:13px; color:${BRAND.muted}; padding-top:20px;">This link expires in 7 days. If you weren't expecting this, you can ignore this email.</td></tr>
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

module.exports = { isEnabled, sendEmail, otpCodeEmailHtml, inviteEmailHtml };
