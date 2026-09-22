const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
const sessionBar = document.getElementById("session-bar");
const adminNav = document.getElementById("admin-nav");
const viewAsSelect = document.getElementById("view-as");
const azStrip = document.getElementById("az-strip");
const contactGroups = document.getElementById("contact-groups");

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

// GHL sometimes stores the contact's own phone number in the "name" field
// when no real name was ever entered -- treat that the same as no name.
function isNameJustThePhone(name, phone) {
  if (!name || !phone) return false;
  const nameDigits = name.replace(/\D/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  return !!nameDigits && nameDigits.slice(-10) === phoneDigits.slice(-10);
}

function initials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  const csrfToken = me.csrfToken || "";
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
    loadContacts();
  });
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
    li.addEventListener("click", () => {
      location.href = `/?contactId=${encodeURIComponent(contact.id)}`;
    });
    searchResults.appendChild(li);
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function formatLastCall(iso) {
  if (!iso) return "No calls yet";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadContacts() {
  const params = new URLSearchParams({ all: "1" });
  if (viewAs) params.set("viewAs", viewAs);
  const res = await fetch(`/api/contacts?${params.toString()}`);
  const contacts = await res.json();

  const grouped = {};
  for (const c of contacts) {
    const displayName = isNameJustThePhone(c.name, c.phone) ? null : c.name;
    const letter = displayName ? displayName[0].toUpperCase() : "#";
    const key = ALPHABET.includes(letter) ? letter : "#";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ ...c, displayName: displayName || "(no name)" });
  }

  const activeLetters = Object.keys(grouped).sort((a, b) => (a === "#" ? -1 : b === "#" ? 1 : a.localeCompare(b)));

  azStrip.innerHTML = (grouped["#"] ? ["#", ...ALPHABET] : ALPHABET)
    .map((letter) => {
      const active = grouped[letter] && grouped[letter].length > 0;
      return `<a href="#group-${encodeURIComponent(letter)}" class="az-letter${active ? " has-contacts" : ""}">${escapeHtml(letter)}</a>`;
    })
    .join("");

  contactGroups.innerHTML = "";
  if (activeLetters.length === 0) {
    contactGroups.innerHTML = `<p class="empty-state empty-state-pad">No contacts yet.</p>`;
    return;
  }

  for (const letter of activeLetters) {
    const header = document.createElement("div");
    header.className = "contact-group-header";
    header.id = `group-${letter}`;
    header.textContent = letter;
    contactGroups.appendChild(header);

    for (const c of grouped[letter]) {
      const row = document.createElement("a");
      row.className = "contact-row";
      row.href = `/?contactId=${encodeURIComponent(c.id)}`;
      row.innerHTML = `
        <div class="contact-row-name">
          <span class="contact-avatar">${escapeHtml(initials(c.displayName))}</span>
          <span>${escapeHtml(c.displayName)}</span>
        </div>
        <div class="contact-row-meta">
          <span>${escapeHtml(c.phone || "")}</span>
          <span>${escapeHtml(formatLastCall(c.lastCallAt))}</span>
        </div>
      `;
      contactGroups.appendChild(row);
    }
  }
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

loadSession();
loadContacts();
