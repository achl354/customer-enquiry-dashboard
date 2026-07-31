const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'enquiries.db');
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
    suggested_action TEXT,
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

module.exports = db;
