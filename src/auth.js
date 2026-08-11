/**
 * Session auth for two kinds of user.
 *
 *   super admin   you, the platform operator. Sees every tenant.
 *   tenant user   an influencer. Sees only their own leads, campaigns,
 *                 questions and knowledge base — never another client's.
 *
 * Scoping is enforced by `scopeTenantId(req)`, which returns the tenant a
 * request is allowed to touch. A super admin may pass ?tenant=<id> to look at
 * one client; an influencer's own id is forced regardless of what they send.
 * Every data route must run its query through it.
 */

import config from "./config.js";
import * as tenants from "./tenants.js";

export function loginTenant(req, tenant) {
  req.session = { role: "tenant", tenant_id: tenant.id, name: tenant.name };
}

export function loginAdmin(req) {
  req.session = { role: "admin", tenant_id: null, name: "Platform admin" };
}

export function logout(req) {
  req.session = null;
}

export function current(req) {
  const s = req.session || {};
  return {
    role: s.role ?? null,
    tenant_id: s.tenant_id ?? null,
    name: s.name ?? null,
  };
}

export function isAdmin(req) {
  return (req.session || {}).role === "admin";
}

/** The tenant this request may access.
 *
 * null means "all tenants" and is only ever returned for a super admin.
 * An influencer cannot widen their scope by sending a different id.
 */
export function scopeTenantId(req) {
  const s = req.session || {};
  if (s.role === "tenant") return s.tenant_id ?? null;
  if (isAdmin(req)) {
    const isJson = (req.headers["content-type"] || "").includes("application/json");
    const raw = req.query?.tenant ?? (isJson ? req.body?.tenant_id : undefined);
    if (raw === undefined || raw === null || raw === "" || raw === "all") return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const wantsJson = (req) => req.path.startsWith("/api/");

export function requireLogin(req, res, next) {
  if (!(req.session || {}).role) {
    if (wantsJson(req)) return res.status(401).json({ error: "not authenticated" });
    return res.redirect("/login");
  }
  req.user = current(req);
  return next();
}

/** Platform-operator only — creating tenants, cross-tenant views. */
export function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    if (wantsJson(req)) return res.status(403).json({ error: "admin only" });
    return res.redirect("/login");
  }
  req.user = current(req);
  return next();
}

/** True if the caller may act on this tenant. */
export function ownsTenant(req, tenantId) {
  if (isAdmin(req)) return true;
  return (
    tenantId !== null &&
    tenantId !== undefined &&
    (req.session || {}).tenant_id === tenantId
  );
}

/** Returns 'admin', 'tenant' or null. */
export function authenticate(req, username, password) {
  if (username === config.ADMIN_USER && password === config.ADMIN_PASSWORD && password) {
    loginAdmin(req);
    return "admin";
  }
  const t = tenants.checkLogin(username, password);
  if (t) {
    if (!t.active) return null;
    loginTenant(req, t);
    return "tenant";
  }
  return null;
}
