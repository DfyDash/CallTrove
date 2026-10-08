const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
const sessionBar = document.getElementById("session-bar");
const adminNav = document.getElementById("admin-nav");
const operatorNavLink = document.getElementById("operator-nav-link");
const viewAsSelect = document.getElementById("view-as");
const azStrip = document.getElementById("az-strip");
const contactGroups = document.getElementById("contact-groups");
const accountSwitcherWrap = document.getElementById("account-switcher-wrap");
const accountSwitcher = document.getElementById("account-switcher");
const mobileNavToggle = document.getElementById("mobile-nav-toggle");
const sidebarEl = document.querySelector(".sidebar");
mobileNavToggle.addEventListener("click", () => sidebarEl.classList.toggle("nav-open"));

let viewAs = "";
let csrfToken = "";
// See app.js for why this is a plain page-navigation, not a live re-fetch.
let currentAccountId = new URLSearchParams(location.search).get("accountId") || "";

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
  const res = await fetch(`/api/me${currentAccountId ? `?accountId=${encodeURIComponent(currentAccountId)}` : ""}`);
  const me = await res.json();
  csrfToken = me.csrfToken || "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})</span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;
  renderCancellationBanner(me);
  if (operatorNavLink) operatorNavLink.hidden = !me.isOperator;

  currentAccountId = me.currentAccountId || "";
  if (me.accounts && me.accounts.length > 1) {
    accountSwitcherWrap.hidden = false;
    accountSwitcher.innerHTML = me.accounts
      .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.ghlLocationId)}</option>`)
      .join("");
    accountSwitcher.value = currentAccountId;
    accountSwitcher.addEventListener("change", () => {
      location.href = `${location.pathname}?accountId=${encodeURIComponent(accountSwitcher.value)}`;
    });
  }

  if (me.role === "admin") {
    adminNav.hidden = false;
    await loadViewAsOptions();
    loadDuplicates();
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
  if (currentAccountId) params.set("accountId", currentAccountId);
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
  if (currentAccountId) params.set("accountId", currentAccountId);
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

// --- Possible duplicates (admins only) ---
// Contacts sharing a phone number. Merging is done in GHL itself (each
// contact links straight to its GHL record) -- this view only finds them.

const duplicatesBar = document.getElementById("duplicates-bar");
const duplicatesToggle = document.getElementById("duplicates-toggle");
const duplicatesCount = document.getElementById("duplicates-count");
const duplicatesPanel = document.getElementById("duplicates-panel");

duplicatesToggle.addEventListener("click", () => {
  const open = duplicatesPanel.hidden;
  duplicatesPanel.hidden = !open;
  duplicatesToggle.setAttribute("aria-expanded", String(open));
});

const duplicatesNotice = document.getElementById("duplicates-notice");
let duplicatesNoticeTimer;

// A message that outlives the panel re-rendering -- after a successful
// catch-up the group usually disappears, taking anything inside it along.
function showDuplicatesNotice(text, isError = false) {
  clearTimeout(duplicatesNoticeTimer);
  duplicatesNotice.textContent = text;
  duplicatesNotice.classList.toggle("duplicates-notice-error", isError);
  duplicatesNotice.hidden = false;
  duplicatesNoticeTimer = setTimeout(() => { duplicatesNotice.hidden = true; }, 12000);
}

function renderDuplicateGroups(groups, suggestSettingAddress) {
  duplicatesCount.textContent = String(groups.length);
  duplicatesBar.hidden = groups.length === 0;
  if (groups.length === 0) {
    duplicatesPanel.hidden = true;
    duplicatesPanel.innerHTML = "";
    return;
  }

  duplicatesPanel.innerHTML = `<p class="duplicates-intro">These contacts share a phone number. To merge them, open each one in GoHighLevel and use its merge tool, then come back and click <strong>I merged these</strong> so CallTrove moves the calls over.</p>`;
  if (suggestSettingAddress) {
    duplicatesPanel.innerHTML += `<p class="duplicates-intro duplicates-hint">These links open the standard GHL site. Your account looks white-labeled, so set your GHL web address in <a href="/settings.html#accounts">Settings &rarr; GHL accounts</a> to open your own branded site instead.</p>`;
  }
  for (const group of groups) {
    const card = document.createElement("div");
    card.className = "duplicate-group";

    const members = group.contacts
      .map((c) => {
        const name = isNameJustThePhone(c.name, c.phone) ? "(no name)" : c.name || "(no name)";
        const calls = `${c.callCount} call${c.callCount === 1 ? "" : "s"}`;
        const ghlLink = c.ghlUrl
          ? `<a class="duplicate-link" href="${escapeHtml(c.ghlUrl)}" target="_blank" rel="noopener noreferrer">Open in GHL &#8599;</a>`
          : "";
        return `<div class="duplicate-member">
          <div class="duplicate-member-main">
            <span class="duplicate-member-name">${escapeHtml(name)}</span>
            <span class="duplicate-member-meta">${escapeHtml(c.phone || "")} &middot; ${escapeHtml(calls)} &middot; ${escapeHtml(formatLastCall(c.lastCallAt))}</span>
          </div>
          <div class="duplicate-member-actions">
            <a class="duplicate-link" href="/?contactId=${encodeURIComponent(c.id)}">View calls</a>
            ${ghlLink}
          </div>
        </div>`;
      })
      .join("");

    card.innerHTML = `${members}
      <div class="duplicate-group-footer">
        <button type="button" class="duplicate-merged">I merged these</button>
        <button type="button" class="duplicate-dismiss">Not duplicates</button>
      </div>`;

    const mergedBtn = card.querySelector(".duplicate-merged");
    mergedBtn.addEventListener("click", async () => {
      mergedBtn.disabled = true;
      mergedBtn.textContent = "Checking GHL...";
      const res = await fetch(`/api/admin/duplicates/reconcile${currentAccountId ? `?accountId=${encodeURIComponent(currentAccountId)}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ contactIds: group.contacts.map((c) => c.id) }),
      });
      const body = await res.json().catch(() => ({}));
      mergedBtn.disabled = false;
      mergedBtn.textContent = "I merged these";
      if (!res.ok) {
        showDuplicatesNotice(body.error || "Couldn't check GHL -- try again.", true);
        return;
      }
      if (body.callsMoved > 0) {
        const calls = `${body.callsMoved} call${body.callsMoved === 1 ? "" : "s"}`;
        const removed = body.contactsRemoved > 0 ? ` and removed ${body.contactsRemoved} leftover contact${body.contactsRemoved === 1 ? "" : "s"}` : "";
        showDuplicatesNotice(`Done: moved ${calls} to the merged contact${removed}.`);
        loadContacts();
        loadDuplicates();
      } else if (body.contactsGone > 0) {
        showDuplicatesNotice("GHL says some of these contacts no longer exist, but CallTrove couldn't find where their calls went. Run \"Import past calls\" in Settings to re-sync them.", true);
      } else if (body.errors > 0) {
        showDuplicatesNotice("Couldn't reach GHL for some of these contacts -- try again in a moment.", true);
      } else {
        showDuplicatesNotice("No change yet: GHL still lists these as separate contacts. If you just merged them, wait a minute and try again.");
      }
    });

    const dismissBtn = card.querySelector(".duplicate-dismiss");
    dismissBtn.addEventListener("click", async () => {
      dismissBtn.disabled = true;
      const res = await fetch(`/api/admin/duplicates/dismiss${currentAccountId ? `?accountId=${encodeURIComponent(currentAccountId)}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ contactIds: group.contacts.map((c) => c.id) }),
      });
      if (!res.ok) {
        dismissBtn.disabled = false;
        dismissBtn.textContent = "Couldn't save — try again";
        return;
      }
      loadDuplicates();
    });

    duplicatesPanel.appendChild(card);
  }
}

async function loadDuplicates() {
  const res = await fetch(`/api/admin/duplicates${currentAccountId ? `?accountId=${encodeURIComponent(currentAccountId)}` : ""}`);
  if (!res.ok) return;
  const { groups, suggestSettingAddress } = await res.json();
  renderDuplicateGroups(groups, suggestSettingAddress);
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
