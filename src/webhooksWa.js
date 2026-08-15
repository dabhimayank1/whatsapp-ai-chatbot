/** WhatsApp webhook: inbound customer messages. */

import express from "express";

import config from "./config.js";
import * as db from "./database.js";
import * as flows from "./flows.js";
import * as leads from "./leads.js";
import { logPayload, requireValidSignature, shortId } from "./security.js";
import * as tenants from "./tenants.js";
import waapi from "./waapi.js";
import { process_ as processIg } from "./webhooksIg.js";
import * as worker from "./worker.js";

export const router = express.Router();

const NON_TEXT_REPLY =
  "I can only read text messages right now. " +
  "Please type your question or tap one of the buttons. 🙂";

router.get("/webhook", (req, res) => {
  const expected = config.WA_VERIFY_TOKEN;
  if (!expected) {
    console.error("webhook handshake refused: WA_VERIFY_TOKEN is not configured");
    return res.status(403).send("Verification failed");
  }
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === expected) {
    console.log("whatsapp webhook verified");
    return res.status(200).send(req.query["hub.challenge"] || "");
  }
  return res.status(403).send("Verification failed");
});

router.post("/webhook", requireValidSignature, (req, res) => {
  // Meta expects a fast 200, so the work happens after we have replied.
  const payload = req.body || {};
  console.log("📥 INBOUND WHATSAPP WEBHOOK RECEIVED:", JSON.stringify(payload));
  res.status(200).send("OK");
  process_(payload).catch((err) =>
    console.error("whatsapp payload failed:", err?.stack || err));
});

export async function process_(payload) {
  try {
    if (payload.object === "instagram" ||
        (payload.entry && payload.entry[0]?.changes && payload.entry[0].changes[0]?.field === "comments")) {
      return await processIg(payload);
    }
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Which of our numbers received this. For tenants on a
        // dedicated number this alone identifies them.
        const phoneNumberId = (value.metadata || {}).phone_number_id || "";
        const contacts = {};
        for (const c of value.contacts || []) {
          contacts[c.wa_id] = (c.profile || {}).name;
        }
        for (const msg of value.messages || []) {
          await onMessage(msg, contacts, phoneNumberId);
        }
      }
    }
    await worker.tick();
  } catch (err) {
    console.error("whatsapp payload failed:", err?.stack || err);
  }
}

/** Whole-message opt-out/opt-in. Substring matching would catch "stop by at 6". */
function consentCommand(text) {
  const normalised = String(text || "").toLowerCase().trim().replace(/[.!]+$/, "");
  if (!normalised) return null;
  if (config.OPT_OUT_KEYWORDS.includes(normalised)) return "out";
  if (config.OPT_IN_KEYWORDS.includes(normalised)) return "in";
  return null;
}

async function onMessage(msg, contacts, phoneNumberId = "") {
  const waId = msg.from || "";
  const mid = msg.id || "";
  if (!waId || !db.claimEvent(`wam:${mid}`)) return;

  const mtype = msg.type;
  const profile = contacts[waId] || "";
  const text = mtype === "text" ? (msg.text?.body ?? "") : "";

  // Work out whose client this is before doing anything else. On a shared
  // number the ref code is the only signal; on a dedicated number the
  // phone_number_id is enough; a returning customer resolves from their
  // existing lead.
  const ref = leads.extractRef(text);
  const tenant = tenants.resolveForWhatsapp(ref || "", waId, phoneNumberId, text);
  const tenantId = tenant ? tenant.id : null;
  if (tenant === null) {
    console.warn(
      `no tenant resolved for ${shortId(waId)} (ref=${ref ? "yes" : "none"}, ` +
      `pnid=${shortId(phoneNumberId)}) — the lead is kept but unattributed`);
  }

  let lead = leads.leadFromWhatsapp(waId, text, profile, tenantId);
  // Backfill: an unattributed lead picks up a tenant once one is resolvable.
  if (tenantId && !lead.tenant_id) {
    db.updateLead(lead.id, { tenant_id: tenantId });
    lead = db.getLead(lead.id);
  }

  // This inbound message is what opens the 24-hour free-form window. Record it
  // before anything decides whether it may reply.
  db.markInbound(lead.id);
  lead = db.getLead(lead.id);
  lead._phone_number_id = phoneNumberId;

  // Consent first, ahead of every other rule. STOP has to work even when a
  // human has taken the thread over and even mid-flow.
  const consent = consentCommand(text);
  if (consent === "out") {
    db.optOut(waId);
    db.saveMessage(lead.id, "whatsapp", "user", text);
    db.addEvent(lead.id, "OPTED_OUT", "customer replied STOP");
    // Sent directly, not queued: optOut() just cancelled this lead's queued
    // rows, and a confirmation is the one message they must still receive.
    const tenantForNumber = lead.tenant_id ? tenants.get(lead.tenant_id) : null;
    await waapi.sendText(waId, config.OPT_OUT_MESSAGE,
                         phoneNumberId || tenants.phoneNumberId(tenantForNumber));
    db.saveMessage(lead.id, "whatsapp", "assistant", config.OPT_OUT_MESSAGE);
    console.log(`opt-out honoured for ${shortId(waId)}`);
    return;
  }
  if (consent === "in" && lead.opted_out) {
    db.optIn(waId);
    db.saveMessage(lead.id, "whatsapp", "user", text);
    db.addEvent(lead.id, "OPTED_IN", "customer replied START");
    db.enqueue("whatsapp", "wa_text",
               { to: waId, text: config.OPT_IN_MESSAGE, phone_number_id: phoneNumberId },
               lead.id);
    db.saveMessage(lead.id, "whatsapp", "assistant", config.OPT_IN_MESSAGE);
    return;
  }
  if (lead.opted_out) {
    // They are opted out and this is not a consent command. Record it so an
    // agent can see they wrote in, but send nothing automated.
    db.saveMessage(lead.id, "whatsapp", "user", text || `[${mtype}]`);
    db.addEvent(lead.id, "INBOUND_WHILE_OPTED_OUT", "no automated reply sent");
    return;
  }

  if (mtype === "interactive") {
    const inter = msg.interactive || {};
    const reply = inter.button_reply || inter.list_reply || {};
    console.log(`tap <- ${shortId(waId)}: ${reply.id}`);
    flows.handleInteractiveReply(lead, reply.id || "", reply.title || "");
    await worker.tick();
    return;
  }

  if (mtype !== "text") {
    db.enqueue("whatsapp", "wa_text",
               { to: waId, text: NON_TEXT_REPLY, phone_number_id: phoneNumberId },
               lead.id);
    db.saveMessage(lead.id, "whatsapp", "assistant", NON_TEXT_REPLY);
    await worker.tick();
    return;
  }

  console.log(`in  <- ${shortId(waId)} (tenant ${tenantId}), ${text.length} chars`);
  await flows.handleText(lead, text);
  await worker.tick();
}
