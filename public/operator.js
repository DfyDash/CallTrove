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

const activityRows = document.getElementById("operator-activity-rows");
const activityPrevBtn = document.getElementById("operator-activity-prev-btn");
const activityNextBtn = document.getElementById("operator-activity-next-btn");
const activityPageIndicator = document.getElementById("operator-activity-page-indicator");
let activityPage = 1;
let activityLoaded = false;

const analyticsSummary = document.getElementById("operator-analytics-summary");
const analyticsRows = document.getElementById("operator-analytics-rows");
const accountsChartSvg = document.getElementById("operator-accounts-chart");
const accountsChartTooltip = document.getElementById("operator-chart-tooltip");
let cachedTenants = [];

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
    operatorRows.innerHTML = `<tr><td colspan="4">Operator access required.</td></tr>`;
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
    operatorRows.innerHTML = `<tr><td colspan="4">Could not load accounts.</td></tr>`;
    analyticsRows.innerHTML = `<tr><td colspan="7">Could not load analytics.</td></tr>`;
    analyticsSummary.innerHTML = "";
    return;
  }
  cachedTenants = await res.json();
  renderAccounts();
  renderAnalytics();
}

function renderAccounts() {
  if (cachedTenants.length === 0) {
    operatorRows.innerHTML = `<tr><td colspan="4">No accounts yet.</td></tr>`;
    return;
  }
  operatorRows.innerHTML = cachedTenants
    .map(
      (t) => `
    <tr data-tenant-id="${escapeHtml(t.id)}">
      <td data-label="Account">${escapeHtml(t.name)}</td>
      <td data-label="Status">${escapeHtml(t.status)}</td>
      <td data-label="Owner">${escapeHtml(t.ownerUsername || "-")}</td>
      <td data-label="Actions">${actionsForTenant(t)}</td>
    </tr>`
    )
    .join("");
}

function renderAnalytics() {
  if (cachedTenants.length === 0) {
    analyticsSummary.innerHTML = "";
    analyticsRows.innerHTML = `<tr><td colspan="7">No accounts yet.</td></tr>`;
    renderAccountsChart([]);
    return;
  }

  const totals = cachedTenants.reduce(
    (acc, t) => ({
      ghlAccountCount: acc.ghlAccountCount + t.ghlAccountCount,
      totalCalls: acc.totalCalls + t.totalCalls,
      completedCalls: acc.completedCalls + t.completedCalls,
      recordingsStored: acc.recordingsStored + t.recordingsStored,
      transcribedMinutes: acc.transcribedMinutes + t.transcribedMinutes,
      estimatedTranscribeCost: acc.estimatedTranscribeCost + t.estimatedTranscribeCost,
    }),
    { ghlAccountCount: 0, totalCalls: 0, completedCalls: 0, recordingsStored: 0, transcribedMinutes: 0, estimatedTranscribeCost: 0 }
  );

  analyticsSummary.innerHTML = `
    <div class="stat-tile"><div class="stat-value">${cachedTenants.length}</div><div class="stat-label">Accounts</div></div>
    <div class="stat-tile"><div class="stat-value">${totals.totalCalls}</div><div class="stat-label">Total calls</div></div>
    <div class="stat-tile"><div class="stat-value">${totals.completedCalls}</div><div class="stat-label">Completed calls</div></div>
    <div class="stat-tile"><div class="stat-value">${totals.recordingsStored}</div><div class="stat-label">Recordings stored</div></div>
    <div class="stat-tile"><div class="stat-value">${Math.round(totals.transcribedMinutes * 10) / 10}</div><div class="stat-label">Transcribed minutes</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(totals.estimatedTranscribeCost)}</div><div class="stat-label">Est. transcribe cost</div></div>
  `;

  analyticsRows.innerHTML = cachedTenants
    .map(
      (t) => `
    <tr data-tenant-id="${escapeHtml(t.id)}">
      <td data-label="Account">${escapeHtml(t.name)}</td>
      <td data-label="GHL accounts">${t.ghlAccountCount}</td>
      <td data-label="Total calls">${t.totalCalls}</td>
      <td data-label="Completed calls">${t.completedCalls}</td>
      <td data-label="Recordings stored">${t.recordingsStored}</td>
      <td data-label="Transcribed minutes">${t.transcribedMinutes}</td>
      <td data-label="Est. transcribe cost">${formatMoney(t.estimatedTranscribeCost)}</td>
    </tr>`
    )
    .join("");

  renderAccountsChart(cachedTenants);
}

// --- Calls-by-account chart (same SVG bar-chart approach as the client
// Coverage tab's month chart -- see settings.js -- just banded by account
// instead of by month, since there's no per-operator time series data.) ---

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART = { width: 900, height: 260, margin: { top: 10, right: 10, bottom: 34, left: 40 } };

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

function truncateLabel(str, max) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function renderAccountsChart(tenants) {
  const { width, height, margin } = CHART;
  accountsChartSvg.innerHTML = "";
  accountsChartSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  accountsChartSvg.setAttribute("preserveAspectRatio", "none");
  if (tenants.length === 0) return;

  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  // Grouped, not stacked -- every account gets four independent bars
  // sharing the 0 baseline, so each one (including "Stored") is directly
  // comparable account-to-account by height alone. A stacked segment
  // sits on top of the one below it at a floating baseline, which hides
  // its true height -- the exact "plopped two colors on top of each
  // other" complaint that sent us back to grouped bars in the first
  // place, and stacking four series would only make that worse.
  //
  // All four numbers get their own bar and their own label, rather than
  // showing two and expecting the other two to be read off by eye:
  // Total calls and Completed calls aren't the same population as
  // "Completed, no recording" -- subtracting the wrong pair (e.g.
  // completedCalls - recordingsStored) silently gives the wrong gap,
  // exactly the bug this replaced. "Missing" is t.completedMissing
  // (computed server-side -- see db.listTenantsForOperator), not
  // totalCalls minus recordingsStored -- a no-answer/busy/voicemail/
  // failed/canceled call never had a recording to begin with, so
  // counting it as "missing" overstates the real gap.
  //
  // totalCalls is always >= the other three for a given account, so it
  // alone sets the scale.
  const maxVal = niceMax(Math.max(...tenants.map((t) => t.totalCalls)));
  const baselineY = margin.top + plotH;
  const bandW = plotW / tenants.length;
  const barGap = 3;
  const barW = Math.min(22, Math.max(3, (bandW - 16 - barGap * 3) / 4));
  const groupW = barW * 4 + barGap * 3;
  const BAR_SERIES = [
    { key: "totalCalls", color: "var(--ink)" },
    { key: "completedCalls", color: "var(--accent)" },
    { key: "recordingsStored", color: "var(--status-good)" },
    { key: "completedMissing", color: "var(--status-critical)" },
  ];

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const v = Math.round((maxVal / tickCount) * i);
    const y = baselineY - (v / maxVal) * plotH;
    accountsChartSvg.appendChild(svgEl("line", { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: "chart-gridline" }));
    const label = svgEl("text", { x: margin.left - 8, y: y + 3, "text-anchor": "end", class: "chart-axis-label" });
    label.textContent = v.toLocaleString();
    accountsChartSvg.appendChild(label);
  }

  // Direct value labels above each bar -- without these, the only way to
  // learn a bar's exact number is to hover it. With four bars per account
  // now instead of two, they need more horizontal room each, so the
  // account-count cutoff for showing them at all is lower than the
  // two-bar version's.
  const showValueLabels = tenants.length <= 4;

  tenants.forEach((t, i) => {
    const groupX = margin.left + i * bandW + (bandW - groupW) / 2;
    const group = svgEl("g", {});

    function valueLabel(x, barHeight, value) {
      if (!showValueLabels || value <= 0) return;
      const barTopY = baselineY - barHeight;
      const el = svgEl("text", { x: x + barW / 2, y: Math.max(margin.top + 8, barTopY - 4), "text-anchor": "middle", class: "chart-axis-label" });
      el.textContent = value.toLocaleString();
      group.appendChild(el);
    }

    let tallestH = 0;
    BAR_SERIES.forEach((series, seriesIndex) => {
      const value = t[series.key];
      const h = (value / maxVal) * plotH;
      tallestH = Math.max(tallestH, h);
      const x = groupX + seriesIndex * (barW + barGap);
      if (value > 0) {
        const el = svgEl("path", { d: topRoundedRectPath(x, baselineY - h, barW, h, 3) });
        el.setAttribute("class", "chart-bar-seg");
        el.setAttribute("fill", series.color);
        group.appendChild(el);
      }
      valueLabel(x, h, value);
    });

    const hit = svgEl("rect", {
      x: margin.left + i * bandW,
      y: margin.top,
      width: bandW,
      height: plotH,
      class: "chart-bar-hit",
      tabindex: t.totalCalls > 0 ? "0" : "-1",
    });
    if (t.totalCalls > 0) {
      const move = (e) => showAccountsChartTooltip(e, t, i, bandW, tallestH);
      hit.addEventListener("pointerenter", move);
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerleave", hideAccountsChartTooltip);
      hit.addEventListener("focus", move);
      hit.addEventListener("blur", hideAccountsChartTooltip);
    }
    group.appendChild(hit);

    const label = svgEl("text", {
      x: margin.left + i * bandW + bandW / 2,
      y: height - 6,
      "text-anchor": "middle",
      class: "chart-axis-label",
    });
    label.textContent = truncateLabel(t.name, Math.max(4, Math.floor(bandW / 6)));
    group.appendChild(label);

    accountsChartSvg.appendChild(group);
  });
}

function showAccountsChartTooltip(e, t, i, bandW, tallestH) {
  const rect = accountsChartSvg.getBoundingClientRect();
  const scaleX = rect.width / CHART.width;
  const scaleY = rect.height / CHART.height;
  const { margin } = CHART;
  const cx = (margin.left + i * bandW + bandW / 2) * scaleX;
  const cy = (margin.top + (CHART.height - margin.top - margin.bottom - tallestH)) * scaleY;

  accountsChartTooltip.hidden = false;
  accountsChartTooltip.style.left = `${cx}px`;
  accountsChartTooltip.style.top = `${Math.max(0, cy - 8)}px`;
  accountsChartTooltip.textContent = "";
  const nameLine = document.createElement("div");
  nameLine.textContent = t.name;

  function tooltipRow(label, value) {
    const row = document.createElement("div");
    const valueSpan = document.createElement("span");
    valueSpan.className = "tooltip-value";
    valueSpan.textContent = String(value);
    row.append(`${label}: `, valueSpan);
    return row;
  }

  accountsChartTooltip.append(
    nameLine,
    tooltipRow("Total calls", t.totalCalls),
    tooltipRow("Completed calls", t.completedCalls),
    tooltipRow("Stored", t.recordingsStored),
    tooltipRow("No recording found", t.completedMissing)
  );
}

function hideAccountsChartTooltip() {
  accountsChartTooltip.hidden = true;
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

// --- Activity ---

async function loadOperatorActivity() {
  activityLoaded = true;
  const res = await fetch(`/api/operator/audit-log?page=${activityPage}&pageSize=50`);
  const data = await res.json();
  activityRows.innerHTML = "";

  if (data.entries.length === 0) {
    activityRows.innerHTML = `<tr><td colspan="3" class="empty-state">No operator activity yet.</td></tr>`;
  }
  for (const entry of data.entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="When">${new Date(entry.createdAt).toLocaleString()}</td>
      <td data-label="Operator">${escapeHtml(entry.actorUsername || "(unknown)")}</td>
      <td data-label="Action">${escapeHtml(entry.message)}</td>
    `;
    activityRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  activityPageIndicator.textContent = `Page ${data.page} of ${totalPages}`;
  activityPrevBtn.disabled = data.page <= 1;
  activityNextBtn.disabled = data.page >= totalPages;
}

activityPrevBtn.addEventListener("click", () => {
  if (activityPage > 1) {
    activityPage -= 1;
    loadOperatorActivity();
  }
});
activityNextBtn.addEventListener("click", () => {
  activityPage += 1;
  loadOperatorActivity();
});

// --- Tabs ---

const TAB_NAMES = ["accounts", "analytics", "activity"];

function activateTab(tab) {
  if (!TAB_NAMES.includes(tab)) tab = "accounts";
  for (const name of TAB_NAMES) {
    document.getElementById(`tab-${name}`).hidden = name !== tab;
    const link = document.querySelector(`#operator-tabs [data-tab="${name}"]`);
    if (link) link.classList.toggle("active", name === tab);
  }
  history.replaceState(null, "", `#${tab}`);

  if (tab === "activity" && !activityLoaded) loadOperatorActivity();
}

document.getElementById("operator-tabs").addEventListener("click", (e) => {
  const link = e.target.closest("[data-tab]");
  if (!link) return;
  e.preventDefault();
  activateTab(link.dataset.tab);
});

(async () => {
  const isOperator = await loadSession();
  if (isOperator) {
    await loadTenants();
    activateTab(location.hash.replace("#", ""));
  }
})();
