// GHL Marketplace app OAuth -- a separate mechanism from src/ghlApi.js's
// static GHL_API_TOKEN, which is the current single-account deployment's
// own long-lived Private Integration key. This is for the multi-account
// case: someone clicks "Install" (or "Connect another account") and GHL
// runs its own consent screen, then redirects back here with a
// short-lived authorization code this module exchanges for that specific
// location's access/refresh tokens. Requires an app actually registered
// in GHL's Marketplace developer portal (an external, one-time setup step
// -- see README) before GHL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI exist to
// configure this with.
const GHL_OAUTH_AUTHORIZE_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";
const GHL_OAUTH_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

// The minimum scopes for what CallTrove actually does today (see
// src/ghlApi.js) -- conversations/call messages, the location's user
// list, and the location record itself (for its name/timezone), plus
// contacts.write for the one write call this app makes: posting an
// AI-generated call summary as a note on the contact (src/callSummary.js /
// src/callSummaryPoller.js).
const SCOPES = [
  "conversations.readonly",
  "conversations/message.readonly",
  "locations.readonly",
  "users.readonly",
  "contacts.write",
].join(" ");

function isConfigured() {
  return Boolean(process.env.GHL_OAUTH_CLIENT_ID && process.env.GHL_OAUTH_CLIENT_SECRET && process.env.GHL_OAUTH_REDIRECT_URI);
}

function buildAuthorizeUrl(state) {
  const url = new URL(GHL_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.GHL_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.GHL_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

// user_type: "Location" pins this to a single-location install (as
// opposed to an agency-wide one, which would hand back a companyId
// instead of a locationId) -- CallTrove's data model is per-location
// (ghl_accounts), so that's the only kind of install this can use.
async function exchangeCodeForTokens(code) {
  const res = await fetch(GHL_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GHL_OAUTH_CLIENT_ID,
      client_secret: process.env.GHL_OAUTH_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.GHL_OAUTH_REDIRECT_URI,
      user_type: "Location",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL OAuth token exchange failed with status ${res.status}: ${body}`);
  }
  return res.json();
}

// OAuth access tokens are short-lived (GHL's are ~1hr); the refresh token
// isn't, so this is what src/accountCredentials.js calls whenever a
// connected account's token_expires_at has passed, to get a fresh
// access_token without asking the admin to reauthorize.
async function refreshAccessToken(refreshToken) {
  const res = await fetch(GHL_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GHL_OAUTH_CLIENT_ID,
      client_secret: process.env.GHL_OAUTH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL OAuth token refresh failed with status ${res.status}: ${body}`);
  }
  return res.json();
}

module.exports = { isConfigured, buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken };
