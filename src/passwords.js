/**
 * Password hashing, wire-compatible with Werkzeug.
 *
 * The Python app stored `scrypt:32768:8:1$salt$hex` (Werkzeug 3's default) and
 * older installs may hold `pbkdf2:sha256:600000$salt$hex`. Both are verified
 * here and new hashes are written in the same scrypt format, so the two apps
 * can share one chatbot.db and the same portal logins either way.
 *
 * Uses node:crypto only — no bcrypt, no native build step.
 */

import crypto from "node:crypto";

const SALT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SALT_LENGTH = 16;

// Werkzeug's defaults.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;

function randomSalt() {
  let s = "";
  for (let i = 0; i < SALT_LENGTH; i++) {
    s += SALT_CHARS[crypto.randomInt(0, SALT_CHARS.length)];
  }
  return s;
}

function scryptHex(password, salt, n, r, p) {
  // node's default maxmem (32 MB) is exactly on the boundary for N=32768,r=8;
  // raise it so the standard Werkzeug parameters never throw.
  return crypto
    .scryptSync(password, salt, SCRYPT_DKLEN, { N: n, r, p, maxmem: 256 * 1024 * 1024 })
    .toString("hex");
}

function pbkdf2Hex(password, salt, iterations, digest) {
  const dklen = crypto.createHash(digest).digest().length;
  return crypto.pbkdf2Sync(password, salt, iterations, dklen, digest).toString("hex");
}

/** Produce `scrypt:32768:8:1$salt$hex`. */
export function generatePasswordHash(password) {
  const salt = randomSalt();
  const hex = scryptHex(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}$${salt}$${hex}`;
}

/** Verify against either supported Werkzeug format. Never throws. */
export function checkPasswordHash(stored, password) {
  if (!stored || !password) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 3) return false;
  const [method, salt, expected] = parts;
  const spec = method.split(":");

  let actual;
  try {
    if (spec[0] === "scrypt") {
      const n = parseInt(spec[1] ?? SCRYPT_N, 10);
      const r = parseInt(spec[2] ?? SCRYPT_R, 10);
      const p = parseInt(spec[3] ?? SCRYPT_P, 10);
      actual = scryptHex(password, salt, n, r, p);
    } else if (spec[0] === "pbkdf2") {
      const digest = spec[1] || "sha256";
      const iterations = parseInt(spec[2] ?? "600000", 10);
      actual = pbkdf2Hex(password, salt, iterations, digest);
    } else {
      return false;
    }
  } catch {
    return false;
  }

  const a = Buffer.from(actual, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
