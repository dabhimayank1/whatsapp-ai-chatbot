/**
 * Webhook authenticity, abuse limits, and log hygiene.
 *
 * The webhook endpoints are the only unauthenticated write path into this app,
 * and they cause outbound messages on our own Meta tokens. Anyone who learns
 * the URL can otherwise POST a forged comment and have us DM an arbitrary
 * Instagram account — spending the hourly allowance, creating leads, and doing
 * it with the client's credentials.
 *
 * Meta signs every webhook POST with HMAC-SHA256 of the raw body, keyed on the
 * app secret, in `X-Hub-Signature-256`. Verifying it is the whole defence, and
 * it has to run against the RAW bytes: re-serialising the parsed JSON changes
 * key order and whitespace, and the digest no longer matches.
 */

import crypto from "node:crypto";

import config from "./config.js";

/** Capture the raw body for signature checking.
 *
 * Passed to express.json({ verify }) — it is the only hook that sees the bytes
 * before they are parsed and discarded.
 */
export function captureRawBody(req, res, buf) {
  if (buf && buf.length) req.rawBody = buf;
}

/** Constant-time compare of two hex digests of possibly different lengths. */
function digestsMatch(a, b) {
  const bufA = Buffer.from(String(a), "utf-8");
  const bufB = Buffer.from(String(b), "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function expectedSignature(rawBody, secret = config.META_APP_SECRET) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Is this POST really from Meta?
 *
 * Returns [ok, reason]. Reasons are for our logs, never for the response body —
 * telling a prober why their forgery failed just helps them.
 */
export function checkSignature(req) {
  if (!config.VERIFY_WEBHOOK_SIGNATURE) return [true, "verification disabled"];
  const secrets = [config.META_APP_SECRET, process.env.IG_APP_SECRET].filter(Boolean);
  if (!secrets.length) return [true, "no app secret configured"];

  const header256 = req.get("x-hub-signature-256") || "";
  const headerSha1 = req.get("x-hub-signature") || "";
  if (!header256 && !headerSha1) return [false, "missing signature headers"];
  if (!req.rawBody) return [false, "raw body unavailable"];

  for (const secret of secrets) {
    if (header256 && digestsMatch(header256, expectedSignature(req.rawBody, secret))) {
      return [true, ""];
    }
    if (headerSha1) {
      const sha1Expected = "sha1=" + crypto.createHmac("sha1", secret).update(req.rawBody).digest("hex");
      if (digestsMatch(headerSha1, sha1Expected)) {
        return [true, ""];
      }
    }
  }
  return [false, "signature mismatch"];
}

/** Express middleware for the webhook POST routes. */
export function requireValidSignature(req, res, next) {
  const [ok, reason] = checkSignature(req);
  if (ok) return next();
  console.error(
    `rejected unsigned webhook POST to ${req.path} from ` +
    `${req.ip || "unknown"}: ${reason}`,
  );
  // 403 and nothing else. Meta will not retry a 403, which is what we want for
  // a forgery; a genuine signature failure means the app secret is wrong, and
  // that shows up in the boot warnings rather than here.
  return res.status(403).send("invalid signature");
}

/** Meta's `signed_request` (used by the data deletion callback).
 *
 * Format is `<base64url hmac>.<base64url json payload>`, signed with the app
 * secret. Returns the payload object, or null if it does not verify.
 */
export function parseSignedRequest(signed, secret = config.META_APP_SECRET) {
  if (!signed || !secret) return null;
  const [sig, payload] = String(signed).split(".");
  if (!sig || !payload) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!digestsMatch(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- rate limiting
/** A fixed-window counter, in memory.
 *
 * Deliberately not Redis: this app is documented to run as a single process, so
 * a Map is the honest implementation. If you ever run two instances, the login
 * limiter becomes per-instance and this comment is your warning.
 */
export function rateLimiter({ windowMs, max, keyOf = (req) => req.ip, name = "limit" }) {
  const hits = new Map();

  const sweep = (nowMs) => {
    for (const [k, v] of hits) if (v.resetAt <= nowMs) hits.delete(k);
  };

  function consume(key, nowMs = Date.now()) {
    if (hits.size > 10_000) sweep(nowMs);
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      hits.set(key, { count: 1, resetAt: nowMs + windowMs });
      return { allowed: true, remaining: max - 1, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.ceil((entry.resetAt - nowMs) / 1000),
      };
    }
    return { allowed: true, remaining: max - entry.count, retryAfter: 0 };
  }

  const middleware = (req, res, next) => {
    const { allowed, retryAfter } = consume(keyOf(req));
    if (allowed) return next();
    console.warn(`${name}: rate limited ${keyOf(req)} on ${req.path}`);
    res.set("Retry-After", String(retryAfter));
    if (req.path.startsWith("/api/")) {
      return res.status(429).json({ error: "too many requests", retry_after: retryAfter });
    }
    return res.status(429).send("Too many requests. Please wait and try again.");
  };

  middleware.consume = consume;
  middleware.reset = (key) => hits.delete(key);
  middleware.clear = () => hits.clear();
  return middleware;
}

// ------------------------------------------------------------- log redaction
const PHONE = /\b(\d[\d\s-]{7,}\d)\b/g;

/** Mask anything that identifies a person, for log lines.
 *
 * Webhook payloads carry phone numbers, profile names and message bodies. On a
 * hosted platform those land in a log stream we do not control and cannot
 * delete, which is both a privacy problem and a promise we made on /privacy.
 */
export function redact(value) {
  if (!config.LOG_REDACT_PII) return typeof value === "string" ? value : JSON.stringify(value);
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 6 ? `${digits.slice(0, 2)}…${digits.slice(-3)}` : "…";
  });
}

/** A phone number or Instagram id, shortened for logs. */
export function shortId(id) {
  const s = String(id ?? "");
  if (!config.LOG_REDACT_PII || s.length <= 6) return s;
  return `${s.slice(0, 2)}…${s.slice(-3)}`;
}

/** Log a webhook payload only if explicitly enabled. */
export function logPayload(label, payload) {
  if (!config.LOG_WEBHOOK_PAYLOADS) return;
  console.log(`${label} ${redact(JSON.stringify(payload))}`);
}

export default {
  captureRawBody, checkSignature, requireValidSignature, expectedSignature,
  parseSignedRequest, rateLimiter, redact, shortId, logPayload,
};
