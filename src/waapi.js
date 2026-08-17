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

/** Send from a specific number, or the shared one if not specified.
 *
 * Returns `[ok, error, data]`. The third element is new and is what makes a
 * failed delivery diagnosable:
 *
 *   { status, message_id, recipient, error_code, error_subcode, error_title,
 *     fbtrace_id, dry_run }
 *
 * Two things worth understanding about `ok`:
 *
 *   · A 200 from Meta means ACCEPTED, not delivered. The real outcome arrives
 *     later on the webhook as a `statuses` entry (sent → delivered → read, or
 *     failed). `message_id` is the wamid those statuses refer back to, so
 *     capturing it here is what lets you join the two together.
 *   · With no token configured this returns ok WITHOUT sending anything. That
 *     is deliberate for offline development, but it marks the queue row `sent`,
 *     so `dry_run: true` is set to distinguish it from a real delivery.
 */
async function post(payload, phoneNumberId = "") {
  if (!config.WHATSAPP_TOKEN) {
    console.warn("WHATSAPP_TOKEN missing — dry run, nothing was sent to Meta");
    return [true, "dry run", { dry_run: true, status: 0 }];
  }
  const rawPnid = phoneNumberId || config.PHONE_NUMBER_ID;
  const pnid = (rawPnid && rawPnid !== "123456123") ? rawPnid : "1200586793147016";
  const url = `${config.GRAPH}/${pnid}/messages`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(config.WHATSAPP_TOKEN || "").trim().replace(/^["']|["']$/g, "")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* Meta always sends JSON; tolerate it if not */ }

    if (r.status >= 400) {
      const e = (parsed && parsed.error) || {};
      const detail = {
        status: r.status,
        error_code: e.code ?? null,
        error_subcode: e.error_subcode ?? null,
        error_title: e.error_user_title || e.type || null,
        error_message: e.message || body.slice(0, 200),
        fbtrace_id: e.fbtrace_id ?? null,
      };
      console.error(
        `WhatsApp send failed ${r.status} code=${detail.error_code ?? "-"}` +
        `${detail.error_subcode ? `/${detail.error_subcode}` : ""}: ${detail.error_message}`,
      );
      // Keep the code in the error string: worker.js classifies retryable vs
      // permanent failures by matching on it.
      return [false, `${r.status} ${e.code ? `[${e.code}] ` : ""}${detail.error_message}`, detail];
    }

    const sent = (parsed?.messages || [])[0] || {};
    return [true, "", {
      status: r.status,
      message_id: sent.id ?? null,
      message_status: sent.message_status ?? null,
      recipient: (parsed?.contacts || [])[0]?.wa_id ?? null,
      dry_run: false,
    }];
  } catch (err) {
    console.error("WhatsApp request failed:", err?.message || err);
    return [false, String(err?.message || err), { status: 0, network_error: true }];
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

/** Send an approved message template.
 *
 * This is the ONLY thing the Cloud API accepts more than 24 hours after the
 * customer's last inbound message — a free-form send there fails with error
 * 131047 no matter how it is worded. It is also the only way to reach an agent
 * who has never messaged the business number, which is every real agent.
 *
 * `params` fill the template's {{1}}, {{2}}… body placeholders in order.
 */
async function sendTemplate(to, templateName, params = [], phoneNumberId = "",
                            language = config.WA_TEMPLATE_LANG) {
  if (!templateName) return [false, "no template name configured"];
  const components = params.length
    ? [{
        type: "body",
        parameters: params.map((p) => ({ type: "text", text: String(p).slice(0, 1024) })),
      }]
    : [];
  return post({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      ...(components.length ? { components } : {}),
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

export default { sendText, sendButtons, sendList, sendTemplate, waLink };
