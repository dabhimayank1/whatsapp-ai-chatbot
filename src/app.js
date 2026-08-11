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
import config from "./config.js";
import * as db from "./database.js";
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

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieSession({
    name: "session",
    keys: [config.SECRET_KEY],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  }));

  db.initDb();
  tenants.ensureDefaultTenants();

  app.get("/privacy", (req, res) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Privacy Policy & Data Deletion</title></head>
        <body style="font-family:sans-serif; padding:40px; line-height:1.6;">
          <h1>Privacy Policy & User Data Deletion</h1>
          <p>We respect your privacy. All user interaction data collected via WhatsApp and Instagram is strictly used to provide automated customer support and qualification services.</p>
          <h2>Data Deletion Instructions</h2>
          <p>If you wish to delete your data from our system, please send an email to <strong>dabhimayank086@gmail.com</strong> with your Instagram username or phone number. We will process your deletion request within 24 hours.</p>
        </body>
      </html>
    `);
  });

  app.use(waRouter);
  app.use(igRouter);
  app.use(trackerRouter);
  app.use(adminRouter);

  app.get("/", (req, res) => res.redirect(302, "/admin"));

  app.get("/health", (req, res) =>
    res.json({
      status: "ok",
      business: config.BUSINESS_NAME,
      domain: config.DOMAIN_NAME,
      queue: db.queueStats(),
    }));

  if (startWorker) worker.start();

  return app;
}

// Only listen when run directly, so the test suites can import createApp().
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const app = createApp();
  app.listen(config.PORT, "0.0.0.0", () => {
    console.log(`SocialToSales listening on http://localhost:${config.PORT}`);
    console.log(`Portal: http://localhost:${config.PORT}/login`);
  });
}

export default createApp;
