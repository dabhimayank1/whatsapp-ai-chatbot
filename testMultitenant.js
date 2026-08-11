/**
 * Multi-tenant isolation test.
 *
 * Two influencers in different verticals share ONE WhatsApp number. Proves:
 *
 *   * each bot refuses the other's topic (per-tenant domain lock)
 *   * each asks its own questions with its own scoring
 *   * the ref code alone routes a lead to the right tenant on a shared number
 *   * a tenant on a dedicated number routes by phone_number_id
 *   * an influencer's portal login cannot see another influencer's leads
 *
 *     node testMultitenant.js
 *
 * No Groq key or Meta credentials required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import aiEngine from "./src/aiEngine.js";
import config from "./src/config.js";
import * as db from "./src/database.js";
import igapi from "./src/igapi.js";
import * as tenants from "./src/tenants.js";
import waapi from "./src/waapi.js";
import * as webhooksIg from "./src/webhooksIg.js";
import * as webhooksWa from "./src/webhooksWa.js";
import * as worker from "./src/worker.js";
import { createApp } from "./src/app.js";
import { reporter, serve } from "./testHelpers.js";

config.DB_PATH = path.join(os.tmpdir(), "mt_test.db");
config.PUBLIC_BASE_URL = "https://s2s.test";
config.WA_BUSINESS_NUMBER = "919000000000";
config.CRM_ADAPTER = "null";
config.ADMIN_USER = "admin";
config.ADMIN_PASSWORD = "adminpass";
config.SECRET_KEY = "test-secret-key";

for (const stale of [config.DB_PATH, config.DB_PATH + "-wal", config.DB_PATH + "-shm"]) {
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

// ------------------------------------------------------------------- stubbing
const SENT = { ig_private: [], ig_public: [], ig_dm: [], wa: [] };
igapi.privateReply = (c, t, tid) => { SENT.ig_private.push([c, t, tid]); return [true, ""]; };
igapi.publicReply = (c, t, tid) => { SENT.ig_public.push([c, t, tid]); return [true, ""]; };
igapi.sendDm = (u, t, tid) => { SENT.ig_dm.push([u, t, tid]); return [true, ""]; };
waapi.sendText = (to, t, p = "") => { SENT.wa.push(["text", to, t, p]); return [true, ""]; };
waapi.sendButtons = (to, b, o, p = "") => { SENT.wa.push(["buttons", to, b, p]); return [true, ""]; };
waapi.sendList = (to, b, btn, o, p = "") => { SENT.wa.push(["list", to, b, p]); return [true, ""]; };

// The classifier answers according to the tenant's own domain — exactly what
// the real model does, without needing a Groq key.
const GYM_WORDS = ["gym", "workout", "fitness", "trainer", "membership", "weight"];
const PROP_WORDS = ["bhk", "flat", "property", "apartment", "possession", "carpet"];

aiEngine.classify = (message, tenant = null) => {
  const m = message.toLowerCase();
  const dom = (tenant || {}).domain_name || "";
  if (["hi", "hello", "thanks"].some((w) => m.includes(w)) && m.length < 12) return "CHAT";
  if (dom.includes("gym") || dom.includes("fitness")) {
    return GYM_WORDS.some((w) => m.includes(w)) ? "IN" : "OUT";
  }
  if (dom.includes("real estate") || dom.includes("property")) {
    return PROP_WORDS.some((w) => m.includes(w)) ? "IN" : "OUT";
  }
  return "OUT";
};
aiEngine.generateAnswer = (lid, m, t = null) =>
  `[${(t || {}).name || "unknown"}] here are the details you asked for.`;

const { check, section, finish } = reporter(70);

const waText = (mid, text, waId, pnid = "PN_SHARED", name = "Customer") => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: pnid },
    contacts: [{ wa_id: waId, profile: { name } }],
    messages: [{ from: waId, id: mid, type: "text", text: { body: text } }] } }] }],
});

const waTap = (mid, waId, oid, title, pnid = "PN_SHARED") => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: pnid },
    contacts: [{ wa_id: waId, profile: { name: "Customer" } }],
    messages: [{ from: waId, id: mid, type: "interactive",
                 interactive: { type: "button_reply",
                                button_reply: { id: oid, title } } }] } }] }],
});

const igComment = (cid, text, media, uid, user, recipient) => ({
  entry: [{ id: recipient, changes: [{ field: "comments", value: {
    id: cid, text, media: { id: media }, from: { id: uid, username: user } } }] }],
});

// ================================================================ setup
db.initDb();

const gym = tenants.create({
  name: "Priya Fitness", domain_name: "gym, fitness training and memberships",
  vertical: "gym", ig_user_id: "IG_GYM", ig_username: "priya.fitness",
  ig_token: "TOK_GYM", portal_user: "priya", password: "priyapass",
  knowledge_base: "Priya Fitness. Monthly ₹2000. Open 5am-10pm. Personal training ₹8000/mo.",
});
tenants.applyTemplate(gym, "gym");

const prop = tenants.create({
  name: "Skyline Properties", domain_name: "real estate and property services",
  vertical: "real_estate", ig_user_id: "IG_PROP", ig_username: "skyline.props",
  ig_token: "TOK_PROP", portal_user: "skyline", password: "skylinepass",
  wa_phone_number_id: "PN_SKYLINE", wa_business_number: "919111111111",
  knowledge_base: "Skyline Properties. 3BHK Satellite ₹1.42 Cr. Possession ready.",
});
tenants.applyTemplate(prop, "real_estate");

db.addAgent("Gym Agent", "919000000001", gym);
db.addAgent("Prop Agent", "919000000002", prop);

db.upsertCampaign({ media_id: "REEL_GYM", tenant_id: gym, name: "6-week transform",
                    keywords: "price,join", property_ref: "6-week program",
                    dm_strategy: "two_step", variant: "A",
                    wa_prefill: "Hi! Interested in {property} ({ref})" });
db.upsertCampaign({ media_id: "REEL_PROP", tenant_id: prop, name: "Satellite 3BHK",
                    keywords: "price,info", property_ref: "3BHK Satellite",
                    dm_strategy: "two_step", variant: "A",
                    wa_prefill: "Hi! Interested in {property} ({ref})" });

section("1 · Tenants isolated at the data layer");
check("two tenants exist", tenants.allTenants().length === 2);
check("gym has its own questions", tenants.questions(gym).length === 5);
check("property has its own questions", tenants.questions(prop).length === 5);
check("question sets differ",
      JSON.stringify(tenants.questions(gym).map((q) => q.key)) !==
      JSON.stringify(tenants.questions(prop).map((q) => q.key)),
      `${JSON.stringify(tenants.questions(gym).map((q) => q.key).slice(0, 3))} vs ` +
      `${JSON.stringify(tenants.questions(prop).map((q) => q.key).slice(0, 3))}`);
check("gym resolves by its Instagram id", tenants.byInstagram("IG_GYM").id === gym);
check("property resolves by its Instagram id", tenants.byInstagram("IG_PROP").id === prop);

section("2 · Instagram comments route to the right tenant");
await webhooksIg.process_(
  igComment("C_GYM", "price please", "REEL_GYM", "VIEWER_1", "rahul", "IG_GYM"));
await webhooksIg.process_(
  igComment("C_PROP", "price please", "REEL_PROP", "VIEWER_2", "sneha", "IG_PROP"));
const gl = db.leadByComment("C_GYM");
const pl = db.leadByComment("C_PROP");
check("gym lead tagged to gym tenant", Boolean(gl) && gl.tenant_id === gym);
check("property lead tagged to property tenant", Boolean(pl) && pl.tenant_id === prop);

await worker.drainChannel("instagram", 20);
const credsUsed = new Set(SENT.ig_private.map(([, , t]) => t));
check("each DM sent with its own tenant credentials",
      credsUsed.size === 2 && credsUsed.has(gym) && credsUsed.has(prop),
      JSON.stringify([...credsUsed]));

section("3 · A comment on an unknown Instagram account is ignored");
let before = SENT.ig_private.length;
await webhooksIg.process_(
  igComment("C_X", "price", "REEL_GYM", "V9", "x", "IG_STRANGER"));
await worker.drainChannel("instagram", 20);
check("no lead created", db.leadByComment("C_X") === null);
check("nothing sent", SENT.ig_private.length === before);

section("4 · Cross-tenant campaign is refused");
before = SENT.ig_private.length;
// The gym's reel, but the event arrives on the property account.
await webhooksIg.process_(
  igComment("C_CROSS", "price", "REEL_GYM", "V8", "y", "IG_PROP"));
await worker.drainChannel("instagram", 20);
check("cross-tenant comment rejected", db.leadByComment("C_CROSS") === null);
check("nothing sent", SENT.ig_private.length === before);

section("5 · Shared WhatsApp number — ref code alone routes the lead");
const gymRef = gl.ref_code;
const propRef = pl.ref_code;
await webhooksWa.process_(
  waText("W1", `Hi! Interested in 6-week program (${gymRef})`, "919800000001", "PN_SHARED"));
await webhooksWa.process_(
  waText("W2", `Hi! Interested in 3BHK Satellite (${propRef})`, "919800000002", "PN_SHARED"));
const g2 = db.getLead(gl.id);
const p2 = db.getLead(pl.id);
check("gym customer bound to gym lead", g2.wa_id === "919800000001");
check("property customer bound to property lead", p2.wa_id === "919800000002");
check("both arrived on the SAME number, still separated",
      g2.tenant_id === gym && p2.tenant_id === prop);

section("6 · Each bot asks its OWN questions");
await worker.drainChannel("whatsapp", 40);
const gymQs = SENT.wa.filter(([, to]) => to === "919800000001").map((x) => x[2]);
const propQs = SENT.wa.filter(([, to]) => to === "919800000002").map((x) => x[2]);
check("gym asked about fitness goals",
      gymQs.some((b) => b.toLowerCase().includes("fitness goal")),
      JSON.stringify(gymQs.at(-1).slice(0, 48)));
check("property asked about buy/rent/invest",
      propQs.some((b) => b.toLowerCase().includes("buy") && b.toLowerCase().includes("rent")),
      JSON.stringify(propQs.at(-1).slice(0, 48)));
check("neither was asked the other's question",
      !gymQs.some((b) => b.toLowerCase().includes("bhk")) &&
      !propQs.some((b) => b.toLowerCase().includes("fitness")));

section("7 · Domain lock is per tenant");
await webhooksWa.process_(
  waText("W3", "what BHK flats do you have?", "919800000001", "PN_SHARED"));
await worker.drainChannel("whatsapp", 40);
const lastGym = SENT.wa.filter(([, to]) => to === "919800000001").at(-1)[2];
check("gym bot refuses a property question",
      lastGym.includes("only help with questions about"), lastGym.slice(0, 56));

await webhooksWa.process_(
  waText("W4", "do you have a gym membership?", "919800000002", "PN_SHARED"));
await worker.drainChannel("whatsapp", 40);
const lastProp = SENT.wa.filter(([, to]) => to === "919800000002").at(-1)[2];
check("property bot refuses a fitness question",
      lastProp.includes("only help with questions about"), lastProp.slice(0, 56));
check("each refusal names its own business",
      lastGym.includes("Priya Fitness") && lastProp.includes("Skyline Properties"));

section("8 · Dedicated number routes without a ref code");
await webhooksWa.process_(
  waText("W5", "3bhk carpet area?", "919777000009", "PN_SKYLINE"));
const direct = db.leadByWa("919777000009");
check("resolved by phone_number_id alone", Boolean(direct) && direct.tenant_id === prop,
      `tenant=${direct ? direct.tenant_id : null}`);

section("9 · Per-tenant scoring, normalised");
const gymAnswers = [["weight-loss", "Weight loss"], ["beginner", "Complete beginner"],
                    ["annual", "Annual"], ["now", "This week"], ["yes", "Yes please"]];
for (const [i, [oid, title]] of gymAnswers.entries()) {
  await webhooksWa.process_(waTap(`T${i}`, "919800000001", oid, title, "PN_SHARED"));
  await worker.drainChannel("whatsapp", 40);
}

const finalGym = db.getLead(gl.id);
const answers = db.getAnswers(gl.id);
check("all five gym answers stored", Object.keys(answers).length === 5,
      JSON.stringify(answers));
check("score normalised to 0-100", finalGym.score >= 0 && finalGym.score <= 100,
      String(finalGym.score));
check("perfect answers score 100", finalGym.score === 100, String(finalGym.score));
check("band is HOT", finalGym.band === "HOT");
check("assigned to the GYM agent, not the property one",
      finalGym.assigned_agent === "Gym Agent", String(finalGym.assigned_agent));

section("10 · Portal scoping — the security boundary");
const client = await serve(createApp({ startWorker: false }));

check("anonymous is refused", (await client.get("/api/leads")).status === 401);

await client.post("/login", { form: { username: "priya", password: "priyapass" } });
const mine = await client.getJson("/api/leads");
check("influencer sees only their own leads",
      mine.every((l) => l.tenant_id === gym), `${mine.length} leads`);
check("influencer sees at least one lead", mine.length >= 1);
check("influencer CANNOT open another tenant's lead",
      (await client.get(`/api/leads/${pl.id}`)).status === 404);
check("influencer CANNOT read another tenant's settings",
      (await client.get(`/api/tenants/${prop}`)).status === 403);
check("influencer CANNOT edit another tenant's questions",
      (await client.post(`/api/tenants/${prop}/questions`, {
        json: { questions: [{ key: "x", question: "?", options: [["a", "A"]] }] },
      })).status === 403);
check("influencer CANNOT widen scope with ?tenant=",
      (await client.getJson(`/api/leads?tenant=${prop}`)).every((l) => l.tenant_id === gym));
check("influencer CANNOT create clients",
      (await client.post("/api/tenants", { json: { name: "x", domain_name: "y" } })).status === 403);
check("influencer CANNOT run the worker",
      (await client.post("/api/worker/tick")).status === 403);

const tok = (await client.getJson(`/api/tenants/${gym}`)).tenant;
check("own Instagram token never leaves the server", !("ig_token" in tok));
check("password hash never leaves the server", !("portal_password" in tok));

section("11 · Admin sees across tenants");
await client.get("/logout");
await client.post("/login", { form: { username: "admin", password: "adminpass" } });
const allLeads = await client.getJson("/api/leads");
const seen = new Set(allLeads.map((l) => l.tenant_id));
check("admin sees both tenants' leads", seen.has(gym) && seen.has(prop),
      JSON.stringify([...seen]));
check("admin can scope to one client",
      (await client.getJson(`/api/leads?tenant=${gym}`)).every((l) => l.tenant_id === gym));
check("admin funnel scopes per client",
      (await client.getJson(`/api/funnel?tenant=${gym}`)).funnel[0].count >= 1);

section("12 · Editing questions takes effect immediately");
await client.post(`/api/tenants/${gym}/questions`, { json: { questions: [
  { key: "budget_pm", question: "Monthly budget?", qtype: "button",
    options: [["low", "Under ₹2000"], ["high", "Above ₹2000"]],
    score_map: { low: 10, high: 40 } }] } });
const qs = tenants.questions(gym);
check("question set replaced", qs.length === 1 && qs[0].key === "budget_pm");
check("max score recalculated", tenants.maxScore(gym) === 40, String(tenants.maxScore(gym)));
check("over-10-option sets are rejected",
      (await client.post(`/api/tenants/${gym}/questions`, { json: { questions: [
        { key: "x", question: "?",
          options: Array.from({ length: 11 }, (_, i) => [String(i), String(i)]) }] } })).status === 400);

client.close();
process.exit(finish());
