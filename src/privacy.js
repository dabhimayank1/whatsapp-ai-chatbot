/**
 * Privacy policy, and the deletion it promises.
 *
 * The policy page used to say "we will process your deletion request within 24
 * hours" while no code in the app could delete anything. That is the sort of
 * gap Meta's App Review looks for, and it is a promise to a real person either
 * way — so the endpoints here do the deletion for real:
 *
 *   GET  /privacy                      the policy, including how to be deleted
 *   GET  /terms                        terms of service, required to go Live
 *   POST /data-deletion                Meta's signed data deletion callback
 *   GET  /data-deletion/status/:code   the status URL that callback must return
 *   POST /deauthorize                  Meta's signed deauthorize callback
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

  <h2>Who we are</h2>
  <p>${escapeHtml(config.BUSINESS_NAME)} operates this messaging service on
  behalf of the businesses that use it — the shop, gym, studio or agency whose
  Instagram post you commented on. Throughout this policy, "the business you
  contacted" means that business. They decide what to ask you and what to do
  with your enquiry; we run the software that carries it.</p>

  <h2>What we collect</h2>
  <p>When you comment on one of their Instagram posts or message them on
  WhatsApp, we store your Instagram username and account id, your WhatsApp
  number and profile name, the messages exchanged with the assistant, and the
  answers you give to its qualification questions. We use it for one purpose:
  to answer your enquiry and pass it to the right person at that business.</p>

  <h2>What we do not do</h2>
  <p>We do not sell your data or use it for advertising. We do not mix your
  enquiry with any other business's — an enquiry to one business is never
  visible to another. Beyond the business you contacted, your data reaches only
  the service providers listed below.</p>

  <h2>Who else handles your data</h2>
  <p>We use a small number of service providers to run this service. They process
  your data only on our instructions, and for no purpose of their own:</p>
  <ul>
    <li><b>The business you contacted</b> — receives your enquiry and your
    answers, which is the whole point of the exchange. They are responsible for
    what they do with it after that.</li>
    <li><b>Meta Platforms</b> — delivers the Instagram and WhatsApp messages
    themselves.</li>
    <li><b>Groq, Inc.</b> (United States) — generates the assistant's replies.
    It receives the text of your messages and the conversation so far. It does
    not receive your phone number or your Instagram account id.</li>
    <li><b>Render Services, Inc.</b> (United States) — hosts this service and
    stores its database.</li>
  </ul>
  <p>Because these providers operate outside your country, your data is
  transferred internationally to reach them.</p>

  <h2>Delete my data</h2>
  <p>Enter the WhatsApp number or Instagram username you contacted us from. The
  deletion runs immediately and cannot be undone — every message, answer, and
  event we hold for you is erased, along with anything still queued to send.</p>
  <form method="POST" action="/privacy/delete-request">
    <input name="identifier" placeholder="WhatsApp number or @instagram_username"
           required aria-label="WhatsApp number or Instagram username">
    <button type="submit">Delete my data</button>
  </form>

  <h2>Through Instagram</h2>
  <p>If you <b>revoke this app's access</b> from your Instagram settings, Meta
  notifies us and we immediately stop every automated message to you, including
  anything already queued. Your enquiry itself is kept, so we can still answer
  it — erasing it is the separate step below.</p>
  <p>If you <b>request deletion of your data</b> through Meta, the erasure above
  runs automatically. You will be given a confirmation code and a status URL of
  the form <code>/data-deletion/status/&lt;code&gt;</code>.</p>
  <p>Replying <code>STOP</code> on WhatsApp has the same effect as revoking
  access, and <code>START</code> reverses it.</p>

  <h2>Retention</h2>
  <p>Leads are kept while the enquiry is open and for as long as the business
  needs them to serve you. Internal de-duplication records are discarded after
  ${config.PROCESSED_EVENT_RETENTION_DAYS} days.</p>

  <p style="margin-top:2.5rem"><a href="/terms">Terms of Service</a></p>
</body>
</html>`);
});

// -------------------------------------------------------------------- terms
/** Terms of service.
 *
 * Basic Settings will not let an app switch to Live without both a privacy
 * policy URL and a terms of service URL, so this is a submission blocker rather
 * than a nicety. It is deliberately short: this service sends messages on a
 * business's behalf, and the only commitments worth making are the ones the
 * code actually keeps.
 */
router.get("/terms", (req, res) => {
  res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Terms of Service — ${escapeHtml(config.BUSINESS_NAME)}</title>
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
           max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem;
           line-height: 1.65; color: #1a1a1a; }
    h1 { font-size: 1.6rem; margin-bottom: .25rem; }
    h2 { font-size: 1.1rem; margin-top: 2rem; }
    .sub { color: #666; margin-top: 0; }
    code { background: #f4f4f5; padding: .1rem .35rem; border-radius: 4px; }
    a { color: #128c7e; }
  </style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p class="sub">${escapeHtml(config.BUSINESS_NAME)}</p>

    <h2>What this service is</h2>
    <p>An automated assistant that replies to comments on our Instagram posts
    and continues the conversation on WhatsApp, so we can answer your enquiry
    and pass it to the right person on our team. You are talking to software
    until a member of our team takes over.</p>

    <h2>Using it</h2>
    <p>Message us only about ${escapeHtml(config.DOMAIN_NAME)}. The assistant
    will not answer anything outside that. Do not send payment details,
    passwords, or identity documents — we neither ask for them nor need them.</p>

    <h2>Stopping it</h2>
    <p>Reply <code>STOP</code> at any time and every automated message ceases,
    including anything already queued. Reply <code>START</code> to resume. To
    have your data erased rather than merely paused, use the form on our
    <a href="/privacy">privacy policy</a>.</p>

    <h2>What we do not promise</h2>
    <p>Message delivery depends on Meta's Instagram and WhatsApp platforms and
    is outside our control. The assistant answers from a fixed knowledge base
    and can be wrong or out of date; nothing it says is a binding offer, quote,
    or professional advice. Confirm anything that matters with a member of our
    team before relying on it.</p>

    <h2>Your data</h2>
    <p>Covered by our <a href="/privacy">privacy policy</a>, which also lists
    every service provider that handles your data and how to delete it.</p>
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

// ---------------------------------------------- Meta's deauthorize callback
/**
 * Meta calls this when a user revokes the app's access to their account.
 *
 * Deliberately not the same thing as `/data-deletion`. Revoking access means
 * "stop using my account", not "forget me" — a business is usually still
 * entitled, and sometimes obliged, to keep the record of an enquiry it is
 * mid-way through answering. So this suppresses everything automated and
 * leaves the record standing; the user erases it separately, from /privacy,
 * and Meta's own deletion callback still erases on request.
 *
 * Meta ignores the response body here, but a 200 is what stops it retrying.
 */
router.post("/deauthorize", (req, res) => {
  const signed = (req.body || {}).signed_request;

  if (!config.META_APP_SECRET) {
    console.error("deauthorize callback received but META_APP_SECRET is not set");
    return res.status(503).json({ error: "deauthorize callback not configured" });
  }

  const payload = parseSignedRequest(signed);
  if (!payload || !payload.user_id) {
    console.error("rejected deauthorize callback: signed_request did not verify");
    return res.status(400).json({ error: "invalid signed_request" });
  }

  const leads = db.leadsForSubject({ igUserId: String(payload.user_id) });
  let paused = 0;
  for (const lead of leads) {
    // optOut() keys on the WhatsApp number, which is the only identifier the
    // queue and the flow are suppressed by. A lead that reached us through
    // Instagram and never opened WhatsApp has none, so pause it directly.
    if (lead.wa_id) paused += db.optOut(lead.wa_id);
    else {
      db.updateLead(lead.id, { bot_paused: 1, flow_active: 0 });
      db.run(
        "UPDATE outbound_queue SET status = 'cancelled', " +
          "last_error = 'access revoked by user' " +
          "WHERE status = 'pending' AND lead_id = ?", [lead.id]);
      paused += 1;
    }
    db.addEvent(lead.id, "DEAUTHORIZED", "user revoked app access on Instagram");
  }

  console.log(`deauthorize: suppressed ${paused} lead(s) for instagram user`);
  return res.status(200).json({ status: "ok" });
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
