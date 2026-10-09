// The web address admins open GHL at, for "Open in GHL" links. Standard GHL
// is app.gohighlevel.com; a white-labeled agency has its own branded
// domain. GHL's API only says THAT a location is white-labeled (a brandId
// on the location record), never the brand's address, so the address is
// entered per account in Settings > GHL accounts (ghl_accounts.ghl_app_url)
// and this module just validates it and decides what to link to.
const accountCredentials = require("./accountCredentials");

const DEFAULT_APP_URL = "https://app.gohighlevel.com";

// What an admin typed -> a clean https origin, or an error to show them.
// Anything beyond the host (path, query, #fragment) is dropped, so pasting a
// whole GHL page URL still works. Only https and real hostnames are
// accepted: the value ends up in an href, and a bare IP, localhost, or a
// non-https scheme (javascript:, http:) is never a legitimate GHL login.
function normalizeAppUrl(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return { ok: true, url: null };
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That doesn't look like a web address." };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "The address must start with https://" };
  if (parsed.username || parsed.password) return { ok: false, error: "Remove anything before the @ sign." };
  const host = parsed.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (!host.includes(".") || isIp || host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, error: "Enter your GHL domain, like app.yourbrand.com" };
  }
  return { ok: true, url: parsed.origin };
}

// Per-account saved address, else the deployment-wide GHL_APP_URL, else
// standard GHL.
function resolveAppBase(account) {
  const envUrl = normalizeAppUrl(process.env.GHL_APP_URL);
  return (account && account.ghlAppUrl) || (envUrl.ok && envUrl.url) || DEFAULT_APP_URL;
}

// Does GHL say this location sits under a white-label brand? Cached per
// account for an hour so Settings/Contacts loads don't each cost a GHL API
// call, and bounded to a few seconds so a slow GHL never stalls the page.
// null (can't tell) is treated the same as "no".
const HINT_TTL_MS = 60 * 60 * 1000;
const HINT_TIMEOUT_MS = 3000;
const hintCache = new Map();

async function looksWhiteLabeled(account) {
  const cached = hintCache.get(account.id);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value = null;
  try {
    const client = await accountCredentials.clientForAccount(account);
    const brandId = await Promise.race([
      client.getLocationBrandId(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), HINT_TIMEOUT_MS)),
    ]);
    if (brandId !== undefined) value = Boolean(brandId);
  } catch (err) {
    console.warn("[ghlAppUrl] could not check white-label status:", err.message);
  }
  if (value !== null) hintCache.set(account.id, { value, expires: Date.now() + HINT_TTL_MS });
  return value === true;
}

module.exports = { DEFAULT_APP_URL, normalizeAppUrl, resolveAppBase, looksWhiteLabeled };
