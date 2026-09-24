const crypto = require("crypto");
const db = require("./db");

const SCRYPT_KEYLEN = 64;

// Reachable even while a tenant is cancellation_pending/canceled -- the
// minimum needed for the account-canceled.html page to show status and
// (for the owner) offer to restore. Everything else in the app is
// blocked outright once a tenant leaves 'active', which is what makes
// cancellation "immediately locks out logins" actually true rather than
// just a UI suggestion.
const REACHABLE_WHILE_CANCELED = ["/api/me", "/api/tenant/status", "/api/admin/tenant/restore"];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

// Session payload is the full set of fields access-control checks need, so
// routes never have to hit the DB just to find out who's asking.
// accountIds is filled in separately by the login handler (routes/auth.js)
// since it needs an async DB lookup (db.listAccessibleAccounts) this
// function can't do on its own -- see requireAccount below for how it's
// enforced.
function sessionUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    ghlUserId: user.ghlUserId,
    tenantId: user.tenantId,
    accountIds: [],
    isOperator: Boolean(user.isOperator),
  };
}

// Checks the tenant's status fresh from the DB on every request (not
// cached in the session at login). The grace period itself is full,
// completely unrestricted access -- the whole point of having one is to
// give everyone on the account time to export their data and otherwise
// keep working normally (including an admin freely granting/managing
// access), not a countdown spent already locked out. Lockout is purely
// a time comparison against purgeAt, so it kicks in the moment the grace
// period actually elapses, with nothing for a bug to accidentally
// trigger early -- and it's trivially reversible (flip status back to
// 'active'), unlike the real data deletion in src/tenantPurge.js, which
// stays a deliberate, separate, manually-run step even after this point.
async function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not logged in" });
    return res.redirect("/login.html");
  }

  const tenant = await db.getTenantById(req.session.user.tenantId);
  const lockedOut =
    tenant &&
    (tenant.status === "canceled" ||
      (tenant.status === "cancellation_pending" && tenant.purgeAt && new Date(tenant.purgeAt) <= new Date()));

  if (lockedOut) {
    if (req.path.startsWith("/api/")) {
      if (!REACHABLE_WHILE_CANCELED.includes(req.path)) {
        return res.status(403).json({ error: "account_canceled", status: tenant.status });
      }
    } else if (req.path !== "/account-canceled.html") {
      return res.redirect("/account-canceled.html");
    }
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "admin access required" });
  }
  next();
}

// The multi-tenant isolation boundary: every data route resolves to
// exactly one connected GHL account per request (req.ghlAccountId), never
// "all accounts the user can see" -- that's what keeps different
// locations' recordings from ever appearing mixed together in one
// response. ?accountId= picks which one; omitted defaults to the first
// account on the user's list (accountIds is populated at login -- see
// routes/auth.js) rather than silently querying across every account.
function requireAccount(req, res, next) {
  const user = req.session && req.session.user;
  const allowed = (user && user.accountIds) || [];
  if (!allowed.length) {
    return res.status(403).json({ error: "no GHL account access" });
  }
  const requested = req.query.accountId;
  if (requested && !allowed.includes(requested)) {
    return res.status(403).json({ error: "no access to that account" });
  }
  req.ghlAccountId = requested || allowed[0];
  next();
}

// Cross-tenant boundary for the platform operator (src/routes/operator.js)
// -- completely separate from requireAdmin, which only ever proves someone
// is an admin *of their own tenant*. isOperator is set at login from the
// users table (see routes/auth.js), never derived from role or anything
// else client-influenced.
function requireOperator(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || !user.isOperator) {
    return res.status(403).json({ error: "operator access required" });
  }
  next();
}

// Session-bound CSRF token, issued on login (routes/auth.js) and handed to
// the client via GET /api/me. For the JSON/fetch-based API routes here --
// the two classic HTML-form POSTs (logout, change-password) check a hidden
// form field directly in routes/auth.js instead, since they aren't fetch
// calls and can't set a custom header.
function requireCsrf(req, res, next) {
  const token = req.get("X-CSRF-Token");
  if (!req.session || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: "invalid or missing CSRF token" });
  }
  next();
}

module.exports = { hashPassword, verifyPassword, sessionUser, requireAuth, requireAdmin, requireAccount, requireOperator, requireCsrf };
