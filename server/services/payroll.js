const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

// Verify Gusto payroll against QBO journal entries
// Requires GUSTO_CLIENT_ID, GUSTO_CLIENT_SECRET, and a stored Gusto access token
async function verifyPayroll(realmId, options = {}) {
  const now = new Date();
  const year = options.year || now.getFullYear();
  const month = options.month || now.getMonth() + 1;

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = lastDay(year, month);

  // Check if Gusto is connected for this company
  const { rows: [company] } = await pool.query(
    'SELECT gusto_access_token, gusto_company_id FROM companies WHERE realm_id = $1',
    [realmId]
  );

  if (!company?.gusto_access_token) {
    return { error: 'Gusto not connected', connected: false };
  }

  // Get a valid token (auto-refreshes if needed)
  const { getGustoAccessToken } = require('../routes/auth');
  const accessToken = await getGustoAccessToken(realmId);

  // If we don't have a company ID yet, try to fetch it
  let gustoCompanyId = company.gusto_company_id;
  if (!gustoCompanyId) {
    try {
      const baseUrl = process.env.GUSTO_API_URL || 'https://api.gusto-demo.com';
      const compRes = await fetch(`${baseUrl}/v1/companies`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
      });
      if (compRes.ok) {
        const compData = await compRes.json();
        const comps = Array.isArray(compData) ? compData : [];
        if (comps.length > 0) {
          gustoCompanyId = comps[0].uuid || '';
        }
        if (gustoCompanyId) {
          await pool.query('UPDATE companies SET gusto_company_id = $1 WHERE realm_id = $2', [gustoCompanyId, realmId]);
        }
      }
    } catch (e) {
      console.error('Failed to fetch Gusto company ID:', e.message);
    }
  }

  if (!gustoCompanyId) {
    return { error: 'Could not determine Gusto company ID', connected: true };
  }

  // 1. Fetch payrolls from Gusto
  const gustoPayrolls = await fetchGustoPayrolls(
    accessToken,
    gustoCompanyId,
    startDate,
    endDate
  );

  // 2. Fetch QBO General Ledger for payroll accounts
  const glData = await qbFetch(realmId,
    `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&account_type=Expense&columns=tx_date,txn_type,name,memo,subt_nat_amount&minorversion=75`
  ).catch(() => null);

  // 3. Compare totals
  const mismatches = [];
  let gustoTotal = 0;
  let qboTotal = 0;

  for (const payroll of gustoPayrolls) {
    gustoTotal += payroll.totals.grossPay || 0;

    // Look for matching QBO journal entry by date
    const qboMatch = findQboPayrollEntry(glData, payroll.checkDate, payroll.totals.grossPay);
    if (!qboMatch.found) {
      mismatches.push({
        type: 'missing_je',
        gustoDate: payroll.checkDate,
        gustoGross: payroll.totals.grossPay,
        gustoNet: payroll.totals.netPay,
        message: `No matching QBO journal entry for ${payroll.checkDate} payroll ($${payroll.totals.grossPay.toLocaleString()})`,
      });
    } else if (Math.abs(qboMatch.amount - payroll.totals.grossPay) > 1) {
      mismatches.push({
        type: 'amount_mismatch',
        gustoDate: payroll.checkDate,
        gustoGross: payroll.totals.grossPay,
        qboAmount: qboMatch.amount,
        diff: qboMatch.amount - payroll.totals.grossPay,
        message: `Amount mismatch for ${payroll.checkDate}: Gusto $${payroll.totals.grossPay.toLocaleString()} vs QBO $${qboMatch.amount.toLocaleString()}`,
      });
    }
  }

  const result = {
    period: `${year}-${String(month).padStart(2, '0')}`,
    connected: true,
    summary: {
      payrollCount: gustoPayrolls.length,
      gustoTotal,
      qboTotal,
      mismatchCount: mismatches.length,
    },
    payrolls: gustoPayrolls.map(p => ({
      checkDate: p.checkDate,
      grossPay: p.totals.grossPay,
      netPay: p.totals.netPay,
      taxes: p.totals.taxes,
      employeeCount: p.employeeCount,
    })),
    mismatches,
  };

  // Store scan result
  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'payroll', $2, $3, $4)
  `, [realmId, result.period, JSON.stringify(result), mismatches.length]);

  return result;
}

// Fetch payrolls from Gusto API (list + individual detail for totals)
async function fetchGustoPayrolls(accessToken, companyId, startDate, endDate) {
  const baseUrl = process.env.GUSTO_API_URL || 'https://api.gusto-demo.com';
  const listUrl = `${baseUrl}/v1/companies/${companyId}/payrolls?start_date=${startDate}&end_date=${endDate}&processed=true`;

  const res = await fetch(listUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gusto API ${res.status}: ${body}`);
  }

  const payrollList = await res.json();

  // Fetch each payroll individually to get totals and employee data
  const payrolls = [];
  for (const p of payrollList) {
    const detailUrl = `${baseUrl}/v1/companies/${companyId}/payrolls/${p.payroll_uuid || p.uuid}`;
    try {
      const detailRes = await fetch(detailUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
      });
      if (detailRes.ok) {
        const detail = await detailRes.json();
        const toNum = (v) => {
          if (typeof v === 'number') return v;
          return (String(v || '0').replace(/,/g, '') * 1) || 0;
        };
        payrolls.push({
          checkDate: detail.check_date || p.check_date,
          payPeriodStart: detail.pay_period?.start_date || p.pay_period?.start_date,
          payPeriodEnd: detail.pay_period?.end_date || p.pay_period?.end_date,
          employeeCount: (detail.employee_compensations || []).length,
          totals: {
            grossPay: toNum(detail.totals?.gross_pay),
            netPay: toNum(detail.totals?.net_pay),
            taxes: toNum(detail.totals?.employer_taxes),
            deductions: toNum(detail.totals?.employee_deductions),
          },
        });
      } else {
        // Fallback to list data if detail fails
        payrolls.push({
          checkDate: p.check_date,
          payPeriodStart: p.pay_period?.start_date,
          payPeriodEnd: p.pay_period?.end_date,
          employeeCount: 0,
          totals: { grossPay: 0, netPay: 0, taxes: 0, deductions: 0 },
        });
      }
    } catch (e) {
      console.error(`Failed to fetch payroll detail ${p.uuid}:`, e.message);
      payrolls.push({
        checkDate: p.check_date,
        payPeriodStart: p.pay_period?.start_date,
        payPeriodEnd: p.pay_period?.end_date,
        employeeCount: 0,
        totals: { grossPay: 0, netPay: 0, taxes: 0, deductions: 0 },
      });
    }
  }

  return payrolls;
}

// Find a matching payroll journal entry in QBO General Ledger data
function findQboPayrollEntry(glData, date, expectedAmount) {
  if (!glData?.Rows?.Row) return { found: false, amount: 0 };

  // Walk through GL rows looking for payroll-related entries near the date
  let totalForDate = 0;
  let found = false;

  function walkRows(rows) {
    for (const row of rows) {
      if (row.Rows?.Row) walkRows(row.Rows.Row);
      if (row.ColData) {
        const txDate = row.ColData[0]?.value || '';
        const txType = row.ColData[1]?.value || '';
        const amount = parseFloat(row.ColData[4]?.value || '0');
        if (txDate === date && /payroll|salary|wage/i.test(txType + ' ' + (row.ColData[3]?.value || ''))) {
          totalForDate += Math.abs(amount);
          found = true;
        }
      }
    }
  }

  walkRows(glData.Rows.Row);
  return { found, amount: totalForDate };
}

function lastDay(year, month) {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { verifyPayroll };
