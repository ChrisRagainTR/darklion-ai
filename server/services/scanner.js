const { pool } = require('../db');
const { getChartOfAccounts, qbFetch } = require('./quickbooks');

// Scan for uncategorized transaction accounts
async function scanUncategorized(realmId) {
  const targetNames = ['Uncategorized Income', 'Uncategorized Expense', 'Ask My Accountant'];
  const accounts = await getChartOfAccounts(realmId);

  const flagged = [];
  const checked = [];

  for (const name of targetNames) {
    const acct = accounts.find(a =>
      (a.Name || '').toLowerCase() === name.toLowerCase() ||
      (a.FullyQualifiedName || '').toLowerCase() === name.toLowerCase()
    );

    if (!acct) continue;

    const balance = Number(acct.CurrentBalance || 0);
    checked.push({ name: acct.Name, id: acct.Id, balance, type: acct.AccountType });

    if (balance !== 0) {
      // Pull transaction detail for this account
      let transactions = [];
      try {
        const query = `SELECT * FROM Purchase WHERE AccountRef = '${acct.Id}' MAXRESULTS 50`;
        const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);
        const purchases = data.QueryResponse?.Purchase || [];
        transactions = purchases.map(p => ({
          date: p.TxnDate || '',
          description: (p.Line?.[0]?.Description || p.PrivateNote || '').substring(0, 80),
          vendor: p.EntityRef?.name || '',
          amount: p.TotalAmt || 0,
        }));
      } catch (e) {
        // Non-fatal — we still flag the account even without detail
      }

      flagged.push({
        name: acct.Name,
        id: acct.Id,
        balance,
        type: acct.AccountType,
        transactionCount: transactions.length,
        transactions,
      });
    }
  }

  const totalFlagged = flagged.reduce((sum, f) => sum + Math.abs(f.balance), 0);

  const result = {
    flagged,
    checked,
    summary: {
      flaggedCount: flagged.length,
      checkedCount: checked.length,
      totalFlaggedAmount: totalFlagged,
    },
  };

  // Store scan result
  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'uncategorized', $2, $3, $4)
  `, [realmId, currentPeriod(), JSON.stringify(result), flagged.length]);

  return result;
}

// Get the latest scan result for a given type
async function getLatestScan(realmId, scanType) {
  const { rows } = await pool.query(`
    SELECT * FROM scan_results
    WHERE realm_id = $1 AND scan_type = $2
    ORDER BY scanned_at DESC LIMIT 1
  `, [realmId, scanType]);
  return rows[0] || null;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { scanUncategorized, getLatestScan };
