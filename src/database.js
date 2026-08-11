/**
 * SQLite persistence for the whole funnel.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5), which is synchronous —
 * so this layer maps one-to-one onto the Python original and no caller has to
 * become async just to read a row. No native module to compile either.
 *
 * The schema is byte-identical to the Python app's, so both can open the same
 * chatbot.db file.
 */

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import config from "./config.js";

// Unambiguous alphabet — no O/0, no I/1, so codes survive being read aloud.
export const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                 TEXT UNIQUE NOT NULL,
    name                 TEXT NOT NULL,
    domain_name          TEXT NOT NULL,      -- what the bot is allowed to discuss
    vertical             TEXT,               -- real_estate | gym | restaurant | ...
    knowledge_base       TEXT,               -- the bot's only source of truth
    ig_user_id           TEXT,
    ig_username          TEXT,
    ig_token             TEXT,
    wa_phone_number_id   TEXT,               -- NULL means use the shared number
    wa_business_number   TEXT,
    out_of_scope_message TEXT,
    flow_intro           TEXT,
    flow_done_hot        TEXT,
    flow_done_cold       TEXT,
    portal_user          TEXT UNIQUE,
    portal_password      TEXT,               -- salted hash, never plaintext
    band_hot             INTEGER NOT NULL DEFAULT 70,
    band_warm            INTEGER NOT NULL DEFAULT 40,
    active               INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenants_ig ON tenants (ig_user_id);
CREATE INDEX IF NOT EXISTS idx_tenants_wa ON tenants (wa_phone_number_id);

CREATE TABLE IF NOT EXISTS tenant_questions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL,
    position     INTEGER NOT NULL,
    key          TEXT NOT NULL,              -- slot name, e.g. 'budget'
    qtype        TEXT NOT NULL,              -- button (<=3) | list (<=10)
    question     TEXT NOT NULL,
    button_label TEXT,
    options      TEXT NOT NULL,              -- json [[id, title], ...]
    score_map    TEXT,                       -- json {option_id: points}
    active       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tq_tenant ON tenant_questions (tenant_id, position);

-- Answers are key/value because every tenant asks different questions.
CREATE TABLE IF NOT EXISTS lead_answers (
    lead_id INTEGER NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    label   TEXT,
    points  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lead_id, key)
);

CREATE TABLE IF NOT EXISTS campaigns (
    media_id     TEXT PRIMARY KEY,          -- Instagram media (reel) id
    tenant_id    INTEGER,
    name         TEXT NOT NULL,
    keywords     TEXT NOT NULL,             -- comma separated, lowercased
    property_ref TEXT,
    dm_strategy  TEXT NOT NULL DEFAULT 'two_step',   -- two_step | one_step
    dm_step1     TEXT,                      -- question, deliberately no link
    dm_step2     TEXT,                      -- carries {link}
    dm_one_step  TEXT,                      -- carries {link}
    public_reply TEXT,
    wa_prefill   TEXT,                      -- carries {ref}
    variant      TEXT NOT NULL DEFAULT 'A', -- for A/B testing DM copy
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id           INTEGER,
    ref_code            TEXT UNIQUE,
    media_id            TEXT,
    variant             TEXT,
    ig_user_id          TEXT,
    ig_username         TEXT,
    comment_id          TEXT UNIQUE,        -- one lead per comment, ever
    wa_id               TEXT,
    name                TEXT,
    stage               TEXT NOT NULL DEFAULT 'COMMENTED',
    score               INTEGER NOT NULL DEFAULT 0,
    band                TEXT,
    assigned_agent      TEXT,
    bot_paused          INTEGER NOT NULL DEFAULT 0,
    flow_step           INTEGER NOT NULL DEFAULT 0,
    flow_active         INTEGER NOT NULL DEFAULT 0,
    out_of_scope_streak INTEGER NOT NULL DEFAULT 0,
    source              TEXT NOT NULL DEFAULT 'instagram',
    recovery_sent       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    clicked_at          TEXT,
    wa_started_at       TEXT,
    qualified_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_wa   ON leads (wa_id);
CREATE INDEX IF NOT EXISTS idx_leads_ig   ON leads (ig_user_id);
CREATE INDEX IF NOT EXISTS idx_leads_ref  ON leads (ref_code);

CREATE TABLE IF NOT EXISTS lead_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL,
    type       TEXT NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events (lead_id, id);
CREATE INDEX IF NOT EXISTS idx_events_type ON lead_events (type);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL,
    channel    TEXT NOT NULL,               -- instagram | whatsapp
    role       TEXT NOT NULL,               -- user | assistant | agent
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages (lead_id, id);

CREATE TABLE IF NOT EXISTS outbound_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id      INTEGER,
    channel      TEXT NOT NULL,             -- instagram | whatsapp
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL,             -- json
    scheduled_at TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_ready ON outbound_queue (status, scheduled_at);

CREATE TABLE IF NOT EXISTS crm_outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL,
    action     TEXT NOT NULL,
    payload    TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at    TEXT
);

-- Meta retries webhooks; recording ids stops double-processing.
CREATE TABLE IF NOT EXISTS processed_events (
    event_id     TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    name      TEXT NOT NULL,
    wa_id     TEXT,
    active    INTEGER NOT NULL DEFAULT 1
);
`;

// --------------------------------------------------------------- timestamps
/** Python's `datetime.now(utc).isoformat(timespec="seconds")` to the character,
 *  so timestamps written by either app sort and compare identically. */
function isoSeconds(date) {
  return date.toISOString().slice(0, 19) + "+00:00";
}

export function now() {
  return isoSeconds(new Date());
}

export function inMinutes(minutes) {
  return isoSeconds(new Date(Date.now() + minutes * 60_000));
}

function minutesAgo(minutes) {
  return isoSeconds(new Date(Date.now() - minutes * 60_000));
}

// ------------------------------------------------------------- connection
let _db = null;
let _openedPath = null;

/** The shared handle. Reopens if config.DB_PATH changed (the test suites do
 *  that before touching anything). */
export function conn() {
  if (_db && _openedPath === config.DB_PATH) return _db;
  if (_db) _db.close();
  _db = new DatabaseSync(config.DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  _openedPath = config.DB_PATH;
  return _db;
}

export function closeDb() {
  if (_db) _db.close();
  _db = null;
  _openedPath = null;
}

export function initDb() {
  conn().exec(SCHEMA);
}

/** node:sqlite rejects booleans and undefined; normalise the way Python did. */
function bind(params) {
  return params.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
}

/** Rows come back with a null prototype — give them a normal one. */
const plain = (r) => (r ? { ...r } : r);

export function rows(sql, params = []) {
  return conn().prepare(sql).all(...bind(params)).map(plain);
}

export function row(sql, params = []) {
  const r = rows(sql, params);
  return r.length ? r[0] : null;
}

export function run(sql, params = []) {
  return conn().prepare(sql).run(...bind(params));
}

/** Wrap a function so its statements commit or roll back together. */
export function transaction(fn) {
  const db = conn();
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ------------------------------------------------------------ deduplication
/** True if this Meta event id was handled before. Records it if not. */
export function alreadyProcessed(eventId) {
  if (!eventId) return false;
  if (row("SELECT 1 AS x FROM processed_events WHERE event_id = ?", [eventId])) {
    return true;
  }
  run("INSERT INTO processed_events (event_id, processed_at) VALUES (?, ?)",
      [eventId, now()]);
  return false;
}

// ----------------------------------------------------------------- ref codes
/** A five-character code unique across all leads. */
export function mintRefCode() {
  for (let i = 0; i < 50; i++) {
    let code = "";
    for (let j = 0; j < 5; j++) {
      code += REF_ALPHABET[crypto.randomInt(0, REF_ALPHABET.length)];
    }
    if (!row("SELECT 1 AS x FROM leads WHERE ref_code = ?", [code])) return code;
  }
  throw new Error("could not mint a unique ref code");
}

// ---------------------------------------------------------------- campaigns
export function upsertCampaign(fields) {
  const kw = { ...fields };
  if (kw.created_at === undefined) kw.created_at = now();
  kw.keywords = String(kw.keywords || "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .join(",");

  const cols = Object.keys(kw);
  const marks = cols.map(() => "?").join(", ");
  const updates = cols
    .filter((c) => c !== "media_id")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  run(
    `INSERT INTO campaigns (${cols.join(", ")}) VALUES (${marks}) ` +
      `ON CONFLICT (media_id) DO UPDATE SET ${updates}`,
    Object.values(kw),
  );
}

export function getCampaign(mediaId) {
  return row("SELECT * FROM campaigns WHERE media_id = ?", [mediaId]);
}

export function allCampaigns(tenantId = null) {
  let where = "";
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    where = " WHERE c.tenant_id = ?";
    params.push(tenantId);
  }
  return rows(
    "SELECT c.*, t.name AS tenant_name, " +
      "(SELECT COUNT(*) FROM leads l WHERE l.media_id = c.media_id) AS lead_count " +
      "FROM campaigns c LEFT JOIN tenants t ON t.id = c.tenant_id" +
      `${where} ORDER BY c.created_at DESC`,
    params,
  );
}

export function matchCampaign(mediaId, commentText, tenantId = null) {
  let camp = getCampaign(mediaId);
  const text = String(commentText || "").toLowerCase();
  if (camp && camp.active) {
    for (const kw of String(camp.keywords || "").split(",")) {
      const trimmed = kw.trim().toLowerCase();
      if (trimmed && text.includes(trimmed)) return camp;
    }
  }
  if (tenantId) {
    const tenantCamps = rows("SELECT * FROM campaigns WHERE tenant_id = ? AND active = 1 ORDER BY created_at DESC", [tenantId]);
    for (const c of tenantCamps) {
      for (const kw of String(c.keywords || "").split(",")) {
        const trimmed = kw.trim().toLowerCase();
        if (trimmed && text.includes(trimmed)) return c;
      }
    }
  }
  return null;
}

// -------------------------------------------------------------------- leads
export function createLead(fields = {}) {
  const kw = { ...fields };
  if (kw.created_at === undefined) kw.created_at = now();
  if (kw.updated_at === undefined) kw.updated_at = now();
  if (kw.ref_code === undefined) kw.ref_code = mintRefCode();
  const cols = Object.keys(kw);
  const marks = cols.map(() => "?").join(", ");
  const res = run(
    `INSERT INTO leads (${cols.join(", ")}) VALUES (${marks})`,
    Object.values(kw),
  );
  return Number(res.lastInsertRowid);
}

export function updateLead(leadId, fields = {}) {
  const kw = { ...fields };
  if (!Object.keys(kw).length) return;
  kw.updated_at = now();
  const sets = Object.keys(kw).map((c) => `${c} = ?`).join(", ");
  run(`UPDATE leads SET ${sets} WHERE id = ?`, [...Object.values(kw), leadId]);
}

export function getLead(leadId) {
  return row("SELECT * FROM leads WHERE id = ?", [leadId]);
}

export function leadByRef(refCode) {
  return row("SELECT * FROM leads WHERE ref_code = ?", [String(refCode).toUpperCase()]);
}

export function leadByWa(waId, tenantId = null) {
  if (tenantId !== null && tenantId !== undefined) {
    return row("SELECT * FROM leads WHERE wa_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1",
               [waId, tenantId]);
  }
  return row("SELECT * FROM leads WHERE wa_id = ? ORDER BY id DESC LIMIT 1", [waId]);
}

export function leadByComment(commentId) {
  return row("SELECT * FROM leads WHERE comment_id = ?", [commentId]);
}

/** Most recent lead for this Instagram user — used to route DM replies. */
export function leadByIgUser(igUserId) {
  return row("SELECT * FROM leads WHERE ig_user_id = ? ORDER BY id DESC LIMIT 1",
             [igUserId]);
}

/** Leads, optionally scoped to one tenant.
 *
 * `tenantId` is not optional in practice — every portal call must pass it.
 * An influencer must never see another influencer's leads.
 */
export function allLeads({ stage = null, band = null, mediaId = null,
                           tenantId = null, limit = 200 } = {}) {
  const sql = [
    "SELECT l.*, c.name AS campaign_name, t.name AS tenant_name,",
    "       t.slug AS tenant_slug,",
    "       (SELECT content FROM messages m WHERE m.lead_id = l.id",
    "         ORDER BY m.id DESC LIMIT 1) AS last_message,",
    "       (SELECT GROUP_CONCAT(COALESCE(a.label, a.value), ' · ')",
    "          FROM lead_answers a WHERE a.lead_id = l.id) AS answers",
    "  FROM leads l",
    "  LEFT JOIN campaigns c ON c.media_id = l.media_id",
    "  LEFT JOIN tenants   t ON t.id = l.tenant_id",
    " WHERE 1=1",
  ];
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    sql.push("AND l.tenant_id = ?"); params.push(tenantId);
  }
  if (stage) { sql.push("AND l.stage = ?"); params.push(stage); }
  if (band) { sql.push("AND l.band = ?"); params.push(band); }
  if (mediaId) { sql.push("AND l.media_id = ?"); params.push(mediaId); }
  sql.push("ORDER BY l.score DESC, l.updated_at DESC LIMIT ?");
  params.push(limit);
  return rows(sql.join(" "), params);
}

/** Clicked the link, never sent the WhatsApp message, not yet nudged. */
export function leadsNeedingRecovery() {
  return rows(
    "SELECT * FROM leads WHERE stage = 'CLICKED' AND recovery_sent = 0 " +
      "AND ig_user_id IS NOT NULL AND clicked_at IS NOT NULL AND clicked_at <= ?",
    [minutesAgo(config.RECOVERY_DELAY_MINUTES)],
  );
}

// ------------------------------------------------------------------- events
export function addEvent(leadId, type, detail = "") {
  run("INSERT INTO lead_events (lead_id, type, detail, created_at) VALUES (?, ?, ?, ?)",
      [leadId, type, detail, now()]);
}

export function leadEvents(leadId) {
  return rows("SELECT * FROM lead_events WHERE lead_id = ? ORDER BY id", [leadId]);
}

/** Move a lead forward. Never moves it backwards down the funnel. */
export function advanceStage(leadId, stage, detail = "") {
  const lead = getLead(leadId);
  if (!lead) return;
  const order = config.STAGES;
  const target = order.indexOf(stage);
  const current = order.indexOf(lead.stage);
  if (target !== -1 && current !== -1 && target <= current) {
    addEvent(leadId, stage, detail);
    return;
  }
  updateLead(leadId, { stage });
  addEvent(leadId, stage, detail);
}

// ------------------------------------------------------------ qualification
/** Store one answer. Key/value because every tenant asks different things. */
export function saveAnswer(leadId, key, value, label = "", points = 0) {
  run(
    "INSERT INTO lead_answers (lead_id, key, value, label, points) " +
      "VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (lead_id, key) DO UPDATE SET " +
      "value = excluded.value, label = excluded.label, points = excluded.points",
    [leadId, key, value, label || value, points],
  );
}

/** {key: value} for scoring and CRM payloads. */
export function getAnswers(leadId) {
  const out = {};
  for (const r of rows("SELECT key, value FROM lead_answers WHERE lead_id = ?", [leadId])) {
    out[r.key] = r.value;
  }
  return out;
}

/** Full rows including human labels and points, for the dashboard. */
export function getAnswerRows(leadId) {
  return rows(
    "SELECT a.* FROM lead_answers a " +
      "LEFT JOIN tenant_questions q " +
      "       ON q.key = a.key " +
      "      AND q.tenant_id = (SELECT tenant_id FROM leads WHERE id = a.lead_id) " +
      "WHERE a.lead_id = ? ORDER BY COALESCE(q.position, 99), a.key",
    [leadId],
  );
}

export function answerPoints(leadId) {
  const r = row("SELECT COALESCE(SUM(points), 0) AS n FROM lead_answers WHERE lead_id = ?",
                [leadId]);
  return r ? r.n : 0;
}

export function summaryOf(leadId) {
  const list = getAnswerRows(leadId).map((r) => r.label || r.value);
  return list.join(" / ") || "no answers yet";
}

// ----------------------------------------------------------------- messages
export function saveMessage(leadId, channel, role, content) {
  run("INSERT INTO messages (lead_id, channel, role, content, created_at) " +
      "VALUES (?, ?, ?, ?, ?)", [leadId, channel, role, content, now()]);
}

/** Recent turns shaped for the Groq API (agent messages read as assistant). */
export function getHistory(leadId, limit = config.HISTORY_TURNS * 2) {
  const r = rows(
    "SELECT role, content FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT ?",
    [leadId, limit],
  );
  return r.reverse().map((m) => ({
    role: m.role === "agent" ? "assistant" : m.role,
    content: m.content,
  }));
}

export function leadMessages(leadId) {
  return rows(
    "SELECT channel, role, content, created_at FROM messages WHERE lead_id = ? ORDER BY id",
    [leadId],
  );
}

// -------------------------------------------------------------------- queue
export function enqueue(channel, kind, payload, leadId = null, delayMinutes = 0) {
  const res = run(
    "INSERT INTO outbound_queue " +
      "(lead_id, channel, kind, payload, scheduled_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    [leadId, channel, kind, JSON.stringify(payload),
     delayMinutes ? inMinutes(delayMinutes) : now(), now()],
  );
  return Number(res.lastInsertRowid);
}

export function dueQueueItems(channel, limit) {
  if (limit <= 0) return [];
  return rows(
    "SELECT * FROM outbound_queue WHERE status = 'pending' AND channel = ? " +
      "AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?",
    [channel, now(), limit],
  );
}

/** Atomically take ownership of a queued row.
 *
 * Returns false if another process already claimed it. This matters because
 * an Instagram private reply may only be sent ONCE per comment — two workers
 * draining the same queue would burn that single allowance twice. Run the app
 * as one process anyway, but do not rely on that for correctness.
 */
export function claimQueueItem(itemId) {
  const res = run(
    "UPDATE outbound_queue SET status = 'sending', scheduled_at = ? " +
      "WHERE id = ? AND status = 'pending'",
    [now(), itemId],
  );
  return res.changes === 1;
}

/** Return rows stuck in 'sending' to the queue.
 *
 * A process killed between claiming and sending would otherwise strand its
 * rows permanently.
 */
export function reclaimStale(minutes = 10) {
  const res = run(
    "UPDATE outbound_queue SET status = 'pending' " +
      "WHERE status = 'sending' AND scheduled_at < ?",
    [minutesAgo(minutes)],
  );
  return res.changes;
}

export function sendsLastHour(channel) {
  const r = row(
    "SELECT COUNT(*) AS n FROM outbound_queue WHERE channel = ? " +
      "AND status = 'sent' AND sent_at >= ?",
    [channel, minutesAgo(60)],
  );
  return r ? r.n : 0;
}

export function markQueue(itemId, status, error = "") {
  run(
    "UPDATE outbound_queue SET status = ?, attempts = attempts + 1, " +
      "last_error = ?, sent_at = ? WHERE id = ?",
    [status, String(error).slice(0, 400), status === "sent" ? now() : null, itemId],
  );
}

/** Push a failed item back with backoff, or give up past the attempt cap. */
export function retryQueue(itemId, error, delayMinutes) {
  const r = row("SELECT attempts FROM outbound_queue WHERE id = ?", [itemId]);
  const attempts = (r ? r.attempts : 0) + 1;
  const status = attempts >= config.QUEUE_MAX_ATTEMPTS ? "failed" : "pending";
  run(
    "UPDATE outbound_queue SET attempts = ?, status = ?, last_error = ?, " +
      "scheduled_at = ? WHERE id = ?",
    [attempts, status, String(error).slice(0, 400), inMinutes(delayMinutes), itemId],
  );
}

export function queueStats() {
  const out = {};
  for (const r of rows(
    "SELECT channel, status, COUNT(*) AS n FROM outbound_queue GROUP BY channel, status",
  )) {
    (out[r.channel] ||= {})[r.status] = r.n;
  }
  return out;
}

// --------------------------------------------------------------- crm outbox
export function crmEnqueue(leadId, action, payload) {
  run("INSERT INTO crm_outbox (lead_id, action, payload, created_at) VALUES (?, ?, ?, ?)",
      [leadId, action, JSON.stringify(payload), now()]);
}

export function dueCrmItems(limit = 20) {
  return rows("SELECT * FROM crm_outbox WHERE status = 'pending' ORDER BY id LIMIT ?",
              [limit]);
}

export function markCrm(itemId, status, error = "") {
  run(
    "UPDATE crm_outbox SET status = ?, attempts = attempts + 1, " +
      "last_error = ?, sent_at = ? WHERE id = ?",
    [status, String(error).slice(0, 400), status === "sent" ? now() : null, itemId],
  );
}

// ------------------------------------------------------------------- agents
export function addAgent(name, waId = "", tenantId = null) {
  run("INSERT INTO agents (tenant_id, name, wa_id) VALUES (?, ?, ?)",
      [tenantId, name, waId]);
}

/** A tenant's own agents. Never falls back to another tenant's team. */
export function activeAgents(tenantId = null) {
  if (tenantId === null || tenantId === undefined) {
    return rows("SELECT * FROM agents WHERE active = 1 ORDER BY id");
  }
  return rows("SELECT * FROM agents WHERE active = 1 AND tenant_id = ? ORDER BY id",
              [tenantId]);
}

// ------------------------------------------------------------ funnel report
/** Distinct leads that ever reached each stage, plus conversion from hop 1. */
export function funnelCounts(mediaId = null, tenantId = null) {
  let where = "";
  const params = [];
  if (mediaId) { where += " AND l.media_id = ?"; params.push(mediaId); }
  if (tenantId !== null && tenantId !== undefined) {
    where += " AND l.tenant_id = ?"; params.push(tenantId);
  }

  const counts = {};
  for (const stage of config.STAGES) {
    const r = row(
      "SELECT COUNT(DISTINCT e.lead_id) AS n FROM lead_events e " +
        "JOIN leads l ON l.id = e.lead_id " +
        `WHERE e.type = ?${where}`,
      [stage, ...params],
    );
    counts[stage] = r ? r.n : 0;
  }

  const entered = Math.max(counts.COMMENTED || 0, counts.DM_SENT || 0) || 1;
  // Deliberately only ONE conversion figure, measured against everyone who
  // entered. A per-hop "vs previous stage" number is not meaningful here:
  // campaigns using dm_strategy='one_step' skip DM_REPLIED and LINK_SENT
  // entirely, so comparing adjacent stages produces conversions above 100%.
  // The two genuinely per-hop rates are in leakReport(), computed per lead.
  return config.STAGES.map((stage) => {
    const n = counts[stage];
    return {
      stage,
      count: n,
      pct_of_top: Math.round((1000 * n) / entered) / 10,
      lost_from_entry: entered - n,
    };
  });
}

/** The two leaks, quantified.
 *
 * Computed per lead, not by comparing stage totals. Leads can enter the
 * funnel part-way through — an unattributed WhatsApp message, a desktop
 * callback — so comparing independent stage counts can produce a conversion
 * rate above 100%. Each rate here is a subset of its own denominator, so it
 * is always bounded.
 */
export function leakReport(mediaId = null, tenantId = null) {
  let where = "";
  const params = [];
  if (mediaId) { where += " AND l.media_id = ?"; params.push(mediaId); }
  if (tenantId !== null && tenantId !== undefined) {
    where += " AND l.tenant_id = ?"; params.push(tenantId);
  }

  const dmSent = row(
    "SELECT COUNT(*) AS n FROM leads l WHERE EXISTS (" +
      "  SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.type = 'DM_SENT'" +
      `)${where}`, params).n;
  const dmClicked = row(
    "SELECT COUNT(*) AS n FROM leads l WHERE l.clicked_at IS NOT NULL AND EXISTS (" +
      "  SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.type = 'DM_SENT'" +
      `)${where}`, params).n;

  const clicked = row(
    `SELECT COUNT(*) AS n FROM leads l WHERE l.clicked_at IS NOT NULL${where}`,
    params).n;
  const engaged = row(
    "SELECT COUNT(*) AS n FROM leads l WHERE l.clicked_at IS NOT NULL " +
      `AND l.wa_started_at IS NOT NULL${where}`, params).n;

  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0.0);

  return {
    leak1_dm_to_click: {
      sent: dmSent, clicked: dmClicked,
      lost: dmSent - dmClicked,
      rate: pct(dmClicked, dmSent),
    },
    leak2_click_to_chat: {
      clicked, engaged,
      lost: clicked - engaged,
      rate: pct(engaged, clicked),
    },
  };
}

/** Click-through per DM copy variant — makes leak 1 a solvable problem. */
export function variantReport(tenantId = null) {
  let where = "";
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    where = " AND l.tenant_id = ?";
    params.push(tenantId);
  }
  return rows(
    `
    SELECT l.variant,
           COUNT(*)                                        AS leads,
           SUM(CASE WHEN l.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
           ROUND(100.0 * SUM(CASE WHEN l.clicked_at IS NOT NULL THEN 1 ELSE 0 END)
                 / COUNT(*), 1)                            AS click_rate
      FROM leads l
     WHERE l.variant IS NOT NULL${where}
     GROUP BY l.variant ORDER BY click_rate DESC
    `,
    params,
  );
}
