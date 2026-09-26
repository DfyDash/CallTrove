const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const CALL_MESSAGE_TYPE = 1; // GHL's Conversations message type for phone calls

// Returns a client bound to one set of credentials. With no args, it's
// the deployment's single static Private Integration token
// (GHL_API_TOKEN / GHL_LOCATION_ID) -- today's only connected account,
// and the module's default export below is exactly this, so every
// existing caller keeps working unchanged. src/poller.js and
// src/backfill.js call forAccount({ apiToken, locationId }) directly for
// each OAuth-connected multi-tenant account instead (see
// src/db/index.js's ghl_accounts.access_token).
//
// The per-process caches below (cachedUsersById, cachedTimezone) live
// inside this closure rather than at module scope specifically so two
// different accounts' clients never share one account's user list or
// timezone -- that was a latent bug risk the moment a second account
// existed, since the original module-level cache had no account
// dimension at all.
function forAccount({ apiToken, locationId } = {}) {
  const token = apiToken || process.env.GHL_API_TOKEN;
  const location = locationId || process.env.GHL_LOCATION_ID;

  function headers() {
    return {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      Accept: "application/json",
    };
  }

  function isConfigured() {
    return Boolean(token && location);
  }

  // Conversations sorted by most recent activity, across the whole
  // sub-account -- no contactId filter, so this is what the poller scans on
  // each cycle to find anything new. GHL's "recording URL" isn't exposed on
  // call messages at all (confirmed against GHL's own docs), which is why
  // this app pulls call data via this API rather than a GHL workflow/webhook.
  async function searchConversations(limit = 100) {
    const url = new URL(`${GHL_API_BASE}/conversations/search`);
    url.searchParams.set("locationId", location);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "desc");
    url.searchParams.set("sortBy", "last_message_date");
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`conversations/search failed with status ${res.status}`);
    const data = await res.json();
    return data.conversations || [];
  }

  // One page of the full conversation history, oldest-sortable via cursor
  // (startAfterDate/startAfterId, echoing the last conversation of the
  // previous page) -- for src/backfill.js, which has to walk the *entire*
  // account history rather than just the most recent page (what
  // searchConversations above is for). Returns the raw conversations array;
  // the caller decides whether another page follows (fewer than `limit`
  // results back means this was the last page).
  async function searchConversationsPage({ limit = 100, sort = "asc", startAfterDate, startAfterId } = {}) {
    const url = new URL(`${GHL_API_BASE}/conversations/search`);
    url.searchParams.set("locationId", location);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", sort);
    url.searchParams.set("sortBy", "last_message_date");
    if (startAfterDate) url.searchParams.set("startAfterDate", String(startAfterDate));
    if (startAfterId) url.searchParams.set("startAfterId", startAfterId);
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`conversations/search (paginated) failed with status ${res.status}`);
    const data = await res.json();
    return data.conversations || [];
  }

  // Every call-type message in a conversation (GHL mixes calls, SMS, emails,
  // etc. into the same message list). Paginates back through the whole
  // conversation via lastMessageId -- GHL only returns the most recent ~20
  // messages per page, newest first, and a busy contact's calls easily fall
  // off that first page entirely (confirmed: a call from over a year back
  // was invisible until this was added). `since`, when given, stops paging
  // once a page's oldest message is already older than it -- for the live
  // poller, which only needs messages newer than its checkpoint and would
  // otherwise re-walk a contact's entire history every cycle; backfill.js
  // omits it because it wants the full history regardless.
  async function listCallMessages(conversationId, { since } = {}) {
    const results = [];
    let lastMessageId;
    for (;;) {
      const url = new URL(`${GHL_API_BASE}/conversations/${conversationId}/messages`);
      if (lastMessageId) url.searchParams.set("lastMessageId", lastMessageId);
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) throw new Error(`conversations/messages failed with status ${res.status}`);
      const data = await res.json();
      const page = (data.messages && data.messages.messages) || [];
      if (page.length === 0) break;

      results.push(...page.filter((m) => m.type === CALL_MESSAGE_TYPE));

      const oldestInPage = new Date(page[page.length - 1].dateAdded);
      if (!(data.messages && data.messages.nextPage)) break;
      if (since && oldestInPage <= since) break;

      lastMessageId = page[page.length - 1].id;
    }
    return results;
  }

  async function downloadRecording(messageId) {
    const url = `${GHL_API_BASE}/conversations/messages/${messageId}/locations/${location}/recording`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`get-message-recording failed with status ${res.status}`);
    const contentType = res.headers.get("content-type") || "audio/x-wav";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  }

  // Cached for the process lifetime -- resolves a GHL userId to a display
  // name without a lookup on every call.
  let cachedUsersById = null;

  async function getUserName(userId) {
    if (!userId) return null;
    if (!cachedUsersById) {
      const users = await listUsers();
      cachedUsersById = new Map(users.map((u) => [u.id, u.name]));
    }
    return cachedUsersById.get(userId) || null;
  }

  // Cached for the process lifetime -- a sub-account's timezone essentially
  // never changes, and this saves an API call on every poll cycle.
  let cachedTimezone = null;

  // Fetches the sub-account's actual configured timezone (an IANA name like
  // "America/Phoenix") so call timestamps display correctly for whichever
  // account this is deployed against, including DST, instead of relying on a
  // hand-configured fixed UTC offset that only happens to be right for one
  // account and one season.
  async function getAccountTimezone() {
    if (cachedTimezone) return cachedTimezone;
    if (!isConfigured()) return null;

    const url = `${GHL_API_BASE}/locations/${location}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      console.warn(`[ghlApi] could not fetch location timezone, status ${res.status}`);
      return null;
    }
    const data = await res.json();
    const timezone = (data.location && data.location.timezone) || data.timezone || null;
    if (timezone) cachedTimezone = timezone;
    return timezone;
  }

  // Fetches the sub-account's GHL user list, trimmed to just what the admin
  // UI needs to map a login account to the identity that appears on their
  // calls -- not the full response, which includes each user's entire GHL
  // permission-scope list and other internal detail with no reason to leave
  // this server.
  async function listUsers() {
    const url = new URL(`${GHL_API_BASE}/users/`);
    url.searchParams.set("locationId", location);
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`users list failed with status ${res.status}`);
    const data = await res.json();
    return (data.users || []).map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  // The one write call this client makes -- everything else above is
  // read-only. Requires the contacts.write scope (src/ghlOAuth.js's SCOPES
  // list), separate from the readonly scopes needed for call ingestion
  // itself. Used by src/callSummaryPoller.js to post the AI-generated call
  // summary as a note on the contact.
  async function addContactNote(contactId, body) {
    const url = `${GHL_API_BASE}/contacts/${contactId}/notes`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`contacts/notes create failed with status ${res.status}`);
    return res.json();
  }

  return {
    isConfigured,
    searchConversations,
    searchConversationsPage,
    listCallMessages,
    downloadRecording,
    getUserName,
    getAccountTimezone,
    listUsers,
    addContactNote,
  };
}

module.exports = { forAccount, ...forAccount() };
