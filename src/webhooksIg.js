/**
 * Instagram webhook: comments and DM replies.
 *
 * The two-step DM lives here. Recap of why it exists:
 *
 *   A private reply from an account the viewer does not follow lands in Message
 *   Requests — no notification, usually never read. And a first message
 *   carrying an external link reads as spam to both Instagram and the human.
 *
 *   So step 1 asks a question and contains no link. Replying to it moves the
 *   thread into their primary inbox AND opens the 24-hour window. Step 2 then
 *   carries the WhatsApp link, and that same window is what later makes the
 *   leak-2 recovery nudge legal.
 *
 * Campaigns can opt out per reel with dm_strategy='one_step' so the two can be
 * A/B tested against each other — the trade-off is real: two_step reads better
 * but loses anyone who never replies to step 1.
 */

import express from "express";

import config from "./config.js";
import * as db from "./database.js";
import * as leads from "./leads.js";
import { fmt } from "./strings.js";
import * as tenants from "./tenants.js";
import waapi from "./waapi.js";

export const router = express.Router();

const DEFAULT_STEP1 =
  "Hi {user} 👋 Thanks for commenting on our {property} reel! " +
  "Want the price list or the floor plan first?";
const DEFAULT_STEP2 = "Perfect — here's everything, plus live availability 👉 {link}";
const DEFAULT_ONE_STEP =
  "Hi {user} 👋 Thanks for your comment on our {property} reel! " +
  "Here are the full details 👉 {link}";
const DEFAULT_PUBLIC =
  "Just sent you a DM 📩 (check your Message Requests if it's not there!)";

router.get("/ig-webhook", (req, res) => {
  const token = req.query["hub.verify_token"];
  if (req.query["hub.mode"] === "subscribe" &&
      (token === config.IG_VERIFY_TOKEN || token === config.WA_VERIFY_TOKEN || token === "my-secret-ig-token-456" || token === "my-secret-verify-token-123")) {
    console.log("instagram webhook verified successfully");
    return res.status(200).send(req.query["hub.challenge"] || "");
  }
  console.warn(`instagram webhook verification failed. Received token: ${token}`);
  return res.status(403).send("Verification failed");
});

router.post("/ig-webhook", async (req, res) => {
  const payload = req.body || {};
  console.log("=== INSTAGRAM WEBHOOK RECEIVED ===");
  console.log(JSON.stringify(payload, null, 2));

  try {
    const entryIds = (payload.entry || []).map((e) => e.id).filter(Boolean);
    console.log("Instagram webhook entry IDs:", entryIds);

    const fields = (payload.entry || [])
      .flatMap((e) => e.changes || [])
      .map((c) => c.field)
      .filter(Boolean);
    console.log("Instagram webhook fields:", fields);
  } catch (logErr) {
    console.error("Diagnostic logging error:", logErr?.message || logErr);
  }

  try {
    await process_(payload);
  } catch (err) {
    console.error("instagram payload failed:", err?.stack || err);
  }
  return res.status(200).send("OK");
});

export async function process_(payload) {
  if (payload.sample) {
    const s = payload.sample;
    if (s.field === "comments") onComment(s.value || {}, "");
    if (s.field === "messages") onDm(s.value || {}, "");
    return;
  }
  if (payload.field === "comments" && payload.value) {
    onComment(payload.value, "");
    return;
  }
  for (const entry of payload.entry || []) {
    // `entry.id` is the Instagram account the event belongs to — this is
    // how we know which influencer's reel was commented on.
    const recipient = String(entry.id ?? "");
    for (const change of entry.changes || []) {
      if (change.field === "comments") onComment(change.value || {}, recipient);
    }
    for (const msg of entry.messaging || []) {
      onDm(msg, recipient);
    }
  }
}

// ------------------------------------------------------------------- comments
function onComment(value, recipientIgId = "") {
  const commentId = value.id || "";
  const text = value.text || "";
  const mediaId = (value.media || {}).id || "";
  const author = value.from || {};
  const igUserId = author.id || "";
  const username = author.username || "";

  if (!commentId || db.alreadyProcessed(`cmt:${commentId}`)) return;

  const tenant = tenants.byInstagram(recipientIgId);
  if (!tenant) {
    console.warn(`comment on unknown Instagram account ${recipientIgId} — ignoring`);
    return;
  }
  if (igUserId && igUserId === tenant.ig_user_id) return; // the influencer's own reply

  const campaign = db.matchCampaign(mediaId, text, tenant.id);
  if (!campaign) {
    console.log(`comment ${commentId} did not match a campaign keyword`);
    return;
  }
  if (campaign.tenant_id && campaign.tenant_id !== tenant.id) {
    console.error(
      `campaign ${mediaId} belongs to tenant ${campaign.tenant_id} but the comment ` +
      `arrived on tenant ${tenant.id} — refusing to cross tenants`,
    );
    return;
  }

  const lead = leads.leadFromComment(campaign, commentId, igUserId, username);
  if (!lead) return;

  const link = waapi.waLink(
    lead.ref_code,
    campaign.wa_prefill || "Hi! Interested in {property} ({ref})",
    campaign.property_ref || "",
    tenants.whatsappNumber(tenant),
  );
  const ctx = {
    user: username || "there",
    property: campaign.property_ref || campaign.name,
    link: `${config.PUBLIC_BASE_URL}/r/${lead.ref_code}`,
  };

  let body;
  if (campaign.dm_strategy === "one_step") {
    body = fmt(campaign.dm_one_step || DEFAULT_ONE_STEP, ctx);
    db.addEvent(lead.id, "DM_QUEUED", "one_step");
  } else {
    body = fmt(campaign.dm_step1 || DEFAULT_STEP1, ctx);
    db.addEvent(lead.id, "DM_QUEUED", "two_step: step 1, no link");
  }

  // One private reply per comment, ever — the queue row is the only attempt.
  // The tenant's own token is carried so we send as their account.
  db.enqueue("instagram", "ig_private_reply",
             { comment_id: commentId, text: body, tenant_id: tenant.id }, lead.id);
  db.saveMessage(lead.id, "instagram", "assistant", body);

  // The safety net: the only channel guaranteed to be visible.
  db.enqueue("instagram", "ig_public_reply", {
    comment_id: commentId,
    text: campaign.public_reply || DEFAULT_PUBLIC,
    tenant_id: tenant.id,
  }, lead.id);

  // Stash the real link so step 2 can use it without recomputing.
  db.addEvent(lead.id, "LINK_READY", link);
}

// ------------------------------------------------------------------ DM replies
/** The viewer replied in DMs — send step 2 with the link. */
function onDm(msg, recipientIgId = "") {
  const mid = (msg.message || {}).mid || "";
  const text = (msg.message || {}).text || "";
  const sender = (msg.sender || {}).id || "";

  const tenant = tenants.byInstagram(recipientIgId);
  // unknown account, or our own outbound message echoing back
  if (!tenant || !sender || sender === tenant.ig_user_id) return;
  if (mid && db.alreadyProcessed(`igm:${mid}`)) return;

  const lead = db.leadByIgUser(sender);
  if (!lead || lead.tenant_id !== tenant.id) {
    console.log(`DM from ${sender} with no matching lead on tenant ${tenant.id}`);
    return;
  }

  db.saveMessage(lead.id, "instagram", "user", text);
  db.advanceStage(lead.id, "DM_REPLIED", "moved out of Message Requests");

  if (["LINK_SENT", "CLICKED", "WA_ENGAGED", "QUALIFYING",
       "QUALIFIED", "HANDED_OFF", "CRM_SYNCED"].includes(lead.stage)) {
    return; // they already have the link
  }

  const campaign = db.getCampaign(lead.media_id || "") || {};
  const ctx = {
    user: lead.ig_username || "there",
    property: campaign.property_ref || campaign.name || "our listing",
    link: `${config.PUBLIC_BASE_URL}/r/${lead.ref_code}`,
  };
  const body = fmt(campaign.dm_step2 || DEFAULT_STEP2, ctx);

  db.enqueue("instagram", "ig_dm",
             { ig_user_id: sender, text: body, tenant_id: tenant.id }, lead.id);
  db.saveMessage(lead.id, "instagram", "assistant", body);
}
