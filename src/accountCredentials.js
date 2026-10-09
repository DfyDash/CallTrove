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
// GHL rotates the refresh token on every refresh, so refreshing with a stale
// one fails. Several things in this one process can need an account's token
// at the same moment (the call poller, the merge watcher, a Settings page
// load), each holding an account row read a little earlier -- so refreshes
// run one at a time per account, and each starts from the newest tokens in
// the database: if someone else just refreshed, their new token is used and
// no second refresh happens.
const refreshing = new Map(); // account id -> in-flight refresh

function isExpiringSoon(account) {
  return Boolean(account.tokenExpiresAt && new Date(account.tokenExpiresAt).getTime() < Date.now() + REFRESH_MARGIN_MS);
}

async function currentAccessToken(account) {
  if (!isExpiringSoon(account) || !account.refreshToken) return account.accessToken;
  if (refreshing.has(account.id)) return refreshing.get(account.id);

  const refresh = (async () => {
    const latest = (await db.getGhlAccountById(account.id)) || account;
    if (!isExpiringSoon(latest)) return latest.accessToken;
    const refreshed = await ghlOAuth.refreshAccessToken(latest.refreshToken || account.refreshToken);
    await db.updateGhlAccountTokens(account.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || latest.refreshToken || account.refreshToken,
      tokenExpiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
    });
    return refreshed.access_token;
  })();
  refreshing.set(account.id, refresh);
  try {
    return await refresh;
  } finally {
    refreshing.delete(account.id);
  }
}

async function clientForAccount(account) {
  if (!account.accessToken) {
    return ghlApi;
  }
  const accessToken = await currentAccessToken(account);
  return ghlApi.forAccount({ apiToken: accessToken, locationId: account.ghlLocationId });
}

module.exports = { clientForAccount };
