const db = require('../db');
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
  const job = db.prepare(
    `INSERT INTO jobs (realm_id, job_type) VALUES (?, 'sync')`
  ).run(realmId);
  const jobId = job.lastInsertRowid;

  try {
    // Query for recent Purchase transactions (bills, expenses, checks)
    const query = `SELECT * FROM Purchase WHERE MetaData.LastUpdatedTime > '${getLastSyncDate(realmId)}' MAXRESULTS 500`;
    const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);

    const purchases = data.QueryResponse?.Purchase || [];

    const upsert = db.prepare(`
      INSERT INTO transactions (realm_id, qb_id, txn_type, date, amount, description, vendor_name, original_account)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(realm_id, qb_id) DO UPDATE SET
        date = excluded.date,
        amount = excluded.amount,
        description = excluded.description,
        vendor_name = excluded.vendor_name,
        original_account = excluded.original_account,
        updated_at = datetime('now')
    `);

    const insertMany = db.transaction((txns) => {
      for (const txn of txns) {
        const line = txn.Line?.[0] || {};
        const vendorRef = txn.EntityRef?.name || '';
        const accountRef = line.AccountBasedExpenseLineDetail?.AccountRef?.name || '';
        const desc = line.Description || txn.PrivateNote || '';

        upsert.run(
          realmId,
          txn.Id,
          'Purchase',
          txn.TxnDate || '',
          txn.TotalAmt || 0,
          desc,
          vendorRef,
          accountRef
        );
      }
    });

    insertMany(purchases);

    // Also sync Expenses (if using the Expense entity)
    try {
      const expenseQuery = `SELECT * FROM Purchase WHERE PaymentType = 'Cash' MAXRESULTS 500`;
      // Purchases with PaymentType cover expenses too in QBO
    } catch (e) {
      // Non-fatal
    }

    db.prepare('UPDATE companies SET last_sync_at = datetime(\'now\') WHERE realm_id = ?').run(realmId);

    db.prepare(`
      UPDATE jobs SET status = 'completed', items_processed = ?, items_total = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(purchases.length, purchases.length, jobId);

    return { synced: purchases.length };
  } catch (err) {
    db.prepare(`
      UPDATE jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?
    `).run(err.message, jobId);
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
  db.prepare(`
    UPDATE transactions SET status = 'written_back', updated_at = datetime('now')
    WHERE realm_id = ? AND qb_id = ?
  `).run(realmId, qbId);

  return { ok: true };
}

function getLastSyncDate(realmId) {
  const company = db.prepare('SELECT last_sync_at FROM companies WHERE realm_id = ?').get(realmId);
  if (company?.last_sync_at) return company.last_sync_at;
  // Default: 90 days ago
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().split('T')[0];
}

module.exports = { syncTransactions, getChartOfAccounts, getVendors, writeBackTransaction };
