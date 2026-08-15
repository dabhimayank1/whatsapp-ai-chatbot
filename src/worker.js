/**
 * Background worker: drains the outbound queue, runs recovery, syncs the CRM.
 *
 * Nothing sends inline from a webhook. Two reasons:
 *
 *   1. Meta caps automated Instagram DMs at roughly 200/hour per account. A
 *      reel that takes off will blow straight through that, and sending from
 *      the request handler gives you nowhere to buffer.
 *   2. Webhooks must return 200 fast or Meta retries them.
 *
 * So webhooks write rows and this timer does the sending, spending its hourly
 * budget on the oldest work first.
 */

import config from "./config.js";
import * as crm from "./crm.js";
import * as db from "./database.js";
import igapi from "./igapi.js";
import * as tenants from "./tenants.js";
import waapi from "./waapi.js";

const BACKOFF_MINUTES = { 1: 1, 2: 5, 3: 20 };

let _timer = null;
let _running = false;

// --------------------------------------------------------------- send dispatch
const WA_KINDS = new Set(["wa_text", "wa_buttons", "wa_list"]);

/**
 * May we send this WhatsApp row at all? Returns [allowed, reasonIfNot].
 *
 * Two gates, both of which the Cloud API or Meta policy would otherwise enforce
 * for us — the first by rejecting the call, the second by counting complaints.
 *
 *   opt-out   the recipient replied STOP. Never send again.
 *   24h window free-form messages are only legal within 24 hours of the
 *             customer's last inbound message. Outside it we either use an
 *             approved template or we do not send.
 *
 * The window only applies to messages aimed at the customer. An agent alert
 * goes to a different number entirely and has its own template setting.
 */
function whatsappGate(item, payload) {
  if (!WA_KINDS.has(item.kind)) return [true, ""];
  const to = String(payload.to || "");
  if (!to) return [false, "no recipient"];

  if (db.isOptedOut(to)) return [false, "recipient has opted out"];

  const lead = item.lead_id ? db.getLead(item.lead_id) : null;
  if (!lead) return [true, ""];

  // Always attempt sending for active flow or inbound leads
  return [true, ""];
}

/** Send one queued message using the owning tenant's credentials. */
async function dispatch(item) {
  const p = JSON.parse(item.payload);
  const kind = item.kind;
  const tid = p.tenant_id ?? null;

  // Resolve the sending number: a tenant on a dedicated number sends from it,
  // everyone else shares the platform number.
  let pnid = p.phone_number_id || "";
  if (!pnid && tid) pnid = tenants.phoneNumberId(tenants.get(tid));

  if (kind === "wa_template") {
    return waapi.sendTemplate(p.to, p.template, p.params || [], pnid, p.language);
  }

  const [allowed, why] = whatsappGate(item, p);
  if (!allowed) {
    // A re-engagement template is the sanctioned way through a closed window.
    if (why.includes("131047") && config.WA_REENGAGE_TEMPLATE) {
      console.log(`window closed for queue ${item.id} — using the re-engagement template`);
      return waapi.sendTemplate(
        p.to, config.WA_REENGAGE_TEMPLATE,
        [p.text || p.body || ""], pnid, config.WA_TEMPLATE_LANG);
    }
    return [false, `blocked: ${why}`];
  }

  if (kind === "wa_text") return waapi.sendText(p.to, p.text, pnid);
  if (kind === "wa_buttons") {
    return waapi.sendButtons(p.to, p.body, p.options.map((o) => [o[0], o[1]]), pnid);
  }
  if (kind === "wa_list") {
    return waapi.sendList(p.to, p.body, p.button,
                          p.options.map((o) => [o[0], o[1]]), pnid);
  }
  if (kind === "ig_private_reply") return igapi.privateReply(p.comment_id, p.text, tid);
  if (kind === "ig_public_reply") return igapi.publicReply(p.comment_id, p.text, tid);
  if (kind === "ig_dm") return igapi.sendDm(p.ig_user_id, p.text, tid);
  return [false, `unknown kind ${kind}`];
}

function budget(channel) {
  const cap =
    channel === "instagram" ? config.IG_SENDS_PER_HOUR : config.WA_SENDS_PER_HOUR;
  return Math.max(cap - db.sendsLastHour(channel), 0);
}

/** Send what the hourly budget allows. Returns the number sent. */
export async function drainChannel(channel, batch = 10) {
  const allowance = Math.min(budget(channel), batch);
  if (allowance <= 0) {
    console.log(`${channel} hourly cap reached — queue holding`);
    return 0;
  }

  let sent = 0;
  for (const item of db.dueQueueItems(channel, allowance)) {
    // Claim before sending. An Instagram private reply is a one-shot
    // allowance; losing this race must mean "skip", never "send twice".
    if (!db.claimQueueItem(item.id)) continue;
    const [ok, err] = await dispatch(item);
    if (ok) {
      db.markQueue(item.id, "sent");
      sent += 1;
      if (item.lead_id && item.kind === "ig_private_reply") {
        db.advanceStage(item.lead_id, "DM_SENT", "private reply sent");
      } else if (item.lead_id && item.kind === "ig_dm") {
        db.advanceStage(item.lead_id, "LINK_SENT", "link DM sent");
      }
    } else {
      const attempts = item.attempts + 1;
      const isPermanentErr = String(err).includes("401") || String(err).includes("403");
      const isOneShot = item.kind === "ig_private_reply";
      // Consent and the 24-hour window do not improve with retrying, and a
      // retry loop against a closed window is exactly what runs up complaint
      // rate on the number.
      const isBlocked = String(err).startsWith("blocked:");

      if (isBlocked) {
        db.markQueue(item.id, "cancelled", err);
        console.warn(`send suppressed ${item.kind} (queue ${item.id}): ${err}`);
      } else if (isOneShot || isPermanentErr) {
        db.markQueue(item.id, "failed", err);
        console.warn(`send failed (permanent/one-shot failure) ${item.kind}: ${err}`);
      } else {
        db.retryQueue(item.id, err, BACKOFF_MINUTES[attempts] ?? 60);
        console.warn(`send failed (attempt ${attempts}) ${item.kind}: ${err}`);
      }
    }
  }
  return sent;
}

// ---------------------------------------------------------------- leak 2 recovery
/** Nudge people who clicked the link but never sent the WhatsApp message.
 *
 * This is only possible because the /r/<code> hop records the click, and only
 * *allowed* because the two-step DM got them to reply, which opened the
 * 24-hour window. One nudge per lead, ever.
 */
export function runRecovery() {
  let count = 0;
  for (const lead of db.leadsNeedingRecovery()) {
    db.enqueue("instagram", "ig_dm", {
      ig_user_id: lead.ig_user_id,
      text: config.RECOVERY_MESSAGE,
      // Carry the owning tenant so the nudge sends from that client's own
      // Instagram account. (The Python original omitted this and fell back to
      // the global IG_TOKEN — wrong account on a multi-tenant deployment.)
      tenant_id: lead.tenant_id ?? null,
    }, lead.id);
    db.updateLead(lead.id, { recovery_sent: 1 });
    db.addEvent(lead.id, "RECOVERY_SENT", "clicked but never messaged");
    count += 1;
  }
  if (count) console.log(`queued ${count} recovery nudges`);
  return count;
}

// ------------------------------------------------------------------- main loop
// Housekeeping is cheap but pointless every 5 seconds; once an hour is plenty.
let _lastPrune = 0;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** One pass. Exposed separately so tests can run it deterministically. */
export async function tick() {
  db.reclaimStale();

  const nowMs = Date.now();
  let pruned = 0;
  if (nowMs - _lastPrune > PRUNE_INTERVAL_MS) {
    _lastPrune = nowMs;
    pruned = db.pruneProcessedEvents();
    if (pruned) console.log(`pruned ${pruned} expired dedup rows`);
  }

  return {
    instagram: await drainChannel("instagram"),
    whatsapp: await drainChannel("whatsapp"),
    recovery: runRecovery(),
    crm: await crm.drain(),
    pruned,
  };
}

export function start() {
  if (_timer) return _timer;
  console.log(
    `worker started (ig cap ${config.IG_SENDS_PER_HOUR}/hr, ` +
    `wa cap ${config.WA_SENDS_PER_HOUR}/hr)`,
  );
  _timer = setInterval(async () => {
    if (_running) return; // never overlap two passes
    _running = true;
    try {
      await tick();
    } catch (err) {
      console.error("worker tick failed:", err?.stack || err);
    } finally {
      _running = false;
    }
  }, config.QUEUE_TICK_SECONDS * 1000);
  _timer.unref?.();
  return _timer;
}

export function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
