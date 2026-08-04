const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'enquiries.db');
// Ensures whichever directory DB_PATH actually resolves to exists — the old
// version of this only ever created the default DATA_DIR, so setting
// DB_PATH to a custom path (e.g. a mounted persistent disk) skipped this
// entirely and would crash on boot if that directory wasn't already there.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS enquiries (
    id TEXT PRIMARY KEY,
    graph_message_id TEXT UNIQUE,
    internet_message_id TEXT,
    received_at TEXT NOT NULL,
    sender_name TEXT,
    sender_email TEXT,
    recipients TEXT,
    subject TEXT,
    body_preview TEXT,
    has_attachments INTEGER DEFAULT 0,
    importance TEXT DEFAULT 'normal',
    web_link TEXT,
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    po_number TEXT,
    quote_number TEXT,
    facility TEXT,
    sender_domain TEXT,
    city_tag TEXT,
    conversation_id TEXT,
    suggested_action TEXT,
    draft_reply TEXT,
    confidence REAL,
    classified_by TEXT DEFAULT 'rules',
    status TEXT NOT NULL DEFAULT 'NEW',
    assigned_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_enquiries_category ON enquiries(category);
  CREATE INDEX IF NOT EXISTS idx_enquiries_priority ON enquiries(priority);
  CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries(status);
  CREATE INDEX IF NOT EXISTS idx_enquiries_received_at ON enquiries(received_at);
`);

// One-time reclassification, not a schema change — REMOVED used to mean "the
// message became unreachable via Graph," modeled as distinct from RESOLVED
// since that was assumed to be unconfirmed evidence of being handled.
// Confirmed directly with staff it isn't: in this mailbox, a message going
// unreachable IS the resolution signal (archiving is what causes it — see
// statusForMissingMessage in db/repository.js). Runs on every boot; a no-op
// after the first time since nothing is ever written back to REMOVED again.
db.prepare("UPDATE enquiries SET status = 'RESOLVED', updated_at = ? WHERE status = 'REMOVED'").run(
  new Date().toISOString()
);

module.exports = db;
