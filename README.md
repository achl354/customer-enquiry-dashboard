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
| `PATCH /api/enquiries/:id/category` | Manual recategorization (`status` has no direct-set endpoint at all — it's derived from Outlook, see "Status sync" below, with `DELETE` as the one dashboard-native exception) |
| `DELETE /api/enquiries/:id` | Detail page's "Delete" — sets `DISMISSED`, doesn't touch the real mailbox |
| `GET /api/enquiries/export` | CSV export — same filters as the list endpoint, no pagination. Lean reporting column set (no draft/body content) |
| `GET /api/stats/overview` | Counts by category/status/priority/facility, `facilityAttributionRate` (see "Facility attribution" below), aging buckets, open workload by assignee, avg resolution time and resolved count (returned for other callers/history's sake — Overview no longer shows these as standalone stat tiles; see "Resolution time by priority" and the resolution-trend panel instead) |
| `GET /api/stats/volume-trend?granularity=day\|week\|month\|quarter` | Received vs. resolved counts by period, since `TOTAL_SINCE` — see "KPI trend panels" below |
| `GET /api/stats/resolution-trend?granularity=month\|quarter\|year&sla=<hours>` | Avg. resolution time + SLA compliance rate rolled up by period, all-time; `sla` defaults to 48 |
| `GET /api/stats/first-response-trend?granularity=month\|quarter\|year` | Avg. time to first reply by period, all-time, forward-looking only (see "First response time") |
| `GET /api/stats/resolution-by-priority` | Avg. resolution time per priority tier, all-time snapshot (no granularity) |
| `GET /api/stats/backlog-trend?granularity=month\|quarter\|year` | Open-enquiry count at the end of each period — an approximation, see "Backlog trend" below |
| `GET /api/stats/status-by-period?granularity=month\|quarter\|year` | Status mix of enquiries *received* in the current month/fiscal-quarter/fiscal-year. No longer called by the frontend (the Overview panel using it was removed — see "Status mix (removed)" below) but left in place |
| `GET /api/ingest/status` | Whether live Graph polling and AI classification are configured |
| `POST /api/ingest/run` | Manually trigger one poll cycle (Inbox only) |
| `GET /api/ingest/folder-map?mailbox=<address>` | CSV of every mail folder, walked by id — see "Folder tree enumeration" below |
| `POST /api/ingest/backfill-all-folders?since=<date>&until=<date>` | Starts the one-off historical catch-up across every folder + full reassessment; `until` (exclusive) is optional, for bounding to a specific window; returns `202` immediately — see "Historical catch-up" below |
| `GET /api/ingest/backfill-status` | Poll this for the backfill's progress/result — `{running, lastResult, lastFinishedAt}` |
| `POST /api/ingest/reclassify-by-facility` `{facility}` | "Reclassify" action on the Top facilities panel — re-runs the classifier against every enquiry currently attributed to `facility` (no Graph config needed). Returns `202` immediately — see "Reclassify by facility" below |
| `GET /api/ingest/reclassify-by-facility-status` | Poll this for that job's progress/result — `{running, lastResult, lastFinishedAt}` |
| `GET /api/ingest/folder-messages?since=<date>&mailbox=<address>` | Read-only streamed CSV audit export, ~32 active folders by default (`?allFolders=true` for all ~380) — see "Folder audit export" below |

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

### Initial backfill

The very first poll after connecting has no prior poll to resume from, so
instead of only grabbing the 50 most recent inbox messages, it backfills
history and paginates through as many pages as it takes to cover it:

- **`BACKFILL_DAYS`** (default `30`) — how far back the first poll reaches.
  Every poll after that is purely incremental (only messages received since
  the last poll), so this only matters once, on connect.
- **`MAX_MESSAGES_PER_POLL`** (default `500`) — a safety cap on any single
  poll's total fetch, backfill or not. **Each message triggers
  classification on ingest — a real Claude API call per email if
  `ANTHROPIC_API_KEY` is set** — so this bounds the worst case instead of
  one huge mailbox silently running up a large first bill. If this cap gets
  hit (logged as a `[graph-client]` warning), the oldest messages inside the
  backfill window are the ones left out that cycle and are **not**
  automatically retried later — lower `BACKFILL_DAYS` or raise this instead.
- Already-ingested messages (matched on Graph message ID) are skipped
  *before* classification runs, not just at the database write — so
  restarting the backend (which resets the in-memory poll cursor, re-running
  the backfill window) re-fetches but does not re-classify anything already
  in the database.
- The backend log line distinguishes the two: `[graph-poller] Backfill: ...`
  for that first poll, `[graph-poller] Polled: ...` for every incremental
  one after.

## Status sync (Outlook folders, categories & follow-up flags)

The dashboard is an add-on triage layer, not the system of record — staff
take the actual action (reply, file the message away) in Outlook, same as
before this existed, and `status` flows one-way from there into the
dashboard. There's no endpoint to set `status` directly, precisely so it
can't drift from what Outlook actually shows — the one exception is the
Detail page's "Delete" button (`DELETE /api/enquiries/:id`), which sets a
dedicated `DISMISSED` status the sync below never touches.
Every poll cycle re-checks each open enquiry's folder location, category
tags, and follow-up flag via Graph's `$batch` endpoint and syncs the result
into `status` (`statusForFolderMove`/`statusForCategories`/`statusForFlag`
in `db/repository.js`):

- Category **"Resolved"** → dashboard status becomes `RESOLVED`, regardless
  of current status. Category **"No Action Needed"** → `IGNORED`, same way.
  These are checked first and take precedence over everything below — e.g.
  tagging "No Action Needed" and then archiving the message still resolves
  to `IGNORED`, not `RESOLVED`, since the category check wins before the
  folder-move check ever runs.
- Moved out of the Inbox into **any** folder → `RESOLVED`. This is staff's
  actual confirmed habit (filing a message away once it's handled, e.g. into
  a customer/PO folder) — checked next, ahead of the flag. Tagging
  "Resolved" and then archiving makes no practical difference: both
  independently produce the same `RESOLVED` outcome.
- Flag set to **Complete** → `RESOLVED` (same outcome, checked as a further
  fallback when neither of the above applies).
- Flag set to **Flagged** (follow-up, not yet complete) → only advances a
  still-untouched `NEW` enquiry to `IN_PROGRESS`. Never downgrades a more
  advanced status the reply-detection sync (below) already set (e.g.
  `WAITING_ON_CUSTOMER`).
- None of the above → no change either way; not evidence the enquiry is
  still new.

**Why folder location, not just categories/flags:** checking real Sent
Items showed the follow-up flag is barely used in practice —
genuinely-handled threads routinely had no flag at all, or one left at
`flagged` rather than `complete`. Categories are a separate,
currently-unused Outlook feature in this mailbox. Folder location is
different: it's staff's actual day-to-day filing habit, confirmed directly,
so it needs no new behavior adopted to work. The tradeoff: moving a message
to Deleted Items also counts as "resolved" (any move out of Inbox, no
per-folder exceptions) — a deliberate simplification, not an oversight.

This runs as part of every `runPollOnce()` (scheduled poll or manual
`POST /api/ingest/run`), which now also returns `flagsChecked`/`flagsUpdated`
counts. There's no reverse direction — the dashboard never writes a flag,
category, folder move, or anything else back to Outlook.

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

## Status sync (message no longer resolvable via Graph)

The flag/category/folder sync above depends on the source message still
resolving by its Graph ID to look up. If it doesn't — a confirmed 404, not
just "no flag/category data" — that's treated the same as a folder move:
`RESOLVED` (`statusForMissingMessage` in `db/repository.js`), checked as a
last resort after categories, the folder check, and the flag — any of
those still wins if present. A 404 from something *other* than the message
itself being gone (rate limiting, a transient error) is not treated this
way — only a confirmed 404 on that specific message triggers it.

**Why this folds into `RESOLVED` rather than staying its own status:**
earlier versions of this app modeled "message gone entirely" as a separate
`REMOVED` status, on the assumption that disappearing wasn't confirmed
evidence of being handled the way an explicit category/flag/folder-move
is. Confirmed directly with staff that assumption doesn't hold for this
mailbox: a message going fully unreachable is what archiving looks like
one step further along (e.g. moved into a personal archive outside what
Graph can see), not evidence of something lost before being acted on. Any
enquiry already sitting at the old `REMOVED` status gets reclassified to
`RESOLVED` automatically on the next server start (a one-time, idempotent
`UPDATE` in `db/index.js` — a no-op after the first run since nothing
writes `REMOVED` anymore).

## Status sync (confirmed spam)

Spam/notification noise shouldn't count as open backlog (sitting in the
queue forever, nobody's ever replying to it) or, once it eventually leaves
the Inbox via the folder-move sync above, as a genuine `RESOLVED` —
resolving a real enquiry is different work from an email that was never
one. Rather than a new status, confirmed spam reuses `IGNORED`
(`statusForConfirmedSpam` in `db/repository.js`), applied in three places:

- **At ingestion** — a message the classifier tags `SPAM_NOTIFICATION`
  gets `IGNORED` instead of `NEW` from the start (checked after the
  Outlook flag/category signals, same priority `statusForFolderMove` has).
- **On manual recategorization** — choosing "Spam / notification" from the
  category dropdown on the Detail page also sets status to `IGNORED`
  (unless the enquiry is already `DISMISSED`, which is left alone as a
  more deliberate override). This one always trusts the call, since it's
  an explicit staff action, not a guess.
- **Backfill** — any enquiry already in the database at `SPAM_NOTIFICATION`
  with a still-open status gets reclassified the same way on next server
  start (same idempotent-migration pattern as the `REMOVED` one above).

**Gated on confidence, not applied blindly.** "Confirmed" is the key word:
a rules-based classification (deterministic, including the noise-sender
short-circuit and the AI-failure fallback) is always trusted. An AI
classification below the existing 50% "needs review" threshold
(`LOW_CONFIDENCE_THRESHOLD`) is deliberately **not** auto-ignored — a real
customer enquiry the AI misreads as spam at low confidence stays visible
as `NEW` and shows up in the existing low-confidence review list, rather
than being silently hidden with nothing ever flagging it for a second
look.

## Avg. resolution time (`resolved_at`)

The "Avg. resolution time" stat is `resolved_at - received_at`, not
`updated_at - received_at`. `updated_at` bumps on *any* field change — a
draft regenerated, a category corrected long after the fact — so it can't
be trusted as "when did this actually become resolved." `resolved_at` is a
dedicated column, set once and never touched again by anything unrelated
to the actual resolution event.

Where it comes from: whenever a category tag, folder-move, or flag
resolves an enquiry (see the status-sync sections above), the poller also
captures the source message's Graph `lastModifiedDateTime` — Exchange
bumps this on a folder move the same as any other property change, so it's
a genuine historical timestamp, not "whenever this poll cycle happened to
run." For a message that's confirmed gone entirely, there's nothing left
to ask Graph about, so `resolved_at` stays `NULL` for that one rather than
guessed at.

**Backfill for existing data.** Since `resolved_at` didn't always exist,
`backfillResolvedAt()` in `graph/poller.js` runs on every poll cycle,
re-querying Graph for `lastModifiedDateTime` on any `RESOLVED` enquiry
still missing it. This population only shrinks over time (as backfill
succeeds) or stays flat (for messages confirmed gone, which have nothing
to recover) — it never grows, since new resolutions get `resolved_at` set
immediately going forward. `overviewStats()` (and the resolution-time
trend/by-priority panels below) only average rows that actually have a
`resolved_at` — a resolved enquiry with no timing data yet (normal right
after deploying this, until the backfill catches up) simply isn't counted
in the average rather than guessed at.

## KPI trend panels (`/stats/volume-trend`, `/stats/resolution-trend`, `/stats/first-response-trend`, `/stats/resolution-by-priority`, `/stats/backlog-trend`)

Five reporting panels on Overview, each backed by its own endpoint rather
than bundled into `/stats/overview` — they're switched by a granularity
toggle the operator controls, not something every page load needs.

**Each of Volume, Resolution time, First response, and Backlog keeps its
own independent Month/Quarter/Year (or day/week/month/quarter for Volume)
toggle.** These briefly shared one consolidated control instead — the
dataviz reference this project generally follows argues for exactly that
("filters scope everything below them — every chart, stat, and table
re-renders against the same slice") — but in practice it broke a real
workflow: switching the shared control re-rendered every panel driven by
it at once, so there was no way to compare a panel's state before and
after changing granularity, or to leave one panel on a different window
than the others while checking something else. Reverted based on that
concrete usability cost outweighing the guideline. There's also no longer
a "status mix" panel to weigh into this (see below) — its removal is part
of why per-panel toggles are the simpler call now anyway.

`period` strings follow the same convention everywhere: `"YYYY-MM"` for
month (calendar), `"YYYY-FQn"` for quarter, `"YYYY"` for year — the latter
two are **fiscal** (the AU financial year, 1 Jul – 30 Jun), not calendar.
`YYYY` is the calendar year the fiscal year *starts* in (e.g. `"2026"` = FY
1 Jul 2026 – 30 Jun 2027, shown in the UI as "FY26–27"). FQ1 = Jul-Sep, FQ2
= Oct-Dec, FQ3 = Jan-Mar, FQ4 = Apr-Jun. Day/week (volume only) use plain
calendar dates instead.

**Enquiry volume** (`/stats/volume-trend?granularity=day|week|month|quarter`,
no year) — received vs. resolved counts. Zero-filled from `TOTAL_SINCE`
through now — scoped to that date the same way the by-category/status/
priority/facility breakdowns are, since this is a volume figure. Three
additions on top of the raw received/resolved lines:
- **Y-axis value labels** — three reference gridlines (0/half/max) with
  their numeric value, rather than an axis-less line (the hovered point
  is the only value directly labeled otherwise, so per dataviz's own
  labeling rule the ticks earn their place).
- **7-day rolling average** (day granularity only, a toggle button next to
  the granularity control) — replaces the raw received/resolved lines with
  their smoothed equivalents rather than adding two more lines alongside
  them; a 4-line chart reads as noise, and smoothing exists specifically
  to replace noisy raw data, not sit next to it. Computed client-side from
  already-fetched rows, no separate endpoint.
- **Net difference** (received − resolved), as a small diverging bar strip
  underneath — always the *raw* daily numbers regardless of the smoothing
  toggle above, since the point is to see the real day-to-day imbalance,
  not a smoothed one. A bar above zero means received outpaced resolved
  that period (backlog growing, warning color); below zero means the
  opposite (backlog shrinking, good color). Its own small chart rather
  than a third line on the volume chart's shared axis — net can be
  negative and carries a different kind of meaning than a raw count, same
  "two measures of different scale → two charts" reasoning the Backlog
  panel already follows.

**Chart height**: both the main volume chart and the net-diff strip were,
for a while, rendering at nearly double their intended height (~250px
instead of ~130px, ~88px instead of 44px) — a leftover CSS rule from the
old grid-based Daily/Weekly volume charts (`.panel .trend-chart svg`,
meant to stretch a chart to fill a shared `.chart-grid` row) had higher
specificity than either chart's own height rule and silently won,
even though nothing has used `.trend-chart` inside a `.chart-grid` since
Volume became its own standalone panel. Removed that dead rule and
reduced the target heights further on top of the fix (~55-95px main
chart, 36px net-diff) — the panel was taking up too much vertical space
even before accounting for the bug.

**Avg. resolution time** (`/stats/resolution-trend?granularity=month|quarter|year&sla=<hours>`)
— an SLA compliance rate alongside the average: `slaCompliantCount`/
`slaComplianceRate` alongside `avgHours`/`count`, bound to `sla` at query
time (default 48) rather than baked into the SQL, so any threshold works
without re-preparing statements. All-time by design, same as the "Avg.
resolution time" tile it originally extended (since removed from Overview
as a standalone tile — this panel and "Resolution time by priority" below
now carry that information) — a process metric, not a volume figure, so
unlike the panels above it isn't scoped to `TOTAL_SINCE`. `resolved_at IS
NOT NULL` already excludes rows with no reliable timing data on its own.
Periods with no resolved rows simply don't appear (no zero-filling —
unlike the volume panel, a KPI trend has no fixed window to fill gaps in).

**First response time** (`/stats/first-response-trend?granularity=month|quarter|year`)
— same idea, grouped by `first_replied_at` instead of `resolved_at`, and
not gated on `status = 'RESOLVED'` (a reply matters whether the enquiry's
since been closed or not). **Forward-looking only**: `first_replied_at` is
set once, the first time `syncReplyStatuses` (graph/poller.js) detects any
reply — customer-facing or an internal forward — via Graph's own
`sentDateTime` on the earliest matching Sent Items message. There's no way
to reconstruct when a past reply was first sent for enquiries that already
had one before this column existed, so this can be sparse or empty for a
while after deploy and only fills in from here forward.

**Resolution time by priority** (`/stats/resolution-by-priority`) — an
all-time snapshot, not a period trend (no `granularity` param): is URGENT
actually resolved faster than NORMAL/LOW? A comparison across priority
tiers, not across time.

**Backlog trend** (`/stats/backlog-trend?granularity=month|quarter|year`)
— open-enquiry count as of the end of each period: `received_at <= end`
AND (`resolved_at` is unset or still after `end`). Deliberately **not**
scoped to `TOTAL_SINCE`, same as the Open/Urgent stat tiles this extends
into a trend — backlog from before tracking began is still real backlog.
**Approximation, not exact**: this over-counts "still open" for any closed
enquiry with no `resolved_at` at all — IGNORED/DISMISSED closures have no
equivalent timestamp to `resolved_at`, and a RESOLVED row can lack one too
if it was resolved before that column existed (see `backfillResolvedAt` in
graph/poller.js, the active repair pass that shrinks this gap over time).
Accepted given the volume this affects is small, rather than adding a
second closure-timestamp column for a KPI this workflow-adjacent.

## Status mix (removed)

Overview briefly had a "Status mix" panel — first a donut, then a stacked
bar, scoped to enquiries received in the current period. Removed after
review: "Open enquiries by age" and "Backlog trend" already answer the
"is stuff piling up, and for how long" question more directly, and status
mix's own signal (what fraction of a period ended up New/Resolved/
Ignored/etc.) added comparatively little on top of those. The backend
endpoint (`/stats/status-by-period`) and `statusByPeriod()` in
`db/repository.js` are left in place — they cost nothing to keep and could
still be called directly if this turns out to be useful after all.

**"Open enquiries by age"** (the aging-bucket panel, `agingBuckets` in
`/stats/overview` — unchanged endpoint) renders as a `StackedBar`
(`StackedBar.jsx`, originally built for status mix, kept for this panel)
rather than a 4-row bar list — the 0-24h/1-3d buckets are often empty or
near-empty in practice (nothing fresh has piled up — genuinely good news,
not a bug), which left visible dead space as separate bar rows. A stacked
bar always fills its full width regardless of how lopsided the underlying
buckets are. Per the dataviz reference this project follows, a stacked
bar is also the more appropriate default for part-to-whole generally
(donut is a deprioritized carve-out for a handful of segments) — the same
reasoning that applied to status mix while it existed.

## Action queue

Replaced the single "oldest unactioned enquiry" banner with the 5
longest-waiting still-open enquiries (`oldestOpenQueue` in
`overviewStats()` — `listOldestOpenEnquiries`-equivalent query, `ORDER BY
received_at ASC LIMIT 5`), each showing age, priority, category, subject,
and sender. **No owner column**: `assigned_to` is an unused schema column
today — nothing reads or writes it, no UI surfaces it — so there's no real
assignment data to show. Adding a real assignment feature (who's on this,
a filterable "unassigned" queue) is future work, not something this panel
fakes with an empty/placeholder value.

## Category Pareto view

"Enquiries by category" (`byCategory` in `/stats/overview`, unchanged
endpoint) is still descending by count, now with a running cumulative
share folded into each label ("... (cum. 68%)") — no new endpoint, computed
client-side in Overview.jsx. A classic Pareto chart pairs bars with a
cumulative-% line on a second axis, which is the single biggest chart
anti-pattern this project avoids elsewhere (never a dual-axis chart), so
the cumulative figure is a direct label rather than a second scale.
Deliberately doesn't highlight specific categories as "automation
candidates" — which ones count as one is a real judgment call for whoever
owns the queue, not something to guess at and bake in silently.

## Facility attribution (`KNOWN_ORG_DOMAINS`, `GENERIC_DOMAINS`)

`facility` (the customer/organisation an enquiry is attributed to) comes
from `orgNameForDomain()` in `triage/classify.js`: an exact lookup against
`KNOWN_ORG_DOMAINS` first, then falls back to title-casing the sender
domain's first label (`bigpond.com` → `"Bigpond"`). That fallback handles
most real company domains fine, but produces two kinds of bad output:

- **A generic/consumer domain title-cased into a fake org name** —
  `gmail.com` → `"Gmail"`, `messaging.microsoft.com` → `"Messaging"`.
  `GENERIC_DOMAINS` now short-circuits these to `null` (unattributed)
  instead — personal webmail and automated-tooling senders (a payment
  gateway, a form-builder, an e-commerce platform, Microsoft's own
  quarantine/messaging infrastructure) are never themselves "the
  organisation this enquiry is about." Deliberately **not** the same list
  as `KNOWN_SUPPLIER_DOMAINS`/`KNOWN_LOGISTICS_DOMAINS` (those exist for
  category routing only) — `activtec.com.au` is documented elsewhere in
  `classify.js` as sometimes acting as a genuine customer despite being on
  the supplier list, so blanket-excluding "supplier/logistics" domains from
  facility naming would misattribute exactly the case that comment warns
  about. `GENERIC_DOMAINS` is limited to domains with no plausible
  dual-role case.
- **A subdomain of an already-known org falling through to its own ugly
  fallback** — `oraclefusion.monashhealth.org` (an internal system at
  Monash Health) used to title-case to `"Oraclefusion"` instead of
  resolving to `"Monash Health"`. `orgNameForDomain()` now also checks
  whether a domain *ends with* `.` + a known domain before falling back.

`KNOWN_ORG_DOMAINS` itself was extended with the next tier of recurring
senders identified from real ingested volume (`barwonhealth.org.au`,
`stgeorgehospital.com.au`, `wecaresupportservices.net.au`,
`fivegoodfriends.com.au`) — still deliberately conservative, not an
attempt to map every domain seen.

**These changes only affect classification going forward** (new mail, or
anything explicitly reclassified via the historical backfill or the
per-facility reclassify action) — they don't retroactively rewrite
`facility` on enquiries already sitting in the database with the old
fallback's output. Reclassify a facility from the Top facilities panel (or
run a backfill) to see it applied to existing rows.

**Attribution-rate KPI**: `facilityAttributionRate` in `/stats/overview`
(shown next to "Top facilities / organisations" as "N% attributed") is the
share of enquiries (since `TOTAL_SINCE`, same scope as `byFacility`) with a
real facility name rather than falling into "Not attributed" — lets the
above changes' actual impact be tracked over time instead of eyeballing
the "Not attributed" bar's size.

**If the "Not attributed" count still looks high after this** despite the
above, check whether a historical backfill has actually been run since
these changes shipped — see "These changes only affect classification
going forward" above. On the dev sample used while building this, the
gap was already down to genuinely-internal mail only (0% real gap) once
the logic itself was verified directly, which suggests a persistently
high count elsewhere is existing data that hasn't been reclassified yet,
not a gap in the domain lists themselves. If a backfill doesn't move the
number, exporting a facility/domain breakdown (the Queue page's CSV
export) is the next step — that shows exactly which domains are still
driving it, rather than guessing at more `KNOWN_ORG_DOMAINS` entries
blind.

## Folder tree enumeration (`/folder-map`)

`GET /api/ingest/folder-map?mailbox=<address>` returns a CSV of every mail
folder in a mailbox — `id`, `displayName`, `full_path`, `parentFolderId`,
`childFolderCount`, `totalItemCount`, `unreadItemCount` — walked recursively
by folder **id**, never by `displayName`. `mailbox` defaults to whatever
`MAILBOX` is already configured to.

**Why by id, not by name.** Tested directly against a mailbox with ~30
custom folders: some plain-looking names resolved fine, others 404'd for no
explainable reason (not hierarchy depth, not a smart-quote/straight-quote
issue — apostrophe'd names failed even with the apostrophe stripped), and
repeated failed lookups triggered Graph 429s — the underlying name-lookup
fallback apparently re-scans the whole mailbox tree on any non-exact,
non-well-known name. Walking the tree by id once, top-level `mailFolders`
down through every level of `childFolders` (not assuming Outlook's
"Favorites" sidebar grouping reflects the real hierarchy — it doesn't), is
the only approach that doesn't depend on name-matching working at all
(`fetchFolderTree` in `graph/client.js`). `fullPath` is reconstructed by
walking each folder's parent chain after the whole tree is known.

Includes 429 handling — honors `Retry-After` when Graph sends one, capped
exponential backoff otherwise — and a deliberate small pause between calls
during the walk itself, since a deep/wide tree is many sequential requests
even before anything throttles.

This is a read-only `GET` — nothing here writes to the database or the
mailbox, safe to run as often as you want.

## Historical catch-up: pulling all folders + reassessing (`/backfill-all-folders`)

Regular polling (`fetchMessagesSince`) only ever looks at the **Inbox** —
that's the correct signal for "a new enquiry arrived," since staff's own
new mail always lands there first. But it means any mail that arrived,
got resolved, and was archived into a folder *before this app was ever
ingesting anything* is invisible to normal polling no matter how long it
runs — it's sitting in a folder it never looks at.

`POST /api/ingest/backfill-all-folders?since=<date>` (`backfillAllFoldersAndReassess`
in `graph/poller.js`) is the one-off catch-up for that. Add `&until=<date>`
(exclusive) to bound it to a specific window instead of pulling everything
since `since` through right now — e.g. `?since=2026-07-01&until=2026-07-14`
re-checks just 1-13 Jul inclusive, useful for topping up a range a previous
run is suspected to have missed without re-spending AI classification
calls on mail outside it that's already correct. It:

1. Calls `fetchAllMailboxMessagesSince` — `/users/{mailbox}/messages` with
   no folder path segment, which searches every folder, not just Inbox —
   and ingests anything not already in the database (idempotent on
   `graph_message_id`, same as regular polling; already-ingested mail is
   skipped here, not re-inserted). Messages already sitting outside Inbox
   get their status/`resolved_at` set immediately at ingestion (via
   `parentFolderId`/`lastModifiedDateTime`, also fetched by this call),
   rather than waiting a full extra cycle for the regular sync to notice.
2. Re-runs classification (`reclassifyEnquiry`) on **every** enquiry
   received on/after `since` — including ones already ingested before this
   ran, and including ones staff already manually recategorized. This is
   deliberately more aggressive than routine polling, which never
   reclassifies anything already in the database.

**Real cost, deliberately not automatic.** Every reclassification is a
real classification call (an Anthropic API call, if configured) — this is
not free, and not something to run routinely. `since` has no default
specifically so this can never fire against the mailbox's entire history
by accident. Only trigger it when there's an actual reason to (a known
ingestion gap, a suspected batch of miscategorized mail).

**What it deliberately doesn't touch:** `draft_reply` is left alone
entirely — a bulk reassessment shouldn't destroy a draft staff may have
already reviewed or copied out. `status` only changes via the same
confirmed-spam rule the manual category-PATCH endpoint uses (recategorized
to spam → `IGNORED`, unless already `DISMISSED`) — everything else about
an enquiry's workflow state (`RESOLVED`, `IN_PROGRESS`,
`WAITING_ON_CUSTOMER`, etc.) is the Outlook-sync's job, not this one's.

**Fire-and-poll, not request/response.** Every step is a real, sequential
network call — for a wide window or a busy mailbox this can run for many
minutes, easily longer than a proxy in front of this app will hold one
idle HTTP connection open. Waiting on that connection for the final result
used to mean a perfectly successful run could still surface client-side as
a bare network failure once the timeout hit, with no way to tell that
apart from a real failure.

So `POST /api/ingest/backfill-all-folders?since=<date>` returns `202
{started: true}` immediately — it kicks the job off (deduped the same way
as regular polling: a second POST while one's already running just returns
`{started: false, running: true}` instead of starting a duplicate) and
returns right away. Poll `GET /api/ingest/backfill-status` afterward:
`{running: true}` while it's still going, and once `running` flips to
`false`, `lastResult` holds the final `{fetched, ingested, failedIngest,
reassessed, reclassified, failed}` summary (or `{error}` if the run failed
outright). The server logs `backfillAllFoldersAndReassess` progress lines
every 25 reclassifications too, if you'd rather watch those directly.

A single bad message (a transient Graph hiccup, an unexpected shape) no
longer aborts the whole run either — both the ingest loop and the
reclassify loop catch per-item errors and keep going, counted in
`failedIngest`/`failed` respectively, so one bad message can't silently
skip everything after it.

## Reclassify by facility (`/ingest/reclassify-by-facility`)

A smaller, targeted sibling of the backfill above — the "↻" button on each
row of Overview's Top facilities panel. Re-runs the classifier against
every enquiry currently attributed to that facility, for when staff spot
that one customer's mail keeps landing in the wrong category. Purely a DB
+ AI-classifier operation, no Graph call at all (facility is already
stored from ingestion) — and no `TOTAL_SINCE` scoping either: every
enquiry with that facility gets reassessed, including ones from before the
reporting window the panel itself is scoped to, so the confirm dialog
describes the scope in words rather than quoting a count that wouldn't
match what's on screen.

Same fire-and-`202`-then-poll shape as `/backfill-all-folders`, for the
same reason (a facility with enough history is still real, sequential AI
calls, easily enough to outlast a proxy's idle-connection timeout) — poll
`GET /api/ingest/reclassify-by-facility-status` for `{running, lastResult,
lastFinishedAt}`. Its own in-flight slot, separate from the backfill job's,
since this is deliberately a much smaller/faster operation that shouldn't
have to wait its turn behind a mailbox-wide catch-up — though triggering
both at once could still double-call the classifier on any row they
happen to both cover (same "one operator, one job" assumption as
everywhere else this pattern is used).

## Folder audit export (`/folder-messages`)

`GET /api/ingest/folder-messages?since=<date>&mailbox=<address>` is a
**read-only** counterpart to `/backfill-all-folders` — same idea (every
message since a date, not just Inbox), but it never touches this app's own
database. It's a reporting export: `fetchAllFolderMessagesSince` in
`graph/client.js` queries each target folder's `/messages` since that
date, and the route streams the result as `messages_since_<date>.csv` —
`folder_id`, `folder_path`, `subject`, `sender`, `recipients`,
`receivedDateTime`, `lastModifiedDateTime`, `days_between_received_and_modified`,
`hasAttachments`, `conversationId`, `internetMessageId`.

**Scoped to the folders actually in use by default.** Of the ~380 folders
in this mailbox, most are stale — old rep archives, one-off restores — and
walking all of them sequentially is slow enough that early runs never
finished downloading at all. `ACTIVE_FOLDER_NAMES` in `routes/ingest.js`
(confirmed against the real folder map, matched by exact `displayName` —
never a fresh Graph name lookup, which is the whole thing this feature
exists to avoid) is the ~32-folder default scope, matching the Outlook
mobile "Favorites" sidebar. Pass `?allFolders=true` for the full ~380-folder
walk if you actually need it. Any name in `ACTIVE_FOLDER_NAMES` that no
longer matches a real folder (renamed, deleted) is logged, not silently
dropped.

**The "resolve time" caveat — read this before trusting the numbers.**
Graph has no field that records when a message was actually filed into a
folder. `lastModifiedDateTime` is the closest proxy — it updates on *any*
change to the message (read status, a category tag, a flag, or a folder
move), not exclusively on being archived. `days_between_received_and_modified`
is `lastModifiedDateTime − receivedDateTime` in fractional days. Both are
labeled `(estimate...)` directly in the CSV's own column headers, not just
here — a large gap suggests a message likely sat before being actioned; a
near-zero gap suggests it was actioned quickly, but neither is a confirmed
"resolved on" date the way `resolved_at` in the dashboard's own database
tries to be (see the "Avg. resolution time" section above) — that one is
scoped to messages the dashboard has actually synced status for, this is a
much rawer, less-processed view across the whole mailbox.

**Resilient to one bad folder.** A single folder erroring (a permissions
quirk on a system folder, repeated 429s past the retry budget) is recorded
and skipped, not fatal to the run.

**Streamed, not buffered.** Rows are written to the response as each
folder completes, not accumulated until the whole walk finishes — a
multi-minute buffered response risks a proxy's idle/request timeout
killing the connection before anything reaches the client at all, which
was the actual cause of downloads that never completed. Because of this,
only `X-Folders-Checked` is set as a response header (known upfront, from
the folder count); `messagesFound`/`foldersErrored`/oldest/newest received
aren't known until the walk finishes, so those are logged to the server
console instead of set as headers. With the default ~32-folder scope this
should complete in well under a minute; `?allFolders=true` brings back the
original several-minutes-for-~380-folders caveat — check server logs for
progress there rather than assuming a timed-out response means it stopped.

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
