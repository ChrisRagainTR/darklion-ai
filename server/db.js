const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') || process.env.DATABASE_URL?.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : false,
});

// Initialize tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      realm_id TEXT UNIQUE NOT NULL,
      company_name TEXT DEFAULT '',
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expires_at BIGINT NOT NULL,
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      last_sync_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(realm_id, qb_id),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      qb_vendor_id TEXT,
      business_category TEXT,
      description TEXT,
      location TEXT,
      researched_at TIMESTAMPTZ,
      UNIQUE(realm_id, vendor_name),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS category_rules (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(realm_id, vendor_name),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      items_processed INTEGER DEFAULT 0,
      items_total INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS scan_results (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      scan_type TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      scanned_at TIMESTAMPTZ DEFAULT NOW(),
      result_data JSONB NOT NULL DEFAULT '{}',
      flag_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new' CHECK(status IN ('new','reviewed','resolved')),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS close_packages (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      period TEXT NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      report_data JSONB NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','reviewed','finalized')),
      reviewer_notes TEXT DEFAULT '',
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS statement_schedules (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      client_name TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL DEFAULT '',
      institution TEXT DEFAULT '',
      access_method TEXT DEFAULT 'portal',
      statement_day INTEGER DEFAULT 1,
      reminder_cadence TEXT DEFAULT '1,5,10',
      contact_email TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      last_reminded_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ,
      current_month TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );
  `);
}

module.exports = { pool, initDB };
