# SocialToSales — Node.js

A multi-tenant platform that turns Instagram Reel comments into qualified
WhatsApp leads. One deployment serves many influencer clients across different
verticals — gym, restaurant, real estate, salon — each with their own bot,
knowledge base, questions and login.

```
Reel comment → auto-DM → tracked link → WhatsApp bot → qualified → agent → CRM
     IG            IG        backend        WhatsApp      score     alert   sync
```

This is a straight port of the Python/Flask original in `../boat`. Same
architecture, same SQLite schema, same behaviour, same 98 checks.

---

## Quick start (no Meta accounts needed)

```bash
npm install
```

```bash
npm run test:funnel
```

53 checks covering the whole funnel with both Meta APIs stubbed — comment to
DM to click to WhatsApp to qualified to scored to CRM, plus rate limiting and
both leak fixes.

```bash
npm run test:multitenant
```

45 checks proving tenant isolation: two clients in different verticals on one
shared WhatsApp number, each refusing the other's topic, with an influencer
login unable to reach another client's data.

```bash
npm run seed
```

Creates three demo clients — a gym, a developer and a restaurant — with their
own questions and leads.

```bash
npm start
```

Open http://localhost:5000/login

| Login | Sees |
|---|---|
| `admin` / your `ADMIN_PASSWORD` | every client, can add new ones |
| `priya` / `demo123` | Priya Fitness only |
| `skyline` / `demo123` | Skyline Properties only |
| `tandoor` / `demo123` | Tandoor House only |

The bot's AI replies need a free Groq key in `.env`; everything else — the
funnel, the portal, the queue, the CRM sync — runs without one.

---

## Requirements

**Node 22.5 or newer.** Persistence uses the built-in `node:sqlite`, so there
is **no native module to compile** — no node-gyp, no Visual Studio Build Tools,
which matters on Windows. Check with `node --version`.

| Dependency | Why |
|---|---|
| `express` | HTTP routing |
| `nunjucks` | Jinja2-compatible templates — the Flask HTML renders unchanged |
| `cookie-session` | signed cookie sessions, same model as Flask's |
| `groq-sdk` | the classifier and answerer |
| `qrcode` | desktop QR fallback |
| `dotenv` | `.env` loading |

---

## Multi-tenant in one paragraph

Every client is a row in `tenants`, and everything the bot says is decided by
the tenant behind the message — never by global config. The ref code minted at
comment time is what routes a lead, so **one WhatsApp number can serve all your
clients**: a gym enquiry and a property enquiry arrive on the same number and
never see each other. Clients who want their own branded number get one
(`wa_phone_number_id`); Business Verification is per business, not per number,
so you verify your company once and hang up to 25 numbers off it.

| Per tenant | Where |
|---|---|
| Domain lock — what the bot will discuss | `tenants.domain_name` |
| Knowledge base — the bot's only source of truth | `tenants.knowledge_base` |
| Qualification questions, options, points | `tenant_questions` |
| Instagram account and token | `tenants.ig_*` |
| WhatsApp number (optional) | `tenants.wa_*` |
| Portal login, agents, leads, campaigns | scoped by `tenant_id` |

---

## How the domain lock works

Three layers, because a system prompt alone loses to *"ignore your instructions"*.

| Layer | Where | What it does |
|---|---|---|
| **Scope classifier** | `aiEngine.classify` | A separate fast model call labels the message `IN`/`CHAT`/`OUT`. The customer's text is passed as **data to be judged**, so there is no instruction for an injection to hijack — the call can only emit one of three words. Fails closed to `OUT`. |
| **Grounded answering** | `aiEngine.generateAnswer` | The answer model may only use the tenant's knowledge base. No invented prices or availability. |
| **Refusal + escalation** | `config.js` | `OUT` → fixed refusal, zero model cost. Three off-topic messages in a row, or the word *agent*, hands the thread to a human. |

No vector database on purpose: one business's knowledge is a few thousand
tokens and Groq gives 128k of context free. Add retrieval past ~30k tokens.

---

## The two leaks, and what fixes them

### Leak 1 — DM sent, never clicked

The main cause is structural: **a DM from an account the viewer doesn't follow
lands in Message Requests** with no notification. Most people rewrite copy when
the message was never read at all.

- **Two-step DM** (`webhooksIg.js`) — the first message carries *no link*, just
  a question. Replying to it moves the thread into their primary inbox **and**
  opens the 24-hour window. Step 2 then carries the link.
- **Public comment reply** — *"Just sent you a DM 📩 (check your Message
  Requests!)"* The only channel guaranteed to be visible.
- **Per-campaign A/B** — `dm_strategy` and `variant` are stored per reel, and
  the dashboard reports click-rate per variant.

### Leak 2 — clicked, WhatsApp never sent

- **Desktop QR fallback** (`tracker.js`) — a `wa.me` link on a laptop hits a QR
  wall and most people leave. Desktop visitors get a scannable code plus a
  callback form instead.
- **Short prefill** — `Hi! Interested in 3BHK Satellite (RL7K2)`.
- **Recovery nudge** (`worker.runRecovery`) — you know who clicked and never
  messaged, and the two-step DM left the 24-hour window open, so one nudge goes
  out 20 minutes later. Once only.

**The connection worth remembering:** fixing leak 1 properly is what makes leak
2 fixable. Without their DM reply there is no open window to recover them in.

---

## Attribution — the hard part

Instagram knows a user ID; WhatsApp knows a phone number. Nothing connects them
— Meta's `ctwa_clid` only exists for **paid** click-to-WhatsApp ads. So:

```
comment → mint ref RL7K2 → DM links to /r/RL7K2
                              ├─ log the click        ← why we don't link wa.me directly
                              └─ 302 → wa.me/…?text=…(RL7K2)
inbound WhatsApp → regex the code → bind wa_id to the lead
```

Without the `/r/` hop, "never clicked" and "clicked but never sent" look
identical — completely different problems.

If a viewer edits the prefilled text away, the lead is still created as
`unattributed`. **Never drop a lead over missing tracking.**

---

## Files

| File | Purpose |
|---|---|
| `src/app.js` | Express assembly, route registration, worker startup |
| `src/tenants.js` | **Client model** — resolution, questions, vertical templates |
| `src/auth.js` | **Session auth and tenant scoping** — the security boundary |
| `src/config.js` | Platform settings and defaults |
| `src/database.js` | Schema, lead queries, funnel and leak reporting |
| `src/leads.js` | Ref codes, identity stitching, scoring, handoff |
| `src/flows.js` | Qualification state machine, driven by tenant questions |
| `src/aiEngine.js` | Per-tenant domain classifier + grounded answerer |
| `src/waapi.js` / `src/igapi.js` | Meta API clients, per-tenant credentials |
| `src/webhooksWa.js` / `src/webhooksIg.js` | Inbound webhooks + tenant resolution |
| `src/tracker.js` | `/r/<code>` click tracker + desktop QR |
| `src/worker.js` | Outbound queue, rate limiting, recovery, CRM drain |
| `src/crm.js` | Swappable CRM adapter + outbox |
| `src/admin.js` | Portal routes and JSON API, scoped on every route |
| `src/passwords.js` | Werkzeug-compatible password hashing |
| `src/strings.js` | `{placeholder}` formatting and URL quoting |
| `testFunnel.js` | 53-check end-to-end suite |
| `testMultitenant.js` | 45-check isolation and security suite |
| `seedDemo.js` | Three demo clients across three verticals |

---

## Why nothing sends from a webhook

Everything outbound goes through `outbound_queue` and is drained by
`worker.js`. Two reasons:

1. Meta caps automated Instagram DMs at roughly **200/hour per account**. A reel
   that takes off blows straight through that, and sending from the request
   handler gives you nowhere to buffer.
2. Webhooks must return 200 fast or Meta retries them.

The worker spends its hourly budget oldest-first with exponential backoff, and
`processed_events` deduplicates Meta's retries so nobody gets a reply twice.

**Run a single process.** The queue drainer is an interval timer inside the web
process; two instances would both drain the queue and blow past the rate limit.
If you need more web capacity, split the worker out into its own process first.

---

## Connecting the real platforms

### WhatsApp

1. Meta app → add **WhatsApp** → copy the token and Phone number ID into `.env`
2. `ngrok http 5000`, put `PUBLIC_BASE_URL` in `.env`
3. Webhook callback `https://…/webhook`, verify token = `WA_VERIFY_TOKEN`
4. Subscribe to the `messages` field

### Instagram

Use **Instagram API with Instagram Login** — it does not require the account to
be linked to a Facebook Page.

1. Convert the account to **Professional** (Business or Creator)
2. Meta app → add **Instagram** → Instagram Login
3. Request scopes: `instagram_business_basic`,
   `instagram_business_manage_comments`, `instagram_business_manage_messages`
4. Webhook callback `https://…/ig-webhook`, verify token = `IG_VERIFY_TOKEN`
5. Subscribe to the `comments` and `messages` fields
6. Add each reel in the dashboard's **Campaigns** tab with its media ID

> ⚠️ **App Review is the critical path — submit on day one.** It takes weeks and
> needs a screencast and a published privacy policy. Everything except the
> Instagram leg works without it, so build the rest while you wait.

---

## Onboarding a new influencer client

No code, no deploy. In the portal as admin → **Clients**:

1. **Add client** — name, domain lock, vertical, portal login
2. Paste their Instagram user id and token (or leave blank until App Review clears)
3. Leave the WhatsApp fields empty to use your shared number
4. **Questions** tab → apply the vertical template, then edit
5. **Knowledge** tab → paste their prices, timings, policies, FAQs
6. **Campaigns** tab → add each reel with its trigger keyword

Templates ship for `gym`, `restaurant`, `real_estate` and `salon`. Add more in
`tenants.TEMPLATES`.

**Scoring is normalised.** Points sit on each option, and the total is scaled to
100 — so one client can ask three questions and another eight, and HOT/WARM/COLD
still mean the same thing. Each client can override their own band thresholds.

---

## Relationship to the Python app

The two are behaviourally equivalent and the SQLite schema is byte-identical,
so they can open the same `chatbot.db`. Password hashes are written in
Werkzeug's `scrypt:32768:8:1$salt$hash` format and verified in both directions,
so portal logins created by either app work in the other.

Deliberate differences:

| | Python | Node |
|---|---|---|
| Persistence | `sqlite3`, connection per call | `node:sqlite`, one shared handle |
| Templating | Jinja2 | Nunjucks (same syntax, templates copied verbatim) |
| Sessions | Flask signed cookie | `cookie-session` |
| Worker | daemon thread | `setInterval`, non-overlapping ticks |
| Password hashing | Werkzeug | `node:crypto`, Werkzeug-compatible format |

**One behaviour fix.** `worker.runRecovery()` now carries `tenant_id` on the
queued nudge. The Python version omitted it, so the leak-2 recovery DM fell back
to the global `IG_TOKEN` instead of the owning client's Instagram account —
wrong sender on a multi-tenant deployment. Every other outbound Instagram call
already passed the tenant through.

---

## Deploying free

| Need | Service | Catch |
|---|---|---|
| Hosting | Render free web service | Sleeps after 15 min → ~50 s cold start. Ping `/health` every 10 min from cron-job.org. |
| Database | [Turso](https://turso.tech) | Free hosting has no persistent disk, so the local `.db` is wiped on redeploy. |
| AI | Groq | 14,400 requests/day free |
| CRM | Zoho / HubSpot free, or `CRM_ADAPTER=webhook` into Zapier or n8n | |

```bash
node src/app.js
```

Once leads have real value, move off the free tier — a ₹350/month VPS removes
the cold starts.
