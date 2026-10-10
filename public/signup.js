const ERROR_MESSAGES = {
  missing: "Fill in every field to create an account.",
  email: "Enter a valid email address.",
  mismatch: "Password and confirmation don't match.",
  tooshort: "Password must be at least 8 characters.",
  taken: "An account with that email already exists.",
  hipaa: "Choose Yes or No for the health-information question.",
};
// Which step to land on when the server rejects the form.
const ERROR_STEP = { email: 2, mismatch: 2, tooshort: 2, taken: 2, hipaa: 3 };

const form = document.querySelector("form");
const steps = Array.from(document.querySelectorAll(".signup-step"));
const backBtn = document.getElementById("signup-back");
const nextBtn = document.getElementById("signup-next");
const submitBtn = document.getElementById("signup-submit");
const stepsEl = document.getElementById("wizard-steps");
const errorEl = document.getElementById("signup-error");
let current = 1;

function hipaaChoice() {
  const picked = form.querySelector('input[name="hipaa"]:checked');
  return picked ? picked.value === "yes" : false;
}

function show(n) {
  current = n;
  steps.forEach((el) => el.classList.toggle("is-current", Number(el.dataset.step) === n));
  backBtn.hidden = n === 1;
  nextBtn.hidden = n === steps.length;
  submitBtn.hidden = n !== steps.length;
  renderWizardSteps(stepsEl, wizardLabels(hipaaChoice()), n);
  const first = steps[n - 1].querySelector("input");
  if (first) first.focus();
}

// Browser validation for just this step's fields, plus the password rules
// that span two fields.
function stepIsValid() {
  const confirm = form.elements.confirmPassword;
  confirm.setCustomValidity("");
  if (current === 2 && form.elements.password.value !== confirm.value) {
    confirm.setCustomValidity("Password and confirmation don't match.");
  }
  for (const input of steps[current - 1].querySelectorAll("input")) {
    if (!input.reportValidity()) return false;
  }
  return true;
}

nextBtn.addEventListener("click", () => {
  errorEl.hidden = true;
  if (stepIsValid()) show(current + 1);
});
backBtn.addEventListener("click", () => {
  errorEl.hidden = true;
  show(current - 1);
});
form.addEventListener("change", (e) => {
  if (e.target.name === "hipaa") renderWizardSteps(stepsEl, wizardLabels(hipaaChoice()), current);
});

// Enter on an early step moves forward instead of submitting half a form.
// On the last step it submits -- and locks the buttons first, because a
// double-click would otherwise fire two POSTs: the unique constraint stops
// a second account, but the loser still leaves an orphaned tenant row
// behind and surfaces as a raw 500 instead of the normal "taken" flow.
form.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && current < steps.length && e.target.tagName === "INPUT" && e.target.type !== "radio") {
    e.preventDefault();
    nextBtn.click();
  }
});
form.addEventListener("submit", (e) => {
  if (current < steps.length) {
    e.preventDefault();
    nextBtn.click();
    return;
  }
  if (!stepIsValid()) {
    e.preventDefault();
    return;
  }
  document.querySelectorAll('form button[type="submit"]').forEach((b) => (b.disabled = true));
});

document.documentElement.classList.add("js-steps");
const error = new URLSearchParams(location.search).get("error");
show(error && ERROR_STEP[error] ? ERROR_STEP[error] : 1);
if (error) {
  errorEl.textContent = ERROR_MESSAGES[error] || "Could not create your account.";
  errorEl.hidden = false;
}
