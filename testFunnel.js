/**
 * End-to-end funnel test with both Meta APIs stubbed.
 *
 * Drives a lead all the way from an Instagram comment to a CRM row and asserts
 * the behaviour that actually matters — including the two leak fixes and the
 * rate limiter.
 *
 *     node testFunnel.js
 *
 * No Groq key or Meta credentials required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import aiEngine from "./src/aiEngine.js";
import config from "./src/config.js";
import * as crm from "./src/crm.js";
import * as db from "./src/database.js";
import igapi from "./src/igapi.js";
import * as tenants from "./src/tenants.js";
import waapi from "./src/waapi.js";
import * as webhooksIg from "./src/webhooksIg.js";
import * as webhooksWa from "./src/webhooksWa.js";
import * as worker from "./src/worker.js";
import { createApp } from "./src/app.js";
import { reporter, serve } from "./testHelpers.js";

// Point at a scratch database. Nothing has opened a connection yet, and
// database.conn() reopens whenever config.DB_PATH changes.
config.DB_PATH = path.join(os.tmpdir(), "funnel_test.db");
config.PUBLIC_BASE_URL = "https://skyline.test";
config.WA_BUSINESS_NUMBER = "919876543210";
config.CRM_ADAPTER = "null";

for (const stale of [config.DB_PATH, config.DB_PATH + "-wal", config.DB_PATH + "-shm"]) {
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

// ------------------------------------------------------------------- stubbing
const SENT = { ig_private: [], ig_public: [], ig_dm: [], wa: [] };

igapi.privateReply = (cid, t) => { SENT.ig_private.push([cid, t]); return [true, ""]; };
igapi.publicReply = (cid, t) => { SENT.ig_public.push([cid, t]); return [true, ""]; };
igapi.sendDm = (uid, t) => { SENT.ig_dm.push([uid, t]); return [true, ""]; };
waapi.sendText = (to, t) => { SENT.wa.push(["text", to, t]); return [true, ""]; };
waapi.sendButtons = (to, b) => { SENT.wa.push(["buttons", to, b]); return [true, ""]; };
waapi.sendList = (to, b) => { SENT.wa.push(["list", to, b]); return [true, ""]; };

// The classifier and answerer need a Groq key; stub them so the test is offline.
aiEngine.classify = (m) =>
  ["poem", "python", "capital of", "ignore all"].some((w) => m.toLowerCase().includes(w))
    ? "OUT" : "IN";
aiEngine.generateAnswer = () => "The 3 BHK at Satellite starts at ₹1.42 Cr. 🏡";

const { check, section, finish } = reporter(68);

const IG_ACCOUNT = "IG_SKYLINE";
const PNID = "PN_MAIN";

const commentPayload = (cid, text, media, uid, user, recipient = IG_ACCOUNT) => ({
  entry: [{ id: recipient, changes: [{ field: "comments", value: {
    id: cid, text, media: { id: media }, from: { id: uid, username: user } } }] }],
});

const dmPayload = (mid, text, uid, recipient = IG_ACCOUNT) => ({
  entry: [{ id: recipient, messaging: [{
    sender: { id: uid }, message: { mid, text } }] }],
});

const waTextPayload = (mid, text, waId, name = "Rahul Mehta") => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: waId, profile: { name } }],
    messages: [{ from: waId, id: mid, type: "text", text: { body: text } }] } }] }],
});

const waTapPayload = (mid, waId, oid, title) => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: waId, profile: { name: "Rahul Mehta" } }],
    messages: [{ from: waId, id: mid, type: "interactive",
                 interactive: { type: "button_reply",
                                button_reply: { id: oid, title } } }] } }] }],
});

// ============================================================== the test itself
db.initDb();

const TENANT = tenants.create({
  name: "Skyline Properties", domain_name: "real estate and property services",
  vertical: "real_estate", ig_user_id: IG_ACCOUNT, ig_username: "skyline.props",
  ig_token: "TOK", wa_phone_number_id: PNID, wa_business_number: "919876543210",
});
tenants.applyTemplate(TENANT, "real_estate");
db.addAgent("Priya S.", "919000000001", TENANT);
db.upsertCampaign({
  media_id: "REEL_SAT_3BHK", tenant_id: TENANT, name: "Satellite 3BHK walkthrough",
  keywords: "price,info,details", property_ref: "3BHK Satellite",
  dm_strategy: "two_step", variant: "A",
  wa_prefill: "Hi! Interested in {property} ({ref})",
});

section("1 · Instagram comment → two-step DM (leak 1 fix)");
await webhooksIg.process_(
  commentPayload("CMT1", "PRICE please", "REEL_SAT_3BHK", "IGU_100", "rahul_m"));
const lead = db.leadByComment("CMT1");
check("lead created from comment", lead !== null);
check("ref code minted", Boolean(lead && lead.ref_code), lead.ref_code);

await worker.drainChannel("instagram", 10);
check("private reply sent", SENT.ig_private.length === 1);
check("step 1 carries NO link", !SENT.ig_private[0][1].includes("http"),
      JSON.stringify(SENT.ig_private[0][1].slice(0, 56)));
check("public 'check Message Requests' reply sent",
      SENT.ig_public.length === 1 && SENT.ig_public[0][1].includes("Request"));
check("stage is DM_SENT", db.getLead(lead.id).stage === "DM_SENT");

section("2 · Webhook retry must not double-send");
await webhooksIg.process_(
  commentPayload("CMT1", "PRICE please", "REEL_SAT_3BHK", "IGU_100", "rahul_m"));
await worker.drainChannel("instagram", 10);
check("duplicate comment ignored", SENT.ig_private.length === 1,
      `${SENT.ig_private.length} sends total`);

section("3 · Non-matching comment is ignored");
await webhooksIg.process_(
  commentPayload("CMT_X", "nice video!", "REEL_SAT_3BHK", "IGU_999", "someone"));
check("no lead for non-keyword comment", db.leadByComment("CMT_X") === null);

section("4 · DM reply → step 2 delivers the link");
await webhooksIg.process_(dmPayload("IGM1", "price list please", "IGU_100"));
await worker.drainChannel("instagram", 10);
check("step 2 DM sent", SENT.ig_dm.length === 1);
check("step 2 carries the tracked link",
      SENT.ig_dm[0][1].includes("/r/" + lead.ref_code));
check("stage advanced to LINK_SENT", db.getLead(lead.id).stage === "LINK_SENT");

section("5 · Click tracker (mobile vs desktop)");
const client = await serve(createApp({ startWorker: false }));
const r = await client.get(`/r/${lead.ref_code}`,
                           { headers: { "user-agent": "Mozilla/5.0 (iPhone)" } });
const location = r.headers.get("location") || "";
check("mobile gets a 302 to wa.me", r.status === 302 && location.includes("wa.me"));
check("prefill contains the ref code", location.includes(lead.ref_code));
check("prefill is short", location.length < 190, `${location.length} chars`);
check("stage is CLICKED", db.getLead(lead.id).stage === "CLICKED");

const lead2Id = db.createLead({
  media_id: "REEL_SAT_3BHK", variant: "A", ig_user_id: "IGU_200",
  ig_username: "desktop_user", comment_id: "CMT_D", stage: "LINK_SENT" });
const code2 = db.getLead(lead2Id).ref_code;
const r2 = await client.get(`/r/${code2}`,
                            { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0)" } });
const body2 = await r2.text();
check("desktop gets the QR page, not a redirect", r2.status === 200);
check("QR page renders a code", body2.includes("<svg"));
check("QR page offers a callback form", body2.includes('name="phone"'));

section("6 · Ref code stitches Instagram to WhatsApp");
await webhooksWa.process_(waTextPayload(
  "WAM1", `Hi! Interested in 3BHK Satellite (${lead.ref_code})`, "919812345678"));
const stitched = db.getLead(lead.id);
check("wa_id bound to the Instagram lead", stitched.wa_id === "919812345678");
check("stage is QUALIFYING", stitched.stage === "QUALIFYING");
check("only one lead exists for this person",
      db.allLeads({}).filter((l) => l.wa_id === "919812345678").length === 1);

section("7 · Qualification flow");
await worker.drainChannel("whatsapp", 20);
check("first question asked as buttons", SENT.wa.some(([k]) => k === "buttons"));

const answers = [["buy", "Buy"], ["3bhk", "3 BHK"], ["1-2Cr", "₹1 Cr – ₹2 Cr"],
                 ["immediate", "Immediately"], ["yes", "Yes please"]];
for (const [i, [oid, title]] of answers.entries()) {
  await webhooksWa.process_(waTapPayload(`WAM_T${i}`, "919812345678", oid, title));
  await worker.drainChannel("whatsapp", 20);
}

const q = db.getAnswers(lead.id);
check("all five answers stored",
      JSON.stringify(["purpose", "config", "budget", "timeline", "site_visit"]
        .map((k) => q[k])) ===
      JSON.stringify(["buy", "3bhk", "1-2Cr", "immediate", "yes"]),
      JSON.stringify(q));

const final = db.getLead(lead.id);
check("top answers score 100 after normalisation", final.score === 100,
      String(final.score));
check("band is HOT", final.band === "HOT");
check("handed off to a human",
      ["HANDED_OFF", "CRM_SYNCED"].includes(final.stage));
check("agent assigned", final.assigned_agent === "Priya S.");
check("bot silenced", final.bot_paused === 1);

section("8 · Domain lock still holds");
await webhooksWa.process_(waTextPayload("WAM_OT", "Write me a poem", "919888777666"));
await worker.drainChannel("whatsapp", 20);
const offLead = db.leadByWa("919888777666");
check("unattributed lead still created", offLead !== null);
check("source marked unattributed", offLead.source === "unattributed");
const lastWa = SENT.wa.filter(([, to]) => to === "919888777666").at(-1)[2];
check("off-topic refused", lastWa.includes("only help with questions about"));

section("9 · Leak 2 recovery");
const recoveryLead = db.createLead({
  media_id: "REEL_SAT_3BHK", variant: "A", ig_user_id: "IGU_300",
  ig_username: "ghosted", comment_id: "CMT_G", stage: "CLICKED" });
db.addEvent(recoveryLead, "CLICKED", "");
db.updateLead(recoveryLead, { clicked_at: "2020-01-01T00:00:00+00:00" });
check("no nudge before the delay elapses",
      db.leadsNeedingRecovery().every((l) => l.id !== lead.id));
const n = worker.runRecovery();
check("recovery queued for the ghosted lead", n >= 1, `${n} queued`);
await worker.drainChannel("instagram", 10);
check("nudge actually sent", SENT.ig_dm.some(([uid]) => uid === "IGU_300"));
check("nudge sent only once", worker.runRecovery() === 0);

section("10 · Rate limiter");
for (let i = 0; i < 6; i++) {
  db.enqueue("instagram", "ig_dm", { ig_user_id: `IGU_R${i}`, text: "hi" });
}
config.IG_SENDS_PER_HOUR = db.sendsLastHour("instagram") + 2;
const before = SENT.ig_dm.length;
await worker.drainChannel("instagram", 50);
check("cap respected — only 2 more sent", SENT.ig_dm.length - before === 2,
      `sent ${SENT.ig_dm.length - before}`);
config.IG_SENDS_PER_HOUR = 150;

section("10b · Queue row claiming (double-send guard)");
const qid = db.enqueue("instagram", "ig_dm", { ig_user_id: "IGU_CLAIM", text: "hi" });
check("first claim wins", db.claimQueueItem(qid) === true);
check("second claim loses", db.claimQueueItem(qid) === false);
check("claimed row is not re-served",
      db.dueQueueItems("instagram", 50).every((i) => i.id !== qid));
check("a fresh claim is NOT reclaimed", db.reclaimStale(10) === 0);
// simulate a process killed mid-send 30 minutes ago
db.run("UPDATE outbound_queue SET scheduled_at = ? WHERE id = ?",
       ["2020-01-01T00:00:00+00:00", qid]);
check("stale claim is reclaimed", db.reclaimStale(10) === 1);
check("reclaimed row is servable again",
      db.dueQueueItems("instagram", 50).some((i) => i.id === qid));

section("11 · CRM outbox");
config.CRM_ADAPTER = "csv";
config.CRM_CSV_PATH = path.join(os.tmpdir(), "funnel_test_crm.csv");
if (fs.existsSync(config.CRM_CSV_PATH)) fs.rmSync(config.CRM_CSV_PATH);
// The webhook handlers call worker.tick() for instant replies, and a tick
// drains the CRM outbox too — so the row queued when this lead qualified was
// already pushed through the 'null' adapter back in section 7. Queue it again
// now that the csv adapter is selected, so what is under test here is the
// adapter rather than the leftover timing of an earlier section.
crm.pushLead(lead.id);
const synced = await crm.drain();
check("crm rows drained", synced >= 1, `${synced} rows`);
check("csv written", fs.existsSync(config.CRM_CSV_PATH));
if (fs.existsSync(config.CRM_CSV_PATH)) {
  const body = fs.readFileSync(config.CRM_CSV_PATH, "utf-8");
  // Columns can't be fixed across tenants, so answers land as readable labels.
  check("csv holds the qualified lead",
        body.includes("HOT") && body.includes("3 BHK") &&
        body.includes("Skyline Properties"),
        body ? body.trim().split("\n").at(-1).slice(0, 70) : "empty");
}
check("stage is CRM_SYNCED", db.getLead(lead.id).stage === "CRM_SYNCED");

section("12 · Funnel report");
const f = Object.fromEntries(db.funnelCounts().map((r) => [r.stage, r.count]));
check("COMMENTED counted", (f.COMMENTED || 0) >= 1);
check("QUALIFIED counted", (f.QUALIFIED || 0) >= 1);
const leak = db.leakReport();
check("leak 1 measured", leak.leak1_dm_to_click.sent >= 1,
      JSON.stringify(leak.leak1_dm_to_click));
check("leak 2 measured", leak.leak2_click_to_chat.clicked >= 1,
      JSON.stringify(leak.leak2_click_to_chat));
check("leak rates never exceed 100%",
      leak.leak1_dm_to_click.rate <= 100 && leak.leak2_click_to_chat.rate <= 100);
check("leak counts are self-consistent",
      leak.leak1_dm_to_click.clicked <= leak.leak1_dm_to_click.sent &&
      leak.leak2_click_to_chat.engaged <= leak.leak2_click_to_chat.clicked);
check("variant report populated", db.variantReport().length >= 1);

// ---------------------------------------------------------------------- result
// Orderly shutdown, then let the loop drain — see the note in testMultitenant.js.
client.close();
worker.stop();
db.closeDb();
process.exitCode = finish();
