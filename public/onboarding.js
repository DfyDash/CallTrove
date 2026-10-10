// Post-signup steps: BAA (only if they said they'll store health
// information), then Paddle checkout. Reuses the same /api/admin endpoints
// as Settings -> HIPAA / BAA and Settings -> Billing.
let csrfToken = "";
let baaHash = "";

const baaSection = document.getElementById("onboarding-baa");
const billingSection = document.getElementById("onboarding-billing");
const stepsEl = document.getElementById("wizard-steps");
let hipaaFlow = false;

async function start() {
  const me = await (await fetch("/api/me")).json();
  csrfToken = me.csrfToken || "";
  const sub = await (await fetch("/api/admin/subscription")).json();
  hipaaFlow = !!sub.hipaaRequested;
  if (sub.hipaaRequested) {
    const baa = await (await fetch("/api/admin/baa")).json();
    if (!baa.acceptance && baa.canAccept) {
      document.getElementById("baa-text").textContent = baa.text;
      baaHash = baa.hash;
      baaSection.hidden = false;
      renderWizardSteps(stepsEl, wizardLabels(true), 3);
      return;
    }
  }
  showBilling(sub);
}

document.getElementById("baa-accept-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("baa-accept-error");
  errEl.hidden = true;
  const btn = document.getElementById("baa-accept-btn");
  btn.disabled = true;
  const res = await fetch("/api/admin/baa/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({
      fullName: document.getElementById("baa-full-name").value.trim(),
      title: document.getElementById("baa-title").value.trim(),
      agree: document.getElementById("baa-agree-checkbox").checked,
      confirmHash: baaHash,
    }),
  });
  btn.disabled = false;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    errEl.textContent = body.error || "could not record acceptance";
    errEl.hidden = false;
    return;
  }
  baaSection.hidden = true;
  showBilling(await (await fetch("/api/admin/subscription")).json());
});

function fmtRate(n) {
  return "$" + String(Number(n));
}

function currentTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function showBilling(sub) {
  const live = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
  if (!sub.checkout || live) {
    location.href = "/";
    return;
  }
  billingSection.hidden = false;
  renderWizardSteps(stepsEl, wizardLabels(!!sub.hipaaRequested), wizardLabels(!!sub.hipaaRequested).length);
  document.getElementById("onboarding-card").classList.add("onboarding-card-wide");
  const statusEl = document.getElementById("subscription-status");
  document.getElementById("plan-name").textContent = sub.hipaaRequested ? "CallTrove for HIPAA" : "CallTrove";
  document.getElementById("onboarding-price").textContent = sub.checkout.priceLabel || "";

  const points = ["Every call recording from your GoHighLevel account, saved and searchable"];
  if (sub.hipaaRequested) points.push("Business Associate Agreement on file");
  if (sub.storage) {
    points.push(`${sub.storage.freeGB} GB of recording storage included, then ${fmtRate(sub.storage.overagePerGbMonth)} per GB per month`);
  }
  if (sub.rates) {
    points.push(`Transcripts and AI summaries as you use them: ${fmtRate(sub.rates.transcriptionPerMinute)} per minute of transcription, ${fmtRate(sub.rates.aiSummaryPerCall)} per AI summary`);
  }
  points.push("Usage is charged to the same card as it adds up");
  const list = document.getElementById("plan-points");
  list.replaceChildren(...points.map((t) => Object.assign(document.createElement("li"), { textContent: t })));

  const fallback = document.getElementById("checkout-fallback");
  if (!sub.checkout.priceId) {
    document.getElementById("checkout-frame").hidden = true;
    fallback.textContent = "Pricing for your plan isn't available yet. Please contact support.";
    fallback.hidden = false;
    return;
  }
  openCheckout(sub, statusEl, fallback).catch((err) => {
    fallback.textContent = (err && err.message) || "Could not load checkout.";
    fallback.hidden = false;
  });
}

async function openCheckout(sub, statusEl, fallback) {
  if (!window.Paddle) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load checkout. Check your connection and refresh."));
      document.head.appendChild(s);
    });
  }
  if (sub.checkout.environment === "sandbox") window.Paddle.Environment.set("sandbox");
  window.Paddle.Initialize({
    token: sub.checkout.clientToken,
    eventCallback: (ev) => {
      if (ev.name === "checkout.completed") {
        statusEl.textContent = "Thanks! Activating your subscription...";
        waitForActivation(statusEl);
      } else if (ev.name === "checkout.error" || ev.name === "checkout.failed") {
        fallback.textContent = "Checkout ran into a problem. Refresh the page to try again.";
        fallback.hidden = false;
      }
    },
  });
  window.Paddle.Checkout.open({
    settings: {
      displayMode: "inline",
      variant: "one-page",
      theme: currentTheme(),
      frameTarget: "checkout-frame",
      frameInitialHeight: 480,
      frameStyle: "width: 100%; min-width: 312px; background-color: transparent; border: none;",
    },
    items: [{ priceId: sub.checkout.priceId, quantity: 1 }],
    customData: { tenantId: sub.checkout.tenantId },
    ...(sub.checkout.email ? { customer: { email: sub.checkout.email } } : {}),
  });
}

// Paddle tells us about the payment through a webhook, a few seconds after
// checkout -- poll until the server has recorded it, then open the app.
async function waitForActivation(statusEl) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const sub = await (await fetch("/api/admin/subscription")).json().catch(() => null);
    if (sub && (sub.status === "active" || sub.status === "trialing")) {
      location.href = "/";
      return;
    }
  }
  statusEl.textContent = "Payment received. Activation is taking longer than usual -- refresh this page in a minute.";
}

start().catch(() => {
  location.href = "/";
});
