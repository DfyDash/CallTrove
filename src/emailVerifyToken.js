// Signed, expiring link token for "confirm your email address". Stateless:
// the token carries the user id and the exact email it was issued for, so it
// stops working if the address changes. Uses SESSION_SECRET as the key.
const crypto = require("crypto");

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function key() {
  return process.env.SESSION_SECRET || "";
}

function sign(payload) {
  return crypto.createHmac("sha256", key()).update(payload).digest("base64url");
}

function createEmailVerifyToken(userId, email, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: String(email).toLowerCase(), x: now + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

// Returns { userId, email } for a good, unexpired token, otherwise null.
function readEmailVerifyToken(token, now = Date.now()) {
  if (!key() || typeof token !== "string") return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { u, e, x } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!u || !e || !x || now > x) return null;
    return { userId: u, email: e };
  } catch (err) {
    return null;
  }
}

module.exports = { createEmailVerifyToken, readEmailVerifyToken };
