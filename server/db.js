const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'darklion.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    realm_id TEXT UNIQUE NOT NULL,
    company_name TEXT DEFAULT '',
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expires_at INTEGER NOT NULL,
    connected_at TEXT DEFAULT (datetime('now')),
    last_sync_at TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    realm_id TEXT NOT NULL,
    qb_id TEXT NOT NULL,
    txn_type TEXT NOT NULL DEFAULT 'Purchase',
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT DEFAULT '',
    vendor_name TEXT DEFAULT '',
    original_account TEXT DEFAULT '',
    ai_category TEXT,
    ai_confidence REAL,
    ai_memo TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','categorized','reviewed','written_back','skipped')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(realm_id, qb_id),
    FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
  );

  CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    realm_id TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    qb_vendor_id TEXT,
    business_category TEXT,
    description TEXT,
    location TEXT,
    researched_at TEXT,
    UNIQUE(realm_id, vendor_name),
    FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    realm_id TEXT NOT NULL,
    job_type TEXT NOT NULL CHECK(job_type IN ('sync','categorize','vendor_research','write_back')),
    status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
    items_processed INTEGER DEFAULT 0,
    items_total INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
  );
`);

module.exports = db;
