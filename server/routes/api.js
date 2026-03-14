const { Router } = require('express');
const { pool } = require('../db');
const { syncTransactions, getChartOfAccounts, writeBackTransaction } = require('../services/quickbooks');
const { categorizeTransactions, researchAllVendors } = require('../services/claude');
const { runFullPipeline } = require('../scheduler');

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
      .filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Income', 'Other Income', 'Other Current Liability', 'Other Current Asset', 'Fixed Asset', 'Other Asset', 'Long Term Liability', 'Equity', 'Bank', 'Accounts Receivable', 'Accounts Payable', 'Credit Card'].includes(a.AccountType))
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

  // Get the vendor name for this transaction
  const { rows: [txn] } = await pool.query(
    'SELECT vendor_name, ai_category FROM transactions WHERE id = $1 AND realm_id = $2', [id, realmId]
  );
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });

  const vendorName = txn.vendor_name;
  const resolvedCategory = (action === 'recategorize' && category) ? category : txn.ai_category;

  if (action === 'approve' || (action === 'recategorize' && category)) {
    // Update this transaction
    await pool.query(
      "UPDATE transactions SET ai_category = $1, status = 'reviewed', updated_at = NOW() WHERE id = $2 AND realm_id = $3",
      [resolvedCategory, id, realmId]
    );

    // Apply to ALL other categorized transactions from the same vendor
    let applied = 0;
    if (vendorName) {
      const { rowCount } = await pool.query(
        "UPDATE transactions SET ai_category = $1, status = 'reviewed', updated_at = NOW() WHERE realm_id = $2 AND vendor_name = $3 AND status = 'categorized' AND id != $4",
        [resolvedCategory, realmId, vendorName, id]
      );
      applied = rowCount;

      // Save vendor→category rule for future categorization
      await pool.query(`
        INSERT INTO category_rules (realm_id, vendor_name, category)
        VALUES ($1, $2, $3)
        ON CONFLICT(realm_id, vendor_name) DO UPDATE SET category = EXCLUDED.category, created_at = NOW()
      `, [realmId, vendorName, resolvedCategory]);
    }

    res.json({ ok: true, applied: applied + 1 });
    return;
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

// Debug: query QBO directly to inspect transactions
router.get('/companies/:realmId/qb-query', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Provide ?q=SELECT...' });
    const { qbFetch } = require('../services/quickbooks');
    const data = await qbFetch(req.params.realmId, `/query?query=${encodeURIComponent(q)}`);
    res.json(data.QueryResponse || data);
  } catch (err) {
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

module.exports = router;
