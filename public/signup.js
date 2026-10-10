const ERROR_MESSAGES = {
  missing: "Fill in every field to create an account.",
  email: "Enter a valid email address.",
  mismatch: "Password and confirmation don't match.",
  tooshort: "Password must be at least 8 characters.",
  taken: "An account with that email already exists.",
  hipaa: "Choose a plan to continue.",
  baa: "Please accept the agreement to continue.",
  unavailable: "Sign-up is temporarily unavailable. Please try again later.",
  emailsend: "We couldn't send your verification email. Check the address and try again.",
};
// Which step to land on when the server rejects the form.
const ERROR_STEP = { email: "login", mismatch: "login", tooshort: "login", taken: "login", emailsend: "login", hipaa: "health", baa: "agreement" };
const SAVED_KEY = "calltroveSignup";

const form = document.getElementById("signup-form");
const card = form;
const panels = {};
document.querySelectorAll(".signup-step").forEach((el) => (panels[el.dataset.step] = el));
const backBtn = document.getElementById("signup-back");
const nextBtn = document.getElementById("signup-next");
const submitBtn = document.getElementById("signup-submit");
const stepsEl = document.getElementById("wizard-steps");
const errorEl = document.getElementById("signup-error");
let index = 0;

function hipaaChoice() {
  const picked = form.querySelector('input[name="hipaa"]:checked');
  return picked ? picked.value === "yes" : false;
}

// About you -> Health data -> (Agreement, only if they said yes) -> Login.
function flow() {
  return hipaaChoice() ? ["about", "health", "agreement", "login"] : ["about", "health", "login"];
}

function render() {
  const order = flow();
  const name = order[index];
  Object.entries(panels).forEach(([key, el]) => el.classList.toggle("is-current", key === name));
  card.classList.toggle("signup-wide", name === "agreement");
  card.classList.toggle("signup-health-wide", name === "health");
  // The agreement's fields only exist for a "yes" answer; disabled inputs
  // are neither validated nor submitted.
  panels.agreement.querySelectorAll("input").forEach((el) => (el.disabled = !hipaaChoice()));
  backBtn.hidden = index === 0;
  nextBtn.hidden = index === order.length - 1;
  submitBtn.hidden = index !== order.length - 1;
  renderWizardSteps(stepsEl, wizardLabels(hipaaChoice()), index + 1);
  const first = panels[name].querySelector("input:not([type=hidden])");
  if (first) first.focus();
}

function goTo(name) {
  const i = flow().indexOf(name);
  index = i === -1 ? 0 : i;
  render();
}

// Browser validation for just this step's fields, plus the password rule
// that spans two fields.
function stepIsValid() {
  const confirm = form.elements.confirmPassword;
  confirm.setCustomValidity("");
  const name = flow()[index];
  if (name === "login" && form.elements.password.value !== confirm.value) {
    confirm.setCustomValidity("Password and confirmation don't match.");
  }
  for (const input of panels[name].querySelectorAll("input")) {
    if (input.type !== "hidden" && !input.reportValidity()) return false;
  }
  return true;
}

// The agreement is built from the business name, so it's fetched when they
// arrive at that step. The hash goes back with the form so the server can
// confirm the text they accepted is the text it would have generated.
async function loadAgreement() {
  const businessName = form.elements.businessName.value.trim();
  const res = await fetch("/auth/baa-preview?businessName=" + encodeURIComponent(businessName));
  if (!res.ok) throw new Error("Could not load the agreement. Please try again.");
  const baa = await res.json();
  document.getElementById("signup-baa-text").textContent = baa.text;
  document.getElementById("signup-baa-hash").value = baa.hash;
  const nameInput = document.getElementById("signup-baa-name");
  if (!nameInput.value) nameInput.value = `${form.elements.firstName.value.trim()} ${form.elements.lastName.value.trim()}`.trim();
}

// A "doesn't match" message set earlier must go away as soon as either password
// is edited, or the browser keeps blocking the form with a stale complaint.
form.addEventListener("input", (e) => {
  if (e.target.name === "password" || e.target.name === "confirmPassword") form.elements.confirmPassword.setCustomValidity("");
});

nextBtn.addEventListener("click", async () => {
  errorEl.hidden = true;
  if (!stepIsValid()) return;
  const order = flow();
  if (order[index + 1] === "agreement") {
    nextBtn.disabled = true;
    try {
      await loadAgreement();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      nextBtn.disabled = false;
      return;
    }
    nextBtn.disabled = false;
  }
  index += 1;
  render();
});
backBtn.addEventListener("click", () => {
  errorEl.hidden = true;
  index -= 1;
  render();
});
form.addEventListener("change", (e) => {
  if (e.target.name === "hipaa") renderWizardSteps(stepsEl, wizardLabels(hipaaChoice()), index + 1);
});

// Enter on an early step moves forward instead of submitting half a form.
form.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && index < flow().length - 1 && e.target.tagName === "INPUT" && e.target.type !== "radio" && e.target.type !== "checkbox") {
    e.preventDefault();
    nextBtn.click();
  }
});

// On the last step it submits -- and locks the buttons first, because a
// double-click would otherwise fire two POSTs: the unique constraint stops
// a second account, but the loser still leaves an orphaned tenant row
// behind and surfaces as a raw 500 instead of the normal "taken" flow.
// What they typed (never the password) is kept so a server-side rejection
// doesn't make them start over.
form.addEventListener("submit", (e) => {
  if (index < flow().length - 1) {
    e.preventDefault();
    nextBtn.click();
    return;
  }
  if (!stepIsValid()) {
    e.preventDefault();
    return;
  }
  try {
    const saved = {};
    ["firstName", "lastName", "businessName", "email", "baaFullName", "baaTitle"].forEach((n) => (saved[n] = form.elements[n].value));
    saved.hipaa = hipaaChoice() ? "yes" : "no";
    saved.baaAgree = document.getElementById("signup-baa-agree").checked;
    sessionStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch (err) {
    // storage blocked -- they just retype
  }
  document.querySelectorAll('form button[type="submit"]').forEach((b) => (b.disabled = true));
});

// Prices come from the server, so what's shown here is what checkout charges.
function fmtRate(n) {
  return "$" + String(Number(n));
}
fetch("/auth/plans")
  .then((r) => (r.ok ? r.json() : null))
  .then((plans) => {
    if (!plans) return;
    for (const key of ["standard", "hipaa"]) {
      const p = plans[key];
      if (!p || !p.priceLabel) continue;
      document.querySelector(`[data-plan="${key}"]`).textContent = p.priceLabel;
      document.querySelector(`[data-plan-detail="${key}"]`).textContent =
        `${p.freeGB} GB of storage included, then ${fmtRate(p.overagePerGbMonth)} per GB per month${key === "hipaa" ? ". Includes a Business Associate Agreement" : ""}.`;
    }
    if (plans.rates) {
      const usage = document.getElementById("signup-usage-note");
      usage.textContent = `Transcripts and AI summaries are billed as you use them: ${fmtRate(plans.rates.transcriptionPerMinute)} per minute of transcription and ${fmtRate(plans.rates.aiSummaryPerCall)} per AI summary.`;
      usage.hidden = false;
    }
  })
  .catch(() => {});

document.documentElement.classList.add("js-steps");
const error = new URLSearchParams(location.search).get("error");
if (error) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SAVED_KEY) || "null");
    sessionStorage.removeItem(SAVED_KEY);
    if (saved) {
      ["firstName", "lastName", "businessName", "email", "baaFullName", "baaTitle"].forEach((n) => (form.elements[n].value = saved[n] || ""));
      const radio = form.querySelector(`input[name="hipaa"][value="${saved.hipaa}"]`);
      if (radio) radio.checked = true;
      document.getElementById("signup-baa-agree").checked = !!saved.baaAgree;
    }
  } catch (err) {
    // nothing to restore
  }
  const target = ERROR_STEP[error] || "about";
  if (target === "agreement" && hipaaChoice()) {
    loadAgreement().then(() => goTo("agreement")).catch(() => goTo("health"));
  } else {
    goTo(target);
  }
  errorEl.textContent = ERROR_MESSAGES[error] || "Could not complete sign-up. Please try again.";
  errorEl.hidden = false;
} else {
  render();
}
