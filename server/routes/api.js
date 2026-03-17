const { Router } = require('express');
const { pool } = require('../db');
const { syncTransactions, getChartOfAccounts, writeBackTransaction } = require('../services/quickbooks');
const { categorizeTransactions, researchAllVendors } = require('../services/claude');
const { runFullPipeline } = require('../scheduler');
const { scanUncategorized, scanLiabilities, scanFixedAssets, getLatestScan } = require('../services/scanner');
const { analyzeVariance, generateClosePackage } = require('../services/reports');
const { detectCoAChanges } = require('../services/coa-monitor');

const router = Router();

// --- Dashboard data ---

// List connected companies
router.get('/companies', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT realm_id, company_name, connected_at, last_sync_at FROM companies ORDER BY connected_at DESC'
  );
  res.json(rows);
});

// Dashboard stats for a company
router.get('/companies/:realmId/stats', async (req, res) => {
  const { realmId } = req.params;

  const { rows: [totals] } = await pool.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'categorized' THEN 1 ELSE 0 END) as categorized,
      SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) as reviewed,
      SUM(CASE WHEN status = 'written_back' THEN 1 ELSE 0 END) as written_back,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
    FROM transactions WHERE realm_id = $1
  `, [realmId]);

  const { rows: [vendorCount] } = await pool.query(
    'SELECT COUNT(*) as count FROM vendors WHERE realm_id = $1', [realmId]
  );

  const { rows: recentJobs } = await pool.query(
    'SELECT * FROM jobs WHERE realm_id = $1 ORDER BY started_at DESC LIMIT 10', [realmId]
  );

  res.json({ totals, vendors: vendorCount.count, recentJobs });
});

// List transactions for a company (with filtering)
router.get('/companies/:realmId/transactions', async (req, res) => {
  const { realmId } = req.params;
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM transactions WHERE realm_id = $1';
  const params = [realmId];
  let paramIdx = 2;

  if (status) {
    query += ` AND status = $${paramIdx}`;
    params.push(status);
    paramIdx++;
  }

  query += ` ORDER BY date DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  params.push(Number(limit), Number(offset));

  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// Get chart of accounts for dropdown
router.get('/companies/:realmId/accounts', async (req, res) => {
  try {
    const accounts = await getChartOfAccounts(req.params.realmId);
    const filtered = accounts
      .filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Income', 'Other Income', 'Other Current Liability', 'Equity'].includes(a.AccountType))
      .map(a => ({ name: a.FullyQualifiedName || a.Name, type: a.AccountType }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Review a transaction (approve, recategorize, or skip)
router.post('/companies/:realmId/transactions/:id/review', async (req, res) => {
  const { realmId, id } = req.params;
  const { action, category } = req.body;

  if (action === 'approve') {
    await pool.query(
      "UPDATE transactions SET status = 'reviewed', updated_at = NOW() WHERE id = $1 AND realm_id = $2",
      [id, realmId]
    );
  } else if (action === 'recategorize' && category) {
    // Update the transaction
    await pool.query(
      "UPDATE transactions SET ai_category = $1, status = 'reviewed', updated_at = NOW() WHERE id = $2 AND realm_id = $3",
      [category, id, realmId]
    );
    // Learn: save vendor→category rule for future categorization
    const { rows } = await pool.query('SELECT vendor_name FROM transactions WHERE id = $1 AND realm_id = $2', [id, realmId]);
    if (rows[0]?.vendor_name) {
      await pool.query(`
        INSERT INTO category_rules (realm_id, vendor_name, category)
        VALUES ($1, $2, $3)
        ON CONFLICT(realm_id, vendor_name) DO UPDATE SET category = EXCLUDED.category, created_at = NOW()
      `, [realmId, rows[0].vendor_name, category]);
    }
  } else if (action === 'skip') {
    await pool.query(
      "UPDATE transactions SET status = 'skipped', updated_at = NOW() WHERE id = $1 AND realm_id = $2",
      [id, realmId]
    );
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }

  res.json({ ok: true });
});

// List vendors for a company
router.get('/companies/:realmId/vendors', async (req, res) => {
  const { realmId } = req.params;
  const { rows } = await pool.query(
    'SELECT * FROM vendors WHERE realm_id = $1 ORDER BY vendor_name', [realmId]
  );
  res.json(rows);
});

// --- Actions ---

// Trigger a sync
router.post('/companies/:realmId/sync', async (req, res) => {
  try {
    const result = await syncTransactions(req.params.realmId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger AI categorization
router.post('/companies/:realmId/categorize', async (req, res) => {
  try {
    const coa = await getChartOfAccounts(req.params.realmId);
    const result = await categorizeTransactions(req.params.realmId, coa);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger vendor research
router.post('/companies/:realmId/research-vendors', async (req, res) => {
  try {
    const result = await researchAllVendors(req.params.realmId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write back reviewed transactions to QuickBooks
router.post('/companies/:realmId/write-back', async (req, res) => {
  const { realmId } = req.params;

  const { rows: [job] } = await pool.query(
    "INSERT INTO jobs (realm_id, job_type) VALUES ($1, 'write_back') RETURNING id",
    [realmId]
  );
  const jobId = job.id;

  try {
    const { rows: reviewed } = await pool.query(
      "SELECT * FROM transactions WHERE realm_id = $1 AND status = 'reviewed' AND ai_category IS NOT NULL",
      [realmId]
    );

    await pool.query('UPDATE jobs SET items_total = $1 WHERE id = $2', [reviewed.length, jobId]);

    let processed = 0;
    const errors = [];

    for (const txn of reviewed) {
      try {
        await writeBackTransaction(realmId, txn.qb_id, txn.ai_category);
        processed++;
        await pool.query('UPDATE jobs SET items_processed = $1 WHERE id = $2', [processed, jobId]);
      } catch (e) {
        errors.push({ qb_id: txn.qb_id, error: e.message });
      }
    }

    await pool.query(
      "UPDATE jobs SET status = 'completed', items_processed = $1, completed_at = NOW() WHERE id = $2",
      [processed, jobId]
    );

    res.json({ written: processed, errors });
  } catch (err) {
    await pool.query(
      "UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err.message, jobId]
    );
    res.status(500).json({ error: err.message });
  }
});

// Run the full overnight pipeline on demand
router.post('/companies/:realmId/run-pipeline', async (req, res) => {
  try {
    const results = await runFullPipeline(req.params.realmId);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Phase 2: Scan endpoints ---

// Uncategorized transaction scan
router.post('/companies/:realmId/scan/uncategorized', async (req, res) => {
  try {
    const result = await scanUncategorized(req.params.realmId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liability health check
router.post('/companies/:realmId/scan/liability', async (req, res) => {
  try {
    const result = await scanLiabilities(req.params.realmId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fixed asset vs expense scan
router.post('/companies/:realmId/scan/fixed-assets', async (req, res) => {
  try {
    const threshold = Number(req.body.threshold) || 2500;
    const result = await scanFixedAssets(req.params.realmId, threshold);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chart of accounts change detection
router.post('/companies/:realmId/scan/coa-changes', async (req, res) => {
  try {
    const days = Number(req.body.days) || 30;
    const result = await detectCoAChanges(req.params.realmId, days);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// P&L variance analysis
router.post('/companies/:realmId/analysis/variance', async (req, res) => {
  try {
    const period = req.body.period || currentPeriod();
    const thresholdPct = Number(req.body.thresholdPct) || 15;
    const thresholdAmt = Number(req.body.thresholdAmt) || 500;
    const result = await analyzeVariance(req.params.realmId, period, thresholdPct, thresholdAmt);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get latest scan results (any type)
router.get('/companies/:realmId/scans', async (req, res) => {
  try {
    const { type } = req.query;
    if (type) {
      const result = await getLatestScan(req.params.realmId, type);
      res.json(result || { message: 'No scan results found' });
    } else {
      // Return latest of each type
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (scan_type) *
        FROM scan_results
        WHERE realm_id = $1
        ORDER BY scan_type, scanned_at DESC
      `, [req.params.realmId]);
      res.json(rows);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Close package endpoints ---

router.post('/companies/:realmId/close-package', async (req, res) => {
  try {
    const period = req.body.period || currentPeriod();
    const pkg = await generateClosePackage(req.params.realmId, period);
    res.json(pkg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:realmId/close-packages', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, period, status, generated_at FROM close_packages WHERE realm_id = $1 ORDER BY generated_at DESC',
      [req.params.realmId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:realmId/close-packages/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM close_packages WHERE id = $1 AND realm_id = $2',
      [req.params.id, req.params.realmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/companies/:realmId/close-packages/:id', async (req, res) => {
  try {
    const { status, reviewer_notes } = req.body;
    const updates = [];
    const params = [req.params.id, req.params.realmId];
    let idx = 3;

    if (status) {
      updates.push(`status = $${idx++}`);
      params.push(status);
    }
    if (reviewer_notes !== undefined) {
      updates.push(`reviewer_notes = $${idx++}`);
      params.push(reviewer_notes);
    }

    if (updates.length === 0) return res.json({ ok: true });

    await pool.query(
      `UPDATE close_packages SET ${updates.join(', ')} WHERE id = $1 AND realm_id = $2`,
      params
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Statement schedule endpoints ---

router.get('/companies/:realmId/statements', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM statement_schedules WHERE realm_id = $1 ORDER BY client_name, account_name',
      [req.params.realmId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/companies/:realmId/statements', async (req, res) => {
  try {
    const { client_name, account_name, institution, access_method, statement_day, contact_email, reminder_cadence, notes } = req.body;
    const { rows: [stmt] } = await pool.query(`
      INSERT INTO statement_schedules (realm_id, client_name, account_name, institution, access_method, statement_day, contact_email, reminder_cadence, notes, current_month)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [req.params.realmId, client_name, account_name, institution || '', access_method || 'portal', statement_day || 1, contact_email || '', reminder_cadence || '1,5,10', notes || '', currentPeriod()]);
    res.json(stmt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/companies/:realmId/statements/:id', async (req, res) => {
  try {
    const fields = ['client_name', 'account_name', 'institution', 'access_method', 'statement_day', 'contact_email', 'reminder_cadence', 'notes', 'status'];
    const updates = [];
    const params = [req.params.id, req.params.realmId];
    let idx = 3;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }

    if (updates.length === 0) return res.json({ ok: true });

    await pool.query(`UPDATE statement_schedules SET ${updates.join(', ')} WHERE id = $1 AND realm_id = $2`, params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/companies/:realmId/statements/:id/received', async (req, res) => {
  try {
    await pool.query(
      "UPDATE statement_schedules SET status = 'received', received_at = NOW() WHERE id = $1 AND realm_id = $2",
      [req.params.id, req.params.realmId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/companies/:realmId/statements/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM statement_schedules WHERE id = $1 AND realm_id = $2', [req.params.id, req.params.realmId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = router;
