const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

const GUSTO_HEADERS = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'X-Gusto-API-Version': '2025-11-15',
});

// Verify Gusto payroll against QBO P&L
async function verifyPayroll(realmId, options = {}) {
  const now = new Date();
  const year = options.year || now.getFullYear();
  const month = options.month || now.getMonth() + 1;

  // Gusto filters by pay period dates, not check dates.
  // Look back 1 month to catch payrolls with check dates in the target month.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const startDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
  const endDate = lastDay(year, month);
  const targetMonth = `${year}-${String(month).padStart(2, '0')}`;

  // Check if Gusto is connected
  const { rows: [company] } = await pool.query(
    'SELECT gusto_access_token, gusto_company_id FROM companies WHERE realm_id = $1',
    [realmId]
  );

  if (!company?.gusto_access_token) {
    return { error: 'Gusto not connected', connected: false };
  }

  const { getGustoAccessToken } = require('../routes/auth');
  const accessToken = await getGustoAccessToken(realmId);

  // Resolve company ID if missing
  let gustoCompanyId = company.gusto_company_id;
  if (!gustoCompanyId) {
    gustoCompanyId = await resolveGustoCompanyId(accessToken, realmId);
  }
  if (!gustoCompanyId) {
    return { error: 'Could not determine Gusto company ID', connected: true };
  }

  // 1. Fetch payroll details from Gusto
  const allPayrolls = await fetchGustoPayrolls(accessToken, gustoCompanyId, startDate, endDate);
  // Filter to only payrolls with check dates in the target month
  const payrolls = allPayrolls.filter(p => p.checkDate && p.checkDate.startsWith(targetMonth));

  // 2. Aggregate totals across all payrolls in the period
  let totalGrossPay = 0;
  let totalEmployerTaxes = 0;
  let totalEmployeeTaxes = 0;
  let totalNetPay = 0;
  let totalBenefits = 0;
  const employeeMap = {};

  for (const p of payrolls) {
    totalGrossPay += p.totals.grossPay;
    totalEmployerTaxes += p.totals.employerTaxes;
    totalEmployeeTaxes += p.totals.employeeTaxes;
    totalNetPay += p.totals.netPay;
    totalBenefits += p.totals.benefits;

    // Aggregate by employee
    for (const emp of p.employees) {
      const key = emp.employeeUuid;
      if (!employeeMap[key]) {
        employeeMap[key] = {
          name: `${emp.firstName} ${emp.lastName}`,
          employeeUuid: emp.employeeUuid,
          grossPay: 0,
          netPay: 0,
          hours: 0,
          flsaStatus: emp.flsaStatus,
        };
      }
      employeeMap[key].grossPay += emp.grossPay;
      employeeMap[key].netPay += emp.netPay;
      employeeMap[key].hours += emp.hours;
    }
  }

  // Load officer tags from DB
  const { rows: metaRows } = await pool.query(
    'SELECT employee_uuid, is_officer FROM employee_metadata WHERE realm_id = $1',
    [realmId]
  );
  const officerMap = Object.fromEntries(metaRows.map(r => [r.employee_uuid, r.is_officer]));

  const employees = Object.values(employeeMap).map(e => ({
    ...e,
    isOfficer: officerMap[e.employeeUuid] || false,
  })).sort((a, b) => b.grossPay - a.grossPay);

  // Compute officer vs non-officer wage totals
  let officerWages = 0;
  let salaryWages = 0;
  for (const e of employees) {
    if (e.isOfficer) officerWages += e.grossPay;
    else salaryWages += e.grossPay;
  }

  // 3. Fetch QBO P&L for comparison
  let qboPnl = null;
  let qboComparison = null;
  try {
    const qboStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const qboEnd = lastDay(year, month);
    qboPnl = await qbFetch(realmId,
      `/reports/ProfitAndLoss?start_date=${qboStart}&end_date=${qboEnd}&minorversion=75`
    );
    qboComparison = extractQboPayrollTotals(qboPnl);
  } catch (e) {
    console.error('QBO P&L fetch failed:', e.message);
  }

  // 4. Compare Gusto vs QBO
  const mismatches = [];
  if (qboComparison) {
    if (Math.abs(salaryWages - qboComparison.salaries) > 1) {
      mismatches.push({
        category: 'Salaries (Non-Officer)',
        gusto: salaryWages,
        qbo: qboComparison.salaries,
        diff: salaryWages - qboComparison.salaries,
      });
    }
    if (Math.abs(officerWages - qboComparison.officerComp) > 1) {
      mismatches.push({
        category: 'Officer Compensation',
        gusto: officerWages,
        qbo: qboComparison.officerComp,
        diff: officerWages - qboComparison.officerComp,
      });
    }
    if (Math.abs(totalEmployerTaxes - qboComparison.payrollTax) > 1) {
      mismatches.push({
        category: 'Payroll Taxes',
        gusto: totalEmployerTaxes,
        qbo: qboComparison.payrollTax,
        diff: totalEmployerTaxes - qboComparison.payrollTax,
      });
    }
  }

  const result = {
    period: `${year}-${String(month).padStart(2, '0')}`,
    connected: true,
    summary: {
      payrollCount: payrolls.length,
      totalGrossPay,
      officerWages,
      salaryWages,
      totalEmployerTaxes,
      totalEmployeeTaxes,
      totalNetPay,
      totalBenefits,
      employeeCount: employees.length,
      mismatchCount: mismatches.length,
    },
    payrolls: payrolls.map(p => ({
      checkDate: p.checkDate,
      payPeriodStart: p.payPeriodStart,
      payPeriodEnd: p.payPeriodEnd,
      employeeCount: p.employees.length,
      grossPay: p.totals.grossPay,
      employerTaxes: p.totals.employerTaxes,
      employeeTaxes: p.totals.employeeTaxes,
      netPay: p.totals.netPay,
      benefits: p.totals.benefits,
    })),
    employees,
    qboComparison,
    mismatches,
    gustoPortalUrl: 'https://app.gusto.com',
  };

  // Store scan result
  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'payroll', $2, $3, $4)
  `, [realmId, result.period, JSON.stringify(result), mismatches.length]);

  return result;
}

// Fetch payroll list + detail from Gusto
async function fetchGustoPayrolls(accessToken, companyId, startDate, endDate) {
  const baseUrl = process.env.GUSTO_API_URL || 'https://api.gusto-demo.com';
  const headers = GUSTO_HEADERS(accessToken);

  const listRes = await fetch(
    `${baseUrl}/v1/companies/${companyId}/payrolls?start_date=${startDate}&end_date=${endDate}&processed=true`,
    { headers }
  );

  if (!listRes.ok) {
    const body = await listRes.text();
    throw new Error(`Gusto API ${listRes.status}: ${body}`);
  }

  const payrollList = await listRes.json();
  const payrolls = [];

  for (const p of payrollList) {
    const uuid = p.payroll_uuid || p.uuid;
    try {
      const detailRes = await fetch(
        `${baseUrl}/v1/companies/${companyId}/payrolls/${uuid}`,
        { headers }
      );
      if (!detailRes.ok) {
        console.error(`Gusto payroll detail ${uuid} failed:`, detailRes.status);
        continue;
      }

      const d = await detailRes.json();
      const toNum = (v) => parseFloat(String(v || '0').replace(/,/g, '')) || 0;

      payrolls.push({
        checkDate: d.check_date,
        payPeriodStart: d.pay_period?.start_date,
        payPeriodEnd: d.pay_period?.end_date,
        totals: {
          grossPay: toNum(d.totals?.gross_pay),
          netPay: toNum(d.totals?.net_pay),
          employerTaxes: toNum(d.totals?.employer_taxes),
          employeeTaxes: toNum(d.totals?.employee_taxes),
          benefits: toNum(d.totals?.benefits),
          companyDebit: toNum(d.totals?.company_debit),
        },
        employees: (d.employee_compensations || []).filter(e => !e.excluded).map(e => {
          // Sum hours from hourly compensations
          const hours = (e.hourly_compensations || []).reduce((sum, h) => sum + parseFloat(h.hours || 0), 0);
          // Determine FLSA status from first hourly comp
          const flsaStatus = e.hourly_compensations?.[0]?.flsa_status || '';
          return {
            employeeUuid: e.employee_uuid,
            firstName: e.preferred_first_name || e.first_name,
            lastName: e.last_name,
            grossPay: toNum(e.gross_pay),
            netPay: toNum(e.net_pay),
            hours,
            flsaStatus,
          };
        }),
      });
    } catch (e) {
      console.error(`Failed to fetch payroll detail ${uuid}:`, e.message);
    }
  }

  return payrolls;
}

// Extract payroll-related totals from QBO P&L report
function extractQboPayrollTotals(pnl) {
  if (!pnl?.Rows?.Row) return null;

  let salaries = 0;
  let officerComp = 0;
  let payrollTax = 0;
  let payrollFees = 0;

  function walkRows(rows) {
    for (const row of rows) {
      if (row.Rows?.Row) walkRows(row.Rows.Row);
      if (row.ColData) {
        const name = (row.ColData[0]?.value || '').toLowerCase();
        const amount = parseFloat(row.ColData[1]?.value || '0');
        if (/salaries|wages/i.test(name) && !/officer/i.test(name)) {
          salaries += amount;
        } else if (/officer.*comp|officer.*salary/i.test(name)) {
          officerComp += amount;
        } else if (/payroll.*tax/i.test(name)) {
          payrollTax += amount;
        } else if (/payroll.*fee|payroll.*process|gusto.*fee/i.test(name)) {
          payrollFees += amount;
        }
      }
      // Also check Summary rows
      if (row.Summary?.ColData) {
        // Skip summary rows - we want line items only
      }
    }
  }

  walkRows(pnl.Rows.Row);
  return { salaries, officerComp, payrollTax, payrollFees };
}

// Resolve Gusto company ID from /v1/companies
async function resolveGustoCompanyId(accessToken, realmId) {
  const baseUrl = process.env.GUSTO_API_URL || 'https://api.gusto-demo.com';
  try {
    const res = await fetch(`${baseUrl}/v1/companies`, { headers: GUSTO_HEADERS(accessToken) });
    if (res.ok) {
      const data = await res.json();
      const comps = Array.isArray(data) ? data : [];
      if (comps.length > 0) {
        const id = comps[0].uuid || '';
        if (id) {
          await pool.query('UPDATE companies SET gusto_company_id = $1 WHERE realm_id = $2', [id, realmId]);
        }
        return id;
      }
    }
  } catch (e) {
    console.error('Failed to resolve Gusto company ID:', e.message);
  }
  return '';
}

function lastDay(year, month) {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { verifyPayroll };
