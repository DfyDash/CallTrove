const db = require("./db");
const ghlApi = require("./ghlApi");
const ghlOAuth = require("./ghlOAuth");

// Refresh a little before actual expiry, not right at the deadline --
// avoids a request landing in the gap between "technically expired" and
// "refreshed", which would otherwise fail and cost a whole poll cycle.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Resolves a ready-to-use ghlApi client for one connected account
// (src/poller.js loops over db.listAllActiveGhlAccounts() and calls this
// per account each cycle), refreshing its OAuth token first if it's
// expired or close to it. The legacy default account (today's single
// deployment, tagged with the static GHL_API_TOKEN rather than an OAuth
// token -- see src/db/schema.sql's backfill) has no access_token stored,
// so it falls back to the plain env-var client, unchanged from before
// multi-account support existed.
async function clientForAccount(account) {
  if (!account.accessToken) {
    return ghlApi;
  }

  let accessToken = account.accessToken;
  const expiringSoon = account.tokenExpiresAt && new Date(account.tokenExpiresAt).getTime() < Date.now() + REFRESH_MARGIN_MS;
  if (expiringSoon && account.refreshToken) {
    const refreshed = await ghlOAuth.refreshAccessToken(account.refreshToken);
    accessToken = refreshed.access_token;
    await db.updateGhlAccountTokens(account.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || account.refreshToken,
      tokenExpiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
    });
  }

  return ghlApi.forAccount({ apiToken: accessToken, locationId: account.ghlLocationId });
}

module.exports = { clientForAccount };
