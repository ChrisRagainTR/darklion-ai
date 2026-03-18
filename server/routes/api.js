const { Router } = require('express');
const { pool } = require('../db');
const { scanUncategorized, getLatestScan } = require('../services/scanner');
const { generateClosePackage } = require('../services/reports');

const router = Router();

// --- Dashboard data ---

// List connected companies
router.get('/companies', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT realm_id, company_name, connected_at, last_sync_at FROM companies ORDER BY connected_at DESC'
  );
  res.json(rows);
});

// --- Uncategorized transaction scan ---
router.post('/companies/:realmId/scan/uncategorized', async (req, res) => {
  try {
    const result = await scanUncategorized(req.params.realmId);
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

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = router;
