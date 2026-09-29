const params = new URLSearchParams(location.search);
if (params.get("error")) {
  document.getElementById("login-error").hidden = false;
}
if (params.get("sent")) {
  document.getElementById("login-sent").hidden = false;
}

// Two submit buttons on this form (verify, and the formaction="resend"
// one) -- disabling both on submit covers either, so a double-click on
// "Send a new code" can't fire two sign-in-code emails for one click.
document.querySelector("form").addEventListener("submit", () => {
  document.querySelectorAll('form button[type="submit"]').forEach((b) => (b.disabled = true));
});

// A code is sent every time this page loads -- the first arrival from
// /login included, not just a resend -- so the cooldown starts
// unconditionally on load rather than only when ?sent= is present. Without
// this, "Send a new code" is clickable the instant the page renders, which
// just races the server-side resend limiter (3 per 15 min) with no
// feedback instead of giving the first code a real chance to arrive.
const RESEND_COOLDOWN_SECONDS = 30;
const resendBtn = document.getElementById("resend-btn");
const resendCooldown = document.getElementById("resend-cooldown");
let resendSecondsLeft = RESEND_COOLDOWN_SECONDS;
resendBtn.disabled = true;
resendCooldown.hidden = false;
const resendTimer = setInterval(() => {
  resendSecondsLeft -= 1;
  if (resendSecondsLeft <= 0) {
    clearInterval(resendTimer);
    resendBtn.disabled = false;
    resendCooldown.hidden = true;
    return;
  }
  resendCooldown.textContent = `Didn't get it? You can request a new code in ${resendSecondsLeft}s.`;
}, 1000);
resendCooldown.textContent = `Didn't get it? You can request a new code in ${resendSecondsLeft}s.`;
