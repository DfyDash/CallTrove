// TOTP (RFC 6238) / HOTP (RFC 4226) for authenticator-app MFA -- hand-rolled
// on Node's built-in crypto rather than a dependency, same reasoning as
// src/auth.js's own scrypt password hashing: it's a small, well-specified
// primitive, and pulling in a library (most of which drag in unrelated
// CLI/parsing dependencies) isn't worth it. Verified against RFC 6238
// Appendix B's official test vectors and round-tripped against RFC 4648
// base32 before ever being wired into a route.
const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const WINDOW = 1; // ±1 step (30s) either side, to absorb clock drift between the phone and this server.

function base32Encode(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder) {
    output += BASE32_ALPHABET[parseInt(bits.slice(bits.length - remainder).padEnd(5, "0"), 2)];
  }
  return output;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue; // tolerate stray spaces/dashes a user might paste in
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// 160 bits -- the size every authenticator app and the RFC's own examples
// use, well above SHA1's 128-bit collision floor.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, "0");
}

// Checks the current step plus ±WINDOW neighbors, timing-safe per
// candidate. Revealing "it matched one of these 3 valid time-steps" isn't a
// meaningful leak -- it doesn't narrow down the secret itself -- so an
// early return on match is fine, same tradeoff every real TOTP
// implementation makes.
function verifyTotp(base32Secret, code, { time = Date.now() } = {}) {
  if (!/^\d{6}$/.test(code)) return false;
  const secretBuffer = base32Decode(base32Secret);
  const counter = Math.floor(time / 1000 / STEP_SECONDS);
  const submitted = Buffer.from(code);
  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    const candidate = Buffer.from(hotp(secretBuffer, counter + drift));
    if (candidate.length === submitted.length && crypto.timingSafeEqual(candidate, submitted)) return true;
  }
  return false;
}

function otpauthUrl({ secret, username, issuer = "CallTrove" }) {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Recovery codes: high-entropy random tokens, not user-chosen passwords, so
// a fast hash (SHA-256) is appropriate -- unlike scrypt for real passwords,
// there's no low-entropy brute-force risk to slow down here, and a batch of
// 10 gets generated/hashed at once on every regeneration.
function generateRecoveryCode() {
  const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(code.toUpperCase().replace(/[^A-Z2-7]/g, "")).digest("hex");
}

module.exports = { generateSecret, verifyTotp, otpauthUrl, generateRecoveryCode, hashRecoveryCode, base32Encode, base32Decode };
