# Customer Enquiry Dashboard

AI-assisted triage for the `sales@jdhealthcare.com.au` inbox. It ingests
incoming customer/vendor emails, classifies them, extracts key fields (PO
number, facility, quote number), suggests a next action for customer service
staff, and gives the team a queue + stats view to work from.

## Why

The `sales@` mailbox mixes several very different kinds of email: PO/ETA
chasing from health department buyers (the majority of volume), product and
clinical enquiries, equipment fault reports, invoice disputes, quotes, supplier
correspondence, and internal staff threads. Each needs different handling —
this dashboard sorts that out automatically so staff can work a prioritized
queue instead of a flat inbox.

## Architecture

```
backend/   Express API + SQLite storage + AI/rule-based triage classifier
           + a Microsoft Graph poller for live mailbox ingestion
frontend/  React (Vite) dashboard: Overview stats, Triage Queue, Enquiry Detail
```

- **Triage dispatcher** (`backend/src/triage/index.js`) — the entry point every
  email goes through. Obvious internal-only threads and known spam senders are
  resolved with cheap deterministic rules (no need to pay for a model call on
  unambiguous cases). Everything else — the actual enquiries — goes to:
  - **AI classifier** (`backend/src/ai/classifier.js`) — a Claude Opus 5
    structured-output call, grounded in `backend/docs/response-patterns.md`
    (real reply patterns learned from the mailbox). Returns category,
    priority, a confidence score, extracted fields, and a suggested action.
    Active whenever `ANTHROPIC_API_KEY` is set.
  - **Rule-based classifier** (`backend/src/triage/classify.js`) — the
    original keyword/domain-based v1. Used as a fallback when no API key is
    configured, or if an AI call fails for a given email, so ingestion never
    blocks on the AI provider being down.
- **Storage** — SQLite (`backend/data/enquiries.db`, gitignored). One row per
  email, keyed by Graph message ID so re-polling is idempotent. Each row
  records which classifier produced it (`classified_by`) and, for AI
  classifications, a confidence score — surfaced on the enquiry detail page,
  with low-confidence results flagged for a second look.
- **Ingestion** — two paths:
  1. `backend/seed-data/sample-emails.json` — real (anonymized-safe) sample
     emails pulled from the mailbox, used by `npm run seed` so the dashboard
     is demoable without live credentials.
  2. `backend/src/graph/poller.js` — polls the mailbox via Microsoft Graph on
     a schedule (default every 5 minutes) once Azure AD credentials are
     configured. No-ops otherwise.

## Enquiry categories

| Category | Meaning |
|---|---|
| `PRODUCT_COMPLAINT` | Formal/adverse-event complaints — LOT/expiry, discontinue-use language |
| `EQUIPMENT_FAULT` | Product not working / fitting issue — may be patient-impacting |
| `BACKORDER_NOTICE` | Automated backorder-past-due notice from a buyer |
| `PO_ETA_REQUEST` | Purchase order or dispatch/ETA chase from a health dept or facility |
| `RETURNS_CREDIT` | Goods returns and credit notes |
| `INVOICE_BILLING` | Invoice disputes, overbilling, payment queries |
| `LOGISTICS_FREIGHT` | Courier/freight coordination (consignments, PODs, pickups) |
| `QUOTE_PRICING` | Quote requests/follow-ups, pricing questions |
| `PRODUCT_ENQUIRY` | General customer product/compatibility/hire questions, sales leads |
| `SUPPLIER_VENDOR` | Correspondence with parts suppliers/manufacturers |
| `INTERNAL` | Staff-to-staff threads that happen to CC sales@ |
| `SPAM_NOTIFICATION` | Quarantine alerts, marketing/training newsletters |

Priority is one of `URGENT` / `HIGH` / `NORMAL` / `LOW`, derived from keywords,
Outlook importance flag, and category (equipment faults are always urgent).

## Running locally

### Backend

```bash
cd backend
npm install
npm run seed   # loads backend/seed-data/sample-emails.json into SQLite
npm start       # http://localhost:4000
npm test        # regression tests for the rule-based classifier (node:test, no extra deps)
```

Copy `backend/.env.example` to `backend/.env` and set `ANTHROPIC_API_KEY` to
enable real AI classification (see below). Without it, `npm run seed` and
live ingestion use the rule-based classifier only — everything else works
the same either way.

### Frontend

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173
```

The frontend reads `VITE_API_BASE` from `frontend/.env` (defaults to
`http://localhost:4000/api`).

### API summary

| Endpoint | Description |
|---|---|
| `GET /api/enquiries?category=&priority=&status=&search=&sort=&order=` | List/filter enquiries. `search` matches subject, body, sender email, PO#, facility, and assignee |
| `GET /api/enquiries/:id` | Single enquiry, full detail |
| `PATCH /api/enquiries/:id` | Update `assignedTo` (dashboard-only; `status` is read-only — rejected with 400 if sent, since it's derived from Outlook, see "Status sync" below) |
| `GET /api/enquiries/export` | CSV export — same filters as the list endpoint, no pagination. Lean reporting column set (no draft/body content) |
| `GET /api/stats/overview` | Counts by category/status/priority/facility, aging buckets, open workload by assignee, 30-day daily volume, avg resolution time (gated behind a minimum sample size) |
| `GET /api/ingest/status` | Whether live Graph polling and AI classification are configured |
| `POST /api/ingest/run` | Manually trigger one poll cycle |

## AI classification

Set `ANTHROPIC_API_KEY` in `backend/.env` (copy from `.env.example`) and
restart the backend. From then on, every enquiry that isn't obviously
internal-only or known spam is classified by Claude Sonnet 5 instead of the
keyword rules — with a confidence score, better handling of nuance (e.g. a
customer who already fixed their own issue vs. an active fault report), and
a suggested action grounded in `backend/docs/response-patterns.md`.

- No key configured → rule-based classifier only, no behavior change.
- Key configured but a classification call fails (network, rate limit, etc.)
  → that single enquiry falls back to the rule-based classifier rather than
  blocking ingestion; it's tagged `classified_by: "rules-fallback"`.
- The model call uses `thinking: {type: "disabled"}` at `effort: "medium"` —
  this is a bounded classification task, not open-ended reasoning, so full
  adaptive thinking isn't needed. Tune this in `backend/src/ai/classifier.js`
  if you want more headroom on harder cases, at higher per-email cost.
- Low-confidence AI classifications (<50%) are flagged on the enquiry detail
  page for a human second look rather than being silently trusted.

## AI-drafted replies

`draftReply` is generated **on demand**, not automatically at classification
time — staff click "Generate draft" on the enquiry detail page, which calls
`POST /api/enquiries/:id/draft` (`generateDraft` in `ai/classifier.js`, a
separate API call from classification). This is a deliberate cost choice:
a large share of enquiries (ignored, low-priority, resolved via the Outlook
flag before anyone opens them) never need a draft at all, so this way
staff only pay for one when they're actually acting on it.

- **Direct-reply categories** (PO/ETA, returns, invoice, quotes, backorder,
  logistics, simple product enquiries) get an actual ready-to-send customer
  reply in the house structure (greeting by first name, "Thank you for
  contacting us", category-specific body, apology if relevant, sign-off).
- **Complaints and genuine equipment faults** get an immediate customer
  acknowledgment as the draft, not an internal handoff — real Sent Items
  show staff reply to the customer straight away (discontinue use, confirm
  product code/LOT/expiry) rather than waiting on internal sign-off first.
  The internal routing (e.g. to Graham Lade and Scott Borresen) is still
  covered separately by `suggestedAction`.
- **Routing-only categories** (trial requests, website/sales-lead
  enquiries, supplier/vendor correspondence) get a short internal handoff
  note using a region placeholder (e.g. `[territory rep — SYDNEY]`) rather
  than an individual's name — see "Territory rep placeholders" below.
- **Already-replied threads get thread history included.** If the enquiry
  has a `conversationId` and Graph is configured, the endpoint fetches every
  prior message in that conversation (`fetchConversationMessages` in
  `graph/client.js`) and includes it in the drafting prompt, so a follow-up
  draft continues the conversation naturally instead of repeating or
  contradicting what's already been said. Best-effort — a Graph failure
  here doesn't block drafting, just means less context.
- The "Generate draft" button/endpoint is available for **every** category —
  the backend doesn't pre-filter any of them out. Categories like
  `INTERNAL`/`SPAM_NOTIFICATION`/`UNCLASSIFIED` (and automated no-reply
  senders in any category) usually have nothing to draft, but that's the
  drafting prompt's own judgment call (`DRAFT_SYSTEM_PROMPT` returns
  `draftReply: null`), not a system pre-filter — staff can still click the
  button and see for themselves, and the button relabels to "Try again" with
  a hint if Claude comes back empty.
- The rule-based fallback classifier still produces a draft automatically
  (a simple template using extracted fields) whenever it classifies an
  enquiry — that's a free template, not an API call, so there's no cost
  reason to withhold it.
- Staff review and edit before sending; there's no auto-send integration —
  drafts are copied into Outlook manually via the "Copy to clipboard"
  button.

## Email thread history

The detail page has a "Show previous replies" button (only shown when the
enquiry has a `conversationId`) that fetches every prior message in that
conversation from Outlook (`GET /api/enquiries/:id/thread`, same
`fetchConversationMessages` Graph call the draft generator uses
internally) and displays them chronologically — sender, recipients,
timestamp, and body. Also on-demand rather than automatic, since most
enquiries have no reply yet and eagerly fetching on every page view would
be a wasted Graph call each time (this is a Graph API call, not Claude, so
it doesn't affect AI spend either way — the on-demand choice here is about
avoiding unnecessary Graph load/latency, not cost). Requires live Graph
polling to be configured, since `conversationId` only gets populated for
messages ingested that way — none of the static seed/demo data has one.

## Territory rep placeholders

`suggestedAction`/`draftReply` never assert an individual's name for
territory-based routing (e.g. "forward to the Sydney rep") — instead they
use a placeholder like `[territory rep — SYDNEY]` for whoever is actioning
the enquiry to fill in. An earlier version named specific people and
needed several corrections as territory assignments changed; routing by
region and leaving the name to a human avoids repeating that. The one
exception is Auckland, which routes to Medix21 (an external distributor
company, not an individual) — that's stable enough to name directly.
Formal complaints still route to Graham Lade and Scott Borresen by name,
since that came directly from the business owner as a fixed escalation
path, not an inferred territory mapping.

## Live ingestion setup (Microsoft Graph)

The seed data lets you run the dashboard today. To have it poll the real
`sales@jdhealthcare.com.au` inbox, an Azure AD admin needs to set up an app
registration:

1. **Azure Portal → Microsoft Entra ID → App registrations → New registration.**
   Any name (e.g. "Customer Enquiry Dashboard"). Single tenant is fine.
2. **API permissions → Add a permission → Microsoft Graph → Application
   permissions → `Mail.Read`.** Then **Grant admin consent**. Application
   permissions (not delegated) are required since this runs unattended as a
   background service, not as a signed-in user.
3. **Restrict the permission to just this mailbox** (strongly recommended —
   otherwise the app can read *every* mailbox in the tenant): create an
   [Application Access Policy](https://learn.microsoft.com/graph/auth-limit-mailbox-access)
   scoped to a mail-enabled security group containing only
   `sales@jdhealthcare.com.au`, via Exchange Online PowerShell:
   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId <group-email> -AccessRight RestrictAccess
   ```
4. **Certificates & secrets → New client secret.** Copy the value immediately
   (shown once).
5. Copy `backend/.env.example` to `backend/.env` and fill in:
   ```
   TENANT_ID=<directory (tenant) ID>
   CLIENT_ID=<application (client) ID>
   CLIENT_SECRET=<client secret value>
   MAILBOX=sales@jdhealthcare.com.au
   ```
6. Restart the backend. It will log `[graph-poller] Scheduled polling
   started` and begin ingesting new mail **every minute** by default (set
   `POLL_CRON_EXPRESSION` to loosen this, e.g. `*/5 * * * *` for every 5
   minutes, if per-minute polling turns out to be more than the mailbox's
   volume needs). Trigger a poll immediately with
   `curl -X POST localhost:4000/api/ingest/run`.

Without these env vars set, the app runs fine in seed-only/demo mode — the
poller silently no-ops.

## Status sync (Outlook categories & follow-up flags)

The dashboard is an add-on triage layer, not the system of record — staff
take the actual action (reply, mark a thread done) in Outlook, same as
before this existed, and `status` flows one-way from there into the
dashboard. It cannot be set manually in the dashboard (`PATCH` rejects a
`status` field with 400) precisely so it can't drift from what Outlook
actually shows. Every poll cycle re-checks each open enquiry's category
tags and follow-up flag via Graph's `$batch` endpoint and syncs the result
into `status` (`statusForCategories`/`statusForFlag` in `db/repository.js`):

- Category **"Resolved"** → dashboard status becomes `RESOLVED`, regardless
  of current status. Category **"No Action Needed"** → `IGNORED`, same way.
  These are checked first and take precedence over the flag below.
- Flag set to **Complete** → `RESOLVED` (same as the category, checked as a
  fallback when no category is set).
- Flag set to **Flagged** (follow-up, not yet complete) → only advances a
  still-untouched `NEW` enquiry to `IN_PROGRESS`. Never downgrades a more
  advanced status the reply-detection sync (below) already set (e.g.
  `WAITING_ON_CUSTOMER`).
- Neither present → no change either way; not evidence the enquiry is still new.

**Why categories, not just the flag:** checking real Sent Items showed the
follow-up flag is barely used in practice — genuinely-handled threads
routinely had no flag at all, or one left at `flagged` rather than
`complete`. Categories are a separate, currently-unused Outlook feature in
this mailbox, so they're a clean, unambiguous channel that doesn't depend
on a habit the team doesn't already have. Staff apply one via Outlook's own
Categorize menu — same low-friction motion as flagging, just a tag nothing
else is already using. This is a process change as much as a code one: it
only works if staff actually tag things "Resolved"/"No Action Needed" when
they're done.

This runs as part of every `runPollOnce()` (scheduled poll or manual
`POST /api/ingest/run`), which now also returns `flagsChecked`/`flagsUpdated`
counts. There's no reverse direction — the dashboard never writes a flag,
category, or anything else back to Outlook.

## Status sync (reply/forward detection)

Separately from the Outlook flag, every poll also checks whether staff have
actually replied to or forwarded an enquiry — without needing anyone to flag
anything manually. Each enquiry stores its Graph `conversationId`; the poller
checks Sent Items for any message in that same conversation via `$batch`
(`fetchReplyStatus` in `graph/client.js`):

- A reply/forward is found **and its recipients overlap the original
  sender's domain** (a genuine customer-facing reply) → status advances to
  `WAITING_ON_CUSTOMER`.
- A reply/forward is found **with only internal (`jdhealthcare.com.au`)
  recipients** (e.g. forwarded to a colleague for action) → status advances
  to `IN_PROGRESS`.
- No reply found → no change.

Like the flag sync, this only ever *advances* status (via a status "rank" —
`statusForReply` in `db/repository.js`) — it never downgrades something the
flag sync already set further along (e.g. won't move an already-`RESOLVED`
enquiry back to `WAITING_ON_CUSTOMER` just because it finds an old reply).
Runs as part of every `runPollOnce()` alongside the flag sync, adding
`repliesChecked`/`repliesUpdated` to the response. Enquiries without a
`conversationId` (seed data, or anything ingested before this feature
existed) are skipped — nothing to check them against.

## Access control (Basic Auth)

The dashboard shows real customer/health-department correspondence with no
other access control by default, so once it's carrying real data rather
than seed data, set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` (see
`backend/.env.example` or the `render.yaml` env vars for Render). When both
are set, every route except `GET /api/health` (which Render's own health
check polls with no credentials) requires HTTP Basic Auth. Leaving either
one blank disables auth entirely — the default, so local dev needs no setup.
See `backend/src/auth/basicAuth.js`.

## Deploying to Render

`render.yaml` at the repo root is a Render Blueprint — it defines everything
needed except secrets, so Render can provision the whole thing from the repo:

1. **Create a Render account** and connect it to this GitHub repo (Render's
   own GitHub integration — an interactive step on Render's side).
2. **New → Blueprint**, point it at this repo. Render reads `render.yaml`
   and provisions a single web service (Node), currently on the **free
   plan**, to confirm the deploy pipeline works before adding any billing.
3. **Fill in the secrets** Render prompts for (left blank in `render.yaml`
   on purpose, so they're never committed to git):
   - `ANTHROPIC_API_KEY` — enables AI classification, same as local.
   - `TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` / `MAILBOX` — the Azure AD
     app registration credentials (see "Live ingestion setup" above). Can be
     left blank for now — the app runs fine in demo mode without them, same
     as locally, and you can add them later once the app registration exists.
   - `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` — see "Access control" above.
     Also fine to leave blank for an initial demo check, but set both before
     this is showing anything beyond seed data on a public URL.
4. **Deploy.** The build step builds the frontend and installs backend
   dependencies; the app then serves both the API and the built frontend
   from one Express process on one URL — no separate frontend host, no CORS
   to configure.

**Free tier caveats** (this is a "confirm it deploys" step, not a
production setup): no persistent disk, so the SQLite database resets on
every redeploy/restart — expect an empty dashboard until it's seeded or
live polling adds data, and don't expect anything entered to survive a
redeploy. It also spins down after ~15 minutes of no HTTP traffic, which
stops the in-process cron poller until the next request wakes it back up.

**When ready to actually rely on this**, switch to the Starter plan or
above and add a persistent disk (e.g. `disk: {name: enquiries-data,
mountPath: /var/data, sizeGB: 1}` in `render.yaml`, plus a `DB_PATH`
env var pointing at `/var/data/enquiries.db`) so data survives restarts
and the poller stays running continuously.

This is a single-instance deployment either way (SQLite doesn't support
multiple app instances writing to it concurrently) — fine for this app's
scale, but worth knowing if traffic ever grows enough to need horizontal
scaling, at which point SQLite would need to move to a real database
server first.

Authentication is opt-in, not on by default — see "Access control" above.
Don't point a Render deployment's public URL at anyone before
`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` are set.

## Roadmap

- **Attachment/PDF parsing** for PO documents (many POs arrive as PDF
  attachments with the real order details, not just in the email body).
- **Classification-accuracy feedback loop.** Nothing currently tracks when
  a human overrides an AI-assigned category/priority, so there's no signal
  for whether real-world accuracy is drifting or which categories the model
  struggles with most.
- **SLA targets.** The aging-bucket breakdown on Overview shows how many
  open enquiries are piling up, but there's no configurable "urgent should
  get a first action within N hours" target or breach alerting yet.
- **Move off Render's free tier** (persistent disk + continuous polling)
  once this is more than a demo — see "Deploying to Render" above.
