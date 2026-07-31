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
| `GET /api/enquiries?category=&priority=&status=&search=&sort=&order=` | List/filter enquiries |
| `GET /api/enquiries/:id` | Single enquiry, full detail |
| `PATCH /api/enquiries/:id` | Update `status` and/or `assignedTo` |
| `GET /api/stats/overview` | Counts by category/status/priority, oldest open, avg resolution time |
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

Every enquiry is also given a `draftReply` at classification time — shown
on the enquiry detail page as an editable, copyable text box:

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
  note addressed to the correct named person(s) per the routing rules in
  `backend/docs/response-patterns.md`, instead of a customer-facing reply —
  these are never answered directly at all.
- `draftReply` is `null` for `INTERNAL`/`SPAM_NOTIFICATION`/`UNCLASSIFIED`,
  and for fully-automated "do not reply" system notifications where no
  message is ever sent.
- The rule-based fallback classifier also produces a draft (a simple
  template using extracted fields), so this never silently disappears if
  the AI classifier is unavailable — it's just less personalized.
- Staff review and edit before sending; there's no auto-send integration —
  drafts are copied into Outlook manually via the "Copy to clipboard"
  button.

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

## Status sync (Outlook follow-up flags)

Staff already use Outlook's follow-up flag to mark a thread done — rather
than asking them to also update status in the dashboard, every poll cycle
re-checks each open enquiry's flag via Graph's `$batch` endpoint and syncs
it into `status`:

- Flag set to **Complete** → dashboard status becomes `RESOLVED`, regardless
  of its current status. This is treated as the strongest signal, since a
  human explicitly marked the thread finished in Outlook.
- Flag set to **Flagged** (follow-up, not yet complete) → only advances a
  still-untouched `NEW` enquiry to `IN_PROGRESS`. It never downgrades a more
  specific status staff already set themselves in the dashboard (e.g.
  `WAITING_ON_CUSTOMER`).
- No flag → no change either way; it's not evidence the enquiry is still new.

This runs as part of every `runPollOnce()` (scheduled poll or manual
`POST /api/ingest/run`), which now also returns `flagsChecked`/`flagsUpdated`
counts. There's currently no reverse direction — changing status in the
dashboard doesn't set the Outlook flag.

## Deploying to Render

`render.yaml` at the repo root is a Render Blueprint — it defines everything
needed except secrets, so Render can provision the whole thing from the repo:

1. **Create a Render account** and connect it to this GitHub repo (Render's
   own GitHub integration — an interactive step on Render's side).
2. **New → Blueprint**, point it at this repo. Render reads `render.yaml`
   and provisions a single web service (Node) with a 1GB persistent disk
   mounted at `/var/data` for the SQLite file.
3. **Pick the Starter plan or above** — the free tier spins down after ~15
   minutes of no HTTP traffic, which kills the in-process cron poller along
   with it. Polling (every minute by default) only works reliably on an
   always-on plan.
4. **Fill in the secrets** Render prompts for (left blank in `render.yaml`
   on purpose, so they're never committed to git):
   - `ANTHROPIC_API_KEY` — enables AI classification, same as local.
   - `TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` / `MAILBOX` — the Azure AD
     app registration credentials (see "Live ingestion setup" above). Can be
     left blank for now — the app runs fine in demo mode without them, same
     as locally, and you can add them later once the app registration exists.
5. **Deploy.** The build step builds the frontend and installs backend
   dependencies; the app then serves both the API and the built frontend
   from one Express process on one URL — no separate frontend host, no CORS
   to configure.

This is a single-instance deployment (SQLite doesn't support multiple app
instances writing to it concurrently) — fine for this app's scale, but worth
knowing if traffic ever grows enough to need horizontal scaling, at which
point SQLite would need to move to a real database server first.

There is currently **no authentication** on the dashboard — see the Roadmap
below. Don't point a Render deployment's public URL at anyone before that's
in place.

## Roadmap

- **Attachment/PDF parsing** for PO documents (many POs arrive as PDF
  attachments with the real order details, not just in the email body).
- **Thread/context awareness.** Classify based on the full email thread
  history, not just the latest message — useful for catching "already
  replied to this" duplicates and for knowing what's already been promised.
- **Auth** for the dashboard itself before any real deployment.
