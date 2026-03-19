const { Router } = require('express');
const { pool } = require('../db');
const { scanUncategorized, getLatestScan } = require('../services/scanner');
const { generateClosePackage } = require('../services/reports');
const { scanVariance } = require('../services/variance');
const { scanLiabilities } = require('../services/liability');
const { verifyPayroll } = require('../services/payroll');
const { auditLog } = require('./firms');
const { getChartOfAccounts, qbFetch, writeBackTransaction } = require('../services/quickbooks');

const router = Router();

// Helper: verify realm belongs to this firm AND user has access (via firm_user_companies)
async function assertRealmOwner(firmId, realmId, res, userId) {
  // Check firm owns the company
  const { rows } = await pool.query(
    'SELECT realm_id FROM companies WHERE realm_id = $1 AND (firm_id = $2 OR firm_id IS NULL)',
    [realmId, firmId]
  );
  if (rows.length === 0) {
    res.status(403).json({ error: 'Access denied to this company' });
    return false;
  }

  // Check per-user company restriction (if userId present)
  if (userId) {
    const { rows: accessRows } = await pool.query(
      'SELECT id FROM firm_user_companies WHERE firm_user_id = $1',
      [userId]
    );
    // If user has specific company restrictions, check if this realm is allowed
    if (accessRows.length > 0) {
      const { rows: allowed } = await pool.query(
        'SELECT id FROM firm_user_companies WHERE firm_user_id = $1 AND realm_id = $2',
        [userId, realmId]
      );
      if (allowed.length === 0) {
        res.status(403).json({ error: 'Access denied to this company' });
        return false;
      }
    }
    // If no rows → unrestricted access to all firm companies
  }

  return true;
}

// Helper: get allowed realm IDs for a user (empty array = all)
async function getUserAllowedRealms(userId) {
  if (!userId) return null; // no restriction
  const { rows } = await pool.query(
    'SELECT realm_id FROM firm_user_companies WHERE firm_user_id = $1',
    [userId]
  );
  return rows.length > 0 ? rows.map(r => r.realm_id) : null; // null = unrestricted
}

// --- Dashboard data ---

// List connected companies scoped to this firm (filtered by user access)
router.get('/companies', async (req, res) => {
  const firmId = req.firm?.id;
  const userId = req.firm?.userId || null;
  let query, params;

  if (firmId) {
    query = 'SELECT realm_id, company_name, connected_at, last_sync_at, token_expires_at, refresh_token, gusto_access_token, gusto_company_id FROM companies WHERE firm_id = $1 ORDER BY company_name ASC';
    params = [firmId];
  } else {
    query = 'SELECT realm_id, company_name, connected_at, last_sync_at, token_expires_at, refresh_token, gusto_access_token, gusto_company_id FROM companies ORDER BY company_name ASC';
    params = [];
  }

  let { rows } = await pool.query(query, params);

  // Filter by per-user company access if applicable
  if (userId && firmId) {
    const allowedRealms = await getUserAllowedRealms(userId);
    if (allowedRealms !== null) {
      rows = rows.filter(r => allowedRealms.includes(r.realm_id));
    }
  }
  const now = Date.now();
  const { refreshTokens } = require('./auth');

  const enriched = [];
  for (const c of rows) {
    let tokenStatus = 'connected';
    const expired = c.token_expires_at && Number(c.token_expires_at) < now;

    if (expired && c.refresh_token) {
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

// Disconnect a company (firm-scoped)
router.delete('/companies/:realmId', async (req, res) => {
  try {
    const { realmId } = req.params;
    const firmId = req.firm?.id;

    if (firmId && !(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    // Get company name for audit log
    const { rows: [comp] } = await pool.query('SELECT company_name FROM companies WHERE realm_id = $1', [realmId]);

    // Delete dependent records first, then the company
    await pool.query('DELETE FROM scan_results WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM close_packages WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM statement_schedules WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM category_rules WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM jobs WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM vendors WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM transactions WHERE realm_id = $1', [realmId]);
    await pool.query('DELETE FROM companies WHERE realm_id = $1', [realmId]);

    await auditLog(firmId, 'company_disconnect', `Disconnected: ${comp?.company_name || realmId}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Uncategorized transaction scan ---
router.post('/companies/:realmId/scan/uncategorized', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const result = await scanUncategorized(req.params.realmId);
    await auditLog(firmId, 'scan_uncategorized', `Realm: ${req.params.realmId}, flags: ${result.summary.flaggedCount}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- P&L Variance Analysis ---
router.post('/companies/:realmId/scan/variance', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { year, month, thresholdPct, thresholdAmt } = req.body || {};
    const result = await scanVariance(req.params.realmId, { year, month, thresholdPct, thresholdAmt });
    await auditLog(firmId, 'scan_variance', `Realm: ${req.params.realmId}, flags: ${result.summary.flaggedCount}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Payroll Verification ---
router.post('/companies/:realmId/scan/payroll', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { year, month } = req.body || {};
    const result = await verifyPayroll(req.params.realmId, { year, month });
    await auditLog(firmId, 'scan_payroll', `Realm: ${req.params.realmId}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Employee officer tagging ---
router.get('/companies/:realmId/employees/metadata', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { rows } = await pool.query(
      'SELECT employee_uuid, employee_name, is_officer FROM employee_metadata WHERE realm_id = $1',
      [req.params.realmId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/companies/:realmId/employees/:employeeUuid/officer', async (req, res) => {
  try {
    const { realmId, employeeUuid } = req.params;
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, realmId, res, req.firm?.userId))) return;

    const { is_officer, employee_name } = req.body;
    await pool.query(`
      INSERT INTO employee_metadata (realm_id, employee_uuid, employee_name, is_officer)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (realm_id, employee_uuid) DO UPDATE SET
        is_officer = EXCLUDED.is_officer,
        employee_name = COALESCE(NULLIF(EXCLUDED.employee_name, ''), employee_metadata.employee_name),
        updated_at = NOW()
    `, [realmId, employeeUuid, employee_name || '', is_officer]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Liability Account Health Check ---
router.post('/companies/:realmId/scan/liability', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const result = await scanLiabilities(req.params.realmId);
    await auditLog(firmId, 'scan_liability', `Realm: ${req.params.realmId}, flags: ${result.summary?.flaggedCount || 0}`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get latest scan results (any type)
router.get('/companies/:realmId/scans', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

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
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { startDate, endDate, period, label, byMonth } = req.body;
    const realmId = req.params.realmId;

    if (byMonth && startDate && endDate) {
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
      const pkg = await generateClosePackage(realmId, period || 'custom', startDate, endDate);
      return res.json(pkg);
    }

    const p = period || currentPeriod();
    const pkg = await generateClosePackage(realmId, p);
    res.json(pkg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:realmId/close-packages', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

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
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

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
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

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

// --- Chart of Accounts ---
router.get('/companies/:realmId/accounts', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const accounts = await getChartOfAccounts(req.params.realmId);
    // Return simplified structure grouped by type
    const simplified = accounts.map(a => ({
      id: a.Id,
      name: a.Name,
      fullName: a.FullyQualifiedName || a.Name,
      type: a.AccountType,
      subType: a.AccountSubType,
      active: a.Active !== false,
    }));
    res.json(simplified);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Transaction Drill-Down ---
router.get('/companies/:realmId/transactions/drilldown', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { account, startDate, endDate } = req.query;
    if (!account || !startDate || !endDate) {
      return res.status(400).json({ error: 'account, startDate, and endDate are required' });
    }

    const endpoint = `/reports/TransactionList?start_date=${startDate}&end_date=${endDate}&account_name=${encodeURIComponent(account)}&minorversion=75`;
    const data = await qbFetch(req.params.realmId, endpoint);

    // Parse QBO TransactionList report
    const report = data.QueryData || data;
    const rows = data.Rows?.Row || [];
    const transactions = [];

    function parseRows(rowArr) {
      for (const row of rowArr) {
        if (row.type === 'Section' && row.Rows?.Row) {
          parseRows(row.Rows.Row);
        } else if (row.ColData) {
          const cols = row.ColData;
          // QBO TransactionList columns: Date, TxnType, DocNum, Name, Memo/Description, Split, Amount, TxnId
          const txn = {
            date: cols[0]?.value || '',
            type: cols[1]?.value || '',
            num: cols[2]?.value || '',
            name: cols[3]?.value || '',
            memo: cols[4]?.value || '',
            split: cols[5]?.value || '',
            amount: parseFloat(cols[6]?.value || '0'),
            txnId: cols[7]?.value || (cols[0]?.id || ''),
          };
          if (txn.date) transactions.push(txn);
        }
      }
    }
    parseRows(rows);

    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Transaction Recode ---
router.post('/companies/:realmId/transactions/recode', async (req, res) => {
  try {
    const firmId = req.firm?.id;
    if (firmId && !(await assertRealmOwner(firmId, req.params.realmId, res, req.firm?.userId))) return;

    const { txnId, txnType, newAccount } = req.body;
    if (!txnId || !newAccount) return res.status(400).json({ error: 'txnId and newAccount are required' });

    await writeBackTransaction(req.params.realmId, txnId, newAccount);

    await auditLog(
      firmId,
      'transaction_recode',
      `Realm: ${req.params.realmId}, txnId: ${txnId}, type: ${txnType || 'Purchase'}, account: ${newAccount}`,
      req.ip
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
