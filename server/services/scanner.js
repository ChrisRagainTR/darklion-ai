const { pool } = require('../db');
const { qbFetch, getChartOfAccounts } = require('./quickbooks');

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

// Scan liability accounts for health issues
async function scanLiabilities(realmId) {
  const accounts = await getChartOfAccounts(realmId);

  const liabilityTypes = ['Other Current Liability', 'Long Term Liability', 'Credit Card'];
  const liabilityAccounts = accounts.filter(a => liabilityTypes.includes(a.AccountType));

  const flagged = [];
  const healthy = [];

  for (const acct of liabilityAccounts) {
    const balance = Number(acct.CurrentBalance || 0);
    const issues = [];

    // Flag negative balances (liabilities should be positive/credit)
    if (balance < 0) {
      issues.push('Negative balance');
    }

    // Flag zero balances on active accounts (might need cleanup)
    if (balance === 0 && acct.Active) {
      issues.push('Zero balance');
    }

    // Flag unusually high balances (>$25k) as needing review
    if (balance > 25000) {
      issues.push('Unusually high balance');
    }

    const entry = {
      name: acct.Name || acct.FullyQualifiedName,
      id: acct.Id,
      type: acct.AccountType,
      subType: acct.AccountSubType || '',
      balance,
      active: acct.Active !== false,
      issues,
    };

    if (issues.length > 0) {
      flagged.push(entry);
    } else {
      healthy.push(entry);
    }
  }

  const result = {
    flagged,
    healthy,
    summary: {
      flaggedCount: flagged.length,
      healthyCount: healthy.length,
      totalAccounts: liabilityAccounts.length,
    },
  };

  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'liability', $2, $3, $4)
  `, [realmId, currentPeriod(), JSON.stringify(result), flagged.length]);

  return result;
}

// Scan for large expense transactions that might be fixed assets
async function scanFixedAssets(realmId, threshold = 2500) {
  // Get all expense accounts
  const accounts = await getChartOfAccounts(realmId);
  const expenseAccounts = accounts.filter(a =>
    ['Expense', 'Other Expense', 'Cost of Goods Sold'].includes(a.AccountType)
  );
  const fixedAssetAccounts = accounts.filter(a => a.AccountType === 'Fixed Asset');

  // Query transactions above threshold from our local DB
  const { rows: largeTxns } = await pool.query(`
    SELECT * FROM transactions
    WHERE realm_id = $1 AND amount >= $2
    ORDER BY amount DESC
    LIMIT 50
  `, [realmId, threshold]);

  // Also try pulling from QBO directly for broader coverage
  let qbFlagged = [];
  try {
    const query = `SELECT * FROM Purchase WHERE TotalAmt >= '${threshold}' MAXRESULTS 50`;
    const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);
    const purchases = data.QueryResponse?.Purchase || [];

    qbFlagged = purchases
      .filter(p => {
        const acctRef = p.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || '';
        return expenseAccounts.some(a =>
          a.Name === acctRef || a.FullyQualifiedName === acctRef
        );
      })
      .map(p => ({
        date: p.TxnDate || '',
        description: (p.Line?.[0]?.Description || p.PrivateNote || '').substring(0, 80),
        vendor: p.EntityRef?.name || '',
        amount: p.TotalAmt || 0,
        expenseAccount: p.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || '',
        qbId: p.Id,
      }));
  } catch (e) {
    // Fall back to local DB results
  }

  // Combine and deduplicate
  const flagged = qbFlagged.length > 0 ? qbFlagged : largeTxns.map(t => ({
    date: t.date,
    description: t.description,
    vendor: t.vendor_name,
    amount: t.amount,
    expenseAccount: t.original_account,
    qbId: t.qb_id,
  }));

  const totalFlagged = flagged.reduce((sum, f) => sum + Number(f.amount), 0);

  const result = {
    flagged,
    fixedAssetAccounts: fixedAssetAccounts.map(a => ({
      name: a.Name,
      balance: a.CurrentBalance || 0,
    })),
    threshold,
    summary: {
      flaggedCount: flagged.length,
      totalFlaggedAmount: totalFlagged,
      fixedAssetAccountCount: fixedAssetAccounts.length,
    },
  };

  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'fixed_asset', $2, $3, $4)
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

module.exports = { scanUncategorized, scanLiabilities, scanFixedAssets, getLatestScan };
