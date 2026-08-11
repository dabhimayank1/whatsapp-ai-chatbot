/**
 * Click tracker — the hop that makes both leaks visible.
 *
 * Linking straight to wa.me would leave "never opened the DM" and "opened
 * WhatsApp but never sent" looking identical in the data. They are completely
 * different problems needing different fixes, so every link goes through here.
 *
 * It also fixes the desktop dead end: a wa.me link on a laptop lands on
 * WhatsApp Web and demands a QR scan, and most people simply leave. Desktop
 * visitors get a scannable code and a callback form instead.
 */

import express from "express";

import config from "./config.js";
import * as db from "./database.js";
import * as leads from "./leads.js";
import * as tenants from "./tenants.js";
import waapi from "./waapi.js";

export const router = express.Router();

const MOBILE_UA = /android|iphone|ipad|ipod|windows phone|mobile|opera mini/i;

export function isMobile(userAgent) {
  return MOBILE_UA.test(userAgent || "");
}

/** Inline SVG QR code. Degrades to an empty string if `qrcode` isn't installed. */
export async function qrSvg(data) {
  let QRCode;
  try {
    ({ default: QRCode } = await import("qrcode"));
  } catch {
    console.warn("qrcode not installed — desktop fallback shows the link only");
    return "";
  }
  return QRCode.toString(data, { type: "svg", margin: 2, width: 380 });
}

router.get("/r/:code", async (req, res) => {
  const lead = db.leadByRef(req.params.code);
  if (!lead) {
    console.warn(`unknown ref code ${req.params.code}`);
    return res.redirect(302, `https://wa.me/${config.WA_BUSINESS_NUMBER}`);
  }

  const tenant = lead.tenant_id ? tenants.get(lead.tenant_id) : null;
  const campaign = db.getCampaign(lead.media_id || "") || {};
  const link = waapi.waLink(
    lead.ref_code,
    campaign.wa_prefill || "Hi! Interested in {property} ({ref})",
    campaign.property_ref || "",
    tenants.whatsappNumber(tenant),
  );

  // Record the click once; a re-click should not reset the recovery clock.
  if (!lead.clicked_at) {
    db.updateLead(lead.id, { clicked_at: db.now() });
    db.advanceStage(lead.id, "CLICKED", (req.get("user-agent") || "").slice(0, 80));
  } else {
    db.addEvent(lead.id, "CLICKED_AGAIN", "");
  }

  if (isMobile(req.get("user-agent"))) {
    return res.redirect(302, link);
  }

  db.addEvent(lead.id, "DESKTOP_CLICK", "shown QR fallback");
  return res.render("qr.html", {
    business: (tenant || {}).name || config.BUSINESS_NAME,
    link,
    qr: await qrSvg(link),
    ref: lead.ref_code,
    property_ref: campaign.property_ref || "",
  });
});

/** Desktop visitor left a number instead of scanning — still a lead. */
router.post("/r/:code/callback", (req, res) => {
  const code = req.params.code;
  const lead = db.leadByRef(code);
  const phone = String((req.body || {}).phone || "").replace(/\D/g, "");
  if (!lead || phone.length < 10) {
    return res.status(400).render("qr.html", {
      business: config.BUSINESS_NAME, link: "", ref: code, property_ref: "",
      error: "Please enter a valid phone number.",
    });
  }

  db.updateLead(lead.id, { wa_id: phone });
  db.addEvent(lead.id, "CALLBACK_REQUESTED", phone);
  db.advanceStage(lead.id, "WA_ENGAGED", "desktop callback request");

  leads.handOff(lead.id, "desktop callback request");
  return res.render("qr.html", {
    business: config.BUSINESS_NAME, link: "", ref: code, property_ref: "",
    done: true,
  });
});
