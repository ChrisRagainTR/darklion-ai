const { pool } = require('../db');
const { getAccessToken } = require('../routes/auth');

const QB_BASE = 'https://quickbooks.api.intuit.com/v3/company';

async function qbFetch(realmId, endpoint, options = {}) {
  const token = await getAccessToken(realmId);
  const url = `${QB_BASE}/${realmId}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QB API ${res.status}: ${body}`);
  }

  return res.json();
}

// Pull uncategorized purchases from QuickBooks
async function syncTransactions(realmId) {
  const { rows: [job] } = await pool.query(
    "INSERT INTO jobs (realm_id, job_type) VALUES ($1, 'sync') RETURNING id",
    [realmId]
  );
  const jobId = job.id;

  try {
    const lastSync = await getLastSyncDate(realmId);
    const query = `SELECT * FROM Purchase WHERE MetaData.LastUpdatedTime > '${lastSync}' MAXRESULTS 500`;
    const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);

    const purchases = data.QueryResponse?.Purchase || [];

    for (const txn of purchases) {
      const line = txn.Line?.[0] || {};
      const vendorRef = txn.EntityRef?.name || '';
      const accountRef = line.AccountBasedExpenseLineDetail?.AccountRef?.name || '';
      const desc = line.Description || txn.PrivateNote || '';

      await pool.query(`
        INSERT INTO transactions (realm_id, qb_id, txn_type, date, amount, description, vendor_name, original_account)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(realm_id, qb_id) DO UPDATE SET
          date = EXCLUDED.date,
          amount = EXCLUDED.amount,
          description = EXCLUDED.description,
          vendor_name = EXCLUDED.vendor_name,
          original_account = EXCLUDED.original_account,
          updated_at = NOW()
      `, [realmId, txn.Id, 'Purchase', txn.TxnDate || '', txn.TotalAmt || 0, desc, vendorRef, accountRef]);
    }

    await pool.query("UPDATE companies SET last_sync_at = NOW() WHERE realm_id = $1", [realmId]);

    await pool.query(
      "UPDATE jobs SET status = 'completed', items_processed = $1, items_total = $2, completed_at = NOW() WHERE id = $3",
      [purchases.length, purchases.length, jobId]
    );

    return { synced: purchases.length };
  } catch (err) {
    await pool.query(
      "UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err.message, jobId]
    );
    throw err;
  }
}

// Get chart of accounts for categorization context
async function getChartOfAccounts(realmId) {
  const data = await qbFetch(realmId, `/query?query=${encodeURIComponent('SELECT * FROM Account MAXRESULTS 500')}`);
  return data.QueryResponse?.Account || [];
}

// Get vendor list
async function getVendors(realmId) {
  const data = await qbFetch(realmId, `/query?query=${encodeURIComponent('SELECT * FROM Vendor MAXRESULTS 500')}`);
  return data.QueryResponse?.Vendor || [];
}

// Write back a categorized transaction to QuickBooks
async function writeBackTransaction(realmId, qbId, accountName) {
  // First read the current purchase
  const data = await qbFetch(realmId, `/purchase/${qbId}?minorversion=75`);
  const purchase = data.Purchase;

  if (!purchase) throw new Error(`Purchase ${qbId} not found`);

  // Look up account ID by name
  const accounts = await getChartOfAccounts(realmId);
  const account = accounts.find(a => a.Name === accountName || a.FullyQualifiedName === accountName);
  if (!account) throw new Error(`Account "${accountName}" not found in chart of accounts`);

  // Update the first line's account
  if (purchase.Line?.[0]?.AccountBasedExpenseLineDetail) {
    purchase.Line[0].AccountBasedExpenseLineDetail.AccountRef = {
      value: account.Id,
      name: account.Name,
    };
  }

  // Write back
  await qbFetch(realmId, `/purchase`, {
    method: 'POST',
    body: JSON.stringify(purchase),
  });

  // Update local status
  await pool.query(
    "UPDATE transactions SET status = 'written_back', updated_at = NOW() WHERE realm_id = $1 AND qb_id = $2",
    [realmId, qbId]
  );

  return { ok: true };
}

async function getLastSyncDate(realmId) {
  const { rows } = await pool.query('SELECT last_sync_at FROM companies WHERE realm_id = $1', [realmId]);
  if (rows[0]?.last_sync_at) return rows[0].last_sync_at;
  // Default: 90 days ago
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().split('T')[0];
}

module.exports = { syncTransactions, getChartOfAccounts, getVendors, writeBackTransaction, qbFetch };
