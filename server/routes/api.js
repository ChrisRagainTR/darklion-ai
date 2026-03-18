const { Router } = require('express');
const { pool } = require('../db');
const { scanUncategorized, getLatestScan } = require('../services/scanner');
const { generateClosePackage } = require('../services/reports');
const { scanVariance } = require('../services/variance');
const { scanLiabilities } = require('../services/liability');
const { verifyPayroll } = require('../services/payroll');

const router = Router();

// --- Dashboard data ---

// List connected companies (with token health, auto-refresh expired tokens)
router.get('/companies', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT realm_id, company_name, connected_at, last_sync_at, token_expires_at, refresh_token, gusto_access_token, gusto_company_id FROM companies ORDER BY company_name ASC'
  );
  const now = Date.now();
  const { refreshTokens } = require('./auth');

  const enriched = [];
  for (const c of rows) {
    let tokenStatus = 'connected';
    const expired = c.token_expires_at && Number(c.token_expires_at) < now;

    if (expired && c.refresh_token) {
      // Try to silently refresh
      try {
        await refreshTokens(c.realm_id);
        tokenStatus = 'connected';
      } catch (e) {
        tokenStatus = 'disconnected';
      }
    } else if (!c.refresh_token) {
      tokenStatus = 'disconnected';
    }

    enriched.push({
      realm_id: c.realm_id,
      company_name: c.company_name,
      connected_at: c.connected_at,
      last_sync_at: c.last_sync_at,
      token_status: tokenStatus,
      gusto_connected: !!c.gusto_access_token,
    });
  }
  res.json(enriched);
});

// Disconnect a company
router.delete('/companies/:realmId', async (req, res) => {
  try {
    const { realmId } = req.params;
    // Delete dependent records first, then the company
    await pool.query('DELETE FROM scan_results WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM close_packages WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM statement_schedules WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM category_rules WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM jobs WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM vendors WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM transactions WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM companies WHERE realm_id = $1', [realmId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// --- P&L Variance Analysis ---
router.post('/companies/:realmId/scan/variance', async (req, res) => {
  try {
    const { year, month, thresholdPct, thresholdAmt } = req.body || {};
    const result = await scanVariance(req.params.realmId, { year, month, thresholdPct, thresholdAmt });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Payroll Verification ---
router.post('/companies/:realmId/scan/payroll', async (req, res) => {
  try {
    const { year, month } = req.body || {};
    const result = await verifyPayroll(req.params.realmId, { year, month });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Gusto debug (temporary) ---
router.get('/companies/:realmId/gusto/debug', async (req, res) => {
  try {
    const { getGustoAccessToken } = require('./auth');
    const accessToken = await getGustoAccessToken(req.params.realmId);
    const baseUrl = process.env.GUSTO_API_URL || 'https://api.gusto-demo.com';

    const meRes = await fetch(`${baseUrl}/v1/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
    });
    const meData = meRes.ok ? await meRes.json() : { error: meRes.status, body: await meRes.text() };

    res.json({ me: meData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Liability Account Health Check ---
router.post('/companies/:realmId/scan/liability', async (req, res) => {
  try {
    const result = await scanLiabilities(req.params.realmId);
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
    const { startDate, endDate, period, label, byMonth } = req.body;
    const realmId = req.params.realmId;

    if (byMonth && startDate && endDate) {
      // Generate one package per month in the range
      const results = [];
      const start = new Date(startDate + 'T00:00:00');
      const end = new Date(endDate + 'T00:00:00');
      const cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        const y = cur.getFullYear();
        const m = cur.getMonth() + 1;
        const p = y + '-' + String(m).padStart(2, '0');
        const pkg = await generateClosePackage(realmId, p);
        results.push(pkg);
        cur.setMonth(cur.getMonth() + 1);
      }
      return res.json(results);
    }

    if (startDate && endDate) {
      // Range-based package
      const pkg = await generateClosePackage(realmId, period || 'custom', startDate, endDate);
      return res.json(pkg);
    }

    // Legacy: single period like "2026-03"
    const p = period || currentPeriod();
    const pkg = await generateClosePackage(realmId, p);
    res.json(pkg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:realmId/close-packages', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, period, status, report_data, generated_at FROM close_packages WHERE realm_id = $1 ORDER BY generated_at DESC',
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
