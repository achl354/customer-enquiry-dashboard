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
backend/   Express API + SQLite storage + rule-based triage classifier
           + a Microsoft Graph poller for live mailbox ingestion
frontend/  React (Vite) dashboard: Overview stats, Triage Queue, Enquiry Detail
```

- **Classifier** (`backend/src/triage/classify.js`) — rule-based v1. Assigns a
  category (see below), priority, extracts PO/quote number and facility name,
  and generates a suggested action string. This is the piece to swap for a
  real AI classifier later (see Roadmap).
- **Storage** — SQLite (`backend/data/enquiries.db`, gitignored). One row per
  email, keyed by Graph message ID so re-polling is idempotent.
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
| `EQUIPMENT_FAULT` | Product not working / fitting issue — may be patient-impacting |
| `BACKORDER_NOTICE` | Automated backorder-past-due notice from a buyer |
| `PO_ETA_REQUEST` | Purchase order or dispatch/ETA chase from a health dept or facility |
| `INVOICE_BILLING` | Invoice disputes, overbilling, payment queries |
| `QUOTE_PRICING` | Quote requests/follow-ups, pricing questions |
| `PRODUCT_ENQUIRY` | General customer product/compatibility/hire questions |
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
| `GET /api/ingest/status` | Whether live Graph polling is configured |
| `POST /api/ingest/run` | Manually trigger one poll cycle |

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
   started` and begin ingesting new mail every 5 minutes. Trigger a poll
   immediately with `curl -X POST localhost:4000/api/ingest/run`.

Without these env vars set, the app runs fine in seed-only/demo mode — the
poller silently no-ops.

## Roadmap

- **Real AI classification.** Swap/augment `classify.js` with a Claude API
  call per email for higher-accuracy category/priority detection, better
  entity extraction (product names, clinical details), and a genuinely
  drafted reply rather than a fixed template — the rule-based version was an
  intentional v1 to ship something usable without an API key dependency.
- **Attachment/PDF parsing** for PO documents (many POs arrive as PDF
  attachments with the real order details, not just in the email body).
- **Auth** for the dashboard itself before any real deployment.
