/**
 * Central configuration.
 *
 * Exported as a single mutable object on purpose: the test suites reach in and
 * change values at runtime (IG_SENDS_PER_HOUR, CRM_ADAPTER) exactly like the
 * Python original did, so every consumer must read `config.X` at call time
 * rather than destructuring at import time.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

const env = (key, fallback = "") =>
  process.env[key] !== undefined && process.env[key] !== "" ? process.env[key] : fallback;
const envInt = (key, fallback) => {
  const n = parseInt(env(key, ""), 10);
  return Number.isFinite(n) ? n : fallback;
};
/** Truthy env flag. Accepts 1/true/yes/on, case-insensitive. */
const envBool = (key, fallback = false) => {
  const raw = env(key, "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
};

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KB_DIR = path.join(BASE_DIR, "knowledge_base");

/** Concatenate every .md/.txt file in knowledge_base/ into one string.
 *
 * Deliberately no vector database: a single business's knowledge is a few
 * thousand tokens and Groq gives us a 128k context window for free.
 */
export function loadKnowledgeBase() {
  if (!fs.existsSync(KB_DIR)) return "";
  const parts = [];
  for (const name of fs.readdirSync(KB_DIR).sort()) {
    if (![".md", ".txt"].includes(path.extname(name).toLowerCase())) continue;
    const stem = path.basename(name, path.extname(name));
    parts.push(`### ${stem}\n${fs.readFileSync(path.join(KB_DIR, name), "utf-8")}`);
  }
  return parts.join("\n\n");
}

const GRAPH_VERSION = "v21.0";
const PHONE_NUMBER_ID = env("PHONE_NUMBER_ID");
const IG_GRAPH_HOST = env("IG_GRAPH_HOST", "graph.instagram.com");

const BUSINESS_NAME = env("BUSINESS_NAME", "Skyline Properties");
const DOMAIN_NAME = env("DOMAIN_NAME", "real estate and property services");

// Whether the operator actually named the business, or we quietly fell back to
// the sample one. This matters more than it looks: BUSINESS_NAME is the name on
// the public privacy policy, and App Review compares that page against the app
// being submitted. A deployment that forgets to set it serves a policy for a
// business that does not exist, and the submission is rejected for it.
const BUSINESS_NAME_DEFAULTED = !env("BUSINESS_NAME");
const DOMAIN_NAME_DEFAULTED = !env("DOMAIN_NAME");

const config = {
  BASE_DIR,
  KB_DIR,
  DB_PATH: env("DB_PATH", path.join(BASE_DIR, "chatbot.db")),

  // ------------------------------------------------------------- credentials
  GROQ_API_KEY: env("GROQ_API_KEY"),

  WHATSAPP_TOKEN: env("WHATSAPP_TOKEN"),
  PHONE_NUMBER_ID,
  // No default: an unset verify token must fail the handshake, not accept a
  // published placeholder.
  WA_VERIFY_TOKEN: env("WA_VERIFY_TOKEN", env("VERIFY_TOKEN")),
  WA_BUSINESS_NUMBER: env("WA_BUSINESS_NUMBER", "919876543210"), // for wa.me links
  // Prefixed onto a bare national number typed into the desktop callback form.
  // wa_id must always be full international format or sends to it will fail.
  DEFAULT_COUNTRY_CODE: env("DEFAULT_COUNTRY_CODE", "91"),

  IG_TOKEN: env("IG_TOKEN"),
  IG_USER_ID: env("IG_USER_ID"),
  IG_VERIFY_TOKEN: env("IG_VERIFY_TOKEN"),

  // Meta signs every webhook POST with this (App Dashboard → Settings → Basic →
  // App Secret). Without it there is nothing stopping a stranger from POSTing a
  // forged comment and making us DM anyone on our tokens.
  META_APP_SECRET: env("META_APP_SECRET"),
  // Only turn this off to debug locally, and never on a public URL.
  VERIFY_WEBHOOK_SIGNATURE: envBool("VERIFY_WEBHOOK_SIGNATURE", true),

  ADMIN_USER: env("ADMIN_USER", "admin"),
  // No default. An unset admin password disables the admin login entirely
  // rather than silently accepting a guessable one.
  ADMIN_PASSWORD: env("ADMIN_PASSWORD"),
  // Preferred over ADMIN_PASSWORD: a scrypt hash in Werkzeug's format, as
  // produced by `node -e "import('./src/passwords.js').then(p=>console.log(
  // p.generatePasswordHash('yourpassword')))"`.
  ADMIN_PASSWORD_HASH: env("ADMIN_PASSWORD_HASH"),

  // Signs the session cookie. A random value per boot logs everyone out on
  // restart, which is safe but annoying — set this in .env for production.
  SECRET_KEY: env("SECRET_KEY") || crypto.randomBytes(32).toString("hex"),

  PUBLIC_BASE_URL: env("PUBLIC_BASE_URL", "http://localhost:5000").replace(/\/+$/, ""),
  PORT: envInt("PORT", 5000),

  GRAPH_VERSION,
  GRAPH: `https://graph.facebook.com/${GRAPH_VERSION}`,
  WA_API_URL: `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,

  // Instagram API *with Instagram Login* is served from graph.instagram.com, not
  // graph.facebook.com. Set IG_GRAPH_HOST to graph.facebook.com only if you chose
  // Facebook Login for Business instead (which also needs a linked Facebook Page).
  IG_GRAPH_HOST,
  IG_GRAPH: `https://${IG_GRAPH_HOST}/${GRAPH_VERSION}`,

  // ------------------------------------------------------------------ models
  ANSWER_MODEL: env("ANSWER_MODEL", "llama3-8b-8192"),
  CLASSIFIER_MODEL: env("CLASSIFIER_MODEL", "llama3-8b-8192"),

  // ---------------------------------------------------------------- identity
  BUSINESS_NAME,
  DOMAIN_NAME,

  // ------------------------------------------------------------------ tenancy
  // One Instagram account and one client on this deployment. When on, a webhook
  // event we cannot map to a tenant falls back to the sole active tenant, and an
  // inbound WhatsApp message with no ref code and no dedicated number does too.
  //
  // Leave this OFF the moment a second client exists: the fallback is exactly
  // what would attribute one client's lead to another. With it off, an
  // unmappable event is logged and dropped instead.
  SINGLE_TENANT_MODE: envBool("SINGLE_TENANT_MODE", false),

  // Seed the primary real-estate client on boot when it is missing, so a fresh
  // deployment can answer WhatsApp immediately instead of dropping the first
  // inbound message for want of a tenant to attribute it to. Unlike the demo
  // seed this runs in production too. Set false to manage clients by hand.
  SEED_PRIMARY_TENANT: envBool("SEED_PRIMARY_TENANT", true),

  // --------------------------------------------------- whatsapp 24-hour window
  // The Cloud API refuses free-form messages more than 24h after the customer's
  // last inbound one (error 131047). Business-initiated messages need an
  // approved template. Name the templates here to enable those sends at all.
  WA_ALERT_TEMPLATE: env("WA_ALERT_TEMPLATE"),      // agent "new hot lead" alert
  WA_REENGAGE_TEMPLATE: env("WA_REENGAGE_TEMPLATE"), // customer outside 24h
  WA_TEMPLATE_LANG: env("WA_TEMPLATE_LANG", "en"),
  WA_WINDOW_HOURS: envInt("WA_WINDOW_HOURS", 24),

  // Whole-message matches that opt a customer out. Policy requires honouring
  // these, and complaint rate is what gets a number restricted.
  OPT_OUT_KEYWORDS: ["stop", "unsubscribe", "opt out", "optout", "stop all",
                     "band karo", "block"],
  OPT_OUT_MESSAGE:
    "Done — you won't get any more messages from us. " +
    "Reply *start* if you ever want to continue. 👋",
  OPT_IN_KEYWORDS: ["start", "resume", "subscribe"],
  OPT_IN_MESSAGE: "Welcome back! How can I help? 🙂",

  // ------------------------------------------------------------------ logging
  // Webhook payloads carry phone numbers, names and message text. Off by
  // default so they never reach a hosting provider's log stream.
  LOG_WEBHOOK_PAYLOADS: envBool("LOG_WEBHOOK_PAYLOADS", false),
  LOG_REDACT_PII: envBool("LOG_REDACT_PII", true),

  // ---------------------------------------------------------------- retention
  // processed_events only ever grows otherwise. Meta stops retrying long
  // before this, so anything older cannot still need deduplicating.
  PROCESSED_EVENT_RETENTION_DAYS: envInt("PROCESSED_EVENT_RETENTION_DAYS", 7),

  // ------------------------------------------------------------------- cookies
  // Send the session cookie over HTTPS only. Defaults on in production.
  COOKIE_SECURE: envBool("COOKIE_SECURE", env("NODE_ENV") === "production"),
  TRUST_PROXY: envBool("TRUST_PROXY", env("NODE_ENV") === "production"),

  HISTORY_TURNS: 10,
  ESCALATE_AFTER_OUT_OF_SCOPE: 3,

  OUT_OF_SCOPE_MESSAGE:
    `Sorry, I can only help with questions about ${DOMAIN_NAME} ` +
    `at ${BUSINESS_NAME}. 😊\n\n` +
    "Please ask me something related to that, or type *agent* to talk to a person.",
  ESCALATION_MESSAGE:
    "I've passed this conversation to our team — someone will reply here shortly. 🙏",
  ERROR_MESSAGE:
    "Sorry, I'm having a technical issue right now. Please try again in a moment.",

  HUMAN_KEYWORDS: ["agent", "human", "representative", "manager", "talk to someone"],

  // ------------------------------------------------------------ rate limiting
  // Meta's practical ceiling is ~200 automated DMs/hour/account. Stay well under.
  IG_SENDS_PER_HOUR: envInt("IG_SENDS_PER_HOUR", 150),
  WA_SENDS_PER_HOUR: envInt("WA_SENDS_PER_HOUR", 600),
  QUEUE_TICK_SECONDS: envInt("QUEUE_TICK_SECONDS", 5),
  QUEUE_MAX_ATTEMPTS: 4,

  // Private replies are only allowed within 7 days of the comment.
  IG_PRIVATE_REPLY_WINDOW_HOURS: 7 * 24,

  // ----------------------------------------------------------- leak recovery
  // Clicked the link but never sent the WhatsApp message → one nudge, once.
  RECOVERY_DELAY_MINUTES: envInt("RECOVERY_DELAY_MINUTES", 20),
  RECOVERY_MESSAGE:
    "Saw you opened the link — WhatsApp not convenient right now? " +
    "Happy to just send the details here instead 📄",

  // ------------------------------------------------------------------ scoring
  // Legacy single-tenant fallbacks. Live scoring reads points off each tenant's
  // own question options; only the bands are still consulted, and only when a
  // tenant has not overridden them.
  BAND_HOT: 70,
  BAND_WARM: 40,

  // ---------------------------------------------------------------------- CRM
  CRM_ADAPTER: env("CRM_ADAPTER", "csv"), // null | csv | webhook
  CRM_WEBHOOK_URL: env("CRM_WEBHOOK_URL"),
  CRM_CSV_PATH: env("CRM_CSV_PATH", path.join(BASE_DIR, "crm_export.csv")),

  // ------------------------------------------------------- lead stage order
  STAGES: [
    "COMMENTED", "DM_SENT", "DM_REPLIED", "LINK_SENT", "CLICKED",
    "WA_ENGAGED", "QUALIFYING", "QUALIFIED", "HANDED_OFF", "CRM_SYNCED",
  ],

  KNOWLEDGE_BASE: "",
};

config.KNOWLEDGE_BASE = loadKnowledgeBase();

/** Shout about anything that is insecure rather than merely unconfigured.
 *
 * Returns the list of warnings so /health can report them and a deploy can be
 * checked without reading the logs.
 */
export function validateSecurity() {
  const warnings = [];

  if (!config.META_APP_SECRET) {
    warnings.push(
      "META_APP_SECRET is not set — webhook payloads CANNOT be verified. Anyone " +
      "who knows your webhook URL can forge comments and make the bot send " +
      "messages on your tokens. Set it from Meta App Dashboard → Settings → Basic.",
    );
  } else if (!config.VERIFY_WEBHOOK_SIGNATURE) {
    warnings.push(
      "VERIFY_WEBHOOK_SIGNATURE is off — webhook signatures are being ignored.",
    );
  }
  if (!config.WA_VERIFY_TOKEN) {
    warnings.push("WA_VERIFY_TOKEN is not set — /webhook cannot complete Meta's handshake.");
  }
  if (!config.IG_VERIFY_TOKEN) {
    warnings.push("IG_VERIFY_TOKEN is not set — /ig-webhook cannot complete Meta's handshake.");
  }
  if (!config.ADMIN_PASSWORD_HASH && !config.ADMIN_PASSWORD) {
    warnings.push("Neither ADMIN_PASSWORD_HASH nor ADMIN_PASSWORD is set — admin login is disabled.");
  }
  if (config.ADMIN_PASSWORD && !config.ADMIN_PASSWORD_HASH) {
    warnings.push(
      "ADMIN_PASSWORD is stored in plaintext in the environment. Prefer " +
      "ADMIN_PASSWORD_HASH (see .env.example).",
    );
  }
  if (["admin", "password", "change-me", "changeme"].includes(
        (config.ADMIN_PASSWORD || "").toLowerCase())) {
    warnings.push("ADMIN_PASSWORD is a well-known default — change it now.");
  }
  if (!env("SECRET_KEY")) {
    warnings.push("SECRET_KEY is not set — every restart logs all portal users out.");
  }
  if (config.PUBLIC_BASE_URL.startsWith("https://") && !config.COOKIE_SECURE) {
    warnings.push("COOKIE_SECURE is off on an HTTPS deployment — set COOKIE_SECURE=true.");
  }
  if (config.LOG_WEBHOOK_PAYLOADS) {
    warnings.push("LOG_WEBHOOK_PAYLOADS is on — customer phone numbers and message text are being logged.");
  }
  if (BUSINESS_NAME_DEFAULTED) {
    warnings.push(
      `BUSINESS_NAME is not set — the public privacy policy at /privacy is being ` +
      `served under the sample name "${BUSINESS_NAME}". Meta's App Review opens ` +
      `that page and compares it to the app being submitted.`,
    );
  }
  if (DOMAIN_NAME_DEFAULTED) {
    warnings.push(
      `DOMAIN_NAME is not set — the bot refuses off-topic questions by naming ` +
      `"${DOMAIN_NAME}", which is the sample vertical, not yours.`,
    );
  }

  if (warnings.length) {
    console.warn("\n  ⚠  Configuration warnings");
    for (const w of warnings) console.warn(`     · ${w}`);
    console.warn("");
  } else {
    console.log("Security configuration: OK");
  }
  return warnings;
}

export function validateIgConfig() {
  const isConfigured = Boolean(config.IG_TOKEN);
  const isSameAsWa = isConfigured && config.IG_TOKEN === config.WHATSAPP_TOKEN;
  const isPlaceholder = isConfigured && config.IG_TOKEN.startsWith("TOK_");
  const isUserIdSet = Boolean(config.IG_USER_ID);

  console.log("Instagram configuration:");
  console.log(`  IG_TOKEN configured: ${isConfigured}`);
  if (isConfigured) {
    console.log(`  IG_TOKEN length: ${config.IG_TOKEN.length}`);
  }
  console.log(`  IG_USER_ID configured: ${isUserIdSet}`);
  console.log(`  IG_GRAPH: ${config.IG_GRAPH}`);

  if (!isConfigured) {
    console.warn("  Instagram token status: IG_TOKEN environment variable is not set.");
    return false;
  }
  if (isSameAsWa) {
    console.log("  Instagram token status: IG_TOKEN matches WHATSAPP_TOKEN (unified System User Token).");
  }
  if (isPlaceholder) {
    console.warn("  Instagram token status: IG_TOKEN is a placeholder token.");
    return false;
  }
  return true;
}

export default config;
