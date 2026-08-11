/**
 * WhatsApp Cloud API client.
 *
 * Interactive messages matter here: tapping a button converts far better than
 * typing an answer, and it hands you clean structured data instead of a string
 * to parse. Meta's limits are tight, so titles are truncated rather than
 * silently rejected by the API.
 *
 * Every function returns `[ok, error]`, mirroring the Python original, and the
 * module is exported as a mutable object so the offline tests can swap the
 * senders for recorders.
 */

import config from "./config.js";
import { fmt, quote } from "./strings.js";

const BUTTON_TITLE_MAX = 20;
const LIST_TITLE_MAX = 24;
const BODY_MAX = 1024;

/** Send from a specific number, or the shared one if not specified. */
async function post(payload, phoneNumberId = "") {
  if (!config.WHATSAPP_TOKEN) {
    console.warn("WHATSAPP_TOKEN missing — dry run:", JSON.stringify(payload));
    return [true, "dry run"];
  }
  const pnid = phoneNumberId || config.PHONE_NUMBER_ID;
  const url = `${config.GRAPH}/${pnid}/messages`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status >= 400) {
      const body = await r.text();
      console.error(`WhatsApp send failed ${r.status}: ${body}`);
      return [false, `${r.status} ${body.slice(0, 200)}`];
    }
    return [true, ""];
  } catch (err) {
    console.error("WhatsApp request failed:", err?.message || err);
    return [false, String(err?.message || err)];
  }
}

async function sendText(to, text, phoneNumberId = "") {
  if (!text) return [false, "empty"];
  return post({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: text.slice(0, 4096) },
  }, phoneNumberId);
}

/** Up to 3 reply buttons. Anything beyond 3 must use sendList(). */
async function sendButtons(to, body, options, phoneNumberId = "") {
  const buttons = options.slice(0, 3).map(([oid, title]) => ({
    type: "reply",
    reply: { id: oid, title: String(title).slice(0, BUTTON_TITLE_MAX) },
  }));
  return post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(body).slice(0, BODY_MAX) },
      action: { buttons },
    },
  }, phoneNumberId);
}

/** Up to 10 rows in a single section. */
async function sendList(to, body, button, options, phoneNumberId = "") {
  const rows = options.slice(0, 10).map(([oid, title]) => ({
    id: oid,
    title: String(title).slice(0, LIST_TITLE_MAX),
  }));
  return post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: String(body).slice(0, BODY_MAX) },
      action: {
        button: String(button).slice(0, BUTTON_TITLE_MAX),
        sections: [{ title: "Options", rows }],
      },
    },
  }, phoneNumberId);
}

/** Build the wa.me link a viewer lands on.
 *
 * Keep the prefilled text SHORT. Long text makes people stop and read before
 * sending, and a bracketed [Ref: X] reads as surveillance — in parentheses at
 * the end it reads as an ordinary enquiry number, which is what people expect.
 */
function waLink(refCode, prefillTemplate, propertyRef = "", businessNumber = "") {
  const text = fmt(prefillTemplate, {
    ref: refCode,
    property: propertyRef || "your listing",
  });
  const number = businessNumber || config.WA_BUSINESS_NUMBER;
  return `https://wa.me/${number}?text=${quote(text.slice(0, 200))}`;
}

export default { sendText, sendButtons, sendList, waLink };
