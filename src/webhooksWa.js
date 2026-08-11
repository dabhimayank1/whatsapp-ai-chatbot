/** WhatsApp webhook: inbound customer messages. */

import express from "express";

import config from "./config.js";
import * as db from "./database.js";
import * as flows from "./flows.js";
import * as leads from "./leads.js";
import * as tenants from "./tenants.js";

export const router = express.Router();

const NON_TEXT_REPLY =
  "I can only read text messages right now. " +
  "Please type your question or tap one of the buttons. 🙂";

router.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === config.WA_VERIFY_TOKEN) {
    console.log("whatsapp webhook verified");
    return res.status(200).send(req.query["hub.challenge"] || "");
  }
  return res.status(403).send("Verification failed");
});

router.post("/webhook", (req, res) => {
  // Meta expects a fast 200, so the work happens after we have replied.
  const payload = req.body || {};
  res.status(200).send("OK");
  process_(payload).catch((err) =>
    console.error("whatsapp payload failed:", err?.stack || err));
});

export async function process_(payload) {
  try {
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
  } catch (err) {
    console.error("whatsapp payload failed:", err?.stack || err);
  }
}

async function onMessage(msg, contacts, phoneNumberId = "") {
  const waId = msg.from || "";
  const mid = msg.id || "";
  if (!waId || db.alreadyProcessed(`wam:${mid}`)) return;

  const mtype = msg.type;
  const profile = contacts[waId] || "";
  const text = mtype === "text" ? msg.text.body : "";

  // Work out whose client this is before doing anything else. On a shared
  // number the ref code is the only signal; on a dedicated number the
  // phone_number_id is enough; a returning customer resolves from their
  // existing lead.
  const ref = leads.extractRef(text);
  const tenant = tenants.resolveForWhatsapp(ref || "", waId, phoneNumberId);
  const tenantId = tenant ? tenant.id : null;
  if (tenant === null) {
    console.warn(
      `no tenant resolved for ${waId} (ref=${ref}, pnid=${phoneNumberId})`);
  }

  let lead = leads.leadFromWhatsapp(waId, text, profile, tenantId);
  // Backfill: an unattributed lead picks up a tenant once one is resolvable.
  if (tenantId && !lead.tenant_id) {
    db.updateLead(lead.id, { tenant_id: tenantId });
    lead = db.getLead(lead.id);
  }
  lead._phone_number_id = phoneNumberId;

  if (mtype === "interactive") {
    const inter = msg.interactive || {};
    const reply = inter.button_reply || inter.list_reply || {};
    console.log(`tap <- ${waId}: ${reply.id}`);
    flows.handleInteractiveReply(lead, reply.id || "", reply.title || "");
    return;
  }

  if (mtype !== "text") {
    db.enqueue("whatsapp", "wa_text",
               { to: waId, text: NON_TEXT_REPLY, phone_number_id: phoneNumberId },
               lead.id);
    db.saveMessage(lead.id, "whatsapp", "assistant", NON_TEXT_REPLY);
    return;
  }

  console.log(`in  <- ${waId} (tenant ${tenantId}): ${text}`);
  await flows.handleText(lead, text);
}
