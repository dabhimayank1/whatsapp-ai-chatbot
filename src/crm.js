/**
 * CRM sync through an outbox.
 *
 * The rule that matters: **this database is the source of truth, the CRM is
 * downstream.** Leads are written locally first and pushed asynchronously with
 * retries, so an hour of CRM downtime costs nothing.
 *
 * Adapters:
 *   null     - no-op, marks synced (useful while developing)
 *   csv      - appends to a local file; fine for the first hundred leads
 *   webhook  - POSTs JSON anywhere: Zoho, HubSpot, Zapier, Make, n8n, Apps Script
 *
 * `webhook` is the practical universal choice — most CRMs accept an inbound
 * webhook, which avoids building and maintaining OAuth for each one.
 */

import fs from "node:fs";

import config from "./config.js";
import * as db from "./database.js";
import * as tenants from "./tenants.js";

const CSV_FIELDS = [
  "lead_id", "tenant", "vertical", "ref_code", "name", "wa_id",
  "ig_username", "campaign", "answers", "score", "band", "stage",
  "source", "assigned_agent", "created_at",
];

/** Flatten a lead for the CRM.
 *
 * Answers are spread as top-level keys because each tenant asks different
 * questions — a gym sends `goal`, a developer sends `budget`. `answers`
 * keeps the readable version for CRMs that take a single notes field.
 */
export function buildPayload(leadId) {
  const lead = db.getLead(leadId) || {};
  const camp = db.getCampaign(lead.media_id || "") || {};
  const tenant = lead.tenant_id ? tenants.get(lead.tenant_id) : null;
  const answers = db.getAnswers(leadId);

  const payload = {
    lead_id: leadId,
    tenant: (tenant || {}).name ?? null,
    tenant_slug: (tenant || {}).slug ?? null,
    vertical: (tenant || {}).vertical ?? null,
    ref_code: lead.ref_code ?? null,
    name: lead.name || lead.ig_username || null,
    wa_id: lead.wa_id ?? null,
    ig_username: lead.ig_username ?? null,
    campaign: camp.name ?? null,
    property_ref: camp.property_ref ?? null,
    answers: db.summaryOf(leadId),
    score: lead.score ?? null,
    band: lead.band ?? null,
    stage: lead.stage ?? null,
    source: lead.source ?? null,
    assigned_agent: lead.assigned_agent ?? null,
    created_at: lead.created_at ?? null,
  };
  for (const [k, v] of Object.entries(answers)) {
    if (!(`q_${k}` in payload)) payload[`q_${k}`] = v;
  }
  return payload;
}

/** Queue a lead for the CRM. Safe to call more than once. */
export function pushLead(leadId, action = "upsert") {
  db.crmEnqueue(leadId, action, buildPayload(leadId));
}

// ------------------------------------------------------------------- adapters
async function sendNull(payload) {
  console.log(`CRM(null) would sync lead ${payload.lead_id}`);
  return [true, ""];
}

/** Minimal quoting, matching Python's csv module default. */
function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function sendCsv(payload) {
  try {
    const fresh = !fs.existsSync(config.CRM_CSV_PATH);
    let out = "";
    if (fresh) out += CSV_FIELDS.join(",") + "\r\n";
    out += CSV_FIELDS.map((f) => csvCell(payload[f])).join(",") + "\r\n";
    fs.appendFileSync(config.CRM_CSV_PATH, out, "utf-8");
    return [true, ""];
  } catch (err) {
    return [false, String(err?.message || err)];
  }
}

async function sendWebhook(payload) {
  if (!config.CRM_WEBHOOK_URL) return [false, "CRM_WEBHOOK_URL not set"];
  try {
    const r = await fetch(config.CRM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status >= 400) {
      const body = await r.text();
      return [false, `${r.status} ${body.slice(0, 200)}`];
    }
    return [true, ""];
  } catch (err) {
    return [false, String(err?.message || err)];
  }
}

const ADAPTERS = { null: sendNull, csv: sendCsv, webhook: sendWebhook };

/** Push pending outbox rows. Returns how many succeeded. */
export async function drain(limit = 20) {
  const adapter = ADAPTERS[config.CRM_ADAPTER] || sendNull;
  let done = 0;
  for (const item of db.dueCrmItems(limit)) {
    const [ok, err] = await adapter(JSON.parse(item.payload));
    if (ok) {
      db.markCrm(item.id, "sent");
      db.advanceStage(item.lead_id, "CRM_SYNCED", config.CRM_ADAPTER);
      done += 1;
    } else {
      const status =
        item.attempts + 1 >= config.QUEUE_MAX_ATTEMPTS ? "failed" : "pending";
      db.markCrm(item.id, status, err);
      console.warn(`CRM push failed for lead ${item.lead_id}: ${err}`);
    }
  }
  return done;
}
