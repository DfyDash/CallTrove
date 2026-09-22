const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;

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
  return { id: user.id, username: user.username, role: user.role, ghlUserId: user.ghlUserId, tenantId: user.tenantId, accountIds: [] };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not logged in" });
    return res.redirect("/login.html");
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

module.exports = { hashPassword, verifyPassword, sessionUser, requireAuth, requireAdmin, requireAccount, requireCsrf };
