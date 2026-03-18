const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

// Scan all liability accounts for health issues
async function scanLiabilities(realmId) {
  // Query all liability-type accounts
  const query = "SELECT * FROM Account WHERE AccountType IN ('Accounts Payable', 'Credit Card', 'Long Term Liability', 'Other Current Liability') MAXRESULTS 200";
  const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);
  const accounts = data.QueryResponse?.Account || [];

  const checked = [];
  const flagged = [];

  for (const acct of accounts) {
    const balance = Number(acct.CurrentBalance || 0);
    const name = acct.Name || acct.FullyQualifiedName || '';
    const subType = acct.AccountSubType || acct.AccountType || '';

    const issues = [];

    // Check 1: Negative balance (unusual for liability)
    if (balance < 0) {
      issues.push({ type: 'negative_balance', message: `Negative balance: $${balance.toLocaleString()}`, severity: 'warning' });
    }

    // Check 2: Zero balance on accounts that typically carry balances
    const expectsBalance = ['Credit Card', 'Long Term Liability'].includes(acct.AccountType);
    if (balance === 0 && expectsBalance) {
      issues.push({ type: 'zero_balance', message: 'Zero balance — verify if expected', severity: 'info' });
    }

    // Check 3: Very large balance relative to typical (> $50k on credit cards)
    if (acct.AccountType === 'Credit Card' && balance > 50000) {
      issues.push({ type: 'high_balance', message: `High balance: $${balance.toLocaleString()}`, severity: 'warning' });
    }

    // Check 4: Stale payroll liabilities — Other Current Liability with non-zero
    if (acct.AccountType === 'Other Current Liability' && Math.abs(balance) > 0) {
      const isPayroll = /payroll|tax|withhold|fica|futa|suta|401k|health\s*ins/i.test(name);
      if (isPayroll) {
        issues.push({ type: 'payroll_liability', message: `Payroll liability balance: $${balance.toLocaleString()} — verify cleared`, severity: 'warning' });
      }
    }

    const entry = {
      name,
      id: acct.Id,
      accountType: acct.AccountType,
      subType,
      balance,
      active: acct.Active !== false,
      issues,
    };

    checked.push(entry);
    if (issues.length > 0) {
      flagged.push(entry);
    }
  }

  // Sort flagged by severity (warnings first) then by absolute balance
  flagged.sort((a, b) => {
    const aWarn = a.issues.some(i => i.severity === 'warning') ? 1 : 0;
    const bWarn = b.issues.some(i => i.severity === 'warning') ? 1 : 0;
    if (aWarn !== bWarn) return bWarn - aWarn;
    return Math.abs(b.balance) - Math.abs(a.balance);
  });

  const result = {
    summary: {
      totalAccounts: checked.length,
      flaggedCount: flagged.length,
      totalLiabilityBalance: checked.reduce((sum, c) => sum + c.balance, 0),
    },
    flagged,
    checked,
  };

  // Store scan result
  const period = currentPeriod();
  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'liability', $2, $3, $4)
  `, [realmId, period, JSON.stringify(result), flagged.length]);

  return result;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { scanLiabilities };
