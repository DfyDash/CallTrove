// Step between Login and Payment: confirm the email with a 6-digit code, so
// nobody can sign up (and pay) for an address they don't control.
const pendingId = new URLSearchParams(location.search).get("id");
const form = document.getElementById("verify-form");
const codeInput = document.getElementById("verify-code");
const errorEl = document.getElementById("verify-error");
const infoEl = document.getElementById("verify-info");
const resendBtn = document.getElementById("verify-resend");
const submitBtn = document.getElementById("verify-submit");
let cooldownTimer = null;

const ERRORS = {
  incorrect: "That code isn't right. Check it and try again.",
  expired: "That code has expired. Send a new code.",
  toomany: "Too many wrong tries. Send a new code.",
  missing: "This sign-up has expired. Please start again.",
};

function showError(message) {
  infoEl.hidden = true;
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function startCooldown(seconds) {
  clearInterval(cooldownTimer);
  let left = seconds;
  const tick = () => {
    resendBtn.disabled = left > 0;
    resendBtn.textContent = left > 0 ? `Send a new code (${left}s)` : "Send a new code";
    left -= 1;
    if (left < -1) clearInterval(cooldownTimer);
  };
  tick();
  if (seconds > 0) cooldownTimer = setInterval(tick, 1000);
}

async function start() {
  if (!pendingId) return showError(ERRORS.missing);
  const res = await fetch("/auth/verify-status?id=" + encodeURIComponent(pendingId));
  if (res.status === 404) return showError(ERRORS.missing);
  const s = await res.json();
  if (s.verified) {
    location.href = "/checkout.html?id=" + encodeURIComponent(pendingId);
    return;
  }
  const labels = wizardLabels(s.hipaaRequested);
  renderWizardSteps(document.getElementById("wizard-steps"), labels, labels.length - 1);
  document.getElementById("verify-intro").textContent = `We sent a 6-digit code to ${s.email}. Enter it below to continue.`;
  startCooldown(s.resendIn || 0);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  submitBtn.disabled = true;
  const res = await fetch("/auth/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pendingId, code: codeInput.value.trim() }),
  }).catch(() => null);
  submitBtn.disabled = false;
  const body = res ? await res.json().catch(() => ({})) : {};
  if (body.ok) {
    location.href = "/checkout.html?id=" + encodeURIComponent(pendingId);
    return;
  }
  showError(ERRORS[body.error] || "Something went wrong. Please try again.");
  codeInput.select();
});

resendBtn.addEventListener("click", async () => {
  errorEl.hidden = true;
  resendBtn.disabled = true;
  const res = await fetch("/auth/resend-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pendingId }),
  }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if (body.ok) {
    infoEl.textContent = "A new code is on its way.";
    infoEl.hidden = false;
    startCooldown(body.resendIn || 30);
    return;
  }
  if (body.error === "limit") showError("You've used all your codes. Please start again.");
  else if (body.error === "cooldown") startCooldown(30);
  else showError("We couldn't send a new code. Please try again in a moment.");
  if (body.error !== "limit") resendBtn.disabled = false;
});

start().catch(() => showError("Something went wrong. Please refresh the page."));
