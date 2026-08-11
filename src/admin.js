/**
 * Portal routes and JSON API.
 *
 * Every data route resolves its scope through `auth.scopeTenantId(req)`. An
 * influencer's session forces their own id; only the platform admin can pass a
 * different one or view across all tenants.
 */

import express from "express";

import * as auth from "./auth.js";
import * as crm from "./crm.js";
import * as db from "./database.js";
import * as leadsMod from "./leads.js";
import * as tenants from "./tenants.js";
import waapi from "./waapi.js";
import * as worker from "./worker.js";

export const router = express.Router();

/** Fetch a lead only if the caller is allowed to see it. */
function guard(req, leadId) {
  const lead = db.getLead(leadId);
  if (!lead || !auth.ownsTenant(req, lead.tenant_id ?? null)) return null;
  return lead;
}

// ----------------------------------------------------------------------- auth
router.get("/login", (req, res) => res.render("login.html", {}));

router.post("/login", (req, res) => {
  const data = req.body || {};
  const role = auth.authenticate(req, data.username || "", data.password || "");
  if (!role) {
    return res.status(401).render("login.html", { error: "Wrong username or password." });
  }
  return res.redirect("/admin");
});

router.get("/logout", (req, res) => {
  auth.logout(req);
  return res.redirect("/login");
});

router.get("/admin", auth.requireLogin, (req, res) => {
  const me = auth.current(req);
  const tenant = me.tenant_id ? tenants.get(me.tenant_id) : null;
  return res.render("admin.html", {
    role: me.role,
    display_name: tenant ? tenant.name : "All clients",
    tenant_id: me.tenant_id || "",
  });
});

router.get("/api/me", auth.requireLogin, (req, res) => {
  const out = auth.current(req);
  out.tenants = auth.isAdmin(req) ? tenants.allTenants() : [];
  out.verticals = Object.keys(tenants.TEMPLATES).sort();
  return res.json(out);
});

// --------------------------------------------------------------------- funnel
router.get("/api/funnel", auth.requireLogin, (req, res) => {
  const tid = auth.scopeTenantId(req);
  const mediaId = req.query.campaign || null;
  return res.json({
    funnel: db.funnelCounts(mediaId, tid),
    leaks: db.leakReport(mediaId, tid),
    variants: db.variantReport(tid),
    queue: auth.isAdmin(req) ? db.queueStats() : {},
  });
});

// ---------------------------------------------------------------------- leads
router.get("/api/leads", auth.requireLogin, (req, res) => {
  return res.json(db.allLeads({
    stage: req.query.stage || null,
    band: req.query.band || null,
    mediaId: req.query.campaign || null,
    tenantId: auth.scopeTenantId(req),
  }));
});

router.get("/api/leads/:leadId", auth.requireLogin, (req, res) => {
  const leadId = parseInt(req.params.leadId, 10);
  const lead = guard(req, leadId);
  if (!lead) return res.status(404).json({ error: "not found" });
  return res.json({
    lead,
    campaign: db.getCampaign(lead.media_id || "") || {},
    answers: db.getAnswerRows(leadId),
    events: db.leadEvents(leadId),
    messages: db.leadMessages(leadId),
  });
});

router.post("/api/leads/:leadId/takeover", auth.requireLogin, (req, res) => {
  const leadId = parseInt(req.params.leadId, 10);
  if (!guard(req, leadId)) return res.status(404).json({ error: "not found" });
  const paused = Boolean((req.body || {}).paused ?? true);
  if (paused) {
    leadsMod.handOff(leadId, "agent took over from dashboard");
  } else {
    db.updateLead(leadId, { bot_paused: 0 });
    db.addEvent(leadId, "BOT_RESUMED", "returned to bot");
  }
  return res.json({ ok: true, paused });
});

router.post("/api/leads/:leadId/reply", auth.requireLogin, async (req, res) => {
  const leadId = parseInt(req.params.leadId, 10);
  const lead = guard(req, leadId);
  if (!lead) return res.status(404).json({ error: "not found" });
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "empty message" });
  if (!lead.wa_id) {
    return res.status(400).json({ ok: false, error: "no WhatsApp number on this lead" });
  }

  const tenant = lead.tenant_id ? tenants.get(lead.tenant_id) : null;
  const [ok, err] = await waapi.sendText(lead.wa_id, text, tenants.phoneNumberId(tenant));
  if (ok) {
    db.saveMessage(leadId, "whatsapp", "agent", text);
    return res.json({ ok: true });
  }
  return res.status(502).json({ ok: false, error: err });
});

// -------------------------------------------------------------------- tenants
router.get("/api/tenants", auth.requireAdmin, (req, res) =>
  res.json(tenants.allTenants()));

router.post("/api/tenants", auth.requireAdmin, (req, res) => {
  const d = req.body || {};
  if (!d.name || !d.domain_name) {
    return res.status(400).json({ ok: false, error: "name and domain_name required" });
  }
  const tid = tenants.create({
    name: d.name,
    domain_name: d.domain_name,
    vertical: d.vertical || "",
    portal_user: d.portal_user || null,
    password: d.password || null,
    ig_user_id: d.ig_user_id || null,
    ig_username: d.ig_username || null,
    ig_token: d.ig_token || null,
    wa_phone_number_id: d.wa_phone_number_id || null,
    wa_business_number: d.wa_business_number || null,
    knowledge_base: d.knowledge_base || null,
  });
  if (d.vertical) tenants.applyTemplate(tid, d.vertical);
  return res.json({ ok: true, tenant_id: tid });
});

router.get("/api/tenants/:tenantId", auth.requireLogin, (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (!auth.ownsTenant(req, tenantId)) return res.status(403).json({ error: "forbidden" });
  const t = tenants.get(tenantId);
  if (!t) return res.status(404).json({ error: "not found" });
  delete t.portal_password; // never leave the server
  if (!auth.isAdmin(req)) delete t.ig_token;
  return res.json({ tenant: t, questions: tenants.questions(tenantId) });
});

router.post("/api/tenants/:tenantId", auth.requireLogin, (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (!auth.ownsTenant(req, tenantId)) return res.status(403).json({ error: "forbidden" });
  const d = req.body || {};

  // An influencer may edit their own content and copy, never their platform
  // wiring or their own active flag.
  const own = ["name", "domain_name", "knowledge_base", "out_of_scope_message",
               "flow_intro", "flow_done_hot", "flow_done_cold", "band_hot", "band_warm"];
  const adminOnly = ["vertical", "ig_user_id", "ig_username", "ig_token",
                     "wa_phone_number_id", "wa_business_number", "portal_user",
                     "password", "active", "slug"];
  const allowed = new Set(auth.isAdmin(req) ? [...own, ...adminOnly] : own);

  const fields = {};
  for (const [k, v] of Object.entries(d)) if (allowed.has(k)) fields[k] = v;
  if (!Object.keys(fields).length) {
    return res.status(400).json({ ok: false, error: "nothing to update" });
  }
  tenants.update(tenantId, fields);
  return res.json({ ok: true });
});

// ------------------------------------------------------------------ questions
router.get("/api/tenants/:tenantId/questions", auth.requireLogin, (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (!auth.ownsTenant(req, tenantId)) return res.status(403).json({ error: "forbidden" });
  return res.json(tenants.questions(tenantId));
});

/** Replace the whole question set. This is the product's core knob. */
router.post("/api/tenants/:tenantId/questions", auth.requireLogin, (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (!auth.ownsTenant(req, tenantId)) return res.status(403).json({ error: "forbidden" });
  const items = (req.body || {}).questions || [];
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false,
                                  error: "questions must be a non-empty list" });
  }
  for (const q of items) {
    if (!q.key || !q.question || !q.options) {
      return res.status(400).json({
        ok: false, error: "each question needs key, question, options" });
    }
    if (q.options.length > 10) {
      return res.status(400).json({
        ok: false,
        error: `'${q.key}' has more than 10 options — WhatsApp lists cap at 10` });
    }
  }
  tenants.setQuestions(tenantId, items);
  return res.json({ ok: true, count: items.length,
                    max_score: tenants.maxScore(tenantId) });
});

router.post("/api/tenants/:tenantId/questions/template", auth.requireLogin, (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (!auth.ownsTenant(req, tenantId)) return res.status(403).json({ error: "forbidden" });
  const vertical = (req.body || {}).vertical || "";
  if (!tenants.applyTemplate(tenantId, vertical)) {
    return res.status(400).json({
      ok: false,
      error: `unknown vertical '${vertical}'`,
      available: Object.keys(tenants.TEMPLATES).sort(),
    });
  }
  return res.json({ ok: true, questions: tenants.questions(tenantId) });
});

// ------------------------------------------------------------------ campaigns
router.get("/api/campaigns", auth.requireLogin, (req, res) =>
  res.json(db.allCampaigns(auth.scopeTenantId(req))));

router.post("/api/campaigns", auth.requireLogin, (req, res) => {
  const d = req.body || {};
  if (!d.media_id || !d.name) {
    return res.status(400).json({ ok: false, error: "media_id and name required" });
  }

  const tid = auth.scopeTenantId(req);
  if (tid === null) {
    return res.status(400).json({ ok: false,
                                  error: "pick a client before adding a campaign" });
  }

  const existing = db.getCampaign(d.media_id);
  if (existing && !auth.ownsTenant(req, existing.tenant_id ?? null)) {
    return res.status(403).json({ ok: false,
                                  error: "that reel belongs to another client" });
  }

  const allowed = new Set(["media_id", "name", "keywords", "property_ref",
                           "dm_strategy", "dm_step1", "dm_step2", "dm_one_step",
                           "public_reply", "wa_prefill", "variant", "active"]);
  const fields = {};
  for (const [k, v] of Object.entries(d)) if (allowed.has(k)) fields[k] = v;
  fields.tenant_id = tid;
  db.upsertCampaign(fields);
  return res.json({ ok: true });
});

// --------------------------------------------------------------------- agents
router.get("/api/agents", auth.requireLogin, (req, res) =>
  res.json(db.activeAgents(auth.scopeTenantId(req))));

router.post("/api/agents", auth.requireLogin, (req, res) => {
  const d = req.body || {};
  if (!d.name) return res.status(400).json({ ok: false, error: "name required" });
  const tid = auth.scopeTenantId(req);
  if (tid === null) return res.status(400).json({ ok: false, error: "pick a client first" });
  db.addAgent(d.name, d.wa_id || "", tid);
  return res.json({ ok: true });
});

// --------------------------------------------------------------------- system
router.post("/api/worker/tick", auth.requireAdmin, async (req, res) =>
  res.json(await worker.tick()));

router.post("/api/crm/drain", auth.requireAdmin, async (req, res) =>
  res.json({ synced: await crm.drain() }));
