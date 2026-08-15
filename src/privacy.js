/**
 * Privacy policy, and the deletion it promises.
 *
 * The policy page used to say "we will process your deletion request within 24
 * hours" while no code in the app could delete anything. That is the sort of
 * gap Meta's App Review looks for, and it is a promise to a real person either
 * way — so the endpoints here do the deletion for real:
 *
 *   GET  /privacy                      the policy, including how to be deleted
 *   POST /data-deletion                Meta's signed data deletion callback
 *   GET  /data-deletion/status/:code   the status URL that callback must return
 *   POST /privacy/delete-request       a human asking, from the policy page
 *
 * Meta's callback arrives as a `signed_request` signed with the app secret. It
 * must be answered with a JSON body containing a status URL and a confirmation
 * code, or the app fails review.
 */

import crypto from "node:crypto";

import express from "express";

import config from "./config.js";
import * as db from "./database.js";
import { parseSignedRequest, rateLimiter, shortId } from "./security.js";

export const router = express.Router();

const requestLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "deletion-request",
});

/** A short, non-guessable receipt the requester can quote back. */
function confirmationCode() {
  return crypto.randomBytes(8).toString("hex");
}

/** Record what we deleted, and for whom, without storing the identifier again.
 *
 * The audit row is the point: after erasing someone we still need to be able to
 * answer "was this request honoured?" — so we keep the code, the count, and the
 * time, and never the phone number.
 */
function recordDeletion(code, identifierKind, leadIds) {
  db.run(
    "INSERT INTO deletion_log (code, identifier_kind, lead_count, created_at) " +
      "VALUES (?, ?, ?, ?)",
    [code, identifierKind, leadIds.length, db.now()],
  );
  console.log(
    `deletion ${code}: erased ${leadIds.length} lead(s) matched by ${identifierKind}`,
  );
}

export function deletionStatus(code) {
  return db.row("SELECT * FROM deletion_log WHERE code = ?", [code]);
}

/** Erase everything we hold about one person. Returns [code, count]. */
export function eraseSubject(identifiers, identifierKind) {
  const leadIds = db.purgeSubject(identifiers);
  const code = confirmationCode();
  recordDeletion(code, identifierKind, leadIds);
  return [code, leadIds.length];
}

// ------------------------------------------------------------------ the policy
router.get("/privacy", (req, res) => {
  res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Privacy Policy &amp; Data Deletion — ${escapeHtml(config.BUSINESS_NAME)}</title>
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
           max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem;
           line-height: 1.65; color: #1a1a1a; }
    h1 { font-size: 1.6rem; margin-bottom: .25rem; }
    h2 { font-size: 1.1rem; margin-top: 2rem; }
    .sub { color: #666; margin-top: 0; }
    form { margin-top: 1rem; display: flex; gap: .5rem; flex-wrap: wrap; }
    input { flex: 1 1 16rem; padding: .6rem .7rem; border: 1px solid #ccc;
            border-radius: 6px; font-size: 1rem; }
    button { padding: .6rem 1.1rem; border: 0; border-radius: 6px;
             background: #128c7e; color: #fff; font-size: 1rem; cursor: pointer; }
    code { background: #f4f4f5; padding: .1rem .35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Privacy Policy &amp; User Data Deletion</h1>
  <p class="sub">${escapeHtml(config.BUSINESS_NAME)}</p>

  <h2>What we collect</h2>
  <p>When you comment on one of our Instagram posts or message us on WhatsApp, we
  store your Instagram username and account id, your WhatsApp number and profile
  name, the messages exchanged with our assistant, and the answers you give to
  our qualification questions. We use it for one purpose: to answer your enquiry
  and pass it to the right person on the team.</p>

  <h2>What we do not do</h2>
  <p>We do not sell your data, use it for advertising, or share it with anyone
  beyond the business you contacted and the systems that deliver these messages
  (Meta, and our own CRM).</p>

  <h2>Delete my data</h2>
  <p>Enter the WhatsApp number or Instagram username you contacted us from. The
  deletion runs immediately and cannot be undone — every message, answer, and
  event we hold for you is erased, along with anything still queued to send.</p>
  <form method="POST" action="/privacy/delete-request">
    <input name="identifier" placeholder="WhatsApp number or @instagram_username"
           required aria-label="WhatsApp number or Instagram username">
    <button type="submit">Delete my data</button>
  </form>

  <h2>Deletion via Instagram</h2>
  <p>If you remove this app from your Instagram account, Meta notifies us and the
  same deletion runs automatically. You will be given a confirmation code and a
  status URL of the form <code>/data-deletion/status/&lt;code&gt;</code>.</p>

  <h2>Retention</h2>
  <p>Leads are kept while the enquiry is open and for as long as the business
  needs them to serve you. Internal de-duplication records are discarded after
  ${config.PROCESSED_EVENT_RETENTION_DAYS} days.</p>
</body>
</html>`);
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ------------------------------------------------- a person asking directly
router.post("/privacy/delete-request", requestLimiter, (req, res) => {
  const raw = String((req.body || {}).identifier || "").trim();
  if (!raw) {
    return res.status(400).type("html")
      .send(page("Nothing to delete", "Please enter a WhatsApp number or Instagram username."));
  }

  const looksLikePhone = /^[+\d][\d\s()-]{7,}$/.test(raw);
  const identifiers = looksLikePhone
    ? { waId: raw }
    : { igUsername: raw };

  const [code, count] = eraseSubject(
    identifiers, looksLikePhone ? "whatsapp number" : "instagram username");

  // Same wording either way. "No record found" would confirm to a stranger
  // whether a given number has ever contacted this business.
  return res.status(200).type("html").send(page(
    "Deletion complete",
    `Anything we held for <strong>${escapeHtml(shortId(raw))}</strong> has been erased. ` +
    `Your confirmation code is <code>${code}</code>` +
    (count ? "" : "") + ".",
  ));
});

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:40rem;
margin:0 auto;padding:3rem 1.25rem;line-height:1.65}code{background:#f4f4f5;
padding:.1rem .35rem;border-radius:4px}a{color:#128c7e}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${body}</p>
<p><a href="/privacy">Back to the privacy policy</a></p></body></html>`;
}

// ------------------------------------------------- Meta's deletion callback
/**
 * Meta calls this when a user removes the app from their Instagram account.
 *
 * The response shape is fixed by Meta: `{ url, confirmation_code }`. An
 * unsigned or badly signed request is rejected — otherwise this endpoint would
 * let anyone delete any user's data by guessing their id.
 */
router.post("/data-deletion", (req, res) => {
  const signed = (req.body || {}).signed_request;

  if (!config.META_APP_SECRET) {
    console.error("data deletion callback received but META_APP_SECRET is not set");
    return res.status(503).json({ error: "deletion callback not configured" });
  }

  const payload = parseSignedRequest(signed);
  if (!payload || !payload.user_id) {
    console.error("rejected data deletion callback: signed_request did not verify");
    return res.status(400).json({ error: "invalid signed_request" });
  }

  const [code] = eraseSubject({ igUserId: String(payload.user_id) }, "instagram user id");
  return res.status(200).json({
    url: `${config.PUBLIC_BASE_URL}/data-deletion/status/${code}`,
    confirmation_code: code,
  });
});

router.get("/data-deletion/status/:code", (req, res) => {
  const record = deletionStatus(req.params.code);
  if (!record) {
    return res.status(404).type("html").send(page(
      "Unknown confirmation code",
      "We have no deletion request with that code. It may have been mistyped.",
    ));
  }
  return res.status(200).type("html").send(page(
    "Deletion confirmed",
    `Request <code>${escapeHtml(record.code)}</code> was completed on ` +
    `${escapeHtml(record.created_at)}. ${record.lead_count} record(s) were erased, ` +
    "and nothing identifying the requester was retained.",
  ));
});

export default router;
