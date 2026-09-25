// Email OTP: short numeric codes for both new-email verification and the
// login step (see db/schema.sql's email_otp_codes). Six digits, the
// conventional shape for an emailed code -- unlike totp_recovery_codes'
// high-entropy tokens, a 6-digit code's real protection is its short
// expiry, single use, and the route-level rate limiter (routes/auth.js's
// mfaLimiter), not the hash itself; SHA-256 here just keeps a DB read from
// directly handing out a valid code.
const crypto = require("crypto");

const CODE_TTL_MS = 10 * 60 * 1000;

function generateCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, "0");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code).trim()).digest("hex");
}

function expiresAt() {
  return new Date(Date.now() + CODE_TTL_MS);
}

module.exports = { generateCode, hashCode, expiresAt, CODE_TTL_MS };
