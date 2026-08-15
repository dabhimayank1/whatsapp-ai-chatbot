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
architecture, same SQLite schema, same behaviour.

---

## Before you deploy this anywhere public

Two settings decide whether this app is safe to expose. Neither has a usable
default, on purpose.

| Set this | Or else |
|---|---|
| `META_APP_SECRET` | Webhook payloads cannot be verified, and anyone who learns your webhook URL can forge Instagram comments and make the bot send DMs on your tokens. `GET /health` reports `webhook_signature: unavailable` until you set it. |
| `ADMIN_PASSWORD_HASH` (or `ADMIN_PASSWORD`) | The admin login is disabled. It used to default to `admin`. Generate a hash with `npm run hash-password -- 'your-password'`. |

`SINGLE_TENANT_MODE` is the third one to understand: leave it **off** unless this
deployment serves exactly one client. See [Multi-tenant](#multi-tenant-in-one-paragraph).

---

## Quick start (no Meta accounts needed)

```bash
npm install
```

```bash
npm test
```

188 checks across three suites, all offline — no Groq key, no Meta credentials.

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
npm run test:security
```

107 checks on the things that are invisible when they work: webhook signature
verification, the subscription handshake, tenant resolution refusing to guess,
the WhatsApp 24-hour window, opt-out, deletion actually deleting, admin login
throttling, and free-text answers matching on whole words only.

```bash
npm run test:seed
```

41 checks that a fresh production deployment can answer WhatsApp on its first
inbound message: the primary client is seeded even under `NODE_ENV=production`,
its five questions are correct, seeding is idempotent, operator edits survive a
reboot, and an inbound "Hi" routes by `phone_number_id` straight to Question 0.

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

### An event that cannot be mapped to a tenant is dropped

That rule is load-bearing. Resolution goes: **ref code** (minted for exactly one
lead, so it is proof) → **dedicated phone number** → **an existing conversation
with this person**. If none of those match, the event is logged and dropped, and
an inbound WhatsApp message becomes an unattributed lead rather than being
assigned to a guess.

`SINGLE_TENANT_MODE=true` relaxes this to "fall back to the only active tenant",
which is correct when you have one client and wrong the moment you have two. It
refuses to engage unless exactly one tenant is active, so it cannot silently
misroute — but turn it off before onboarding client number two.

There is no name matching. Searching the customer's message text for a client's
name handed "hi priya, is the gym open?" from a stranger straight to the gym.

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
| `src/security.js` | **Webhook signature verification**, rate limiting, log redaction |
| `src/privacy.js` | Policy page, deletion endpoints, Meta's deletion callback |
| `src/passwords.js` | Werkzeug-compatible password hashing |
| `src/strings.js` | `{placeholder}` formatting and URL quoting |
| `testFunnel.js` | 53-check end-to-end suite |
| `testMultitenant.js` | 45-check isolation suite |
| `testSecurity.js` | 90-check authenticity, consent and privacy suite |
| `seedDemo.js` | Three demo clients across three verticals |

Two different seeds, and the difference matters:

| Seed | When | What |
|---|---|---|
| **Primary tenant** (`ensurePrimaryTenant`) | every boot, **including production** | the one real client — Skyline Properties on `wa_phone_number_id 1200586793147016` — with its five questions. Disable with `SEED_PRIMARY_TENANT=false`. |
| **Demo clients** (`ensureDefaultTenants`) | only outside production, and only into an empty database | three sample clients with the password `demo123`. Force with `SEED_DEMO_TENANTS=true`. |

The primary seed exists because of a real outage: Render runs
`NODE_ENV=production` on a disk that starts empty, so the demo seed was skipped
and the `tenants` table stayed empty. An inbound "Hi" then resolved to no
tenant, `tenants.questions(null)` returned `[]`, and `startFlow()` never ran —
the customer got a generic AI reply and no qualification questions at all.

It is conservative about a client that already exists: routing fields are filled
in only when blank, never overwritten, and questions are seeded only when there
are none. Edits made in the portal outrank the constant in the source.

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
`render.yaml` pins `numInstances: 1` for this reason.

---

## The WhatsApp 24-hour window

The Cloud API refuses free-form messages more than 24 hours after the customer's
last inbound message — error 131047, no matter how the message is worded. Only an
approved template gets through.

Every inbound message records `leads.last_inbound_at`, and the worker checks it
before sending. Outside the window it either uses `WA_REENGAGE_TEMPLATE` or
cancels the row with the reason attached, rather than retrying into a wall.

**The case that catches everyone: agent alerts.** A hot-lead alert goes to *your
team*, who have almost certainly never messaged the business number — so there is
no open window and a plain-text alert always fails. Set `WA_ALERT_TEMPLATE` to an
approved template with five body placeholders: band, score, name and number,
answers, dashboard link.

Cancelled and failed sends appear in a banner at the top of the Funnel tab, with
the Meta error and a retry button. That banner is the point: an expired token
used to mean a client's DMs stopped silently.

---

## Consent

A whole-message `stop` / `unsubscribe` / `opt out` sets `leads.opted_out`, pauses
the bot, cancels anything already queued for that number, and sends one
confirmation. `start` reverses it. Matching is on the whole message, so "can I
stop by at 6?" is a question, not an opt-out. Later messages from an opted-out
person are recorded for the agent but get no automated reply.

Policy requires honouring this, and complaint rate is what gets a number
restricted.

---

## Privacy and deletion

`/privacy` states what is collected and carries a form that deletes it. Deletion
is a hard delete — the lead, its messages, answers, events, queued sends and CRM
rows all go, and an audit row keeps the confirmation code and count while
retaining nothing that identifies the requester.

| Route | Purpose |
|---|---|
| `GET /privacy` | policy, and the deletion form |
| `POST /privacy/delete-request` | someone deleting their own data |
| `POST /data-deletion` | Meta's signed data-deletion callback (App Review needs this) |
| `GET /data-deletion/status/:code` | the status URL that callback returns |
| `DELETE /api/leads/:id` | operator deleting one lead |
| `POST /api/privacy/erase` | operator deleting by number or username |

Point Meta's **Data Deletion Request URL** at `POST /data-deletion`. It verifies
the `signed_request` against `META_APP_SECRET` and rejects anything unsigned —
otherwise the endpoint would let anyone delete any user's data by guessing an id.

Webhook payload logging is off by default (`LOG_WEBHOOK_PAYLOADS`), because those
payloads carry phone numbers and message bodies and a hosting provider's log
stream is not somewhere you can delete them from.

---

## Connecting the real platforms

### WhatsApp

1. Meta app → **Settings → Basic → App Secret** into `META_APP_SECRET`. Do this
   first; without it no webhook can be authenticated.
2. Meta app → add **WhatsApp** → copy the token and Phone number ID into `.env`
3. `ngrok http 5000`, put `PUBLIC_BASE_URL` in `.env`
4. Webhook callback `https://…/webhook`, verify token = `WA_VERIFY_TOKEN`
   (invent your own — there is no default, and an unset token fails the handshake)
5. Subscribe to the `messages` field
6. WhatsApp Manager → **Message templates** → create the agent alert template and
   set `WA_ALERT_TEMPLATE`

### Instagram

Use **Instagram API with Instagram Login** — it does not require the account to
be linked to a Facebook Page.

1. Convert the account to **Professional** (Business or Creator)
2. Meta app → add **Instagram** → Instagram Login
3. Request scopes: `instagram_business_basic`,
   `instagram_business_manage_comments`, `instagram_business_manage_messages`
4. Webhook callback `https://…/ig-webhook`, verify token = `IG_VERIFY_TOKEN`.
   It must differ from `WA_VERIFY_TOKEN`, and the placeholder strings in
   `.env.example` are not accepted — they are published, so they are not secrets.
5. Subscribe to the `comments` and `messages` fields
6. **Data Deletion Request URL** → `https://…/data-deletion`
7. Add each reel in the dashboard's **Campaigns** tab with its media ID. A comment
   on a reel you have not registered still works — the keyword match borrows
   another campaign's copy and a campaign row is created for the real reel, so
   per-reel numbers stay honest. Rename it in the Campaigns tab.

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

**The schema has diverged.** `leads` gained `last_inbound_at` and `opted_out`, and
there is a new `deletion_log` table. `database.migrate()` adds the columns to an
existing database on boot, so upgrading in place is safe — but the Python app
would need the same columns before the two can share one file again.

---

## Deliberate omissions

Things a reviewer might expect that are absent on purpose, so they read as
decisions rather than oversights:

- **No CSRF tokens.** The session cookie is `SameSite=Lax`, which browsers do not
  attach to cross-site POSTs, so a form on another origin cannot act as a logged-in
  user. The unauthenticated form that does exist — the desktop callback — is rate
  limited instead, because each submission queues an agent alert.
- **No Redis for rate limiting.** The app is documented to run as one process, so
  in-memory counters are the honest implementation. Run two instances and the login
  limiter becomes per-instance.
- **No vector database.** One business's knowledge is a few thousand tokens against
  Groq's 128k context. Add retrieval past ~30k.
- **Failed sends are surfaced, not alerted on.** They appear in the portal; nothing
  emails you. Wire `GET /api/failures` into whatever you already watch.

---

## Deploying free

| Need | Service | Catch |
|---|---|---|
| Hosting | Render free web service | Sleeps after 15 min → ~50 s cold start, and **the worker sleeps with it**, so the queue and recovery nudges stall until something wakes the process. Ping `/health` every 10 min from cron-job.org. |
| Database | Mounted disk, or [Turso](https://turso.tech) | Free hosting has no persistent disk, so the local `.db` — every lead you have — is wiped on redeploy. |
| AI | Groq | 14,400 requests/day free |
| CRM | Zoho / HubSpot free, or `CRM_ADAPTER=webhook` into Zapier or n8n | |

`render.yaml` is a working blueprint: one instance, a mounted disk at
`/var/data`, `DB_PATH` pointed at it, and every secret marked `sync: false` so it
comes from the dashboard rather than the repo.

```bash
node src/app.js
```

SIGTERM is handled, so a deploy stops the worker and closes the database rather
than being killed mid-send and stranding claimed queue rows for ten minutes.

**The free tier's ephemeral disk is the real risk here, not the cold starts.**
Once leads have value, mount a disk or move to a ₹350/month VPS.
