/**
 * Security, consent and privacy suite.
 *
 * Covers the things that are invisible when they work and expensive when they
 * do not: webhook authenticity, tenant isolation with no guessing, the WhatsApp
 * 24-hour window, opt-out, and deletion actually deleting.
 *
 *     node testSecurity.js
 *
 * No Groq key or Meta credentials required.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import aiEngine from "./src/aiEngine.js";
import config from "./src/config.js";
import * as db from "./src/database.js";
import igapi from "./src/igapi.js";
import * as privacy from "./src/privacy.js";
import { expectedSignature, parseSignedRequest, rateLimiter } from "./src/security.js";
import * as tenants from "./src/tenants.js";
import { normalisePhone } from "./src/tracker.js";
import waapi from "./src/waapi.js";
import * as webhooksIg from "./src/webhooksIg.js";
import * as webhooksWa from "./src/webhooksWa.js";
import * as worker from "./src/worker.js";
import { createApp } from "./src/app.js";
import { reporter, serve } from "./testHelpers.js";

config.DB_PATH = path.join(os.tmpdir(), "sec_test.db");
config.PUBLIC_BASE_URL = "https://s2s.test";
config.WA_BUSINESS_NUMBER = "919000000000";
config.CRM_ADAPTER = "null";
config.SECRET_KEY = "test-secret-key";
config.ADMIN_USER = "admin";
config.ADMIN_PASSWORD = "adminpass";
config.ADMIN_PASSWORD_HASH = "";
config.META_APP_SECRET = "test-app-secret";
config.VERIFY_WEBHOOK_SIGNATURE = true;
config.WA_VERIFY_TOKEN = "wa-verify-token";
config.IG_VERIFY_TOKEN = "ig-verify-token";
config.SINGLE_TENANT_MODE = false;
config.IG_USER_ID = "";
config.WA_ALERT_TEMPLATE = "";
config.WA_REENGAGE_TEMPLATE = "";

for (const stale of [config.DB_PATH, config.DB_PATH + "-wal", config.DB_PATH + "-shm"]) {
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

// ------------------------------------------------------------------- stubbing
const SENT = { ig_private: [], ig_public: [], ig_dm: [], wa: [], template: [] };
igapi.privateReply = (c, t, tid) => { SENT.ig_private.push([c, t, tid]); return [true, ""]; };
igapi.publicReply = (c, t, tid) => { SENT.ig_public.push([c, t, tid]); return [true, ""]; };
igapi.sendDm = (u, t, tid) => { SENT.ig_dm.push([u, t, tid]); return [true, ""]; };
waapi.sendText = (to, t, p = "") => { SENT.wa.push(["text", to, t, p]); return [true, ""]; };
waapi.sendButtons = (to, b, o, p = "") => { SENT.wa.push(["buttons", to, b, p]); return [true, ""]; };
waapi.sendList = (to, b, btn, o, p = "") => { SENT.wa.push(["list", to, b, p]); return [true, ""]; };
waapi.sendTemplate = (to, name, params, p = "") => {
  SENT.template.push([to, name, params, p]); return [true, ""];
};

aiEngine.classify = () => "IN";
aiEngine.generateAnswer = () => "Here are the details.";

const { check, section, finish } = reporter(70);

const igComment = (cid, text, media, uid, user, recipient) => ({
  entry: [{ id: recipient, changes: [{ field: "comments", value: {
    id: cid, text, media: { id: media }, from: { id: uid, username: user } } }] }],
});

const igDm = (mid, text, uid, recipient) => ({
  entry: [{ id: recipient, messaging: [{ sender: { id: uid }, message: { mid, text } }] }],
});

const waText = (mid, text, waId, pnid = "PN_SHARED", name = "Customer") => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: pnid },
    contacts: [{ wa_id: waId, profile: { name } }],
    messages: [{ from: waId, id: mid, type: "text", text: { body: text } }] } }] }],
});

// ================================================================= setup
db.initDb();

const gym = tenants.create({
  name: "Priya Fitness", domain_name: "gym, fitness training and memberships",
  vertical: "gym", ig_user_id: "IG_GYM", ig_username: "priya.fitness",
  portal_user: "priya", password: "priyapass",
  knowledge_base: "Priya Fitness. Monthly ₹2000.",
});
tenants.applyTemplate(gym, "gym");

const prop = tenants.create({
  name: "Skyline Properties", domain_name: "real estate and property services",
  vertical: "real_estate", ig_user_id: "IG_PROP", ig_username: "skyline.props",
  portal_user: "skyline", password: "skylinepass",
  wa_phone_number_id: "PN_SKYLINE",
  knowledge_base: "Skyline Properties. 3BHK ₹1.42 Cr.",
});
tenants.applyTemplate(prop, "real_estate");

db.upsertCampaign({ media_id: "REEL_GYM", tenant_id: gym, name: "6-week transform",
                    keywords: "price,join", property_ref: "6-week program",
                    dm_strategy: "two_step", variant: "A",
                    wa_prefill: "Hi! Interested in {property} ({ref})" });

// ================================================= 1 · webhook authenticity
section("1 · Webhook signature verification");

const client = await serve(createApp({ startWorker: false }));

async function rawPost(path_, bodyObj, { sign = true, secret = config.META_APP_SECRET } = {}) {
  const body = JSON.stringify(bodyObj);
  const headers = { "content-type": "application/json" };
  if (sign) headers["x-hub-signature-256"] = expectedSignature(body, secret);
  return fetch(`${client.base}${path_}`, { method: "POST", headers, body });
}

const unsigned = await rawPost("/ig-webhook",
  igComment("SIG_A", "price", "REEL_GYM", "V1", "a", "IG_GYM"), { sign: false });
check("unsigned IG webhook POST is rejected", unsigned.status === 403,
      `status ${unsigned.status}`);
check("...and created no lead", db.leadByComment("SIG_A") === null);

const forged = await rawPost("/ig-webhook",
  igComment("SIG_B", "price", "REEL_GYM", "V2", "b", "IG_GYM"),
  { secret: "wrong-secret" });
check("wrongly signed IG webhook POST is rejected", forged.status === 403,
      `status ${forged.status}`);
check("...and created no lead", db.leadByComment("SIG_B") === null);

const genuine = await rawPost("/ig-webhook",
  igComment("SIG_C", "price", "REEL_GYM", "V3", "c", "IG_GYM"));
check("correctly signed IG webhook POST is accepted", genuine.status === 200);
await new Promise((r) => setTimeout(r, 60)); // handler runs after the 200
check("...and the lead was created", db.leadByComment("SIG_C") !== null);

const waUnsigned = await rawPost("/webhook",
  waText("SIG_W", "hello", "919800000099"), { sign: false });
check("unsigned WhatsApp webhook POST is rejected", waUnsigned.status === 403);

const waSigned = await rawPost("/webhook", waText("SIG_W2", "hello", "919800000098"));
check("correctly signed WhatsApp webhook POST is accepted", waSigned.status === 200);

section("2 · Subscription handshake");
const badToken = await client.get(
  "/ig-webhook?hub.mode=subscribe&hub.challenge=X&hub.verify_token=my-secret-ig-token-456");
check("the old hardcoded IG token no longer verifies", badToken.status === 403,
      `status ${badToken.status}`);
const crossToken = await client.get(
  `/ig-webhook?hub.mode=subscribe&hub.challenge=X&hub.verify_token=${config.WA_VERIFY_TOKEN}`);
check("the WhatsApp token does not verify the IG webhook", crossToken.status === 403);
const goodToken = await client.get(
  `/ig-webhook?hub.mode=subscribe&hub.challenge=CHAL&hub.verify_token=${config.IG_VERIFY_TOKEN}`);
check("the configured IG token verifies", goodToken.status === 200);
check("...and echoes the challenge", (await goodToken.text()) === "CHAL");

// ================================================= 3 · tenant isolation
section("3 · No guessing which tenant an event belongs to");
config.SINGLE_TENANT_MODE = false;
check("unknown Instagram account resolves to nothing",
      tenants.byInstagram("IG_STRANGER") === null);
check("an empty account id resolves to nothing", tenants.byInstagram("") === null);
check("a known account still resolves", tenants.byInstagram("IG_GYM").id === gym);

check("no ref code and no dedicated number resolves to nothing",
      tenants.resolveForWhatsapp("", "919777000001", "PN_SHARED", "hi") === null);
check("a customer naming a client in their text does NOT route to that client",
      tenants.resolveForWhatsapp("", "919777000002", "PN_SHARED",
                                 "hi priya, is the gym open?") === null);
check("a dedicated number still resolves",
      tenants.resolveForWhatsapp("", "919777000003", "PN_SKYLINE", "hi").id === prop);

config.SINGLE_TENANT_MODE = true;
check("single-tenant mode refuses to guess while 2 tenants are active",
      tenants.byInstagram("IG_STRANGER") === null);
tenants.update(prop, { active: 0 });
check("single-tenant mode falls back once only ONE tenant is active",
      tenants.byInstagram("IG_STRANGER")?.id === gym);
tenants.update(prop, { active: 1 });
config.SINGLE_TENANT_MODE = false;

section("4 · Instagram DM replies are scoped to their own tenant");
// The same viewer engages with both clients; the older lead must still resolve.
db.upsertCampaign({ media_id: "REEL_PROP", tenant_id: prop, name: "Satellite 3BHK",
                    keywords: "price,info", property_ref: "3BHK Satellite",
                    dm_strategy: "two_step", variant: "A",
                    wa_prefill: "Hi! Interested in {property} ({ref})" });
webhooksIg.process_(igComment("C_BOTH_1", "price", "REEL_GYM", "VIEWER_X", "x", "IG_GYM"));
webhooksIg.process_(igComment("C_BOTH_2", "price", "REEL_PROP", "VIEWER_X", "x", "IG_PROP"));
const gymLead = db.leadByComment("C_BOTH_1");
const propLead = db.leadByComment("C_BOTH_2");
check("both leads exist for one viewer", Boolean(gymLead) && Boolean(propLead));
check("unscoped lookup returns only the newest",
      db.leadByIgUser("VIEWER_X").id === propLead.id);
check("scoped lookup finds the gym's lead", db.leadByIgUser("VIEWER_X", gym).id === gymLead.id);
check("scoped lookup finds the property's lead",
      db.leadByIgUser("VIEWER_X", prop).id === propLead.id);

const dmBefore = db.getLead(gymLead.id).stage;
webhooksIg.process_(igDm("MID_X", "price list please", "VIEWER_X", "IG_GYM"));
check("the older client's step-2 DM is still delivered",
      db.getLead(gymLead.id).stage !== dmBefore ||
      db.leadEvents(gymLead.id).some((e) => e.type === "DM_REPLIED"),
      `stage ${db.getLead(gymLead.id).stage}`);

// ================================================= 5 · campaign attribution
section("5 · An unregistered reel is tracked as itself");
webhooksIg.process_(igComment("C_NEW", "price", "REEL_BRAND_NEW", "V_NEW", "n", "IG_GYM"));
const newLead = db.leadByComment("C_NEW");
check("a lead was still created", newLead !== null);
check("attributed to the ACTUAL reel, not the one it borrowed copy from",
      newLead.media_id === "REEL_BRAND_NEW", String(newLead?.media_id));
check("a campaign row now exists for the real reel",
      db.getCampaign("REEL_BRAND_NEW") !== null);
check("...owned by the right tenant", db.getCampaign("REEL_BRAND_NEW").tenant_id === gym);

db.upsertCampaign({ media_id: "REEL_OFF", tenant_id: gym, name: "paused reel",
                    keywords: "price", active: 0 });
check("a deactivated campaign does not match",
      db.matchCampaign("REEL_OFF", "price please", gym) === null);

// ================================================= 6 · dedup claim/release
section("6 · Event dedup claims and releases");
check("first claim wins", db.claimEvent("evt:1") === true);
check("second claim loses", db.claimEvent("evt:1") === false);
db.releaseEvent("evt:1");
check("a released event can be claimed again", db.claimEvent("evt:1") === true);
check("an unmatched comment does not consume its event id",
      (() => {
        webhooksIg.process_(
          igComment("C_NOKW", "nice video", "REEL_GYM", "V_NK", "nk", "IG_GYM"));
        return db.wasProcessed("cmt:C_NOKW") === false;
      })());
check("a comment on an unknown account does not consume its event id",
      (() => {
        webhooksIg.process_(
          igComment("C_UNK", "price", "REEL_GYM", "V_U", "u", "IG_NOBODY"));
        return db.wasProcessed("cmt:C_UNK") === false;
      })());
db.run("INSERT OR REPLACE INTO processed_events (event_id, processed_at) VALUES (?, ?)",
       ["evt:old", "2020-01-01T00:00:00+00:00"]);
check("expired dedup rows are pruned", db.pruneProcessedEvents(7) >= 1);
check("...and recent ones are kept", db.wasProcessed("evt:1") === true);

// ================================================= 7 · 24-hour window
section("7 · WhatsApp 24-hour window");
const winLead = db.createLead({
  tenant_id: gym, wa_id: "919700000001", name: "Window Test",
  stage: "WA_ENGAGED", source: "instagram",
});
db.markInbound(winLead);
check("a lead that just messaged has an open window",
      db.isWindowOpen(db.getLead(winLead)) === true);

db.enqueue("whatsapp", "wa_text",
           { to: "919700000001", text: "inside the window", tenant_id: gym }, winLead);
await worker.drainChannel("whatsapp", 10);
check("a send inside the window goes out",
      SENT.wa.some(([, to, t]) => to === "919700000001" && t === "inside the window"));

db.run("UPDATE leads SET last_inbound_at = ?, wa_started_at = ? WHERE id = ?",
       ["2020-01-01T00:00:00+00:00", "2020-01-01T00:00:00+00:00", winLead]);
check("a stale lead has a closed window",
      db.isWindowOpen(db.getLead(winLead)) === false);

const staleId = db.enqueue("whatsapp", "wa_text",
                           { to: "919700000001", text: "outside the window", tenant_id: gym },
                           winLead);
await worker.drainChannel("whatsapp", 10);
check("a free-form send outside the window is NOT attempted",
      !SENT.wa.some(([, , t]) => t === "outside the window"));
const staleRow = db.row("SELECT * FROM outbound_queue WHERE id = ?", [staleId]);
check("...it is cancelled, not retried forever", staleRow.status === "cancelled",
      `${staleRow.status} after ${staleRow.attempts} attempt(s)`);
check("...with a diagnosable reason", /131047/.test(staleRow.last_error || ""),
      String(staleRow.last_error).slice(0, 60));

config.WA_REENGAGE_TEMPLATE = "reengage_v1";
db.enqueue("whatsapp", "wa_text",
           { to: "919700000001", text: "please come back", tenant_id: gym }, winLead);
await worker.drainChannel("whatsapp", 10);
check("with a template configured, the closed window uses it instead",
      SENT.template.some(([to, name]) => to === "919700000001" && name === "reengage_v1"));
config.WA_REENGAGE_TEMPLATE = "";

const agentLead = db.getLead(winLead);
db.enqueue("whatsapp", "wa_text",
           { to: "919999888877", text: "agent alert", tenant_id: gym }, agentLead.id);
await worker.drainChannel("whatsapp", 10);
check("an alert to a DIFFERENT number is not blocked by the lead's window",
      SENT.wa.some(([, to, t]) => to === "919999888877" && t === "agent alert"));

config.WA_ALERT_TEMPLATE = "lead_alert_v1";
db.addAgent("Gym Agent", "919000000001", gym);
const hotLead = db.createLead({ tenant_id: gym, wa_id: "919700000002",
                                stage: "QUALIFIED", score: 90, band: "HOT" });
db.markInbound(hotLead);
const leadsMod = await import("./src/leads.js");
leadsMod.handOff(hotLead, "test handoff");
await worker.drainChannel("whatsapp", 10);
check("the agent alert goes out as an approved template",
      SENT.template.some(([to, name]) => to === "919000000001" && name === "lead_alert_v1"));
config.WA_ALERT_TEMPLATE = "";

// ================================================= 8 · opt-out
section("8 · Opt-out is honoured");
await webhooksWa.process_(waText("OO_1", "Hi, price?", "919600000001", "PN_SKYLINE"));
const ooLead = db.leadByWa("919600000001");
check("lead created for the customer", ooLead !== null);

await webhooksWa.process_(waText("OO_2", "STOP", "919600000001", "PN_SKYLINE"));
check("the customer is marked opted out", db.isOptedOut("919600000001") === true);
check("a confirmation was still sent",
      SENT.wa.some(([, to, t]) => to === "919600000001" && t === config.OPT_OUT_MESSAGE));
check("the opt-out is recorded on the lead",
      db.leadEvents(ooLead.id).some((e) => e.type === "OPTED_OUT"));

const beforeOptOut = SENT.wa.length;
db.enqueue("whatsapp", "wa_text",
           { to: "919600000001", text: "should never send", tenant_id: prop }, ooLead.id);
await worker.drainChannel("whatsapp", 10);
check("nothing further is sent to them",
      !SENT.wa.slice(beforeOptOut).some(([, , t]) => t === "should never send"));

// Scoped to what is sent AFTER this point. Scanning the whole history was
// wrong: the webhook handlers now tick the worker inline, so the reply to this
// contact's very first message (before they opted out) has legitimately been
// delivered and would match forever.
const beforeLaterMessage = SENT.wa.length;
await webhooksWa.process_(waText("OO_3", "do you have 3bhk?", "919600000001", "PN_SKYLINE"));
await worker.drainChannel("whatsapp", 10);
check("a later message gets no automated reply",
      !SENT.wa.slice(beforeLaterMessage).some(([, to]) => to === "919600000001"),
      JSON.stringify(SENT.wa.slice(beforeLaterMessage).map((x) => x[2]?.slice(0, 30))));
check("...but is still recorded for the agent",
      db.leadEvents(ooLead.id).some((e) => e.type === "INBOUND_WHILE_OPTED_OUT"));

await webhooksWa.process_(waText("OO_4", "start", "919600000001", "PN_SKYLINE"));
check("START opts them back in", db.isOptedOut("919600000001") === false);

check("'stop by at 6' is not treated as an opt-out", (() => {
  const before = db.isOptedOut("919600000009");
  webhooksWa.process_(waText("OO_5", "can I stop by at 6?", "919600000009", "PN_SKYLINE"));
  return before === db.isOptedOut("919600000009");
})());

// ================================================= 9 · deletion
section("9 · Deletion actually deletes");
const delLead = db.createLead({ tenant_id: gym, wa_id: "919500000001",
                                ig_user_id: "IG_DEL", ig_username: "deleteme",
                                stage: "QUALIFIED" });
db.saveMessage(delLead, "whatsapp", "user", "my private message");
db.saveAnswer(delLead, "goal", "muscle", "Build muscle", 15);
db.addEvent(delLead, "COMMENTED", "test");
db.enqueue("whatsapp", "wa_text", { to: "919500000001", text: "queued" }, delLead);
db.crmEnqueue(delLead, "upsert", { lead_id: delLead });

const removed = db.purgeLead(delLead);
check("the lead row is gone", db.getLead(delLead) === null);
check("its messages are gone", db.leadMessages(delLead).length === 0);
check("its answers are gone", Object.keys(db.getAnswers(delLead)).length === 0);
check("its events are gone", db.leadEvents(delLead).length === 0);
check("its queued sends are gone",
      db.row("SELECT COUNT(*) AS n FROM outbound_queue WHERE lead_id = ?", [delLead]).n === 0);
check("its CRM rows are gone",
      db.row("SELECT COUNT(*) AS n FROM crm_outbox WHERE lead_id = ?", [delLead]).n === 0,
      JSON.stringify(removed));

const subj = db.createLead({ tenant_id: gym, wa_id: "919500000002",
                             ig_username: "SubjectUser", stage: "WA_ENGAGED" });
check("purge by instagram username is case-insensitive",
      db.purgeSubject({ igUsername: "@subjectuser" }).includes(subj));

section("10 · Meta's data deletion callback");
const noSig = await client.post("/data-deletion", { form: { signed_request: "garbage" } });
check("an unverifiable signed_request is refused", noSig.status === 400,
      `status ${noSig.status}`);

const victim = db.createLead({ tenant_id: gym, ig_user_id: "IG_VICTIM",
                              ig_username: "victim", stage: "COMMENTED" });
const payload = Buffer.from(JSON.stringify({ user_id: "IG_VICTIM" })).toString("base64url");
const sig = crypto.createHmac("sha256", config.META_APP_SECRET)
  .update(payload).digest("base64url");
const del = await client.post("/data-deletion",
                             { form: { signed_request: `${sig}.${payload}` } });
check("a correctly signed callback is accepted", del.status === 200);
const delBody = await del.json();
check("it returns a confirmation code", Boolean(delBody.confirmation_code));
check("it returns a status URL", String(delBody.url).includes("/data-deletion/status/"));
check("the user's data is actually gone", db.getLead(victim) === null);
const status = await client.get(`/data-deletion/status/${delBody.confirmation_code}`);
check("the status URL resolves", status.status === 200);
check("signed_request parsing rejects a tampered payload",
      parseSignedRequest(`${sig}.${Buffer.from('{"user_id":"OTHER"}').toString("base64url")}`)
        === null);

// ================================================= 11 · admin auth
section("11 · Admin authentication");
const authMod = await import("./src/auth.js");
authMod.loginLimiter.clear();

const savedPassword = config.ADMIN_PASSWORD;
config.ADMIN_PASSWORD = "";
config.ADMIN_PASSWORD_HASH = "";
const noPw = await client.post("/login", { form: { username: "admin", password: "admin" } });
check("with no admin password configured, admin/admin is refused", noPw.status === 401);
const emptyPw = await client.post("/login", { form: { username: "admin", password: "" } });
check("...and an empty password is refused", emptyPw.status === 401);
config.ADMIN_PASSWORD = savedPassword;
authMod.loginLimiter.clear();

const { generatePasswordHash } = await import("./src/passwords.js");
config.ADMIN_PASSWORD_HASH = generatePasswordHash("hashed-pass");
config.ADMIN_PASSWORD = "";
const hashOk = await client.post("/login",
                                 { form: { username: "admin", password: "hashed-pass" } });
check("a hashed admin password authenticates", hashOk.status === 302,
      `status ${hashOk.status}`);
await client.get("/logout");
const hashBad = await client.post("/login",
                                  { form: { username: "admin", password: "wrong" } });
check("...and a wrong one does not", hashBad.status === 401);
config.ADMIN_PASSWORD_HASH = "";
config.ADMIN_PASSWORD = savedPassword;
authMod.loginLimiter.clear();

let limited = 0;
for (let i = 0; i < 14; i++) {
  const r = await client.post("/login",
                              { form: { username: "bruteforce", password: `guess${i}` } });
  if (r.status === 429) limited += 1;
}
check("password guessing is rate limited", limited > 0, `${limited} of 14 throttled`);
authMod.loginLimiter.clear();

section("12 · Rate limiter mechanics");
const rl = rateLimiter({ windowMs: 1000, max: 2, name: "test" });
check("first request allowed", rl.consume("k", 0).allowed === true);
check("second request allowed", rl.consume("k", 0).allowed === true);
check("third request blocked", rl.consume("k", 0).allowed === false);
check("a different key is unaffected", rl.consume("other", 0).allowed === true);
check("the window resets", rl.consume("k", 2000).allowed === true);

// ================================================= 13 · misc hardening
section("13 · Phone normalisation");
check("a bare 10-digit number gains its country code",
      normalisePhone("9876543210") === "919876543210");
check("a trunk zero is replaced", normalisePhone("09876543210") === "919876543210");
check("punctuation is stripped", normalisePhone("+91 98765-43210") === "919876543210");
check("a 00 international prefix is handled",
      normalisePhone("00919876543210") === "919876543210");
check("an already-qualified number is unchanged",
      normalisePhone("919876543210") === "919876543210");
check("too short is rejected", normalisePhone("12345") === null);
check("too long is rejected", normalisePhone("1234567890123456789") === null);
check("empty is rejected", normalisePhone("") === null);

section("14 · /health leaks nothing");
const health = await (await client.get("/health")).json();
check("health responds ok", health.status === "ok");
check("queue detail is no longer public", !("queue" in health), JSON.stringify(health));
check("signature state is reported", health.webhook_signature === "enforced");

section("15 · Free-text answers match on whole words only");
// Substring matching recorded answers the customer never gave: with options
// yes/maybe/no, "i don't know" matched "no" inside "k-no-w".
const flows = await import("./src/flows.js");
const yesNo = { options: [["yes", "Yes please"], ["maybe", "Maybe later"], ["no", "Not yet"]] };
const buyRent = { options: [["buy", "Buy"], ["rent", "Rent"], ["invest", "Invest"]] };
const bhk = { options: [["1bhk", "1 BHK"], ["3bhk", "3 BHK"], ["plot", "Plot / Land"]] };

const m = (step, t) => flows.matchOption(step, t)?.[0] ?? null;
check("an exact option id matches", m(yesNo, "yes") === "yes");
check("an exact option title matches", m(yesNo, "Yes please") === "yes");
check("case and padding are ignored", m(yesNo, "  MAYBE  ") === "maybe");
check("'i don't know' is NOT read as 'no'", m(yesNo, "i don't know") === null,
      String(m(yesNo, "i don't know")));
check("'not now' is NOT read as 'no'", m(yesNo, "not now") === null,
      String(m(yesNo, "not now")));
check("'nothing yet' is NOT read as 'no'", m(yesNo, "nothing yet") === null);
check("a whole-word answer in a sentence still matches",
      m(buyRent, "i want to buy") === "buy");
check("an ambiguous message naming two options is refused",
      m(buyRent, "should i buy or rent?") === null,
      String(m(buyRent, "should i buy or rent?")));
check("a multi-word title matches", m(bhk, "3 BHK please") === "3bhk");
check("a title with punctuation matches", m(bhk, "plot / land") === "plot");
check("unrelated text matches nothing", m(bhk, "what are your timings?") === null);
check("empty text matches nothing", m(yesNo, "") === null);

section("16 · The worker never runs two passes at once");
// The webhook handlers call tick() inline for instant replies. Overlapping
// passes double-push the CRM outbox, double-send recovery nudges, and each
// grant themselves a full hourly budget.
const inFlight = worker.tick();          // not awaited: still running
const reentrant = await worker.tick();   // must be refused
check("a re-entrant tick is skipped", reentrant?.skipped === true,
      JSON.stringify(reentrant));
const firstResult = await inFlight;
check("the pass already running still completes", firstResult?.skipped !== true,
      JSON.stringify(Object.keys(firstResult || {})));
const afterwards = await worker.tick();
check("ticks work again once the pass finishes", afterwards?.skipped !== true);

section("17 · Meta's response data is recorded against the lead");
// A 200 from Meta means ACCEPTED, not delivered — the real outcome arrives
// later as a `statuses` webhook keyed on the wamid. Capturing that id is what
// makes an accepted-then-undelivered message traceable at all.
const traceLead = db.createLead({ tenant_id: gym, wa_id: "919400000001",
                                  stage: "WA_ENGAGED", source: "instagram" });
db.markInbound(traceLead);

waapi.sendText = (to, t, p = "") => {
  SENT.wa.push(["text", to, t, p]);
  return [true, "", { status: 200, message_id: "wamid.TRACE1", dry_run: false }];
};
db.enqueue("whatsapp", "wa_text", { to: "919400000001", text: "hi", tenant_id: gym }, traceLead);
await worker.drainChannel("whatsapp", 10);
const accepted = db.leadEvents(traceLead).find((e) => e.type === "WA_ACCEPTED");
check("the wamid Meta returned is stored on the lead",
      Boolean(accepted) && accepted.detail.includes("wamid.TRACE1"),
      accepted ? accepted.detail : "no WA_ACCEPTED event");

// No token configured means post() reports success without sending anything.
// That marks the row 'sent', so it has to be distinguishable from a delivery.
waapi.sendText = (to, t, p = "") => {
  SENT.wa.push(["text", to, t, p]);
  return [true, "dry run", { dry_run: true, status: 0 }];
};
db.enqueue("whatsapp", "wa_text", { to: "919400000001", text: "hi again", tenant_id: gym }, traceLead);
await worker.drainChannel("whatsapp", 10);
check("a dry run is recorded as such, not as a delivery",
      db.leadEvents(traceLead).some((e) => e.type === "WA_DRY_RUN"));

// ------------------------------------------------------------------- shutdown
client.close();
worker.stop();
db.closeDb();
process.exitCode = finish();
