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
const purgeOverdueBanner = document.getElementById("purge-overdue-banner");

// How many days past becoming purge-eligible an account can sit still
// un-purged before it's flagged as needing attention, rather than just
// quietly waiting for someone to notice -- see tenantPurge.js's
// all-or-nothing purge: a repeatedly-failing purge otherwise leaves an
// account stuck in cancellation_pending with nothing surfacing that on
// its own.
const PURGE_OVERDUE_DAYS = 2;

const activityRows = document.getElementById("operator-activity-rows");
const activityPrevBtn = document.getElementById("operator-activity-prev-btn");
const activityNextBtn = document.getElementById("operator-activity-next-btn");
const activityPageIndicator = document.getElementById("operator-activity-page-indicator");
let activityPage = 1;
let activityLoaded = false;

const analyticsSummary = document.getElementById("operator-analytics-summary");
const costSummary = document.getElementById("operator-cost-summary");
const accountSearchInput = document.getElementById("operator-account-search");
const accountSearchResults = document.getElementById("operator-search-results");
const accountSearchScope = document.getElementById("operator-search-scope");
let cachedTenants = [];
let searchQuery = "";
let searchScope = "name"; // "name" | "owner" -- which field the typed search matches against

// A canceled tenant is dead weight on a live financial view -- no owner,
// no connected GHL account, nothing left to analyze, just a row of
// zeroes (exactly what prompted this). Analytics and Cost & revenue
// exclude them by default; Accounts still shows every status, since
// that's the tab you'd actually use to find/restore/delete one.
function activeOnly(list) {
  return list.filter((t) => t.status !== "canceled");
}

function matchesSearch(t, q) {
  const field = searchScope === "owner" ? t.ownerUsername : t.name;
  return (field || "").toLowerCase().includes(q);
}

// Shared sort+search core for every tab that lists accounts. The list is
// ALWAYS grouped/sorted by account name, regardless of searchScope --
// deliberately kept simple: switching the search filter to "Owner" only
// changes what your typed text matches against, it never reorganizes the
// page itself, so there's one consistent layout to learn rather than the
// list visibly rearranging every time the filter changes. Each tab passes
// its own base list (the full set for Accounts, activeOnly() for
// Analytics/Cost & revenue) so the same search term narrows each tab's
// own population rather than a single shared list.
function filterAndSort(baseList) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = q ? baseList.filter((t) => matchesSearch(t, q)) : baseList;
  return [...filtered].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// A-Z grouping -- same pattern as the Contacts page's own directory
// (public/contacts.js's loadContacts): instead of one long list (or a
// page of 20 with no sense of where in the alphabet you are), accounts
// are grouped under a letter header, with a jump strip of every letter
// above the table -- a grey letter has no accounts under it right now,
// an accent-colored one does and jumps straight to that group.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function groupByLetter(tenants) {
  const grouped = {};
  for (const t of tenants) {
    const name = t.name || "";
    const letter = name ? name[0].toUpperCase() : "#";
    const key = ALPHABET.includes(letter) ? letter : "#";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  }
  return grouped;
}

// groupIdPrefix keeps each tab's jump targets/header ids distinct
// (accounts-A, analytics-A, cost-A, ...) since Analytics/Cost & revenue
// can have a different active-letter set than Accounts (activeOnly()
// excludes canceled tenants) even though all three show the same search.
function renderAzStrip(stripEl, grouped, groupIdPrefix) {
  const letters = grouped["#"] ? ["#", ...ALPHABET] : ALPHABET;
  stripEl.innerHTML = letters
    .map((letter) => {
      const active = grouped[letter] && grouped[letter].length > 0;
      return `<a href="#${groupIdPrefix}-${encodeURIComponent(letter)}" class="az-letter${active ? " has-contacts" : ""}">${escapeHtml(letter)}</a>`;
    })
    .join("");
}

// Renders <tr> group-header rows interleaved with each letter's own
// tenant rows into tbody, via rowTemplate(tenant) -> inner <tr> html.
// colspan matches the table's real column count so the header row still
// looks right as a single banner across every column.
function renderGroupedRows(tbody, stripEl, tenants, groupIdPrefix, colspan, rowTemplate) {
  const grouped = groupByLetter(tenants);
  renderAzStrip(stripEl, grouped, groupIdPrefix);
  const activeLetters = Object.keys(grouped).sort((a, b) => (a === "#" ? -1 : b === "#" ? 1 : a.localeCompare(b)));

  tbody.innerHTML = "";
  for (const letter of activeLetters) {
    const header = document.createElement("tr");
    header.innerHTML = `<td colspan="${colspan}" class="contact-group-header" id="${groupIdPrefix}-${escapeHtml(letter)}">${escapeHtml(letter)}</td>`;
    tbody.appendChild(header);
    for (const t of grouped[letter]) {
      const row = document.createElement("tr");
      row.dataset.tenantId = t.id;
      row.innerHTML = rowTemplate(t);
      tbody.appendChild(row);
    }
  }
}

// --- Search scope (Account name / Owner) -- picks which field the typed
// search matches, see matchesSearch() and filterAndSort()'s own comment
// for why this never changes how the list is grouped/sorted, only what
// counts as a match. ---
const SCOPE_PLACEHOLDERS = { name: "Search by account name...", owner: "Search by owner..." };
accountSearchScope.addEventListener("change", () => {
  searchScope = accountSearchScope.value;
  accountSearchInput.placeholder = SCOPE_PLACEHOLDERS[searchScope];
  // Re-run whatever's currently typed against the new field, rather than
  // requiring it to be retyped.
  const value = accountSearchInput.value.trim();
  if (value) renderSearchDropdown(value);
  renderAll();
});

// --- Search dropdown (same interaction as Contacts' sidebar search:
// type, see a live dropdown of matches, click one to commit it as the
// filter) -- client-side only, no fetch needed, the full account list is
// already in cachedTenants. Searches every account regardless of status
// (so a canceled one is still findable from here, e.g. to go manage it
// on Accounts), even though Analytics/Cost & revenue won't show it if
// it's canceled -- see activeOnly() above.
let searchDebounce;
accountSearchInput.addEventListener("input", () => {
  const value = accountSearchInput.value.trim();
  clearTimeout(searchDebounce);
  if (!value) {
    accountSearchResults.hidden = true;
    accountSearchResults.innerHTML = "";
    searchQuery = "";
    renderAll();
    return;
  }
  searchDebounce = setTimeout(() => renderSearchDropdown(value), 200);
});

accountSearchInput.addEventListener("focus", () => {
  if (accountSearchInput.value.trim() && accountSearchResults.innerHTML) accountSearchResults.hidden = false;
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) accountSearchResults.hidden = true;
});

function renderSearchDropdown(query) {
  const q = query.toLowerCase();
  const matches = cachedTenants.filter((t) => matchesSearch(t, q)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  accountSearchResults.innerHTML = "";
  accountSearchResults.hidden = false;
  if (matches.length === 0) {
    accountSearchResults.innerHTML = `<li class="search-empty">No matching accounts.</li>`;
    return;
  }
  for (const t of matches) {
    const li = document.createElement("li");
    li.className = "search-result-item";
    li.innerHTML = `${escapeHtml(t.name)}<span class="contact-phone">${escapeHtml(t.ownerUsername || "No owner")}</span>`;
    li.addEventListener("click", () => {
      // Commit whichever field was actually searched -- if scope is
      // "owner", the box should hold the owner's name (what matchesSearch
      // checks against), not the account's own name.
      const committed = searchScope === "owner" ? t.ownerUsername || "" : t.name || "";
      accountSearchInput.value = committed;
      searchQuery = committed;
      accountSearchResults.hidden = true;
      renderAll();
    });
    accountSearchResults.appendChild(li);
  }
}

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
    operatorRows.innerHTML = `<tr><td colspan="5">Operator access required.</td></tr>`;
    return false;
  }
  return true;
}

function formatMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

// Disabled for a canceled tenant -- nothing left to provision storage
// for, and switching it would have no effect anyway.
function storageTierSelect(t) {
  const tier = t.storageTier || "standard";
  const disabled = t.status === "canceled" ? "disabled" : "";
  const option = (value, label) => `<option value="${value}" ${tier === value ? "selected" : ""}>${label}</option>`;
  return `<select class="storage-tier-select" data-id="${escapeHtml(t.id)}" ${disabled}>
      ${option("standard", "Standard")}
      ${option("hipaa", "HIPAA")}
    </select>`;
}

// Whole days since a tenant became eligible for purge and still wasn't
// (0 if not eligible yet, not pending, or just became eligible today).
function daysPastEligible(t) {
  if (t.status !== "cancellation_pending" || !t.purgeAt) return 0;
  const ms = Date.now() - new Date(t.purgeAt).getTime();
  return ms > 0 ? Math.floor(ms / (24 * 60 * 60 * 1000)) : 0;
}

function isPurgeOverdue(t) {
  return daysPastEligible(t) >= PURGE_OVERDUE_DAYS;
}

function actionsForTenant(t) {
  if (t.status === "active") {
    return `<button type="button" class="cancel-tenant-btn" data-id="${escapeHtml(t.id)}">Cancel</button>`;
  }
  if (t.status === "cancellation_pending") {
    const purgeAt = new Date(t.purgeAt);
    const eligible = purgeAt <= new Date();
    const overdueDays = daysPastEligible(t);
    return `<button type="button" class="restore-tenant-btn" data-id="${escapeHtml(t.id)}">Restore</button>
      <button type="button" class="purge-tenant-btn delete-btn" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" ${eligible ? "" : "disabled"}>
        ${eligible ? "Delete" : `Eligible ${purgeAt.toLocaleDateString()}`}
      </button>
      ${
        isPurgeOverdue(t)
          ? `<span class="purge-overdue-row-badge" title="Eligible for purge ${overdueDays} day(s) ago but still not purged -- check the Activity log for why it's failing">${overdueDays}d overdue</span>`
          : ""
      }`;
  }
  return `<span class="settings-note">-</span>`; // canceled -- nothing left to do
}

async function loadTenants() {
  const res = await fetch("/api/operator/tenants");
  if (!res.ok) {
    operatorRows.innerHTML = `<tr><td colspan="5">Could not load accounts.</td></tr>`;
    analyticsSummary.innerHTML = `<p class="empty-state empty-state-pad">Could not load analytics.</p>`;
    costSummary.innerHTML = `<p class="empty-state empty-state-pad">Could not load cost &amp; revenue.</p>`;
    return;
  }
  cachedTenants = await res.json();
  renderAll();
}

function renderAll() {
  renderAccounts();
  renderAnalytics();
  renderCostAndRevenue();
}

const accountsAzStrip = document.getElementById("accounts-az-strip");

// Always computed off the full, unfiltered list -- an overdue purge must
// stay visible regardless of whatever search is currently typed in, or
// it could sit hidden behind a filter indefinitely, same problem this
// banner exists to prevent in the first place.
function renderPurgeOverdueBanner() {
  const overdue = cachedTenants.filter(isPurgeOverdue);
  purgeOverdueBanner.hidden = overdue.length === 0;
  purgeOverdueBanner.textContent =
    overdue.length === 0
      ? ""
      : `⚠ ${overdue.length} account${overdue.length === 1 ? "" : "s"} overdue for purge -- eligible but still not deleted: ${overdue
          .map((t) => `"${t.name}" (${daysPastEligible(t)}d)`)
          .join(", ")}`;
}

function renderAccounts() {
  renderPurgeOverdueBanner();
  const tenants = filterAndSort(cachedTenants);
  if (tenants.length === 0) {
    accountsAzStrip.innerHTML = "";
    operatorRows.innerHTML = `<tr><td colspan="5">${cachedTenants.length === 0 ? "No accounts yet." : "No accounts match your search."}</td></tr>`;
    return;
  }
  renderGroupedRows(
    operatorRows,
    accountsAzStrip,
    tenants,
    "accounts",
    5,
    (t) => `
      <td data-label="Account"><a href="#account/${encodeURIComponent(t.id)}" class="account-detail-link">${escapeHtml(t.name)}</a></td>
      <td data-label="Status">${escapeHtml(t.status)}</td>
      <td data-label="Owner">${escapeHtml(t.ownerUsername || "-")}</td>
      <td data-label="Storage tier">${storageTierSelect(t)}</td>
      <td data-label="Actions">${actionsForTenant(t)}</td>
    `
  );
}

// Combined totals only, across every active account matching the current
// search -- no per-account table here any more (see this tab's own note
// in operator.html). For one account's own numbers, click into it from
// Accounts -- see showAccountDetail()/renderAccountDetail() below, which
// render the identical stat-tile shape for a single tenant.
function renderAnalytics() {
  // activeOnly: a canceled tenant has nothing left to analyze -- see
  // activeOnly()'s own comment.
  const tenants = filterAndSort(activeOnly(cachedTenants));
  if (tenants.length === 0) {
    analyticsSummary.innerHTML = `<p class="empty-state empty-state-pad">${activeOnly(cachedTenants).length === 0 ? "No active accounts yet." : "No accounts match your search."}</p>`;
    return;
  }

  const totals = tenants.reduce(
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
    <div class="stat-tile"><div class="stat-value">${tenants.length}</div><div class="stat-label">Accounts</div></div>
    <div class="stat-tile"><div class="stat-value">${totals.totalCalls}</div><div class="stat-label">Total calls</div></div>
    <div class="stat-tile"><div class="stat-value">${totals.completedCalls}</div><div class="stat-label">Completed calls</div></div>
    <div class="stat-tile"><div class="stat-value">${totals.recordingsStored}</div><div class="stat-label">Recordings stored</div></div>
    <div class="stat-tile"><div class="stat-value">${Math.round(totals.transcribedMinutes * 10) / 10}</div><div class="stat-label">Transcribed minutes</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(totals.estimatedTranscribeCost)}</div><div class="stat-label">Est. transcribe cost</div></div>
  `;
}

// Own tab (Cost & revenue, separate from Analytics -- see operator.html),
// still driven by the same filterAndSort() search as every other
// account-listing tab, but combined totals only -- same reasoning as
// renderAnalytics() above. Real cost_ledger sums (routes/operator.js's
// /tenants -- see that route's own comment), not the live
// transcribedMinutes-based estimate Analytics shows -- every number here
// is a permanent receipt at the rate in effect when it happened.
function renderCostAndRevenue() {
  // activeOnly: see its own comment -- a canceled tenant is the exact
  // kind of zeroed-out row this was built to stop cluttering this tab.
  const tenants = filterAndSort(activeOnly(cachedTenants));
  if (tenants.length === 0) {
    costSummary.innerHTML = `<p class="empty-state empty-state-pad">${activeOnly(cachedTenants).length === 0 ? "No active accounts yet." : "No accounts match your search."}</p>`;
    return;
  }

  const totals = tenants.reduce(
    (acc, t) => ({
      transcriptionAwsCost: acc.transcriptionAwsCost + t.transcriptionAwsCost,
      transcriptionRevenue: acc.transcriptionRevenue + t.transcriptionRevenue,
      aiSummaryAwsCost: acc.aiSummaryAwsCost + t.aiSummaryAwsCost,
      aiSummaryRevenue: acc.aiSummaryRevenue + t.aiSummaryRevenue,
      storageAwsCost: acc.storageAwsCost + t.storageAwsCost,
      storageRevenue: acc.storageRevenue + t.storageRevenue,
      transcriptCleanupAwsCost: acc.transcriptCleanupAwsCost + t.transcriptCleanupAwsCost,
      transcriptCleanupRevenue: acc.transcriptCleanupRevenue + t.transcriptCleanupRevenue,
      totalAwsCost: acc.totalAwsCost + t.totalAwsCost,
      totalRevenue: acc.totalRevenue + t.totalRevenue,
      margin: acc.margin + t.margin,
    }),
    {
      transcriptionAwsCost: 0, transcriptionRevenue: 0, aiSummaryAwsCost: 0, aiSummaryRevenue: 0,
      storageAwsCost: 0, storageRevenue: 0, transcriptCleanupAwsCost: 0, transcriptCleanupRevenue: 0,
      totalAwsCost: 0, totalRevenue: 0, margin: 0,
    }
  );

  costSummary.innerHTML = `
    <div class="stat-tile"><div class="stat-value">${formatMoney(totals.totalRevenue)}</div><div class="stat-label">Total revenue</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(totals.totalAwsCost)}</div><div class="stat-label">Total AWS cost</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(totals.margin)}</div><div class="stat-label">Margin</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(totals.storageAwsCost)}</div><div class="stat-label">Storage cost</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(totals.storageRevenue)}</div><div class="stat-label">Storage overage revenue</div></div>
  `;
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

operatorRows.addEventListener("change", async (e) => {
  const select = e.target.closest(".storage-tier-select");
  if (!select) return;

  const tenant = cachedTenants.find((t) => t.id === select.dataset.id);
  const previousTier = tenant ? tenant.storageTier || "standard" : "standard";
  const tier = select.value;
  select.disabled = true;
  const res = await fetch(`/api/operator/tenants/${select.dataset.id}/storage-tier`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ tier }),
  });
  select.disabled = false;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "Could not change storage tier");
    select.value = previousTier;
    return;
  }
  loadTenants();
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

const TAB_NAMES = ["accounts", "analytics", "cost", "activity"];
const accountDetailSection = document.getElementById("tab-account-detail");

function activateTab(tab) {
  if (!TAB_NAMES.includes(tab)) tab = "accounts";
  accountDetailSection.hidden = true;
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

// --- Account detail (click an account's name on the Accounts tab) ---
// Reached via a real <a href="#account/<id>">, not intercepted the way
// ordinary [data-tab] links are -- native navigation sets location.hash
// itself (pushing a real history entry, so the browser's own Back button
// works), and the hashchange listener below reacts to it. Uses the same
// cachedTenants data every other tab already has in memory, so no extra
// fetch.
function renderAccountDetail(t) {
  document.getElementById("account-detail-name").textContent = t.name;
  document.getElementById("account-detail-meta").textContent =
    `Owner: ${t.ownerUsername || "(none)"} -- Status: ${t.status}`;

  document.getElementById("account-detail-analytics-summary").innerHTML = `
    <div class="stat-tile"><div class="stat-value">${t.ghlAccountCount}</div><div class="stat-label">GHL accounts</div></div>
    <div class="stat-tile"><div class="stat-value">${t.totalCalls}</div><div class="stat-label">Total calls</div></div>
    <div class="stat-tile"><div class="stat-value">${t.completedCalls}</div><div class="stat-label">Completed calls</div></div>
    <div class="stat-tile"><div class="stat-value">${t.recordingsStored}</div><div class="stat-label">Recordings stored</div></div>
    <div class="stat-tile"><div class="stat-value">${t.transcribedMinutes}</div><div class="stat-label">Transcribed minutes</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.estimatedTranscribeCost)}</div><div class="stat-label">Est. transcribe cost</div></div>
  `;

  document.getElementById("account-detail-cost-summary").innerHTML = `
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.transcriptionAwsCost)}</div><div class="stat-label">Transcription cost</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.transcriptionRevenue)}</div><div class="stat-label">Transcription revenue</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.aiSummaryAwsCost)}</div><div class="stat-label">AI summary cost</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.aiSummaryRevenue)}</div><div class="stat-label">AI summary revenue</div></div>
    <div class="stat-tile"><div class="stat-value">${t.storedGB} GB</div><div class="stat-label">Storage used</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.storageAwsCost)}</div><div class="stat-label">Storage cost</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.storageRevenue)}</div><div class="stat-label">Storage overage revenue</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.transcriptCleanupAwsCost)}</div><div class="stat-label">Transcript cleanup cost</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.transcriptCleanupRevenue)}</div><div class="stat-label">Transcript cleanup revenue</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.totalAwsCost)}</div><div class="stat-label">Total cost</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.totalRevenue)}</div><div class="stat-label">Total revenue</div></div>
    <div class="stat-tile"><div class="stat-value">${formatMoney(t.margin)}</div><div class="stat-label">Margin</div></div>
  `;
}

function showAccountDetail(tenantId) {
  const t = cachedTenants.find((x) => x.id === tenantId);
  if (!t) {
    activateTab("accounts"); // stale/bad id (e.g. a bookmarked link to a since-purged account) -- fall back rather than show a blank page
    return;
  }
  for (const name of TAB_NAMES) {
    document.getElementById(`tab-${name}`).hidden = true;
    const link = document.querySelector(`#operator-tabs [data-tab="${name}"]`);
    if (link) link.classList.toggle("active", name === "accounts"); // still "within" Accounts, conceptually
  }
  accountDetailSection.hidden = false;
  renderAccountDetail(t);
}

document.getElementById("account-detail-back-btn").addEventListener("click", () => activateTab("accounts"));

function routeToHash(hash) {
  if (hash.startsWith("account/")) {
    showAccountDetail(decodeURIComponent(hash.slice("account/".length)));
  } else {
    activateTab(hash);
  }
}

window.addEventListener("hashchange", () => routeToHash(location.hash.replace("#", "")));

(async () => {
  const isOperator = await loadSession();
  if (isOperator) {
    await loadTenants();
    routeToHash(location.hash.replace("#", ""));
  }
})();
