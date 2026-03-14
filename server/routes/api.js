const { Router } = require('express');
const db = require('../db');
const { syncTransactions, getChartOfAccounts, writeBackTransaction } = require('../services/quickbooks');
const { categorizeTransactions, researchAllVendors } = require('../services/claude');

const router = Router();

// --- Dashboard data ---

// List connected companies
router.get('/companies', (req, res) => {
  const companies = db.prepare(`
    SELECT realm_id, company_name, connected_at, last_sync_at FROM companies ORDER BY connected_at DESC
  `).all();
  res.json(companies);
});

// Dashboard stats for a company
router.get('/companies/:realmId/stats', (req, res) => {
  const { realmId } = req.params;

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'categorized' THEN 1 ELSE 0 END) as categorized,
      SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) as reviewed,
      SUM(CASE WHEN status = 'written_back' THEN 1 ELSE 0 END) as written_back,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
    FROM transactions WHERE realm_id = ?
  `).get(realmId);

  const vendorCount = db.prepare(
    'SELECT COUNT(*) as count FROM vendors WHERE realm_id = ?'
  ).get(realmId);

  const recentJobs = db.prepare(`
    SELECT * FROM jobs WHERE realm_id = ? ORDER BY started_at DESC LIMIT 10
  `).all(realmId);

  res.json({ totals, vendors: vendorCount.count, recentJobs });
});

// List transactions for a company (with filtering)
router.get('/companies/:realmId/transactions', (req, res) => {
  const { realmId } = req.params;
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM transactions WHERE realm_id = ?';
  const params = [realmId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY date DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const transactions = db.prepare(query).all(...params);
  res.json(transactions);
});

// Review a transaction (approve or change category)
router.post('/companies/:realmId/transactions/:id/review', (req, res) => {
  const { realmId, id } = req.params;
  const { action, category } = req.body; // action: 'approve', 'recategorize', 'skip'

  if (action === 'approve') {
    db.prepare(`UPDATE transactions SET status = 'reviewed', updated_at = datetime('now') WHERE id = ? AND realm_id = ?`).run(id, realmId);
  } else if (action === 'recategorize' && category) {
    db.prepare(`UPDATE transactions SET ai_category = ?, status = 'reviewed', updated_at = datetime('now') WHERE id = ? AND realm_id = ?`).run(category, id, realmId);
  } else if (action === 'skip') {
    db.prepare(`UPDATE transactions SET status = 'skipped', updated_at = datetime('now') WHERE id = ? AND realm_id = ?`).run(id, realmId);
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }

  res.json({ ok: true });
});

// List vendors for a company
router.get('/companies/:realmId/vendors', (req, res) => {
  const { realmId } = req.params;
  const vendors = db.prepare('SELECT * FROM vendors WHERE realm_id = ? ORDER BY vendor_name').all(realmId);
  res.json(vendors);
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

  const job = db.prepare(
    `INSERT INTO jobs (realm_id, job_type) VALUES (?, 'write_back')`
  ).run(realmId);
  const jobId = job.lastInsertRowid;

  try {
    const reviewed = db.prepare(`
      SELECT * FROM transactions WHERE realm_id = ? AND status = 'reviewed' AND ai_category IS NOT NULL
    `).all(realmId);

    db.prepare('UPDATE jobs SET items_total = ? WHERE id = ?').run(reviewed.length, jobId);

    let processed = 0;
    const errors = [];

    for (const txn of reviewed) {
      try {
        await writeBackTransaction(realmId, txn.qb_id, txn.ai_category);
        processed++;
        db.prepare('UPDATE jobs SET items_processed = ? WHERE id = ?').run(processed, jobId);
      } catch (e) {
        errors.push({ qb_id: txn.qb_id, error: e.message });
      }
    }

    db.prepare(`
      UPDATE jobs SET status = 'completed', items_processed = ?, completed_at = datetime('now') WHERE id = ?
    `).run(processed, jobId);

    res.json({ written: processed, errors });
  } catch (err) {
    db.prepare(`
      UPDATE jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?
    `).run(err.message, jobId);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
