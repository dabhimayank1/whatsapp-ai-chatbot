/**
 * Primary tenant seeding and first-inbound routing.
 *
 * Guards the production failure this was written for: Render runs with
 * NODE_ENV=production on an empty disk, the demo seed is skipped there, and an
 * inbound "Hi" resolved to no tenant — so the customer got a generic reply and
 * no qualification questions at all.
 *
 *     node testSeed.js
 *
 * No Groq key or Meta credentials required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set BEFORE importing anything: this is the environment the bug appeared in.
process.env.NODE_ENV = "production";

import aiEngine from "./src/aiEngine.js";
import config from "./src/config.js";
import * as db from "./src/database.js";
import * as tenants from "./src/tenants.js";
import waapi from "./src/waapi.js";
import * as webhooksWa from "./src/webhooksWa.js";
import * as worker from "./src/worker.js";
import { reporter } from "./testHelpers.js";

config.DB_PATH = path.join(os.tmpdir(), "seed_test.db");
config.PUBLIC_BASE_URL = "https://s2s.test";
config.CRM_ADAPTER = "null";
config.SECRET_KEY = "test-secret-key";
config.SEED_PRIMARY_TENANT = true;
config.SINGLE_TENANT_MODE = false;

for (const stale of [config.DB_PATH, config.DB_PATH + "-wal", config.DB_PATH + "-shm"]) {
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

const SENT = [];
waapi.sendText = (to, t) => { SENT.push(["text", to, t]); return [true, "", { message_id: "wamid.1" }]; };
waapi.sendButtons = (to, b, o) => { SENT.push(["buttons", to, b, o]); return [true, "", { message_id: "wamid.2" }]; };
waapi.sendList = (to, b, btn, o) => { SENT.push(["list", to, b, o]); return [true, "", { message_id: "wamid.3" }]; };
aiEngine.classify = () => "CHAT";
aiEngine.generateAnswer = () => "Welcome! How can I help?";

const { check, section, finish } = reporter(70);

const PNID = tenants.PRIMARY_TENANT.wa_phone_number_id;
const CUSTOMER = "918799020418";
const waText = (mid, text, waId = CUSTOMER, pnid = PNID) => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: pnid },
    contacts: [{ wa_id: waId, profile: { name: "Mayank" } }],
    messages: [{ from: waId, id: mid, type: "text", text: { body: text } }] } }] }],
});
const waTap = (mid, oid, title, waId = CUSTOMER) => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: waId, profile: { name: "Mayank" } }],
    messages: [{ from: waId, id: mid, type: "interactive",
                 interactive: { type: "button_reply", button_reply: { id: oid, title } } }] } }] }],
});

// ================================================================ seeding
db.initDb();
section("1 · Seeds into an empty production database");
check("the database really is empty", tenants.allTenants().length === 0);

tenants.ensureDefaultTenants();   // what createApp() calls on boot

const sky = tenants.bySlug("skyline-properties");
check("Skyline Properties exists after boot", Boolean(sky));
check("...even though NODE_ENV is production", process.env.NODE_ENV === "production");
check("...and the demo clients were NOT seeded alongside it",
      tenants.allTenants().length === 1, `${tenants.allTenants().length} tenant(s)`);
check("vertical is real_estate", sky.vertical === "real_estate");
check("wa_phone_number_id is the live number", sky.wa_phone_number_id === "1200586793147016",
      String(sky.wa_phone_number_id));
check("wa_business_number is the live number", sky.wa_business_number === "15552041400",
      String(sky.wa_business_number));
check("the domain lock is set", sky.domain_name === "real estate and property services");
check("a knowledge base is present", (sky.knowledge_base || "").length > 50);
check("the tenant is active", sky.active === 1);

section("2 · The five qualification questions");
const qs = tenants.questions(sky.id);
check("exactly five questions", qs.length === 5, `${qs.length}`);
check("they are in order",
      JSON.stringify(qs.map((q) => q.key)) ===
      JSON.stringify(["purpose", "config", "budget", "timeline", "site_visit"]),
      JSON.stringify(qs.map((q) => q.key)));
check("Q0 greets and asks buy/rent/invest",
      qs[0].question.includes("Welcome to Skyline Properties") &&
      qs[0].question.includes("Buy, Rent, or Invest"), qs[0].question.slice(0, 46));
check("Q0 options are Buy/Rent/Invest",
      JSON.stringify(qs[0].options.map((o) => o[1])) === JSON.stringify(["Buy", "Rent", "Invest"]));
check("Q1 options are 1/2/3 BHK",
      JSON.stringify(qs[1].options.map((o) => o[1])) === JSON.stringify(["1 BHK", "2 BHK", "3 BHK"]));
check("Q2 options are the three budget bands",
      JSON.stringify(qs[2].options.map((o) => o[1])) ===
      JSON.stringify(["Under ₹50L", "₹50L - ₹1Cr", "₹1Cr - ₹2Cr"]));
check("Q3 options are the three timelines",
      JSON.stringify(qs[3].options.map((o) => o[1])) ===
      JSON.stringify(["Immediately", "Within 30 days", "Just exploring"]));
check("Q4 asks about the free site visit pickup",
      qs[4].question.includes("free site visit pickup"));
check("every question renders as buttons", qs.every((q) => q.qtype === "button"));
check("every question has exactly 3 options", qs.every((q) => q.options.length === 3));
check("every option carries a score",
      qs.every((q) => q.options.every(([id]) => id in q.score_map)));
check("button titles fit WhatsApp's 20-char limit",
      qs.every((q) => q.options.every(([, t]) => t.length <= 20)));
check("the maximum score is exactly 100", tenants.maxScore(sky.id) === 100,
      String(tenants.maxScore(sky.id)));

section("3 · Seeding is idempotent");
tenants.ensureDefaultTenants();
tenants.ensureDefaultTenants();
check("running boot twice more creates no duplicates",
      tenants.allTenants().length === 1, `${tenants.allTenants().length} tenant(s)`);
check("...and does not duplicate the questions",
      tenants.questions(sky.id).length === 5);

section("4 · An operator's edits are never overwritten");
tenants.setQuestions(sky.id, [
  { key: "custom", qtype: "button", question: "Custom question?",
    options: [["a", "A"], ["b", "B"]], score_map: { a: 10, b: 20 } },
]);
tenants.update(sky.id, { knowledge_base: "operator edited" });
tenants.ensurePrimaryTenant();
check("edited questions survive a reboot",
      tenants.questions(sky.id).length === 1 &&
      tenants.questions(sky.id)[0].key === "custom");
check("an edited knowledge base survives a reboot",
      tenants.get(sky.id).knowledge_base === "operator edited");
// Put the real questions back for the routing test below.
tenants.setQuestions(sky.id, tenants.PRIMARY_TENANT.questions);

section("5 · First inbound 'Hi' routes and asks Question 0");
await webhooksWa.process_(waText("wamid.hi", "Hi"));
await worker.drainChannel("whatsapp", 20);

const lead = db.leadByWa(CUSTOMER);
check("a lead was created", Boolean(lead));
check("it resolved to Skyline by phone_number_id alone", lead.tenant_id === sky.id,
      `tenant_id=${lead.tenant_id}`);
check("the flow is active", lead.flow_active === 1);
check("stage is QUALIFYING", lead.stage === "QUALIFYING", lead.stage);
const q0 = SENT.find(([kind, , body]) => kind === "buttons" && body.includes("Buy, Rent, or Invest"));
check("Question 0 was sent as buttons", Boolean(q0),
      JSON.stringify(SENT.map((s) => s[0])));
check("Question 0 carries the welcome", Boolean(q0) && q0[2].includes("Welcome to Skyline Properties"));
check("its three buttons are Buy/Rent/Invest",
      Boolean(q0) && JSON.stringify(q0[3].map((o) => o[1])) ===
      JSON.stringify(["Buy", "Rent", "Invest"]));

section("6 · The whole flow runs to a HOT lead");
const answers = [["buy", "Buy"], ["3bhk", "3 BHK"], ["1-2Cr", "₹1Cr - ₹2Cr"],
                 ["immediate", "Immediately"], ["yes", "Yes please"]];
for (const [i, [oid, title]] of answers.entries()) {
  await webhooksWa.process_(waTap(`wamid.t${i}`, oid, title));
  await worker.drainChannel("whatsapp", 20);
}
const done = db.getLead(lead.id);
check("all five answers stored", Object.keys(db.getAnswers(lead.id)).length === 5,
      JSON.stringify(db.getAnswers(lead.id)));
check("flow_step reached the end", done.flow_step === 5, String(done.flow_step));
check("top answers score 100", done.score === 100, String(done.score));
check("band is HOT", done.band === "HOT");
check("qualified and handed off",
      ["QUALIFIED", "HANDED_OFF", "CRM_SYNCED"].includes(done.stage), done.stage);
check("no send was left failed or cancelled",
      !JSON.stringify(db.queueStats()).includes("failed") &&
      !JSON.stringify(db.queueStats()).includes("cancelled"),
      JSON.stringify(db.queueStats()));

section("7 · Seeding can be turned off");
config.SEED_PRIMARY_TENANT = false;
check("ensurePrimaryTenant() is a no-op when disabled",
      tenants.ensurePrimaryTenant() === null);
config.SEED_PRIMARY_TENANT = true;

worker.stop();
db.closeDb();
process.exitCode = finish();
