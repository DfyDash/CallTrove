// Payment step of sign-up. No account exists yet: Paddle's confirmation of
// the first payment is what creates it (src/paddle.js), so this page just
// shows the plan, takes payment, then waits for that to happen.
const params = new URLSearchParams(location.search);
const pendingId = params.get("id");
const statusEl = document.getElementById("subscription-status");
const fallback = document.getElementById("checkout-fallback");
const stepsEl = document.getElementById("wizard-steps");

function fmtRate(n) {
  return "$" + String(Number(n));
}

function currentTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function fail(message) {
  document.getElementById("checkout-frame").hidden = true;
  fallback.textContent = message;
  fallback.hidden = false;
}

function loginUrl(emailed) {
  return "/login.html?paid=1" + (emailed ? "&emailed=1" : "") + (accountEmail ? "&email=" + encodeURIComponent(accountEmail) : "");
}

let accountEmail = "";

// Our own confirmation replaces Paddle's, so the buyer isn't left looking at
// Paddle's generic success screen while the account is being created.
function showPaymentReceived() {
  document.getElementById("checkout-frame").hidden = true;
  fallback.hidden = true;
  document.getElementById("checkout-done").hidden = false;
}

async function waitForAccount() {
  showPaymentReceived();
  statusEl.textContent = "";
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch("/auth/checkout-status?id=" + encodeURIComponent(pendingId)).catch(() => null);
    const body = res && res.ok ? await res.json() : null;
    if (body && body.ready) {
      location.href = loginUrl(body.emailed);
      return;
    }
  }
  document.getElementById("checkout-done-text").textContent = "Your account is taking longer than usual to set up. Try logging in with your email in a minute.";
}

async function start() {
  if (!pendingId) return fail("This checkout link is missing its sign-up. Please start again.");
  const res = await fetch("/auth/checkout-config?id=" + encodeURIComponent(pendingId));
  if (res.status === 404) return fail("This sign-up has expired. Please start again.");
  if (!res.ok) return fail("Checkout isn't available right now. Please try again later.");
  const cfg = await res.json();
  if (cfg.ready) {
    location.href = loginUrl(false);
    return;
  }
  accountEmail = (cfg.checkout && cfg.checkout.email) || "";
  const labels = wizardLabels(cfg.hipaaRequested);
  renderWizardSteps(stepsEl, labels, labels.length);
  document.getElementById("plan-name").textContent = cfg.hipaaRequested ? "CallTrove for HIPAA" : "CallTrove";
  document.getElementById("onboarding-price").textContent = cfg.checkout.priceLabel || "";
  const points = ["Every call recording from your GoHighLevel account, saved and searchable"];
  if (cfg.hipaaRequested) points.push("Business Associate Agreement on file");
  if (cfg.storage) points.push(`${cfg.storage.freeGB} GB of recording storage included, then ${fmtRate(cfg.storage.overagePerGbMonth)} per GB per month`);
  if (cfg.rates) points.push(`Transcripts and AI summaries as you use them: ${fmtRate(cfg.rates.transcriptionPerMinute)} per minute of transcription, ${fmtRate(cfg.rates.aiSummaryPerCall)} per AI summary`);
  points.push("Usage is charged to the same card as it adds up");
  document.getElementById("plan-points").replaceChildren(...points.map((t) => Object.assign(document.createElement("li"), { textContent: t })));

  if (!cfg.checkout.priceId) return fail("Pricing for your plan isn't available yet. Please contact support.");
  if (!window.Paddle) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load checkout. Check your connection and refresh."));
      document.head.appendChild(s);
    });
  }
  if (cfg.checkout.environment === "sandbox") window.Paddle.Environment.set("sandbox");
  window.Paddle.Initialize({
    token: cfg.checkout.clientToken,
    eventCallback: (ev) => {
      if (ev.name === "checkout.completed") waitForAccount();
      else if (ev.name === "checkout.error" || ev.name === "checkout.failed") {
        fallback.textContent = "Checkout ran into a problem. Refresh the page to try again.";
        fallback.hidden = false;
      }
    },
  });
  window.Paddle.Checkout.open({
    settings: {
      displayMode: "inline",
      showAddDiscounts: false,
      variant: "one-page",
      theme: currentTheme(),
      frameTarget: "checkout-frame",
      frameInitialHeight: 480,
      frameStyle: "width: 100%; min-width: 312px; background-color: transparent; border: none;",
    },
    items: [{ priceId: cfg.checkout.priceId, quantity: 1 }],
    customData: { pendingSignupId: cfg.checkout.pendingSignupId },
    customer: { email: cfg.checkout.email },
  });
}

start().catch((err) => fail((err && err.message) || "Could not load checkout."));
