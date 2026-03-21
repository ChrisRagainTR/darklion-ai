const { Pool } = require('pg');

// Enable SSL for any cloud Postgres (Neon, Supabase, Railway, Render, etc.)
// Disable only for local dev (localhost/127.0.0.1) or when explicitly set
const dbUrl = process.env.DATABASE_URL || '';
const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
const sslOff = process.env.DB_SSL === 'false';

const pool = new Pool({
  connectionString: dbUrl,
  ssl: (isLocal || sslOff) ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

// Initialize tables
async function initDB() {
  await pool.query(`
    -- ===================== FIRMS (multi-tenant) =====================
    CREATE TABLE IF NOT EXISTS firms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      plan TEXT DEFAULT 'trial'
    );

    -- ===================== COMPANIES =====================
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      realm_id TEXT UNIQUE NOT NULL,
      company_name TEXT DEFAULT '',
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expires_at BIGINT NOT NULL,
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      last_sync_at TIMESTAMPTZ,
      firm_id INTEGER REFERENCES firms(id)
    );

    -- Add firm_id to companies if it doesn't exist yet (migration)
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS firm_id INTEGER REFERENCES firms(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Add Gusto columns if missing
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS gusto_access_token TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS gusto_refresh_token TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS gusto_company_id TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS gusto_token_expires_at BIGINT;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== AUDIT LOG =====================
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
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

    -- Add UNIQUE constraint on statement_schedules (realm_id, account_name) if not exists
    DO $$ BEGIN
      ALTER TABLE statement_schedules ADD CONSTRAINT statement_schedules_realm_account_unique UNIQUE (realm_id, account_name);
    EXCEPTION WHEN duplicate_table THEN NULL;
    WHEN duplicate_object THEN NULL;
    END $$;

    -- Add qb_account_id column if not exists
    DO $$ BEGIN
      ALTER TABLE statement_schedules ADD COLUMN qb_account_id TEXT DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    -- Add last_retrieved_month column if not exists
    DO $$ BEGIN
      ALTER TABLE statement_schedules ADD COLUMN last_retrieved_month TEXT DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS statement_monthly_status (
      id SERIAL PRIMARY KEY,
      schedule_id INTEGER NOT NULL REFERENCES statement_schedules(id) ON DELETE CASCADE,
      realm_id TEXT NOT NULL,
      month TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','requested','received','uploaded')),
      received_at TIMESTAMPTZ,
      notes TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(schedule_id, month)
    );

    CREATE TABLE IF NOT EXISTS employee_metadata (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      employee_uuid TEXT NOT NULL,
      employee_name TEXT DEFAULT '',
      is_officer BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(realm_id, employee_uuid),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    -- ===================== FIRM USERS (multi-user per firm) =====================
    CREATE TABLE IF NOT EXISTS firm_users (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner','admin')),
      invite_token TEXT UNIQUE,
      invite_expires_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      UNIQUE(firm_id, email)
    );

    CREATE TABLE IF NOT EXISTS firm_user_companies (
      id SERIAL PRIMARY KEY,
      firm_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      realm_id TEXT NOT NULL,
      UNIQUE(firm_user_id, realm_id)
    );

    -- Migrate existing firm owners into firm_users (idempotent)
    INSERT INTO firm_users (firm_id, name, email, password_hash, role, accepted_at)
    SELECT id, name, email, password_hash, 'owner', NOW()
    FROM firms
    ON CONFLICT (firm_id, email) DO NOTHING;

    -- ===================== FIRM USERS: display_name + expanded roles =====================
    ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT '';

    -- ===================== FIRM USERS: avatar_url =====================
    DO $$ BEGIN
      ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE firm_users DROP CONSTRAINT IF EXISTS firm_users_role_check;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE firm_users ADD CONSTRAINT firm_users_role_check CHECK (role IN ('owner','admin','staff','agent'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- ===================== RELATIONSHIPS =====================
    CREATE TABLE IF NOT EXISTS relationships (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      name TEXT NOT NULL DEFAULT '',
      service_tier TEXT DEFAULT 'standard',
      stripe_customer_id TEXT DEFAULT '',
      stripe_subscription_id TEXT DEFAULT '',
      billing_status TEXT DEFAULT 'active',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== COMPANIES: new columns =====================
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS relationship_id INTEGER REFERENCES relationships(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS entity_type TEXT DEFAULT 'other';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS ein_encrypted TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_year_end TEXT DEFAULT '12/31';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS stanford_tax_url TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== PEOPLE =====================
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      relationship_id INTEGER REFERENCES relationships(id),
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      date_of_birth_encrypted TEXT DEFAULT '',
      ssn_last4 TEXT DEFAULT '',
      ssn_encrypted TEXT DEFAULT '',
      filing_status TEXT DEFAULT '',
      spouse_id INTEGER REFERENCES people(id),
      portal_enabled BOOLEAN DEFAULT FALSE,
      portal_password_hash TEXT,
      portal_invite_token TEXT UNIQUE,
      portal_invite_expires_at TIMESTAMPTZ,
      portal_last_login_at TIMESTAMPTZ,
      stanford_tax_url TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== PERSON_COMPANY_ACCESS =====================
    CREATE TABLE IF NOT EXISTS person_company_access (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      access_level TEXT NOT NULL DEFAULT 'full',
      ownership_pct NUMERIC(5,2),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(person_id, company_id)
    );

    -- ===================== FIRMS: slug column =====================
    DO $$ BEGIN
      ALTER TABLE firms ADD COLUMN IF NOT EXISTS slug TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS firms_slug_unique ON firms(slug) WHERE slug != '';

    -- ===================== BACKFILL: set slug for firms that don't have one =====================
    DO $$ BEGIN
      UPDATE firms
      SET slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '[^a-zA-Z0-9 ]', '', 'g'), '\s+', '', 'g'))
      WHERE slug IS NULL OR slug = '';
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    -- ===================== BACKFILL: create relationships for existing companies =====================
    DO $$ BEGIN
      INSERT INTO relationships (firm_id, name, created_at, updated_at)
      SELECT DISTINCT c.firm_id, c.company_name, NOW(), NOW()
      FROM companies c
      WHERE c.relationship_id IS NULL AND c.company_name IS NOT NULL AND c.company_name != ''
      ON CONFLICT DO NOTHING;

      UPDATE companies c
      SET relationship_id = r.id
      FROM relationships r
      WHERE c.relationship_id IS NULL
        AND r.firm_id = c.firm_id
        AND r.name = c.company_name;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    -- Add notes to companies (idempotent)
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Add folder_section and folder_category to documents (idempotent)
    DO $$ BEGIN
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_section TEXT DEFAULT 'firm_uploaded';
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_category TEXT DEFAULT 'other';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Add last_notification_sent_at to people (for smart message notifications)
    DO $$ BEGIN
      ALTER TABLE people ADD COLUMN IF NOT EXISTS last_notification_sent_at TIMESTAMPTZ;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== DOCUMENTS =====================
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      owner_type TEXT NOT NULL DEFAULT 'company',
      owner_id INTEGER NOT NULL,
      year TEXT DEFAULT '',
      doc_type TEXT DEFAULT 'other',
      display_name TEXT DEFAULT '',
      s3_bucket TEXT DEFAULT '',
      s3_key TEXT DEFAULT '',
      mime_type TEXT DEFAULT '',
      size_bytes INTEGER DEFAULT 0,
      uploaded_by_type TEXT DEFAULT 'staff',
      uploaded_by_id INTEGER,
      is_delivered BOOLEAN DEFAULT FALSE,
      delivered_at TIMESTAMPTZ,
      viewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== SECURE MESSAGING =====================
    CREATE TABLE IF NOT EXISTS message_threads (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      subject TEXT DEFAULT '',
      status TEXT DEFAULT 'open' CHECK(status IN ('open','waiting','resolved')),
      category TEXT DEFAULT 'general',
      assigned_to INTEGER REFERENCES firm_users(id),
      last_message_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS thread_companies (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      ai_confidence REAL DEFAULT 1.0,
      added_by TEXT DEFAULT 'ai',
      UNIQUE(thread_id, company_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('staff','client','agent')),
      sender_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_internal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== PIPELINES =====================
    CREATE TABLE IF NOT EXISTS pipeline_templates (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      name TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT 'company' CHECK(entity_type IN ('company','person','relationship')),
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES pipeline_templates(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#c9a84c',
      is_terminal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_instances (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      template_id INTEGER REFERENCES pipeline_templates(id),
      name TEXT NOT NULL DEFAULT '',
      tax_year TEXT DEFAULT '',
      status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_jobs (
      id SERIAL PRIMARY KEY,
      instance_id INTEGER NOT NULL REFERENCES pipeline_instances(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL DEFAULT 'company' CHECK(entity_type IN ('company','person','relationship')),
      entity_id INTEGER NOT NULL,
      current_stage_id INTEGER REFERENCES pipeline_stages(id),
      assigned_to INTEGER REFERENCES firm_users(id),
      notes TEXT DEFAULT '',
      priority TEXT DEFAULT 'normal' CHECK(priority IN ('normal','high','urgent')),
      due_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_job_history (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
      from_stage_id INTEGER REFERENCES pipeline_stages(id),
      to_stage_id INTEGER REFERENCES pipeline_stages(id),
      moved_by INTEGER REFERENCES firm_users(id),
      moved_at TIMESTAMPTZ DEFAULT NOW(),
      note TEXT DEFAULT ''
    );

    -- ===================== PIPELINE ENHANCEMENTS =====================

    -- Job status / blocker flags
    DO $$ BEGIN
      ALTER TABLE pipeline_jobs ADD COLUMN IF NOT EXISTS job_status TEXT DEFAULT 'active';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Stage auto-assign on entry
    DO $$ BEGIN
      ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS auto_assign_to INTEGER REFERENCES firm_users(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Stage auto-message on entry
    DO $$ BEGIN
      ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS auto_message TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Team member credentials (e.g. CPA/PFS, CFP)
    DO $$ BEGIN
      ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS credentials TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== TAX RETURN DELIVERIES =====================
    CREATE TABLE IF NOT EXISTS tax_deliveries (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      company_id INTEGER REFERENCES companies(id),
      tax_year TEXT NOT NULL DEFAULT '',
      title TEXT DEFAULT '',
      intro_note TEXT DEFAULT '',
      tax_summary JSONB DEFAULT '{}',
      review_doc_id INTEGER REFERENCES documents(id),
      signature_doc_id INTEGER REFERENCES documents(id),
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','approved','needs_changes','signed','complete')),
      needs_changes_note TEXT DEFAULT '',
      pipeline_job_id INTEGER REFERENCES pipeline_jobs(id),
      created_by INTEGER REFERENCES firm_users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_job_updates (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES firm_users(id),
      body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tax_delivery_signers (
      id SERIAL PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES tax_deliveries(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id),
      approved_at TIMESTAMPTZ,
      approved_ip TEXT DEFAULT '',
      signed_at TIMESTAMPTZ,
      signed_ip TEXT DEFAULT '',
      signature_data TEXT DEFAULT '',
      signature_type TEXT DEFAULT 'drawn' CHECK(signature_type IN ('drawn','typed')),
      needs_changes_at TIMESTAMPTZ,
      needs_changes_note TEXT DEFAULT '',
      UNIQUE(delivery_id, person_id)
    );
  `);
}

module.exports = { pool, initDB };
