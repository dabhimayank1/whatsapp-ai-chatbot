/**
 * Express entry point — assembles the funnel.
 *
 * Routes:
 *   GET/POST /webhook      WhatsApp Cloud API
 *   GET/POST /ig-webhook   Instagram comments and DMs
 *   GET      /r/<code>     click tracker → WhatsApp (or QR on desktop)
 *   GET      /admin        dashboard
 *   GET      /health       keep-alive target for a free-tier cron ping
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import cookieSession from "cookie-session";
import express from "express";
import nunjucks from "nunjucks";

import { router as adminRouter } from "./admin.js";
import config, { validateIgConfig, validateSecurity } from "./config.js";
import * as db from "./database.js";
import { router as privacyRouter } from "./privacy.js";
import { captureRawBody } from "./security.js";
import * as tenants from "./tenants.js";
import { router as trackerRouter } from "./tracker.js";
import { router as igRouter } from "./webhooksIg.js";
import { router as waRouter } from "./webhooksWa.js";
import * as worker from "./worker.js";

const TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "templates",
);

export function createApp({ startWorker = true } = {}) {
  const app = express();

  // Jinja2-compatible templating, so the Flask templates render unchanged.
  nunjucks.configure(TEMPLATE_DIR, { express: app, autoescape: true });

  // Behind Render's proxy, req.ip is the proxy's address unless we say so —
  // which would make every rate limiter count the whole internet as one client.
  if (config.TRUST_PROXY) app.set("trust proxy", 1);

  // `verify` is the only place the raw bytes are still available, and webhook
  // signatures are computed over exactly those bytes — re-serialising the
  // parsed object changes key order and whitespace and the digest stops matching.
  app.use(express.json({ limit: "2mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  // A few headers no template should have to remember.
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set("X-Frame-Options", "DENY");
    next();
  });

  app.use(cookieSession({
    name: "session",
    keys: [config.SECRET_KEY],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // Lax is also the CSRF control: browsers do not attach a Lax cookie to a
    // cross-site POST, so a form on someone else's page cannot act as a
    // logged-in user.
    sameSite: "lax",
    secure: config.COOKIE_SECURE,
  }));

  db.initDb();
  tenants.ensureDefaultTenants();
  validateIgConfig();
  const warnings = validateSecurity();

  app.use(privacyRouter);
  app.use(waRouter);
  app.use(igRouter);
  app.use(trackerRouter);
  app.use(adminRouter);

  app.get("/", (req, res) => res.redirect(302, "/admin"));

  // The keep-alive target for a free-tier cron ping. Deliberately thin: it used
  // to return full queue counts to anyone who asked. Queue detail now lives on
  // /api/funnel behind the admin login.
  app.get("/health", (req, res) =>
    res.json({
      status: "ok",
      config_warnings: warnings.length,
      webhook_signature: config.META_APP_SECRET
        ? (config.VERIFY_WEBHOOK_SIGNATURE ? "enforced" : "disabled")
        : "unavailable (META_APP_SECRET not set)",
    }));

  if (startWorker) worker.start();

  return app;
}

// Only listen when run directly, so the test suites can import createApp().
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const app = createApp();
  const server = app.listen(config.PORT, "0.0.0.0", () => {
    console.log(`SocialToSales listening on http://localhost:${config.PORT}`);
    console.log(`Portal: http://localhost:${config.PORT}/login`);
  });

  // A deploy sends SIGTERM. Without this the process is killed mid-send and its
  // claimed queue rows sit in 'sending' until reclaimStale() frees them ten
  // minutes later — so every deploy delayed a batch of DMs.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — finishing up`);
    worker.stop();
    server.close(() => {
      db.closeDb();
      console.log("shutdown complete");
    });
    // Do not wait forever on a hung keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export default createApp;
