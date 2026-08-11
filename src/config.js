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

const config = {
  BASE_DIR,
  KB_DIR,
  DB_PATH: env("DB_PATH", path.join(BASE_DIR, "chatbot.db")),

  // ------------------------------------------------------------- credentials
  GROQ_API_KEY: env("GROQ_API_KEY"),

  WHATSAPP_TOKEN: "EAAWV2ST7dpoBSEhR8fRsBAVSvzRPPSa9ZCBCasVLFxuEYZBq2fvLBVKcyWWpvNrUsDH1SKRZCTcIwN1ii5BzzBZCZBsjAJIzSqeJQyirxfoGuQWaX4K3xD2wbxZCgQQGObJ8ZAiFBdcg0NZBQtDebtvVIZBS0Y1KTZB6OcALhGoFT6RvuvkLDV6Qwm2bJihuuPEqlbyFSm10uwEZB2a8LO6qZAbfcUlGvmdTi0cxH1NmVRf0",
  PHONE_NUMBER_ID,
  WA_VERIFY_TOKEN: env("WA_VERIFY_TOKEN", env("VERIFY_TOKEN", "changeme")),
  WA_BUSINESS_NUMBER: env("WA_BUSINESS_NUMBER", "919876543210"), // for wa.me links

  IG_TOKEN: "EAAWV2ST7dpoBSEhR8fRsBAVSvzRPPSa9ZCBCasVLFxuEYZBq2fvLBVKcyWWpvNrUsDH1SKRZCTcIwN1ii5BzzBZCZBsjAJIzSqeJQyirxfoGuQWaX4K3xD2wbxZCgQQGObJ8ZAiFBdcg0NZBQtDebtvVIZBS0Y1KTZB6OcALhGoFT6RvuvkLDV6Qwm2bJihuuPEqlbyFSm10uwEZB2a8LO6qZAbfcUlGvmdTi0cxH1NmVRf0",
  IG_USER_ID: env("IG_USER_ID"),
  IG_VERIFY_TOKEN: env("IG_VERIFY_TOKEN", env("WA_VERIFY_TOKEN", "my-secret-verify-token-123")),

  ADMIN_USER: env("ADMIN_USER", "admin"),
  ADMIN_PASSWORD: env("ADMIN_PASSWORD", "admin"),

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
  ANSWER_MODEL: env("ANSWER_MODEL", "llama-3.3-70b-versatile"),
  CLASSIFIER_MODEL: env("CLASSIFIER_MODEL", "llama-3.1-8b-instant"),

  // ---------------------------------------------------------------- identity
  BUSINESS_NAME,
  DOMAIN_NAME,

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

export default config;
