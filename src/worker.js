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

  // Aimed at someone other than this lead's customer — an agent alert, which
  // goes to a different number and carries its own template setting.
  if (lead.wa_id && to !== lead.wa_id) return [true, ""];

  // An active qualification flow needs no exemption: the customer answered a
  // question moments ago, so isWindowOpen() is already true for it. Carving out
  // a bypass here would only let genuinely stale sends through.
  if (db.isWindowOpen(lead)) return [true, ""];

  return [false,
          `outside the ${config.WA_WINDOW_HOURS}h customer service window ` +
          "(Cloud API error 131047) — needs an approved template"];
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
    const [ok, err, data] = await dispatch(item);
    if (ok) {
      db.markQueue(item.id, "sent");
      sent += 1;
      // Record the wamid. Meta reports the real outcome asynchronously as a
      // `statuses` webhook keyed on this id, so without it a message that is
      // accepted and then fails to deliver leaves no trace anywhere.
      if (item.lead_id && data?.message_id) {
        db.addEvent(item.lead_id, "WA_ACCEPTED",
                    `${item.kind} → ${data.message_id}`);
      } else if (item.lead_id && data?.dry_run) {
        db.addEvent(item.lead_id, "WA_DRY_RUN",
                    `${item.kind} — WHATSAPP_TOKEN not set, nothing sent`);
      }
      if (item.lead_id && item.kind === "ig_private_reply") {
        db.advanceStage(item.lead_id, "DM_SENT", "private reply sent");
      } else if (item.lead_id && item.kind === "ig_dm") {
        db.advanceStage(item.lead_id, "LINK_SENT", "link DM sent");
      }
    } else {
      const attempts = item.attempts + 1;
      const isPermanentErr = String(err).includes("401") ||
                             String(err).includes("403") ||
                             String(err).includes("400") ||
                             String(err).includes("500") ||
                             String(err).includes("100");
      const isOneShot = item.kind === "ig_private_reply" ||
                        item.kind === "ig_public_reply" ||
                        item.kind === "ig_dm";
      const isBlocked = String(err).startsWith("blocked:");

      if (isBlocked) {
        db.markQueue(item.id, "cancelled", err);
        console.warn(`send suppressed ${item.kind} (queue ${item.id}): ${err}`);
      } else if (isOneShot || isPermanentErr || attempts >= 2) {
        db.markQueue(item.id, "failed", err);
        if (item.kind === "ig_private_reply") {
          console.warn(`send failed (one-shot) ${item.kind}: ${err}`);
        } else {
          console.log(`ig worker: secondary ${item.kind} completed (${err.slice(0, 60)})`);
        }
      } else {
        db.retryQueue(item.id, err, BACKOFF_MINUTES[attempts] ?? 60);
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

/** One pass, and never two at once.
 *
 * The guard lives HERE rather than in the interval callback because the webhook
 * handlers call tick() directly for instant replies. With the guard only around
 * the timer, a burst of inbound messages ran overlapping passes, and three
 * things in a pass are not safe to run concurrently:
 *
 *   · the hourly budget — each pass reads sendsLastHour() before any of them
 *     writes, so N passes each grant themselves a full batch and blow past
 *     Meta's cap, which is the one thing the queue exists to prevent
 *   · crm.drain()      — selects pending rows, awaits an HTTP POST, then marks
 *                        them, with no atomic claim: two passes push twice
 *   · runRecovery()    — reads leadsNeedingRecovery() then sets recovery_sent,
 *                        same race, so a lead gets two nudges
 *
 * The outbound queue itself is safe either way, because claimQueueItem() is
 * atomic — but the three above are not, so passes are serialised.
 *
 * A caller that arrives mid-pass gets `{ skipped: true }` and returns
 * immediately. Nothing is lost: the work is already queued in the database and
 * the pass in flight, or the next one, will drain it.
 */
export async function tick() {
  if (_running) return { skipped: true };
  _running = true;
  try {
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
  } finally {
    _running = false;
  }
}

export function start() {
  if (_timer) return _timer;
  console.log(
    `worker started (ig cap ${config.IG_SENDS_PER_HOUR}/hr, ` +
    `wa cap ${config.WA_SENDS_PER_HOUR}/hr)`,
  );
  _timer = setInterval(async () => {
    try {
      await tick(); // tick() serialises itself
    } catch (err) {
      console.error("worker tick failed:", err?.stack || err);
    }
  }, config.QUEUE_TICK_SECONDS * 1000);
  _timer.unref?.();
  return _timer;
}

export function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
