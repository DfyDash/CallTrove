// Progress bar shared by the sign-up pages (signup.html, onboarding.html).
// labels: array of step names; current: 1-based index of the active step.
function renderWizardSteps(el, labels, current) {
  el.replaceChildren(
    ...labels.map((label, i) => {
      const n = i + 1;
      const item = document.createElement("div");
      item.className = "wizard-step" + (n < current ? " is-done" : n === current ? " is-current" : "");
      if (n === current) item.setAttribute("aria-current", "step");
      const dot = document.createElement("span");
      dot.className = "wizard-dot";
      dot.textContent = n < current ? "\u2713" : String(n);
      const text = document.createElement("span");
      text.className = "wizard-label";
      text.textContent = label;
      item.append(dot, text);
      return item;
    })
  );
}

function wizardLabels(hipaa) {
  return hipaa ? ["About you", "Plan", "Agreement", "Login", "Payment"] : ["About you", "Plan", "Login", "Payment"];
}
