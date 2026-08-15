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
import { rateLimiter, shortId } from "./security.js";
import * as tenants from "./tenants.js";
import waapi from "./waapi.js";

export const router = express.Router();

const MOBILE_UA = /android|iphone|ipad|ipod|windows phone|mobile|opera mini/i;

// The callback form needs no session, and each submission hands a lead off to
// an agent — which queues a WhatsApp alert. Unlimited, that is a free way to
// spam the client's team and burn the number's send allowance.
const callbackLimiter = rateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  name: "callback",
});

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

/** Turn what someone typed into a number the Cloud API will accept.
 *
 * `wa_id` is always full international format, digits only, no plus. A bare
 * 10-digit Indian mobile is what most people type, and storing that unchanged
 * meant every later send to the lead failed — the number simply does not exist
 * without its country code.
 *
 * Returns null if it cannot be made into something plausible.
 */
export function normalisePhone(raw, defaultCountryCode = config.DEFAULT_COUNTRY_CODE) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;

  // 00 as an international prefix, and a single leading trunk 0.
  if (digits.startsWith("00")) digits = digits.slice(2);
  const cc = String(defaultCountryCode || "").replace(/\D/g, "");

  if (digits.length === 10 && cc) {
    digits = cc + digits;             // bare national number
  } else if (cc && digits.length === 11 && digits.startsWith("0")) {
    digits = cc + digits.slice(1);    // national number with a trunk 0
  }

  // E.164 allows 15 digits; anything under 10 cannot be a mobile number.
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/** Desktop visitor left a number instead of scanning — still a lead. */
router.post("/r/:code/callback", callbackLimiter, (req, res) => {
  const code = req.params.code;
  const lead = db.leadByRef(code);
  const phone = normalisePhone((req.body || {}).phone);
  if (!lead || !phone) {
    return res.status(400).render("qr.html", {
      business: config.BUSINESS_NAME, link: "", ref: code, property_ref: "",
      error: "Please enter a valid phone number with your country code.",
    });
  }

  // wa_started_at matters as much as wa_id here. Without it the lead counts as
  // "clicked but never engaged" in leakReport() even though its stage says
  // WA_ENGAGED, so every desktop conversion was quietly reported as a leak.
  db.updateLead(lead.id, { wa_id: phone, wa_started_at: db.now() });
  db.addEvent(lead.id, "CALLBACK_REQUESTED", shortId(phone));
  db.advanceStage(lead.id, "WA_ENGAGED", "desktop callback request");

  leads.handOff(lead.id, "desktop callback request");
  return res.render("qr.html", {
    business: config.BUSINESS_NAME, link: "", ref: code, property_ref: "",
    done: true,
  });
});
