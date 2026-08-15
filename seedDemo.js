/**
 * Populate the database with three influencer clients and a realistic funnel,
 * so the portal has something to show before any real traffic arrives.
 *
 *     node seedDemo.js
 *
 * Deletes and recreates the database. Never run this against production data.
 *
 * Logins created:
 *     admin  / your ADMIN_PASSWORD — no default, so set one in .env first
 *     priya  / demo123                                  gym only
 *     skyline/ demo123                                  real estate only
 *     tandoor/ demo123                                  restaurant only
 */

import fs from "node:fs";

import config from "./src/config.js";
import * as db from "./src/database.js";
import * as leadsMod from "./src/leads.js";
import * as tenants from "./src/tenants.js";

for (const stale of [config.DB_PATH, config.DB_PATH + "-wal", config.DB_PATH + "-shm"]) {
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

db.initDb();

// Seeded PRNG so re-running produces the same demo funnel every time.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(11);
const randint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const choice = (arr) => arr[Math.floor(rnd() * arr.length)];

// ------------------------------------------------------------------- clients
const CLIENTS = [
  {
    name: "Priya Fitness", vertical: "gym", portal_user: "priya",
    ig_user_id: "IG_PRIYA", ig_username: "priya.fitness",
    agent: ["Rohit (trainer)", "919000000001"],
    kb: "Priya Fitness, Bodakdev Ahmedabad. Monthly ₹2,000 · Quarterly ₹5,400 · " +
        "Annual ₹18,000. Personal training ₹8,000/month. Open 5 AM – 10 PM. " +
        "Free trial session available. Steam, cardio, free weights, CrossFit zone.",
    reels: [["REEL_PF_1", "6-week transformation", "price,join,cost",
             "6-week program", "two_step", "A"],
            ["REEL_PF_2", "Home workout series", "plan,price",
             "online coaching", "one_step", "B"]],
  },
  {
    name: "Skyline Properties", vertical: "real_estate", portal_user: "skyline",
    ig_user_id: "IG_SKYLINE", ig_username: "skyline.props",
    agent: ["Amit (sales)", "919000000002"],
    kb: "Skyline Properties, RERA registered. Skyline Satellite 3BHK ₹1.42 Cr, " +
        "4BHK ₹1.95 Cr, ready to move. Skyline Greens 2BHK ₹62 L, 3BHK ₹94 L, " +
        "possession Dec 2027. Booking ₹2 lakh. Free site visit pickup.",
    reels: [["REEL_SK_1", "Satellite 3BHK walkthrough", "price,info,details",
             "3BHK Satellite", "two_step", "A"],
            ["REEL_SK_2", "Greens launch offer", "price,book",
             "2BHK Greens", "one_step", "B"]],
  },
  {
    name: "Tandoor House", vertical: "restaurant", portal_user: "tandoor",
    ig_user_id: "IG_TANDOOR", ig_username: "tandoor.house",
    agent: ["Neha (front desk)", "919000000003"],
    kb: "Tandoor House, CG Road Ahmedabad. North Indian and Mughlai. " +
        "Lunch 12–3:30, dinner 7–11:30. Party hall seats 60. Catering from " +
        "₹450/plate. Pure veg and Jain options. Table booking recommended.",
    reels: [["REEL_TH_1", "Butter chicken reel", "menu,price,book",
             "dinner booking", "two_step", "A"]],
  },
];

const NAMES = ["Rahul Mehta", "Sneha Patel", "Vikram Shah", "Anita Desai", "Karan Joshi",
               "Meera Nair", "Rohit Verma", "Divya Rao", "Sameer Khan", "Pooja Iyer",
               "Nikhil Bhatt", "Ritu Malhotra", "Arjun Pillai", "Kavya Menon",
               "Manish Gupta", "Tara Sethi", "Yash Trivedi", "Ishita Bose",
               "Aditya Rane", "Neha Kulkarni"];

const ago = (hours) =>
  new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19) + "+00:00";

const event = (leadId, type, detail, hours) =>
  db.run("INSERT INTO lead_events (lead_id, type, detail, created_at) VALUES (?, ?, ?, ?)",
         [leadId, type, detail, ago(hours)]);

let nameI = 0;

for (const spec of CLIENTS) {
  const tid = tenants.create({
    name: spec.name,
    domain_name: tenants.TEMPLATES[spec.vertical].domain_name,
    vertical: spec.vertical, portal_user: spec.portal_user,
    password: "demo123", ig_user_id: spec.ig_user_id,
    ig_username: spec.ig_username, ig_token: `TOK_${spec.vertical.toUpperCase()}`,
    knowledge_base: spec.kb,
  });
  tenants.applyTemplate(tid, spec.vertical);
  db.addAgent(spec.agent[0], spec.agent[1], tid);

  for (const [mid, cname, kws, ref, strategy, variant] of spec.reels) {
    db.upsertCampaign({ media_id: mid, tenant_id: tid, name: cname, keywords: kws,
                        property_ref: ref, dm_strategy: strategy, variant,
                        wa_prefill: "Hi! Interested in {property} ({ref})" });
  }

  const questions = tenants.questions(tid);
  const nLeads = randint(9, 14);

  for (let i = 0; i < nLeads; i++) {
    const [mid, cname, , ref, strategy, variant] = choice(spec.reels);
    const person = NAMES[nameI % NAMES.length]; nameI += 1;
    const handle = person.split(" ")[0].toLowerCase() + randint(10, 99);
    const h = 70 - i * 2.7;

    const leadId = db.createLead({
      tenant_id: tid, media_id: mid, variant,
      ig_user_id: `V_${tid}_${i}`, ig_username: handle,
      comment_id: `C_${tid}_${i}`, stage: "COMMENTED", source: "instagram",
      created_at: ago(h), updated_at: ago(h) });
    event(leadId, "COMMENTED", `@${handle} on ${cname}`, h);

    event(leadId, "DM_SENT", "private reply sent", h - 0.02);
    db.updateLead(leadId, { stage: "DM_SENT" });
    if (rnd() > 0.55) continue;                        // leak 1

    if (strategy === "two_step") {
      event(leadId, "DM_REPLIED", "moved out of Message Requests", h - 0.3);
      event(leadId, "LINK_SENT", "step 2 with link", h - 0.31);
    }
    db.updateLead(leadId, { stage: "LINK_SENT" });
    event(leadId, "CLICKED", "iPhone", h - 0.5);
    db.updateLead(leadId, { stage: "CLICKED", clicked_at: ago(h - 0.5) });

    if (rnd() > 0.7) {                                 // leak 2
      if (rnd() > 0.4) {
        event(leadId, "RECOVERY_SENT", "clicked but never messaged", h - 0.85);
        db.updateLead(leadId, { recovery_sent: 1 });
      }
      continue;
    }

    const wa = `9198${randint(10000000, 99999999)}`;
    db.updateLead(leadId, { wa_id: wa, name: person, stage: "WA_ENGAGED",
                            wa_started_at: ago(h - 0.6) });
    event(leadId, "WA_ENGAGED", "ref matched, identities stitched", h - 0.6);
    const code = db.getLead(leadId).ref_code;
    db.saveMessage(leadId, "instagram", "assistant",
                   `Hi ${handle} 👋 Thanks for commenting on our ${ref} reel!`);
    db.saveMessage(leadId, "whatsapp", "user", `Hi! Interested in ${ref} (${code})`);
    event(leadId, "QUALIFYING", "", h - 0.62);
    db.updateLead(leadId, { stage: "QUALIFYING" });

    if (rnd() > 0.85) {                                // dropped mid-flow
      const q0 = questions[0];
      const [oid, olabel] = choice(q0.options);
      db.saveAnswer(leadId, q0.key, oid, olabel, q0.score_map[oid] ?? 0);
      continue;
    }

    for (const qn of questions) {
      const [oid, olabel] = choice(qn.options);
      db.saveAnswer(leadId, qn.key, oid, olabel, qn.score_map[oid] ?? 0);
      event(leadId, "ANSWERED", `${qn.key} = ${oid}`, h - 0.7);
    }
    db.saveMessage(leadId, "whatsapp", "user", "Sounds good 👍");

    event(leadId, "QUALIFIED", db.summaryOf(leadId), h - 0.75);
    db.updateLead(leadId, { stage: "QUALIFIED", qualified_at: ago(h - 0.75) });
    const [score, band] = leadsMod.scoreLead(leadId);

    if (band === "HOT") {
      db.updateLead(leadId, { stage: "HANDED_OFF", bot_paused: 1,
                              assigned_agent: spec.agent[0] });
      event(leadId, "HANDED_OFF", `hot lead, score ${score}`, h - 0.77);
      db.saveMessage(leadId, "whatsapp", "assistant",
                     "Perfect, thank you! 🙌 Someone from our team will " +
                     "message you here shortly.");
      if (rnd() > 0.35) {
        event(leadId, "CRM_SYNCED", "csv", h - 0.8);
        db.updateLead(leadId, { stage: "CRM_SYNCED" });
      }
    }
  }
}

// A walk-in with no Instagram origin, proving attribution handles it.
const lid = db.createLead({ tenant_id: 1, wa_id: "919811112222", name: "Direct Enquiry",
                            stage: "WA_ENGAGED", source: "unattributed",
                            wa_started_at: ago(3) });
db.addEvent(lid, "WA_ENGAGED", "no ref code — unattributed");
db.saveMessage(lid, "whatsapp", "user", "Do you have evening batches?");

// ---------------------------------------------------------------------- report
console.log();
for (const t of tenants.allTenants()) {
  const leak = db.leakReport(null, t.id);
  console.log(
    `  ${t.name.padEnd(22)} ${String(t.vertical).padEnd(12)} ` +
    `${String(t.lead_count).padStart(3)} leads · ` +
    `${tenants.questions(t.id).length} questions · ` +
    `leak1 ${String(leak.leak1_dm_to_click.rate).padStart(5)}% · ` +
    `leak2 ${String(leak.leak2_click_to_chat.rate).padStart(5)}%`,
  );
}

const adminHint = config.ADMIN_PASSWORD_HASH
  ? "(your ADMIN_PASSWORD_HASH)"
  : config.ADMIN_PASSWORD
    ? config.ADMIN_PASSWORD
    : "DISABLED — set ADMIN_PASSWORD_HASH or ADMIN_PASSWORD in .env";
console.log(`\n  Logins   admin / ${adminHint}   (all clients)`);
for (const spec of CLIENTS) {
  console.log(`           ${spec.portal_user} / demo123`.padEnd(38) +
              `(${spec.name} only)`);
}
console.log("\n  Run:  npm start    then open http://localhost:5000/login\n");
