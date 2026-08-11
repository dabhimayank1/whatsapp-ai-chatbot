/**
 * Tenant model — one row per influencer client.
 *
 * A tenant owns its own Instagram account, knowledge base, domain lock,
 * qualification questions and leads. Everything the bot says is decided by the
 * tenant behind the message, never by global config.
 *
 * WhatsApp routing supports both models:
 *
 *   shared number     every tenant uses your one verified number. The ref code
 *                     in the prefilled text says which tenant the lead belongs
 *                     to, so one number serves all 30.
 *   dedicated number  a tenant with their own wa_phone_number_id. Costs a
 *                     number but the customer sees their brand. Sell it as an
 *                     upsell.
 *
 * Business Verification is per business, not per number — you verify your
 * company once and can hang up to 25 numbers off the same WhatsApp Business
 * Account.
 */

import config from "./config.js";
import * as db from "./database.js";
import { checkPasswordHash, generatePasswordHash } from "./passwords.js";

export function slugify(name) {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "tenant";
}

/** Drop keys the caller left empty, the way Python's `if v is not None` did. */
function defined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------- CRUD
/** Create a tenant. Returns the new tenant id. */
export function create({ name, domain_name, vertical = "", slug, password, ...rest }) {
  let candidate = slug || slugify(name);
  const base = candidate;
  let n = 2;
  while (db.row("SELECT 1 AS x FROM tenants WHERE slug = ?", [candidate])) {
    candidate = `${base}-${n}`;
    n += 1;
  }

  const fields = {
    slug: candidate,
    name,
    domain_name,
    vertical,
    created_at: db.now(),
    ...defined(rest),
  };
  if (password) fields.portal_password = generatePasswordHash(password);

  const cols = Object.keys(fields);
  const marks = cols.map(() => "?").join(", ");
  const res = db.run(
    `INSERT INTO tenants (${cols.join(", ")}) VALUES (${marks})`,
    Object.values(fields),
  );
  return Number(res.lastInsertRowid);
}

export function update(tenantId, fields = {}) {
  const kw = { ...fields };
  if ("password" in kw) {
    const pw = kw.password;
    delete kw.password;
    if (pw) kw.portal_password = generatePasswordHash(pw);
  }
  if (!Object.keys(kw).length) return;
  const sets = Object.keys(kw).map((c) => `${c} = ?`).join(", ");
  db.run(`UPDATE tenants SET ${sets} WHERE id = ?`, [...Object.values(kw), tenantId]);
}

export function get(tenantId) {
  return db.row("SELECT * FROM tenants WHERE id = ?", [tenantId]);
}

export function bySlug(slug) {
  return db.row("SELECT * FROM tenants WHERE slug = ?", [slug]);
}

export function byPortalUser(username) {
  return db.row("SELECT * FROM tenants WHERE portal_user = ?", [username]);
}

export function allTenants(activeOnly = false) {
  let sql =
    "SELECT t.*, " +
    "(SELECT COUNT(*) FROM leads l WHERE l.tenant_id = t.id) AS lead_count, " +
    "(SELECT COUNT(*) FROM campaigns c WHERE c.tenant_id = t.id) AS campaign_count " +
    "FROM tenants t";
  if (activeOnly) sql += " WHERE t.active = 1";
  return db.rows(sql + " ORDER BY t.name");
}

export function checkLogin(username, password) {
  const t = byPortalUser(username);
  if (t && t.portal_password && checkPasswordHash(t.portal_password, password)) {
    return t;
  }
  return null;
}

// --------------------------------------------------------------- resolution
export function byInstagram(igUserId) {
  if (igUserId) {
    const match = db.row("SELECT * FROM tenants WHERE ig_user_id = ? AND active = 1", [igUserId]);
    if (match) return match;
  }
  const activeWithIg = allTenants(true).filter((t) => t.ig_user_id);
  if (activeWithIg.length >= 1) return activeWithIg[0];
  const allActive = allTenants(true);
  if (allActive.length >= 1) return allActive[0];
  return null;
}

/** Only matches tenants on a dedicated WhatsApp number. */
export function byPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return db.row("SELECT * FROM tenants WHERE wa_phone_number_id = ? AND active = 1",
                [phoneNumberId]);
}

/** Work out which tenant an inbound WhatsApp message belongs to.
 *
 * Order matters. The ref code is the strongest signal because it was minted
 * for exactly one lead; a dedicated phone number is next; an existing
 * conversation is the fallback for someone returning days later without a
 * ref code.
 */
export function resolveForWhatsapp(refCode = "", waId = "", phoneNumberId = "", text = "") {
  if (refCode) {
    const lead = db.leadByRef(refCode);
    if (lead && lead.tenant_id) return get(lead.tenant_id);
  }

  const t = byPhoneNumberId(phoneNumberId);
  if (t) return t;

  const lowered = String(text || "").toLowerCase();
  if (lowered) {
    for (const tenant of allTenants(true)) {
      const name = (tenant.name || "").toLowerCase();
      const firstName = name.split(" ")[0];

      if (name && lowered.includes(name)) return tenant;
      if (tenant.slug && lowered.includes(tenant.slug.toLowerCase())) return tenant;
      if (firstName && firstName.length >= 3 && lowered.includes(firstName)) return tenant;
    }
  }

  if (waId) {
    const lead = db.leadByWa(waId);
    if (lead && lead.tenant_id) return get(lead.tenant_id);
  }

  const all = allTenants(true);
  if (all.length > 0) return all[0];
  return null;
}

/** The number customers message for this tenant. */
export function whatsappNumber(tenant) {
  if (tenant && tenant.wa_business_number) return tenant.wa_business_number;
  return config.WA_BUSINESS_NUMBER;
}

/** Which WhatsApp sender to send from. */
export function phoneNumberId(tenant) {
  if (tenant && tenant.wa_phone_number_id) return tenant.wa_phone_number_id;
  return config.PHONE_NUMBER_ID;
}

// ------------------------------------------------------------- copy helpers
export function outOfScopeMessage(tenant) {
  if (tenant && tenant.out_of_scope_message) return tenant.out_of_scope_message;
  const name = tenant ? tenant.name : config.BUSINESS_NAME;
  const domain = tenant ? tenant.domain_name : config.DOMAIN_NAME;
  return (
    `Sorry, I can only help with questions about ${domain} at ${name}. 😊\n\n` +
    "Please ask me something related to that, or type *agent* to talk to a person."
  );
}

export function text(tenant, field, fallback) {
  if (tenant && tenant[field]) return tenant[field];
  return fallback;
}

// ------------------------------------------------------------------ questions
/** The tenant's qualification questions, in order, decoded. */
export function questions(tenantId) {
  const list = db.rows(
    "SELECT * FROM tenant_questions WHERE tenant_id = ? AND active = 1 " +
      "ORDER BY position, id",
    [tenantId],
  );
  return list.map((r) => ({
    ...r,
    options: JSON.parse(r.options || "[]"),
    score_map: JSON.parse(r.score_map || "{}"),
  }));
}

/** Replace a tenant's whole question set.
 *
 * Each item: {key, qtype, question, button_label, options: [[id,title]...],
 *             score_map: {option_id: points}}
 */
export function setQuestions(tenantId, items) {
  db.transaction(() => {
    db.run("DELETE FROM tenant_questions WHERE tenant_id = ?", [tenantId]);
    items.forEach((q, pos) => {
      const opts = (q.options || []).map((o) => [String(o[0]), String(o[1])]);
      db.run(
        "INSERT INTO tenant_questions " +
          "(tenant_id, position, key, qtype, question, button_label, " +
          " options, score_map, active) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
        [
          tenantId,
          pos,
          q.key,
          opts.length <= 3 && q.qtype !== "list" ? "button" : "list",
          q.question,
          q.button_label ?? "Choose",
          JSON.stringify(opts),
          JSON.stringify(q.score_map || {}),
        ],
      );
    });
  });
}

/** Best possible score for this tenant — used to normalise the bands. */
export function maxScore(tenantId) {
  let total = 0;
  for (const q of questions(tenantId)) {
    const points = Object.values(q.score_map);
    if (points.length) total += Math.max(...points.map(Number));
  }
  return total || 100;
}

// -------------------------------------------------------- vertical templates
// Starting points, not straitjackets. Every tenant edits their own copy in the
// portal — a gym does not care about BHK and a restaurant does not care about
// possession dates.
export const TEMPLATES = {
  real_estate: {
    domain_name: "real estate and property services",
    questions: [
      { key: "purpose", qtype: "button",
        question: "Are you looking to *buy*, *rent* or *invest*?",
        options: [["buy", "Buy"], ["rent", "Rent"], ["invest", "Invest"]],
        score_map: { buy: 15, invest: 15, rent: 8 } },
      { key: "config", qtype: "list", button_label: "Choose type",
        question: "What configuration are you after?",
        options: [["1bhk", "1 BHK"], ["2bhk", "2 BHK"], ["3bhk", "3 BHK"],
                  ["4bhk+", "4 BHK or larger"], ["plot", "Plot / Land"]],
        score_map: { "1bhk": 10, "2bhk": 12, "3bhk": 15, "4bhk+": 15, plot: 12 } },
      { key: "budget", qtype: "list", button_label: "Choose budget",
        question: "What budget range should I work with?",
        options: [["under-50L", "Under ₹50 lakh"],
                  ["50L-1Cr", "₹50 lakh – ₹1 Cr"], ["1-2Cr", "₹1 Cr – ₹2 Cr"],
                  ["2Cr+", "Above ₹2 Cr"]],
        score_map: { "under-50L": 10, "50L-1Cr": 20, "1-2Cr": 25, "2Cr+": 25 } },
      { key: "timeline", qtype: "button",
        question: "How soon are you planning to move on this?",
        options: [["immediate", "Immediately"], ["1-3m", "1–3 months"],
                  ["exploring", "Just exploring"]],
        score_map: { immediate: 30, "1-3m": 20, exploring: 0 } },
      { key: "site_visit", qtype: "button",
        question: "Would you like to schedule a site visit?",
        options: [["yes", "Yes please"], ["maybe", "Maybe later"], ["no", "Not yet"]],
        score_map: { yes: 15, maybe: 5, no: 0 } },
    ],
  },
  gym: {
    domain_name: "gym, fitness training and memberships",
    questions: [
      { key: "goal", qtype: "list", button_label: "Choose goal",
        question: "What's your main fitness goal?",
        options: [["weight-loss", "Weight loss"], ["muscle", "Build muscle"],
                  ["general", "General fitness"], ["sport", "Sports training"],
                  ["rehab", "Injury recovery"]],
        score_map: { "weight-loss": 15, muscle: 15, general: 10, sport: 15, rehab: 12 } },
      { key: "experience", qtype: "button",
        question: "Have you trained at a gym before?",
        options: [["beginner", "Complete beginner"], ["some", "Some experience"],
                  ["regular", "Train regularly"]],
        score_map: { beginner: 15, some: 12, regular: 10 } },
      { key: "plan", qtype: "list", button_label: "Choose plan",
        question: "Which membership interests you?",
        options: [["trial", "Trial session"], ["monthly", "Monthly"],
                  ["quarterly", "3 months"], ["annual", "Annual"],
                  ["pt", "Personal training"]],
        score_map: { trial: 10, monthly: 18, quarterly: 24, annual: 30, pt: 30 } },
      { key: "start", qtype: "button",
        question: "When would you like to start?",
        options: [["now", "This week"], ["month", "Within a month"],
                  ["exploring", "Just exploring"]],
        score_map: { now: 30, month: 18, exploring: 0 } },
      { key: "trial", qtype: "button",
        question: "Want to book a free trial session?",
        options: [["yes", "Yes please"], ["maybe", "Maybe later"], ["no", "Not yet"]],
        score_map: { yes: 15, maybe: 5, no: 0 } },
    ],
  },
  restaurant: {
    domain_name: "restaurant dining, reservations and catering",
    questions: [
      { key: "occasion", qtype: "list", button_label: "Choose",
        question: "What's the occasion?",
        options: [["casual", "Casual meal"], ["birthday", "Birthday"],
                  ["anniversary", "Anniversary"], ["corporate", "Corporate"],
                  ["party", "Private party"], ["catering", "Catering order"]],
        score_map: { casual: 8, birthday: 18, anniversary: 18, corporate: 25,
                     party: 25, catering: 25 } },
      { key: "party_size", qtype: "list", button_label: "How many",
        question: "How many people?",
        options: [["1-2", "1–2"], ["3-5", "3–5"], ["6-10", "6–10"],
                  ["11-25", "11–25"], ["25+", "More than 25"]],
        score_map: { "1-2": 8, "3-5": 12, "6-10": 18, "11-25": 25, "25+": 30 } },
      { key: "when", qtype: "button",
        question: "When are you planning to visit?",
        options: [["today", "Today or tomorrow"], ["week", "This week"],
                  ["later", "Later / flexible"]],
        score_map: { today: 30, week: 20, later: 5 } },
      { key: "booking", qtype: "button",
        question: "Shall I have the team hold a table for you?",
        options: [["yes", "Yes please"], ["maybe", "Maybe later"], ["no", "Just asking"]],
        score_map: { yes: 15, maybe: 5, no: 0 } },
    ],
  },
  salon: {
    domain_name: "salon, spa and beauty services",
    questions: [
      { key: "service", qtype: "list", button_label: "Choose service",
        question: "Which service are you interested in?",
        options: [["hair", "Hair"], ["skin", "Skin / facial"], ["nails", "Nails"],
                  ["bridal", "Bridal package"], ["spa", "Spa / massage"]],
        score_map: { hair: 12, skin: 12, nails: 10, bridal: 30, spa: 15 } },
      { key: "when", qtype: "button",
        question: "When would you like to come in?",
        options: [["today", "Today or tomorrow"], ["week", "This week"],
                  ["later", "Later / flexible"]],
        score_map: { today: 30, week: 20, later: 5 } },
      { key: "booking", qtype: "button",
        question: "Would you like to book an appointment?",
        options: [["yes", "Yes please"], ["maybe", "Maybe later"], ["no", "Just asking"]],
        score_map: { yes: 25, maybe: 8, no: 0 } },
    ],
  },
};

/** Seed a tenant's questions from a vertical template. */
export function applyTemplate(tenantId, vertical) {
  const tpl = TEMPLATES[vertical];
  if (!tpl) return false;
  setQuestions(tenantId, tpl.questions);
  update(tenantId, { vertical });
  return true;
}

export function ensureDefaultTenants() {
  if (allTenants().length > 0) return;
  const CLIENTS = [
    {
      name: "Priya Fitness", vertical: "gym", portal_user: "priya",
      ig_username: "priya.fitness",
      kb: "Priya Fitness, Bodakdev Ahmedabad. Monthly ₹2,000 · Quarterly ₹5,400 · " +
          "Annual ₹18,000. Personal training ₹8,000/month. Open 5 AM – 10 PM. " +
          "Free trial session available. Steam, cardio, free weights, CrossFit zone.",
    },
    {
      name: "Skyline Properties", vertical: "real_estate", portal_user: "skyline",
      ig_user_id: "17841448785224373",
      ig_username: "jay_dwarkadhish__31",
      kb: "Skyline Properties, RERA registered. Skyline Satellite 3BHK ₹1.42 Cr, " +
          "4BHK ₹1.95 Cr, ready to move. Skyline Greens 2BHK ₹62 L, 3BHK ₹94 L, " +
          "possession Dec 2027. Booking ₹2 lakh. Free site visit pickup.",
    },
    {
      name: "Tandoor House", vertical: "restaurant", portal_user: "tandoor",
      ig_username: "tandoor.house",
      kb: "Tandoor House, CG Road Ahmedabad. North Indian and Mughlai. " +
          "Lunch 12–3:30, dinner 7–11:30. Party hall seats 60. Catering from " +
          "₹450/plate. Pure veg and Jain options. Table booking recommended.",
    },
  ];
  for (const c of CLIENTS) {
    const tid = create({
      name: c.name,
      domain_name: TEMPLATES[c.vertical].domain_name,
      vertical: c.vertical,
      portal_user: c.portal_user,
      password: "demo123",
      ig_user_id: c.ig_user_id || null,
      ig_username: c.ig_username,
      knowledge_base: c.kb,
    });
    applyTemplate(tid, c.vertical);

    if (c.vertical === "real_estate") {
      db.upsertCampaign({ media_id: "REEL_SK_1", tenant_id: tid, name: "Satellite 3BHK walkthrough", keywords: "price,info,details", property_ref: "3BHK Satellite", dm_strategy: "two_step", variant: "A", wa_prefill: "Hi! Interested in {property} ({ref})" });
      const lid = db.createLead({ tenant_id: tid, media_id: "REEL_SK_1", name: "Arjun Pillai", wa_id: "919889263840", stage: "QUALIFIED", score: 85, band: "HOT", source: "instagram" });
      db.saveAnswer(lid, "purpose", "buy", "Buy", 30);
      db.saveAnswer(lid, "config", "3bhk", "3 BHK", 25);
      db.saveAnswer(lid, "budget", "1-2Cr", "₹1-2 Cr", 30);
      db.saveMessage(lid, "whatsapp", "user", "Hi! Interested in 3BHK Satellite");
      db.saveMessage(lid, "whatsapp", "assistant", "We have 3BHK flats available in Skyline Satellite for ₹1.42 Cr. Would you like to book a site visit? 🏠");
    } else if (c.vertical === "gym") {
      db.upsertCampaign({ media_id: "REEL_PF_1", tenant_id: tid, name: "6-week transformation", keywords: "price,join,cost", property_ref: "6-week program", dm_strategy: "two_step", variant: "A", wa_prefill: "Hi! Interested in {property} ({ref})" });
      const lid = db.createLead({ tenant_id: tid, media_id: "REEL_PF_1", name: "Vikram Shah", wa_id: "919843926694", stage: "QUALIFIED", score: 75, band: "HOT", source: "instagram" });
      db.saveAnswer(lid, "goal", "general", "General fitness", 10);
      db.saveAnswer(lid, "experience", "beginner", "Complete beginner", 15);
      db.saveAnswer(lid, "plan", "trial", "Trial session", 10);
      db.saveMessage(lid, "whatsapp", "user", "Hi! Interested in 6-week program");
      db.saveMessage(lid, "whatsapp", "assistant", "Welcome to Priya Fitness! Monthly ₹2,000. Free trial session available. 🏋️");
    } else if (c.vertical === "restaurant") {
      db.upsertCampaign({ media_id: "REEL_TH_1", tenant_id: tid, name: "Butter chicken reel", keywords: "menu,price,book", property_ref: "dinner booking", dm_strategy: "two_step", variant: "A", wa_prefill: "Hi! Interested in {property} ({ref})" });
      const lid = db.createLead({ tenant_id: tid, media_id: "REEL_TH_1", name: "Meera Nair", wa_id: "919854208435", stage: "QUALIFIED", score: 90, band: "HOT", source: "instagram" });
      db.saveAnswer(lid, "party", "4", "4 people", 20);
      db.saveAnswer(lid, "timing", "dinner", "Dinner", 20);
      db.saveMessage(lid, "whatsapp", "user", "Hi! Interested in dinner booking");
      db.saveMessage(lid, "whatsapp", "assistant", "Welcome to Tandoor House! Table booking confirmed. 🍽️");
    }
  }
  db.run("UPDATE tenants SET ig_token = NULL WHERE ig_token LIKE 'TOK_%'");
}

export default {
  slugify, create, update, get, bySlug, byPortalUser, allTenants, checkLogin,
  byInstagram, byPhoneNumberId, resolveForWhatsapp, whatsappNumber, phoneNumberId,
  outOfScopeMessage, text, questions, applyTemplate, TEMPLATES, ensureDefaultTenants,
};

