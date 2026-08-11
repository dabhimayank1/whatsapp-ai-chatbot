/**
 * Lead lifecycle: creation, attribution, scoring, handoff.
 *
 * The scoring weights live on each tenant's own question options — tune them
 * against real closes after roughly fifty leads. The bands are only useful if
 * they change who picks up the phone first.
 */

import config from "./config.js";
import * as crm from "./crm.js";
import * as db from "./database.js";
import * as tenants from "./tenants.js";

// Matches "(RL7K2)" or "[Ref: RL7K2]" or a bare code — tolerant on purpose,
// because people edit prefilled text.
const REF_PATTERN = new RegExp(
  `(?:\\bref[:\\s#]*|[\\[(])\\s*([${db.REF_ALPHABET}]{5})\\s*[\\])]?`,
  "i",
);

export function extractRef(text) {
  const m = REF_PATTERN.exec(String(text || ""));
  return m ? m[1].toUpperCase() : null;
}

// ------------------------------------------------------------------- creation
/** One lead per comment. Returns null if this comment was already handled. */
export function leadFromComment(campaign, commentId, igUserId, igUsername) {
  if (db.leadByComment(commentId)) return null;
  const leadId = db.createLead({
    tenant_id: campaign.tenant_id ?? null,
    media_id: campaign.media_id,
    variant: campaign.variant,
    ig_user_id: igUserId,
    ig_username: igUsername,
    comment_id: commentId,
    stage: "COMMENTED",
    source: "instagram",
  });
  db.addEvent(leadId, "COMMENTED", `@${igUsername} on ${campaign.name}`);
  return db.getLead(leadId);
}

/** Find or create the lead behind an inbound WhatsApp message.
 *
 * Attribution order:
 *   1. ref code in the message  → bind to the Instagram lead (the happy path)
 *   2. existing lead on this number
 *   3. brand new unattributed lead — never drop someone over missing tracking
 */
export function leadFromWhatsapp(waId, text, profileName = "", tenantId = null) {
  const ref = extractRef(text);
  if (ref) {
    const lead = db.leadByRef(ref);
    if (lead && !lead.wa_id) {
      db.updateLead(lead.id, {
        wa_id: waId,
        name: profileName || lead.name,
        wa_started_at: db.now(),
      });
      db.addEvent(lead.id, "WA_ENGAGED", `ref ${ref} matched → ${waId}`);
      db.advanceStage(lead.id, "WA_ENGAGED", "identities stitched");
      return db.getLead(lead.id);
    }
    if (lead) return lead;
  }

  const existing = db.leadByWa(waId);
  if (existing) {
    if (tenantId && existing.tenant_id !== tenantId) {
      db.updateLead(existing.id, { tenant_id: tenantId, flow_step: 0, flow_active: 0, out_of_scope_streak: 0, bot_paused: 0 });
      return db.getLead(existing.id);
    }
    return existing;
  }

  const leadId = db.createLead({
    tenant_id: tenantId,
    wa_id: waId,
    name: profileName,
    stage: "WA_ENGAGED",
    source: ref ? "instagram" : "unattributed",
    wa_started_at: db.now(),
  });
  db.addEvent(
    leadId,
    "WA_ENGAGED",
    "no ref code — unattributed" + (tenantId ? "" : "; no tenant resolved"),
  );
  console.log(`unattributed lead created for ${waId} (tenant ${tenantId})`);
  return db.getLead(leadId);
}

// -------------------------------------------------------------------- scoring
/** Sum the points attached to each answer, normalised to 0–100.
 *
 * Points live on the tenant's own question options, so a gym and a developer
 * can weight completely different things without touching this function.
 * Normalising matters because one tenant may ask three questions and another
 * six — a raw total would make the bands meaningless across tenants.
 */
export function scoreLead(leadId) {
  const lead = db.getLead(leadId) || {};
  const tenant = lead.tenant_id ? tenants.get(lead.tenant_id) : null;

  const raw = db.answerPoints(leadId);
  const possible = lead.tenant_id ? tenants.maxScore(lead.tenant_id) : 100;
  const score = possible ? Math.round((100 * raw) / possible) : 0;

  const hot = (tenant || {}).band_hot || config.BAND_HOT;
  const warm = (tenant || {}).band_warm || config.BAND_WARM;
  const band = score >= hot ? "HOT" : score >= warm ? "WARM" : "COLD";

  db.updateLead(leadId, { score, band });
  db.addEvent(leadId, "SCORED", `${raw}/${possible} → ${score} → ${band}`);
  return [score, band];
}

export function summaryLine(lead) {
  return db.summaryOf(lead.id);
}

// -------------------------------------------------------------------- handoff
/** Silence the bot and alert an agent. Idempotent. */
export function handOff(leadId, reason = "") {
  const lead = db.getLead(leadId);
  if (!lead) return;
  if (lead.bot_paused) return;

  const agents = db.activeAgents(lead.tenant_id ?? null);
  const assigned = agents.length ? agents[0].name : null;
  db.updateLead(leadId, { bot_paused: 1, flow_active: 0, assigned_agent: assigned });
  db.advanceStage(leadId, "HANDED_OFF", reason || "handed to human");

  if (agents.length && agents[0].wa_id) {
    notifyAgent(agents[0].wa_id, leadId);
  }

  crm.pushLead(leadId);
}

/** Queue a WhatsApp alert to the agent. Hot leads should feel urgent. */
export function notifyAgent(agentWaId, leadId) {
  const lead = db.getLead(leadId);
  if (!lead) return;
  const tenant = lead.tenant_id ? tenants.get(lead.tenant_id) : null;
  const text =
    `🔔 *${lead.band || "NEW"} lead* · score ${lead.score}` +
    (tenant ? ` · ${tenant.name}` : "") + "\n" +
    `${lead.name || lead.ig_username || "Unknown"} (+${lead.wa_id || "—"})\n` +
    `${summaryLine(lead)}\n` +
    `Ref ${lead.ref_code} · ${config.PUBLIC_BASE_URL}/admin#lead-${leadId}`;
  db.enqueue("whatsapp", "wa_text", { to: agentWaId, text }, leadId);
}
