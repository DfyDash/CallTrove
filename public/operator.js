const sessionBar = document.getElementById("session-bar");
const operatorRows = document.getElementById("operator-rows");
const mobileNavToggle = document.getElementById("mobile-nav-toggle");
const sidebarEl = document.querySelector(".sidebar");
const operatorNavLink = document.getElementById("operator-nav-link");
mobileNavToggle.addEventListener("click", () => sidebarEl.classList.toggle("nav-open"));

const purgeConfirm = document.getElementById("purge-confirm");
const purgeConfirmName = document.getElementById("purge-confirm-name");
const purgeConfirmInput = document.getElementById("purge-confirm-input");
const confirmPurgeBtn = document.getElementById("confirm-purge-btn");
const cancelPurgeBtn = document.getElementById("cancel-purge-btn");
const purgeError = document.getElementById("purge-error");

let csrfToken = "";
let pendingPurgeTenantId = null;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  csrfToken = me.csrfToken || "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})</span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;
  if (operatorNavLink) operatorNavLink.hidden = !me.isOperator;

  if (!me.isOperator) {
    operatorRows.innerHTML = `<tr><td colspan="9">Operator access required.</td></tr>`;
    return false;
  }
  return true;
}

function formatMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

function actionsForTenant(t) {
  if (t.status === "active") {
    return `<button type="button" class="cancel-tenant-btn" data-id="${escapeHtml(t.id)}">Cancel</button>`;
  }
  if (t.status === "cancellation_pending") {
    const purgeAt = new Date(t.purgeAt);
    const eligible = purgeAt <= new Date();
    return `<button type="button" class="restore-tenant-btn" data-id="${escapeHtml(t.id)}">Restore</button>
      <button type="button" class="purge-tenant-btn delete-btn" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" ${eligible ? "" : "disabled"}>
        ${eligible ? "Delete" : `Eligible ${purgeAt.toLocaleDateString()}`}
      </button>`;
  }
  return `<span class="settings-note">-</span>`; // canceled -- nothing left to do
}

async function loadTenants() {
  const res = await fetch("/api/operator/tenants");
  if (!res.ok) {
    operatorRows.innerHTML = `<tr><td colspan="9">Could not load accounts.</td></tr>`;
    return;
  }
  const tenants = await res.json();
  if (tenants.length === 0) {
    operatorRows.innerHTML = `<tr><td colspan="9">No accounts yet.</td></tr>`;
    return;
  }
  operatorRows.innerHTML = tenants
    .map(
      (t) => `
    <tr data-tenant-id="${escapeHtml(t.id)}">
      <td data-label="Account">${escapeHtml(t.name)}</td>
      <td data-label="Status">${escapeHtml(t.status)}</td>
      <td data-label="Owner">${escapeHtml(t.ownerUsername || "-")}</td>
      <td data-label="GHL accounts">${t.ghlAccountCount}</td>
      <td data-label="Total calls">${t.totalCalls}</td>
      <td data-label="Recordings stored">${t.recordingsStored}</td>
      <td data-label="Transcribed minutes">${t.transcribedMinutes}</td>
      <td data-label="Est. transcribe cost">${formatMoney(t.estimatedTranscribeCost)}</td>
      <td data-label="Actions">${actionsForTenant(t)}</td>
    </tr>`
    )
    .join("");
}

operatorRows.addEventListener("click", async (e) => {
  const cancelBtn = e.target.closest(".cancel-tenant-btn");
  const restoreBtn = e.target.closest(".restore-tenant-btn");
  const purgeBtn = e.target.closest(".purge-tenant-btn");

  if (cancelBtn) {
    if (!confirm("Cancel this account? Every login is locked out immediately, with a grace period before it becomes eligible for deletion.")) return;
    const res = await fetch(`/api/operator/tenants/${cancelBtn.dataset.id}/cancel`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Could not cancel this account");
      return;
    }
    loadTenants();
  }

  if (restoreBtn) {
    const res = await fetch(`/api/operator/tenants/${restoreBtn.dataset.id}/restore`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Could not restore this account");
      return;
    }
    loadTenants();
  }

  if (purgeBtn) {
    pendingPurgeTenantId = purgeBtn.dataset.id;
    purgeConfirmName.textContent = purgeBtn.dataset.name;
    purgeConfirmInput.value = "";
    purgeError.hidden = true;
    purgeConfirm.hidden = false;
    purgeConfirmInput.focus();
  }
});

cancelPurgeBtn.addEventListener("click", () => {
  purgeConfirm.hidden = true;
  purgeError.hidden = true;
  pendingPurgeTenantId = null;
});

confirmPurgeBtn.addEventListener("click", async () => {
  if (purgeConfirmInput.value !== "DELETE ACCOUNT") {
    purgeError.textContent = 'Type "DELETE ACCOUNT" exactly to confirm.';
    purgeError.hidden = false;
    return;
  }
  confirmPurgeBtn.disabled = true;
  const res = await fetch(`/api/operator/tenants/${pendingPurgeTenantId}/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ confirm: purgeConfirmInput.value }),
  });
  confirmPurgeBtn.disabled = false;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    purgeError.textContent = data.error || "Could not delete this account";
    purgeError.hidden = false;
    return;
  }
  purgeConfirm.hidden = true;
  pendingPurgeTenantId = null;
  loadTenants();
});

(async () => {
  const isOperator = await loadSession();
  if (isOperator) await loadTenants();
})();
