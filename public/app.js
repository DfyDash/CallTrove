const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
const callRows = document.getElementById("call-rows");
const sessionBar = document.getElementById("session-bar");
const adminNav = document.getElementById("admin-nav");
const viewAsSelect = document.getElementById("view-as");
const directionSelect = document.getElementById("direction-select");
const dispositionSelect = document.getElementById("disposition-select");
const statGrid = document.getElementById("stat-grid");
const contactContext = document.getElementById("contact-context");
const contactContextName = document.getElementById("contact-context-name");
const backToContactsBtn = document.getElementById("back-to-contacts-btn");
const dateFromInput = document.getElementById("date-from");
const dateToInput = document.getElementById("date-to");
const pageSizeSelect = document.getElementById("page-size-select");
const resultsSummary = document.getElementById("results-summary");
const pageIndicator = document.getElementById("page-indicator");
const prevPageBtn = document.getElementById("prev-page-btn");
const nextPageBtn = document.getElementById("next-page-btn");

let viewAs = "";
let transcriptionEnabled = false;
let csrfToken = "";

// Default view: this week, all contacts -- never an empty screen on load,
// never pulling too much data unasked either.
const state = {
  contactId: null,
  contactLabel: "All contacts",
  disposition: null,
  direction: null,
  hasRecording: null,
  dateFrom: "",
  dateTo: "",
  datePreset: "week",
  page: 1,
  pageSize: 20,
};

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetRange(preset) {
  const now = new Date();
  if (preset === "today") return { from: fmtDate(now), to: fmtDate(now) };
  if (preset === "week") {
    const from = new Date(now);
    from.setDate(now.getDate() - now.getDay());
    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    return { from: fmtDate(from), to: fmtDate(to) };
  }
  if (preset === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: fmtDate(from), to: fmtDate(to) };
  }
  if (preset === "year") {
    return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  }
  if (preset === "all") return { from: "", to: "" };
  return { from: "", to: "" };
}

function updatePresetButtonsUi() {
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === state.datePreset);
  });
}

function applyDateRange(from, to, preset = null) {
  state.dateFrom = from;
  state.dateTo = to;
  state.datePreset = preset;
  dateFromInput.value = from;
  dateToInput.value = to;
  state.page = 1;
  updatePresetButtonsUi();
  loadCalls();
}

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  transcriptionEnabled = !!me.transcriptionEnabled;
  csrfToken = me.csrfToken || "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})</span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;

  if (me.role === "admin") {
    adminNav.hidden = false;
    await loadViewAsOptions();
  }
}

async function loadViewAsOptions() {
  const res = await fetch("/api/admin/users");
  const users = await res.json();
  const agents = users.filter((u) => u.ghlUserId);

  viewAsSelect.innerHTML = `<option value="">All users</option>` +
    agents.map((u) => `<option value="${escapeHtml(u.ghlUserId)}">${escapeHtml(u.ghlUserName || u.username)}</option>`).join("");
  viewAsSelect.hidden = agents.length === 0;

  viewAsSelect.addEventListener("change", () => {
    viewAs = viewAsSelect.value;
    state.page = 1;
    loadCalls();
    loadDispositions();
  });
}

async function loadDispositions() {
  const params = new URLSearchParams();
  if (viewAs) params.set("viewAs", viewAs);
  const query = params.toString();
  const res = await fetch(`/api/dispositions${query ? `?${query}` : ""}`);
  const dispositions = await res.json();
  const current = dispositionSelect.value;
  dispositionSelect.innerHTML = `<option value="">All</option>` +
    dispositions.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(dispositionLabel(d))}</option>`).join("");
  dispositionSelect.value = state.disposition || current || "";
}

async function loadSearchResults(search) {
  if (!search) {
    searchResults.hidden = true;
    searchResults.innerHTML = "";
    return;
  }
  const params = new URLSearchParams({ search });
  if (viewAs) params.set("viewAs", viewAs);
  const res = await fetch(`/api/contacts?${params.toString()}`);
  const contacts = await res.json();
  renderSearchResults(contacts);
}

// GHL sometimes stores the contact's own phone number in the "name" field
// when no real name was ever entered -- showing both then just repeats the
// same number twice, so treat that case the same as no name at all.
function isNameJustThePhone(name, phone) {
  if (!name || !phone) return false;
  const nameDigits = name.replace(/\D/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  return !!nameDigits && nameDigits.slice(-10) === phoneDigits.slice(-10);
}

function renderSearchResults(contacts) {
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
    li.addEventListener("click", () => selectContact(contact));
    searchResults.appendChild(li);
  }
}

function selectContact(contact) {
  state.contactId = contact.id;
  state.contactLabel = contact.name || contact.phone || contact.id;
  state.page = 1;
  updateContactContextUi();
  loadCalls();
  searchInput.value = "";
  searchResults.hidden = true;
  searchResults.innerHTML = "";
}

function clearContactFilter() {
  state.contactId = null;
  state.contactLabel = "All contacts";
  state.disposition = null;
  state.direction = null;
  state.hasRecording = null;
  state.page = 1;
  dispositionSelect.value = "";
  directionSelect.value = "";
  updateContactContextUi();
  loadCalls();
}

// Direction/Outcome already show their own state via their dropdowns, so
// this bar only needs to appear for the two filters with no visible
// control of their own: a specific contact (from search or the Contacts
// page), or a recording-status deep link from the Coverage report.
function updateContactContextUi() {
  if (state.contactId) {
    backToContactsBtn.textContent = "← Back to all contacts";
    contactContextName.textContent = `Viewing: ${state.contactLabel}`;
    contactContext.hidden = false;
  } else if (state.hasRecording !== null) {
    backToContactsBtn.textContent = "← Clear filter";
    contactContextName.textContent = state.hasRecording
      ? "Showing calls with a recording"
      : "Showing calls with no recording found";
    contactContext.hidden = false;
  } else {
    contactContext.hidden = true;
  }
}

function transcriptCell(call) {
  const canTranscribe = transcriptionEnabled && call.hasRecording;
  switch (call.transcriptionStatus) {
    case "completed":
      return `<details class="transcript-details" data-call="${call.id}">
                <summary>View transcript</summary>
                <p class="transcript-text">Loading…</p>
              </details>`;
    case "pending":
      return `<span class="transcript-pending">Transcribing…</span>`;
    case "failed":
      return `<span class="transcript-failed">Transcription failed</span>` +
        (canTranscribe ? ` <button class="transcribe-btn" data-call="${call.id}">Retry</button>` : "");
    default:
      return canTranscribe
        ? `<button class="transcribe-btn" data-call="${call.id}">Transcribe</button>`
        : `<span>-</span>`;
  }
}

function callParams() {
  const params = new URLSearchParams();
  if (state.contactId) params.set("contactId", state.contactId);
  if (state.disposition) params.set("disposition", state.disposition);
  if (state.direction) params.set("direction", state.direction);
  if (state.hasRecording !== null) params.set("hasRecording", state.hasRecording);
  if (state.dateFrom) params.set("dateFrom", state.dateFrom);
  if (state.dateTo) params.set("dateTo", state.dateTo);
  if (viewAs) params.set("viewAs", viewAs);
  return params;
}

function statTile(label, value) {
  return `<div class="stat-tile"><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;
}

async function loadStats() {
  const res = await fetch(`/api/calls/stats?${callParams().toString()}`);
  const stats = await res.json();
  statGrid.innerHTML =
    statTile("Total calls", stats.total) +
    statTile("Inbound / Outbound", `${stats.inbound} / ${stats.outbound}`) +
    statTile("Missed calls", stats.missed);
}

async function loadCalls() {
  const params = callParams();
  params.set("page", state.page);
  params.set("pageSize", state.pageSize);

  const res = await fetch(`/api/calls?${params.toString()}`);
  const data = await res.json();
  renderCalls(data);
  loadStats();

  // Arriving here via a deep link (e.g. from the coverage report) sets
  // contactId before the contact's actual name/phone is known -- fill it
  // in from the first matching call once results come back.
  if (state.contactId && state.contactLabel === "…" && data.calls.length > 0) {
    const call = data.calls[0];
    state.contactLabel = call.contactName || call.contactPhone || state.contactId;
    updateContactContextUi();
  }
}

// GHL's own call disposition, formatted for display ("no-answer" -> "No
// answer"). This is what actually explains why most "no recording" calls
// have nothing to play -- the call was never answered, not that fetching
// the recording failed.
function dispositionLabel(disposition) {
  if (!disposition) return null;
  return disposition.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Per-disposition color as a fixed CSS class rather than an inline style:
// the app's CSP has no 'unsafe-inline' for style-src, so a dynamically
// computed style="" attribute is silently dropped by the browser.
const OUTCOME_CLASSES = {
  completed: "outcome-completed",
  "no-answer": "outcome-no-answer",
  voicemail: "outcome-voicemail",
  busy: "outcome-busy",
  canceled: "outcome-canceled",
};

function outcomeBadge(disposition) {
  const label = dispositionLabel(disposition);
  if (!label) return "-";
  const cls = OUTCOME_CLASSES[disposition] || "outcome-default";
  return `<span class="outcome-badge ${cls}">${escapeHtml(label)}</span>`;
}

function formatDuration(seconds) {
  if (!seconds) return "-";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderCalls(data) {
  const { calls, total, page, pageSize } = data;
  callRows.innerHTML = "";

  if (calls.length === 0) {
    callRows.innerHTML = `<tr><td colspan="8" class="empty-state">No calls match this filter.</td></tr>`;
  }

  for (const call of calls) {
    const tr = document.createElement("tr");
    const when = call.occurredAt ? new Date(call.occurredAt).toLocaleString() : "-";
    const duration = formatDuration(call.durationSeconds);
    const contactDisplayName = isNameJustThePhone(call.contactName, call.contactPhone) ? "(no name)" : call.contactName || "(no name)";
    const contactCell = `${escapeHtml(contactDisplayName)}<span class="contact-phone">${escapeHtml(call.contactPhone || "")}</span>`;
    const disposition = dispositionLabel(call.disposition);
    // A call GHL disposed as anything other than "Completed" (no answer,
    // busy, canceled, voicemail...) was never going to have a recording --
    // that's the call's own outcome, not something CallTrove failed to
    // fetch. Only an unexplained gap on a completed call is worth a
    // less certain-sounding label.
    const noRecordingReason =
      disposition && call.disposition !== "completed" ? disposition : "No recording found";
    const recordingCell = call.hasRecording
      ? `<div class="recording-cell">
           <button type="button" class="play-btn" aria-label="Play recording" data-static-duration="${formatDuration(call.durationSeconds)}">
             <svg class="play-icon" width="10" height="10" viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>
             <svg class="pause-icon" width="10" height="10" viewBox="0 0 24 24" hidden><rect x="5" y="4" width="5" height="16"></rect><rect x="14" y="4" width="5" height="16"></rect></svg>
             <span class="play-time">${formatDuration(call.durationSeconds)}</span>
           </button>
           <audio class="recording-audio" preload="none" src="/api/calls/${call.id}/recording"></audio>
           <a class="download-link" href="/api/calls/${call.id}/recording?download" download>Download</a>
         </div>`
      : `<span>${escapeHtml(noRecordingReason)}</span>`;

    tr.innerHTML = `
      <td>${contactCell}</td>
      <td>${when}</td>
      <td>${escapeHtml(call.direction || "-")}</td>
      <td>${duration}</td>
      <td>${escapeHtml(call.handledByName || "-")}</td>
      <td>${outcomeBadge(call.disposition)}</td>
      <td>${recordingCell}</td>
      <td>${transcriptCell(call)}</td>
    `;
    callRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  resultsSummary.textContent = total === 0 ? "0 calls" : `${total} call${total === 1 ? "" : "s"} found`;
  pageIndicator.textContent = `Page ${page} of ${totalPages}`;
  prevPageBtn.disabled = page <= 1;
  nextPageBtn.disabled = page >= totalPages;
}

// Transcript text is fetched lazily, only when a row's <details> is opened
// -- capture phase because "toggle" doesn't bubble in every browser.
callRows.addEventListener(
  "toggle",
  async (e) => {
    const details = e.target.closest(".transcript-details");
    if (!details || !details.open || details.dataset.loaded) return;
    details.dataset.loaded = "1";
    const textEl = details.querySelector(".transcript-text");
    const res = await fetch(`/api/calls/${details.dataset.call}/transcript`);
    const data = await res.json();
    textEl.textContent = data.transcript || "(empty transcript)";
  },
  true
);

// On-demand transcription: nothing starts until someone clicks this.
callRows.addEventListener("click", async (e) => {
  const btn = e.target.closest(".transcribe-btn");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Starting…";
  const res = await fetch(`/api/calls/${btn.dataset.call}/transcribe`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (res.ok) {
    btn.closest("td").innerHTML = `<span class="transcript-pending">Transcribing…</span>`;
  } else {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "Failed to start transcription");
    btn.disabled = false;
    btn.textContent = "Transcribe";
  }
});

// Minimal play/pause pill instead of the full native <audio controls>
// widget, matching the artifact's compact design. Only one recording
// plays at a time.
function mmss(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updatePlayBtn(audio) {
  const btn = audio.closest(".recording-cell").querySelector(".play-btn");
  const playing = !audio.paused && !audio.ended;
  btn.querySelector(".play-icon").hidden = playing;
  btn.querySelector(".pause-icon").hidden = !playing;
  btn.querySelector(".play-time").textContent = playing
    ? `${mmss(audio.currentTime)} / ${mmss(audio.duration)}`
    : btn.dataset.staticDuration;
}

callRows.addEventListener("click", (e) => {
  const btn = e.target.closest(".play-btn");
  if (!btn) return;
  const audio = btn.closest(".recording-cell").querySelector(".recording-audio");
  if (audio.paused) {
    callRows.querySelectorAll(".recording-audio").forEach((a) => {
      if (a !== audio && !a.paused) a.pause();
    });
    audio.play();
  } else {
    audio.pause();
  }
});

// Media events don't bubble, so these need the capture phase -- same
// reasoning as the "toggle" listener above for transcript details.
for (const evt of ["play", "pause", "timeupdate", "ended"]) {
  callRows.addEventListener(
    evt,
    (e) => {
      if (!e.target.classList || !e.target.classList.contains("recording-audio")) return;
      if (evt === "ended") e.target.currentTime = 0;
      updatePlayBtn(e.target);
    },
    true
  );
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSearchResults(searchInput.value.trim()), 200);
});

searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim() && searchResults.innerHTML) searchResults.hidden = false;
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) searchResults.hidden = true;
});

backToContactsBtn.addEventListener("click", clearContactFilter);

document.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const { from, to } = presetRange(btn.dataset.preset);
    applyDateRange(from, to, btn.dataset.preset);
  });
});

dateFromInput.addEventListener("change", () => applyDateRange(dateFromInput.value, state.dateTo, null));
dateToInput.addEventListener("change", () => applyDateRange(state.dateFrom, dateToInput.value, null));

directionSelect.addEventListener("change", () => {
  state.direction = directionSelect.value || null;
  state.page = 1;
  updateContactContextUi();
  loadCalls();
});

dispositionSelect.addEventListener("change", () => {
  state.disposition = dispositionSelect.value || null;
  state.page = 1;
  updateContactContextUi();
  loadCalls();
});

pageSizeSelect.addEventListener("change", () => {
  state.pageSize = Number(pageSizeSelect.value);
  state.page = 1;
  loadCalls();
});

prevPageBtn.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    loadCalls();
  }
});

nextPageBtn.addEventListener("click", () => {
  state.page += 1;
  loadCalls();
});

// Initial view: this week, all contacts -- unless a deep link (from the
// coverage report, e.g.) asks for a specific contact or outcome, in which
// case default to "all time" instead, since the call in question could be
// from well outside the current week.
const deepLinkParams = new URLSearchParams(location.search);
const deepLinkContactId = deepLinkParams.get("contactId");
const deepLinkDisposition = deepLinkParams.get("disposition");
const deepLinkHasRecording = deepLinkParams.get("hasRecording");
const deepLinkAllTime = deepLinkParams.get("all") !== null;

if (deepLinkContactId || deepLinkDisposition || deepLinkHasRecording !== null || deepLinkAllTime) {
  if (deepLinkContactId) {
    state.contactId = deepLinkContactId;
    state.contactLabel = "…";
  }
  if (deepLinkDisposition) state.disposition = deepLinkDisposition;
  if (deepLinkHasRecording !== null) state.hasRecording = deepLinkHasRecording === "true";
  state.dateFrom = "";
  state.dateTo = "";
  state.datePreset = "all";
  history.replaceState(null, "", location.pathname);
} else {
  const initialRange = presetRange("week");
  state.dateFrom = initialRange.from;
  state.dateTo = initialRange.to;
}
dateFromInput.value = state.dateFrom;
dateToInput.value = state.dateTo;
updatePresetButtonsUi();
updateContactContextUi();

loadSession();
loadDispositions().then(() => {
  dispositionSelect.value = state.disposition || "";
});
loadCalls();
