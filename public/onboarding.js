// Post-signup steps: BAA (only if they said they'll store health
// information), then Paddle checkout. Reuses the same /api/admin endpoints
// as Settings -> HIPAA / BAA and Settings -> Billing.
let csrfToken = "";
let baaHash = "";

const baaSection = document.getElementById("onboarding-baa");
const billingSection = document.getElementById("onboarding-billing");

async function start() {
  const me = await (await fetch("/api/me")).json();
  csrfToken = me.csrfToken || "";
  const sub = await (await fetch("/api/admin/subscription")).json();
  if (sub.hipaaRequested) {
    const baa = await (await fetch("/api/admin/baa")).json();
    if (!baa.acceptance && baa.canAccept) {
      document.getElementById("baa-text").textContent = baa.text;
      baaHash = baa.hash;
      baaSection.hidden = false;
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

function showBilling(sub) {
  const live = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
  if (!sub.checkout || live) {
    location.href = "/";
    return;
  }
  billingSection.hidden = false;
  const statusEl = document.getElementById("subscription-status");
  const btn = document.getElementById("subscribe-btn");
  statusEl.textContent = "Subscribe now, or skip and do it later from Settings \u2192 Billing.";
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      if (!window.Paddle) {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("Could not load checkout."));
          document.head.appendChild(s);
        });
      }
      if (sub.checkout.environment === "sandbox") window.Paddle.Environment.set("sandbox");
      window.Paddle.Initialize({
        token: sub.checkout.clientToken,
        eventCallback: (ev) => {
          if (ev.name === "checkout.completed") {
            statusEl.textContent = "Thanks! Your subscription is being activated.";
            btn.hidden = true;
            document.getElementById("skip-link").textContent = "Continue to CallTrove";
          }
        },
      });
      window.Paddle.Checkout.open({
        items: [{ priceId: sub.checkout.priceId, quantity: 1 }],
        customData: { tenantId: sub.checkout.tenantId },
        ...(sub.checkout.email ? { customer: { email: sub.checkout.email } } : {}),
      });
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

start().catch(() => {
  location.href = "/";
});
