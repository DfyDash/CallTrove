const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
const sessionBar = document.getElementById("session-bar");
const adminNav = document.getElementById("admin-nav");
const viewAsSelect = document.getElementById("view-as");
const mobileNavToggle = document.getElementById("mobile-nav-toggle");
const sidebarEl = document.querySelector(".sidebar");
mobileNavToggle.addEventListener("click", () => sidebarEl.classList.toggle("nav-open"));
let csrfToken = "";
let viewAs = "";

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// See app.js for why this exists -- shown to everyone on a tenant that's
// mid-grace-period so nobody's caught off guard by the eventual lockout.
function renderCancellationBanner(me) {
  const banner = document.getElementById("cancellation-banner");
  if (!banner) return;
  if (!me.cancellationPending) {
    banner.hidden = true;
    return;
  }
  const when = new Date(me.cancellationPending.purgeAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  banner.innerHTML = `This account is scheduled for cancellation. Everyone will be locked out on <strong>${escapeHtml(when)}</strong> -- export anything you need before then.`;
  banner.hidden = false;
}

function isNameJustThePhone(name, phone) {
  if (!name || !phone) return false;
  const nameDigits = name.replace(/\D/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  return !!nameDigits && nameDigits.slice(-10) === phoneDigits.slice(-10);
}

function dispositionLabel(disposition) {
  if (!disposition || disposition === "(unknown)") return "(unknown)";
  return disposition.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(seconds) {
  if (!seconds) return "-";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --- shared sidebar chrome (session bar, admin "viewing calls for", quick search) ---

let isAdmin = false;

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  isAdmin = me.role === "admin";
  csrfToken = me.csrfToken || "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})</span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;
  document.getElementById("account-summary").textContent = `Signed in as ${me.username} (${me.role}).`;
  renderCancellationBanner(me);

  if (!isAdmin) {
    for (const name of TAB_NAMES) {
      if (name === "account") continue;
      const link = document.querySelector(`#settings-tabs [data-tab="${name}"]`);
      if (link) link.hidden = true;
    }
    activateTab(location.hash.replace("#", ""));
    return;
  }

  adminNav.hidden = false;
  await loadViewAsOptions();
  await loadDangerZone();

  if (me.transcriptionEnabled) await loadTranscriptionSettings();

  loadTeam();
  activateTab(location.hash.replace("#", ""));
}

// --- Cancel this account (owner-only -- see src/routes/admin.js) ---

const dangerZone = document.getElementById("danger-zone");
const openCancelBtn = document.getElementById("open-cancel-btn");
const cancelConfirm = document.getElementById("cancel-confirm");
const cancelConfirmName = document.getElementById("cancel-confirm-name");
const cancelConfirmInput = document.getElementById("cancel-confirm-input");
const confirmCancelBtn = document.getElementById("confirm-cancel-btn");
const cancelCancelBtn = document.getElementById("cancel-cancel-btn");
const cancelError = document.getElementById("cancel-error");
const gracePeriodDaysEl = document.getElementById("grace-period-days");
let tenantName = "";

async function loadDangerZone() {
  const res = await fetch("/api/tenant/status");
  const tenant = await res.json();
  if (!tenant.isOwner) return; // stays hidden -- only the paying owner can see or trigger this
  if (tenant.status !== "active") return; // already canceled/pending -- nothing new to offer here, account-canceled.html covers that state
  tenantName = tenant.name;
  cancelConfirmName.textContent = tenant.name;
  gracePeriodDaysEl.textContent = tenant.gracePeriodDays;
  dangerZone.hidden = false;
}

openCancelBtn.addEventListener("click", () => {
  cancelConfirm.hidden = false;
  cancelConfirmInput.value = "";
  cancelConfirmInput.focus();
});

cancelCancelBtn.addEventListener("click", () => {
  cancelConfirm.hidden = true;
  cancelError.hidden = true;
});

confirmCancelBtn.addEventListener("click", async () => {
  if (cancelConfirmInput.value !== tenantName) {
    cancelError.textContent = "That doesn't match the account name.";
    cancelError.hidden = false;
    return;
  }
  if (!confirm(`This will lock everyone out of "${tenantName}" immediately and permanently delete its data after the grace period. Are you sure?`)) {
    return;
  }
  confirmCancelBtn.disabled = true;
  const res = await fetch("/api/admin/tenant/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ confirmName: cancelConfirmInput.value }),
  });
  if (res.ok) {
    location.href = "/account-canceled.html";
    return;
  }
  const body = await res.json().catch(() => ({}));
  cancelError.textContent = body.error || "Could not cancel the account.";
  cancelError.hidden = false;
  confirmCancelBtn.disabled = false;
});

async function loadViewAsOptions() {
  const res = await fetch("/api/admin/users");
  const users = await res.json();
  const agents = users.filter((u) => u.ghlUserId);
  viewAsSelect.innerHTML = `<option value="">All users</option>` +
    agents.map((u) => `<option value="${escapeHtml(u.ghlUserId)}">${escapeHtml(u.ghlUserName || u.username)}</option>`).join("");
  viewAsSelect.hidden = agents.length === 0;
}

async function loadSearchResults(search) {
  if (!search) {
    searchResults.hidden = true;
    searchResults.innerHTML = "";
    return;
  }
  const res = await fetch(`/api/contacts?search=${encodeURIComponent(search)}`);
  const contacts = await res.json();
  searchResults.innerHTML = "";
  searchResults.hidden = false;
  if (contacts.length === 0) {
    searchResults.innerHTML = `<li class="search-empty">No matching contacts.</li>`;
    return;
  }
  for (const contact of contacts) {
    const li = document.createElement("li");
    li.className = "search-result-item";
    const displayName = isNameJustThePhone(contact.name, contact.phone) ? "(no name)" : contact.name || "(no name)";
    li.innerHTML = `${escapeHtml(displayName)}<span class="contact-phone">${escapeHtml(contact.phone || "")}</span>`;
    li.addEventListener("click", () => {
      location.href = `/?contactId=${encodeURIComponent(contact.id)}`;
    });
    searchResults.appendChild(li);
  }
}

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSearchResults(searchInput.value.trim()), 200);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) searchResults.hidden = true;
});

// --- tab switching ---

const TAB_NAMES = ["account", "team", "accounts", "report", "coverage", "transcription", "backfill", "activity", "access"];
const tabLoaded = {};

function activateTab(tab) {
  if (!isAdmin) {
    tab = "account";
  } else if (!TAB_NAMES.includes(tab)) {
    tab = "team";
  }
  for (const name of TAB_NAMES) {
    document.getElementById(`tab-${name}`).hidden = name !== tab;
    const link = document.querySelector(`#settings-tabs [data-tab="${name}"]`);
    if (link) link.classList.toggle("active", name === tab);
  }
  history.replaceState(null, "", `#${tab}`);

  if (!isAdmin) return;

  if (tab === "accounts" && !tabLoaded.accounts) loadGhlAccountsTab();
  if (tab === "report" && !tabLoaded.report) loadCallReport();
  if (tab === "coverage" && !tabLoaded.coverage) loadCoverage();
  if (tab === "backfill" && !tabLoaded.backfill) loadBackfillStatus();
  if (tab === "activity" && !tabLoaded.activity) loadAuditLog();
  if (tab === "access" && !tabLoaded.access) loadAccessLog();
}

document.getElementById("settings-tabs").addEventListener("click", (e) => {
  const link = e.target.closest("[data-tab]");
  if (!link) return;
  e.preventDefault();
  activateTab(link.dataset.tab);
});

// --- Team members ---

const userRows = document.getElementById("user-rows");
const accountsColTh = document.getElementById("accounts-col-th");
let tenantAccounts = [];
const addUserForm = document.getElementById("add-user-form");
const addUserError = document.getElementById("add-user-error");
const ghlUserSelect = document.getElementById("ghl-user-select");
let ghlUsers = [];

function ghlUserOptionsHtml(selectedId) {
  let html = `<option value="">(none)</option>`;
  for (const u of ghlUsers) {
    const label = `${u.name || "(no name)"}${u.email ? ` — ${u.email}` : ""}`;
    html += `<option value="${escapeHtml(u.id)}" ${u.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }
  return html;
}

async function loadGhlUsers() {
  const res = await fetch("/api/admin/ghl-users");
  ghlUsers = await res.json();
  for (const u of ghlUsers) {
    const option = document.createElement("option");
    option.value = u.id;
    option.dataset.name = u.name || u.email || u.id;
    option.textContent = `${u.name || "(no name)"}${u.email ? ` — ${u.email}` : ""}`;
    ghlUserSelect.appendChild(option);
  }
}

function accountAccessCellHtml(user) {
  if (tenantAccounts.length <= 1) return "";
  if (user.accountIds === null) return `<span class="settings-note">All (admin)</span>`;

  const checkboxes = tenantAccounts
    .map((a) => {
      const checked = user.accountIds.includes(a.id) ? "checked" : "";
      return `<label class="account-access-option"><input type="checkbox" value="${escapeHtml(a.id)}" ${checked} /> ${escapeHtml(a.name || a.ghlLocationId)}</label>`;
    })
    .join("");
  const count = user.accountIds.length;
  return `
    <details class="account-access-details">
      <summary>${count} account${count === 1 ? "" : "s"}</summary>
      <div class="account-access-list">${checkboxes}</div>
      <button type="button" data-id="${escapeHtml(user.id)}" class="account-access-save-btn">Save</button>
    </details>
  `;
}

async function loadUsers() {
  const res = await fetch("/api/admin/users");
  const users = await res.json();
  userRows.innerHTML = "";
  for (const user of users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="Username">${escapeHtml(user.username)}</td>
      <td data-label="Role">${escapeHtml(user.role)}</td>
      <td data-label="GHL user">
        <select class="ghl-link-select">${ghlUserOptionsHtml(user.ghlUserId)}</select>
        <button data-id="${user.id}" class="link-ghl-btn">Save</button>
      </td>
      <td class="accounts-col" data-label="Accounts" ${tenantAccounts.length <= 1 ? "hidden" : ""}>${accountAccessCellHtml(user)}</td>
      <td data-label="Actions">
        <button data-id="${user.id}" class="reset-btn">Reset password</button>
        <button data-id="${user.id}" class="delete-btn">Delete</button>
      </td>
    `;
    tr.querySelector(".delete-btn").addEventListener("click", () => deleteUser(user.id, user.username));
    tr.querySelector(".reset-btn").addEventListener("click", () => resetPassword(user.id, user.username));
    tr.querySelector(".link-ghl-btn").addEventListener("click", () => {
      const select = tr.querySelector(".ghl-link-select");
      linkGhlUser(user.id, select.value || null);
    });
    const accountSaveBtn = tr.querySelector(".account-access-save-btn");
    if (accountSaveBtn) {
      accountSaveBtn.addEventListener("click", () => {
        const checked = Array.from(tr.querySelectorAll(".account-access-list input:checked")).map((el) => el.value);
        saveAccountAccess(user.id, checked);
      });
    }
    userRows.appendChild(tr);
  }
}

async function saveAccountAccess(userId, accountIds) {
  const res = await fetch(`/api/admin/users/${userId}/account-access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ accountIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not update account access");
    return;
  }
  loadUsers();
}

function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 14);
}

async function resetPassword(id, username) {
  if (!confirm(`Reset the password for "${username}"? Their current password will stop working immediately.`)) return;
  const newPassword = generatePassword();
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ password: newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not reset password");
    return;
  }
  alert(`New password for "${username}":\n\n${newPassword}\n\nSend this to them securely -- it won't be shown again.`);
  tabLoaded.activity = false;
}

async function linkGhlUser(id, ghlUserId) {
  const ghlUser = ghlUsers.find((u) => u.id === ghlUserId);
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ ghlUserId, ghlUserName: ghlUser ? ghlUser.name || ghlUser.email || ghlUser.id : null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not update GHL link");
    return;
  }
  loadUsers();
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not delete user");
    return;
  }
  loadUsers();
}

addUserForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  addUserError.hidden = true;
  const formData = new FormData(addUserForm);
  const payload = Object.fromEntries(formData.entries());
  delete payload.ghlUser;
  const selectedOption = ghlUserSelect.selectedOptions[0];
  payload.ghlUserId = ghlUserSelect.value || null;
  payload.ghlUserName = ghlUserSelect.value ? selectedOption.dataset.name : null;
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    addUserError.textContent = body.error || "could not create user";
    addUserError.hidden = false;
    return;
  }
  addUserForm.reset();
  loadUsers();
});

async function loadTeam() {
  if (tabLoaded.team) return;
  tabLoaded.team = true;

  // The per-user account-access checklist only makes sense (and only
  // shows) once there's more than one connected account -- same "don't
  // clutter today's single-account reality" reasoning as the sidebar
  // switcher.
  const res = await fetch("/api/admin/ghl-accounts");
  const { accounts } = await res.json();
  tenantAccounts = accounts;
  accountsColTh.hidden = tenantAccounts.length <= 1;

  await loadGhlUsers();
  await loadUsers();
}

// --- GHL accounts (multi-tenant: connected locations) ---

const ghlAccountRows = document.getElementById("ghl-account-rows");
const connectGhlAccountBtn = document.getElementById("connect-ghl-account-btn");
const ghlOauthNotConfigured = document.getElementById("ghl-oauth-not-configured");

async function loadGhlAccountsTab() {
  tabLoaded.accounts = true;
  const res = await fetch("/api/admin/ghl-accounts");
  const { accounts, oauthConfigured } = await res.json();

  ghlAccountRows.innerHTML = accounts.length
    ? accounts
        .map(
          (a) => `<tr>
            <td data-label="Location name">${escapeHtml(a.name || a.ghlLocationId)}</td>
            <td data-label="GHL location ID">${escapeHtml(a.ghlLocationId)}</td>
            <td data-label="State (records retention)">
              <input type="text" class="account-state-input" maxlength="2" placeholder="e.g. CA" value="${escapeHtml(a.state || "")}" data-id="${escapeHtml(a.id)}" />
              <button type="button" class="account-state-save-btn" data-id="${escapeHtml(a.id)}">Save</button>
              <span class="account-state-status" data-id="${escapeHtml(a.id)}"></span>
            </td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty-state">No GHL accounts connected yet.</td></tr>`;

  connectGhlAccountBtn.hidden = !oauthConfigured;
  ghlOauthNotConfigured.hidden = oauthConfigured;
}

ghlAccountRows.addEventListener("click", async (e) => {
  const btn = e.target.closest(".account-state-save-btn");
  if (!btn) return;
  const id = btn.dataset.id;
  const input = ghlAccountRows.querySelector(`.account-state-input[data-id="${id}"]`);
  const statusEl = ghlAccountRows.querySelector(`.account-state-status[data-id="${id}"]`);
  btn.disabled = true;
  statusEl.textContent = "Saving…";
  const res = await fetch(`/api/admin/ghl-accounts/${id}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ state: input.value.trim() }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    statusEl.textContent = `Saved -- recomputed retention for ${body.callsRecomputed} call(s).`;
  } else {
    statusEl.textContent = body.error || "Could not save.";
  }
  btn.disabled = false;
});

connectGhlAccountBtn.addEventListener("click", () => {
  location.href = "/api/admin/ghl-oauth/connect";
});

// --- Call report ---

const reportLeaderboardEl = document.getElementById("report-leaderboard");
const reportDetailEl = document.getElementById("report-detail");
const repBarsEl = document.getElementById("rep-bars");
const repRowsEl = document.getElementById("rep-rows");
const repChipsEl = document.getElementById("rep-chips");
let reportPreset = "month";
let reportData = null; // { reps, trend }
let selectedRepId = null;

// Bars below are filled by rounding to one of the .w-N / .trend-h-N
// classes in style.css rather than an inline style="width:…"/"height:…":
// the CSP here has no 'unsafe-inline' for style-src, so a computed
// style="" attribute is silently dropped by the browser.
function widthBucket(pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return Math.round(clamped / 10) * 10;
}

function reportPresetRange(preset) {
  const now = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  if (preset === "today") return { from: fmt(now), to: fmt(now) };
  if (preset === "week") {
    const from = new Date(now);
    from.setDate(now.getDate() - now.getDay());
    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    return { from: fmt(from), to: fmt(to) };
  }
  if (preset === "month") {
    return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  }
  if (preset === "year") return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  return { from: "", to: "" };
}

document.getElementById("report-presets").addEventListener("click", (e) => {
  const btn = e.target.closest(".preset-btn");
  if (!btn) return;
  reportPreset = btn.dataset.preset;
  document.querySelectorAll("#report-presets .preset-btn").forEach((b) => b.classList.toggle("active", b === btn));
  loadCallReport();
});

async function loadCallReport() {
  tabLoaded.report = true;
  const { from, to } = reportPresetRange(reportPreset);
  const params = new URLSearchParams();
  if (from) params.set("dateFrom", from);
  if (to) params.set("dateTo", to);
  const res = await fetch(`/api/admin/call-report?${params.toString()}`);
  reportData = await res.json();
  renderReportLeaderboard();
  if (selectedRepId) renderReportDetail();
}

function renderReportLeaderboard() {
  const reps = reportData.reps;
  const maxTotal = Math.max(1, ...reps.map((r) => r.total));

  repBarsEl.innerHTML = "";
  repRowsEl.innerHTML = "";

  if (reps.length === 0) {
    repBarsEl.innerHTML = `<p class="empty-state">No calls in this range yet.</p>`;
    repRowsEl.innerHTML = `<tr><td colspan="5" class="empty-state">No calls in this range yet.</td></tr>`;
    return;
  }

  for (const rep of reps) {
    const barRow = document.createElement("div");
    barRow.className = "rep-bar-row";
    const pct = Math.round((rep.total / maxTotal) * 100);
    barRow.innerHTML = `
      <span class="rep-bar-name">${escapeHtml(rep.name || "(unnamed)")}</span>
      <div class="rep-bar-track"><div class="rep-bar-fill w-${widthBucket(pct)}"></div></div>
      <span class="rep-bar-total">${rep.total}</span>
    `;
    barRow.addEventListener("click", () => selectRep(rep.id));
    repBarsEl.appendChild(barRow);

    const tr = document.createElement("tr");
    tr.className = "clickable-row";
    tr.innerHTML = `
      <td data-label="Rep">${escapeHtml(rep.name || "(unnamed)")}</td>
      <td data-label="Total calls">${rep.total}</td>
      <td data-label="Completion rate">${rep.completionPct}%</td>
      <td data-label="Avg. duration">${formatDuration(rep.avgDurationSeconds)}</td>
      <td data-label="Inbound / outbound">${rep.inbound} / ${rep.outbound}</td>
    `;
    tr.addEventListener("click", () => selectRep(rep.id));
    repRowsEl.appendChild(tr);
  }
}

function selectRep(id) {
  selectedRepId = id;
  reportLeaderboardEl.hidden = true;
  reportDetailEl.hidden = false;
  renderReportDetail();
}

document.getElementById("back-to-leaderboard").addEventListener("click", () => {
  selectedRepId = null;
  reportDetailEl.hidden = true;
  reportLeaderboardEl.hidden = false;
});

function renderReportDetail() {
  const rep = reportData.reps.find((r) => r.id === selectedRepId);
  if (!rep) {
    selectedRepId = null;
    reportDetailEl.hidden = true;
    reportLeaderboardEl.hidden = false;
    return;
  }

  document.getElementById("rep-detail-name").textContent = rep.name || "(unnamed)";
  document.getElementById("rep-detail-total").textContent = rep.total;
  document.getElementById("rep-detail-completion").textContent = `${rep.completionPct}%`;
  document.getElementById("rep-detail-duration").textContent = formatDuration(rep.avgDurationSeconds);
  document.getElementById("rep-detail-mix").textContent = `${rep.inbound} / ${rep.outbound}`;

  repChipsEl.innerHTML = "";
  for (const r of reportData.reps) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `rep-chip${r.id === selectedRepId ? " active" : ""}`;
    chip.textContent = r.name || "(unnamed)";
    chip.addEventListener("click", () => selectRep(r.id));
    repChipsEl.appendChild(chip);
  }

  const trend = (reportData.trend && reportData.trend[rep.id]) || [];
  const maxCount = Math.max(1, ...Object.values(reportData.trend || {}).flat().map((d) => d.count));
  const trendEl = document.getElementById("rep-trend");
  trendEl.innerHTML = "";

  // A genuinely all-zero week (this rep just hasn't had a call in the last
  // 7 calendar days -- independent of whatever date range the stats above
  // cover) rendered as seven 0px bars, indistinguishable from the chart
  // having failed to draw at all. Say so explicitly instead.
  if (trend.length > 0 && trend.every((point) => point.count === 0)) {
    trendEl.innerHTML = `<p class="empty-state">No calls in the last 7 days.</p>`;
  } else {
    for (const point of trend) {
      const label = new Date(`${point.day}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });
      // A floor bucket (trend-h-0, 3px) keeps a real (but non-zero-week)
      // zero-count day visibly distinct from empty space, same reasoning
      // as above.
      const bucket = point.count === 0 ? 0 : Math.max(10, widthBucket((point.count / maxCount) * 100));
      const col = document.createElement("div");
      col.className = "trend-bar-col";
      col.innerHTML = `<div class="trend-bar trend-h-${bucket}" title="${point.count} calls"></div><span class="trend-bar-label">${escapeHtml(label)}</span>`;
      trendEl.appendChild(col);
    }
  }

  const total = rep.inbound + rep.outbound;
  const inboundPct = total ? Math.round((rep.inbound / total) * 100) : 0;
  document.getElementById("rep-mix-bar").innerHTML =
    `<div class="mix-bar-inbound w-${widthBucket(inboundPct)}"></div><div class="mix-bar-outbound w-${widthBucket(100 - inboundPct)}"></div>`;
}

// --- Call recording coverage (chart code unchanged from the standalone report) ---

const statGrid = document.getElementById("stat-grid");
const dispositionRows = document.getElementById("disposition-rows");
const gapRows = document.getElementById("gap-rows");
const gapPrevBtn = document.getElementById("gap-prev-btn");
const gapNextBtn = document.getElementById("gap-next-btn");
const gapPageIndicator = document.getElementById("gap-page-indicator");
const monthChartSvg = document.getElementById("month-chart");
const chartTooltip = document.getElementById("chart-tooltip");
let gapPage = 1;

function statTile(label, value, href) {
  const tag = href ? "a" : "div";
  const hrefAttr = href ? ` href="${escapeHtml(href)}"` : "";
  const className = href ? "stat-tile stat-tile-link" : "stat-tile";
  return `<${tag} class="${className}"${hrefAttr}><div class="stat-value">${value}</div><div class="stat-label">${escapeHtml(label)}</div></${tag}>`;
}

async function loadCoverage() {
  tabLoaded.coverage = true;
  const res = await fetch("/api/admin/coverage");
  const { summary, byDisposition, byMonth } = await res.json();

  const storedPct = summary.total ? Math.round((summary.stored / summary.total) * 100) : 0;
  statGrid.innerHTML =
    statTile("Total calls", summary.total, "/?all=1") +
    statTile("Recordings stored", `${summary.stored} (${storedPct}%)`, "/?hasRecording=true") +
    statTile("Completed calls", summary.completed, "/?disposition=completed") +
    statTile("Completed, no recording found", summary.completedMissing, "/?disposition=completed&hasRecording=false");

  dispositionRows.innerHTML = "";
  if (byDisposition.length === 0) {
    dispositionRows.innerHTML = `<tr><td colspan="3" class="empty-state">No calls yet.</td></tr>`;
  }
  for (const row of byDisposition) {
    const tr = document.createElement("tr");
    const clickable = row.disposition !== "(unknown)";
    if (clickable) {
      tr.className = "clickable-row";
      tr.title = `View all "${dispositionLabel(row.disposition)}" calls on the dashboard`;
      tr.addEventListener("click", () => {
        location.href = `/?disposition=${encodeURIComponent(row.disposition)}`;
      });
    }
    tr.innerHTML = `
      <td data-label="Outcome">${escapeHtml(dispositionLabel(row.disposition))}</td>
      <td data-label="Calls">${row.count}</td>
      <td data-label="Recorded">${row.stored}</td>
    `;
    dispositionRows.appendChild(tr);
  }

  renderMonthChart(byMonth);
  loadGaps();
}

async function loadGaps() {
  const res = await fetch(`/api/admin/coverage/gaps?page=${gapPage}&pageSize=20`);
  const data = await res.json();
  gapRows.innerHTML = "";

  if (data.gaps.length === 0) {
    gapRows.innerHTML = `<tr><td colspan="5" class="empty-state">No gaps found.</td></tr>`;
  }
  for (const call of data.gaps) {
    const tr = document.createElement("tr");
    const when = call.occurredAt ? new Date(call.occurredAt).toLocaleString() : "-";
    if (call.contactId) {
      tr.className = "clickable-row";
      tr.title = "View this contact on the dashboard";
      tr.addEventListener("click", () => {
        location.href = `/?contactId=${encodeURIComponent(call.contactId)}`;
      });
    }
    const gapContactName = isNameJustThePhone(call.contactName, call.contactPhone) ? "(no name)" : call.contactName || "(no name)";
    tr.innerHTML = `
      <td data-label="Contact">${escapeHtml(gapContactName)}${call.contactPhone ? ` (${escapeHtml(call.contactPhone)})` : ""}</td>
      <td data-label="Date/Time">${when}</td>
      <td data-label="Direction">${escapeHtml(call.direction || "-")}</td>
      <td data-label="Handled by">${escapeHtml(call.handledByName || "-")}</td>
      <td data-label="Status">${escapeHtml(call.recordingStatus || "-")}</td>
    `;
    gapRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  gapPageIndicator.textContent = `Page ${data.page} of ${totalPages}`;
  gapPrevBtn.disabled = data.page <= 1;
  gapNextBtn.disabled = data.page >= totalPages;
}

gapPrevBtn.addEventListener("click", () => {
  if (gapPage > 1) {
    gapPage -= 1;
    loadGaps();
  }
});
gapNextBtn.addEventListener("click", () => {
  gapPage += 1;
  loadGaps();
});

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART = { width: 900, height: 260, margin: { top: 10, right: 10, bottom: 26, left: 40 } };

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function topRoundedRectPath(x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h));
  if (rad === 0) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return `M${x},${y + rad} A${rad},${rad} 0 0 1 ${x + rad},${y} H${x + w - rad} A${rad},${rad} 0 0 1 ${x + w},${y + rad} V${y + h} H${x} Z`;
}

function niceMax(value) {
  if (value <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function renderMonthChart(byMonth) {
  const { width, height, margin } = CHART;
  monthChartSvg.innerHTML = "";
  monthChartSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  monthChartSvg.setAttribute("preserveAspectRatio", "none");
  if (byMonth.length === 0) return;

  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxVal = niceMax(Math.max(...byMonth.map((m) => m.completed)));
  const baselineY = margin.top + plotH;
  const bandW = plotW / byMonth.length;
  const barW = Math.min(24, Math.max(2, bandW - 6));
  const labelEvery = Math.max(1, Math.ceil(byMonth.length / 10));

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const v = Math.round((maxVal / tickCount) * i);
    const y = baselineY - (v / maxVal) * plotH;
    monthChartSvg.appendChild(
      svgEl("line", { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: "chart-gridline" })
    );
    const label = svgEl("text", { x: margin.left - 8, y: y + 3, "text-anchor": "end", class: "chart-axis-label" });
    label.textContent = v.toLocaleString();
    monthChartSvg.appendChild(label);
  }

  byMonth.forEach((m, i) => {
    const missing = Math.max(0, m.completed - m.stored);
    const x = margin.left + i * bandW + (bandW - barW) / 2;
    const storedH = (m.stored / maxVal) * plotH;
    const missingH = (missing / maxVal) * plotH;
    const gap = m.stored > 0 && missing > 0 ? 2 : 0;

    const group = svgEl("g", {});

    if (m.stored > 0) {
      const h = Math.max(0, storedH - gap / 2);
      const y = baselineY - h;
      const el =
        missing > 0
          ? svgEl("rect", { x, y, width: barW, height: h })
          : svgEl("path", { d: topRoundedRectPath(x, y, barW, h, 4) });
      el.setAttribute("class", "chart-bar-seg");
      el.setAttribute("fill", "var(--status-good)");
      group.appendChild(el);
    }
    if (missing > 0) {
      const h = Math.max(0, missingH - gap / 2);
      const y = baselineY - storedH - missingH + (gap - gap / 2);
      const el = svgEl("path", { d: topRoundedRectPath(x, y, barW, h, 4) });
      el.setAttribute("class", "chart-bar-seg");
      el.setAttribute("fill", "var(--status-critical)");
      group.appendChild(el);
    }

    const hit = svgEl("rect", {
      x: margin.left + i * bandW,
      y: margin.top,
      width: bandW,
      height: plotH,
      class: "chart-bar-hit",
      tabindex: m.completed > 0 ? "0" : "-1",
    });
    if (m.completed > 0) {
      const move = (e) => showChartTooltip(e, m, missing, i, bandW, storedH);
      hit.addEventListener("pointerenter", move);
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerleave", hideChartTooltip);
      hit.addEventListener("focus", move);
      hit.addEventListener("blur", hideChartTooltip);
    }
    group.appendChild(hit);

    if (i % labelEvery === 0) {
      const label = svgEl("text", {
        x: margin.left + i * bandW + bandW / 2,
        y: height - 6,
        "text-anchor": "middle",
        class: "chart-axis-label",
      });
      label.textContent = monthLabel(m.month);
      group.appendChild(label);
    }

    monthChartSvg.appendChild(group);
  });
}

function showChartTooltip(e, m, missing, i, bandW, storedH) {
  const rect = monthChartSvg.getBoundingClientRect();
  const scaleX = rect.width / CHART.width;
  const scaleY = rect.height / CHART.height;
  const { margin } = CHART;
  const cx = (margin.left + i * bandW + bandW / 2) * scaleX;
  const cy = (margin.top + (CHART.height - margin.top - margin.bottom - storedH)) * scaleY;

  chartTooltip.hidden = false;
  chartTooltip.style.left = `${cx}px`;
  chartTooltip.style.top = `${Math.max(0, cy - 8)}px`;
  chartTooltip.textContent = "";
  const monthLine = document.createElement("div");
  monthLine.textContent = monthLabel(m.month);

  function tooltipRow(label, value) {
    const row = document.createElement("div");
    const valueSpan = document.createElement("span");
    valueSpan.className = "tooltip-value";
    valueSpan.textContent = String(value);
    row.append(`${label}: `, valueSpan);
    return row;
  }

  const storedLine = tooltipRow("Stored", m.stored);
  const missingLine = tooltipRow("No recording found", missing);
  chartTooltip.append(monthLine, storedLine, missingLine);
}

function hideChartTooltip() {
  chartTooltip.hidden = true;
}

// --- Transcription ---

const autoTranscribeToggle = document.getElementById("auto-transcribe-toggle");

async function loadTranscriptionSettings() {
  const res = await fetch("/api/admin/settings");
  const settings = await res.json();
  autoTranscribeToggle.checked = !!settings.autoTranscribeEnabled;
}

autoTranscribeToggle.addEventListener("change", async () => {
  autoTranscribeToggle.disabled = true;
  const res = await fetch("/api/admin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ autoTranscribeEnabled: autoTranscribeToggle.checked }),
  });
  if (!res.ok) {
    alert("Could not update the setting");
    autoTranscribeToggle.checked = !autoTranscribeToggle.checked;
  }
  autoTranscribeToggle.disabled = false;
  tabLoaded.activity = false;
});

// --- Historical backfill & export ---

const runBackfillBtn = document.getElementById("run-backfill-btn");
const backfillStatus = document.getElementById("backfill-status");
let backfillPollTimer = null;

function renderBackfillStatus(state) {
  if (state.running) {
    runBackfillBtn.disabled = true;
    runBackfillBtn.textContent = "Backfill running…";
    backfillStatus.textContent = "This can take a while for a lot of history -- feel free to navigate away and check back.";
    if (!backfillPollTimer) backfillPollTimer = setInterval(loadBackfillStatus, 5000);
    return;
  }
  runBackfillBtn.disabled = false;
  runBackfillBtn.textContent = "Run historical backfill";
  if (backfillPollTimer) {
    clearInterval(backfillPollTimer);
    backfillPollTimer = null;
  }
  if (state.lastError) {
    backfillStatus.textContent = `Last run failed: ${state.lastError}`;
  } else if (state.lastResult) {
    const r = state.lastResult;
    backfillStatus.textContent =
      `Last run: ${r.callsSaved} call${r.callsSaved === 1 ? "" : "s"} saved, ${r.callsSkipped} already had, ` +
      `${r.callsFailed} failed to process (${r.conversationsSeen} conversations scanned).`;
  } else {
    backfillStatus.textContent = "";
  }
}

async function loadBackfillStatus() {
  tabLoaded.backfill = true;
  const res = await fetch("/api/admin/backfill");
  renderBackfillStatus(await res.json());
}

runBackfillBtn.addEventListener("click", async () => {
  if (!confirm("Run a full historical backfill now? This walks the account's entire call history and can take a while for large accounts.")) return;
  const res = await fetch("/api/admin/backfill", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not start backfill");
    return;
  }
  renderBackfillStatus(await res.json());
  tabLoaded.activity = false;
});

// --- Activity log ---

const auditRows = document.getElementById("audit-rows");
const auditPrevBtn = document.getElementById("audit-prev-btn");
const auditNextBtn = document.getElementById("audit-next-btn");
const auditPageIndicator = document.getElementById("audit-page-indicator");
let auditPage = 1;

async function loadAuditLog() {
  tabLoaded.activity = true;
  const res = await fetch(`/api/admin/audit-log?page=${auditPage}&pageSize=50`);
  const data = await res.json();
  auditRows.innerHTML = "";

  if (data.entries.length === 0) {
    auditRows.innerHTML = `<tr><td colspan="3" class="empty-state">No activity yet.</td></tr>`;
  }
  for (const entry of data.entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="When">${new Date(entry.createdAt).toLocaleString()}</td>
      <td data-label="Admin">${escapeHtml(entry.actorUsername || "(unknown)")}</td>
      <td data-label="Action">${escapeHtml(entry.message)}</td>
    `;
    auditRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  auditPageIndicator.textContent = `Page ${data.page} of ${totalPages}`;
  auditPrevBtn.disabled = data.page <= 1;
  auditNextBtn.disabled = data.page >= totalPages;
}

auditPrevBtn.addEventListener("click", () => {
  if (auditPage > 1) {
    auditPage -= 1;
    loadAuditLog();
  }
});
auditNextBtn.addEventListener("click", () => {
  auditPage += 1;
  loadAuditLog();
});

// --- Access log ---

const accessRows = document.getElementById("access-rows");
const accessPrevBtn = document.getElementById("access-prev-btn");
const accessNextBtn = document.getElementById("access-next-btn");
const accessPageIndicator = document.getElementById("access-page-indicator");
let accessPage = 1;

const ACTION_LABELS = {
  recording_played: "Played recording",
  recording_downloaded: "Downloaded recording",
  transcript_viewed: "Viewed transcript",
  transcription_requested: "Requested transcription",
};

// "Name (phone)" -- but when the "name" on file is really just the phone
// number again (no real name entered), showing it a second time in parens
// is a pointless repeat, so fall back to the phone alone.
function contactLabel(entry) {
  const nameIsJustPhone = isNameJustThePhone(entry.contactName, entry.contactPhone);
  if (nameIsJustPhone) return escapeHtml(entry.contactPhone);
  if (entry.contactName || entry.contactPhone) {
    return `${escapeHtml(entry.contactName || "(no name)")}${entry.contactPhone ? ` (${escapeHtml(entry.contactPhone)})` : ""}`;
  }
  return entry.callId ? escapeHtml(entry.callId) : "-";
}

async function loadAccessLog() {
  tabLoaded.access = true;
  const res = await fetch(`/api/admin/phi-access-log?page=${accessPage}&pageSize=50`);
  const data = await res.json();
  accessRows.innerHTML = "";

  if (data.entries.length === 0) {
    accessRows.innerHTML = `<tr><td colspan="6" class="empty-state">No access recorded yet.</td></tr>`;
  }
  for (const entry of data.entries) {
    const tr = document.createElement("tr");
    const result = entry.success
      ? `<span>Allowed</span>`
      : `<span class="transcript-failed">Denied${entry.denialReason ? ` (${escapeHtml(entry.denialReason)})` : ""}</span>`;
    tr.innerHTML = `
      <td data-label="When">${new Date(entry.createdAt).toLocaleString()}</td>
      <td data-label="User">${escapeHtml(entry.username || "(unknown)")}</td>
      <td data-label="Action">${ACTION_LABELS[entry.action] || escapeHtml(entry.action)}</td>
      <td data-label="Call">${contactLabel(entry)}</td>
      <td data-label="Result">${result}</td>
      <td data-label="IP address">${escapeHtml(entry.ipAddress || "-")}</td>
    `;
    accessRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  accessPageIndicator.textContent = `Page ${data.page} of ${totalPages}`;
  accessPrevBtn.disabled = data.page <= 1;
  accessNextBtn.disabled = data.page >= totalPages;
}

accessPrevBtn.addEventListener("click", () => {
  if (accessPage > 1) {
    accessPage -= 1;
    loadAccessLog();
  }
});
accessNextBtn.addEventListener("click", () => {
  accessPage += 1;
  loadAccessLog();
});

// --- init ---

loadSession();
