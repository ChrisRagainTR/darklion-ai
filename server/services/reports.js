const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

// Analyze P&L variance for a given period
async function analyzeVariance(realmId, period, thresholdPct = 15, thresholdAmt = 500) {
  // Parse period (e.g., "2026-02") into date ranges
  const [year, month] = period.split('-').map(Number);

  const currentStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const currentEnd = lastDayOfMonth(year, month);

  // Prior month
  const priorMonth = month === 1 ? 12 : month - 1;
  const priorYear = month === 1 ? year - 1 : year;
  const priorStart = `${priorYear}-${String(priorMonth).padStart(2, '0')}-01`;
  const priorEnd = lastDayOfMonth(priorYear, priorMonth);

  // Same month last year
  const pyStart = `${year - 1}-${String(month).padStart(2, '0')}-01`;
  const pyEnd = lastDayOfMonth(year - 1, month);

  // Fetch all three P&L reports
  const [currentPnl, priorPnl, pyPnl] = await Promise.all([
    fetchPnl(realmId, currentStart, currentEnd),
    fetchPnl(realmId, priorStart, priorEnd),
    fetchPnl(realmId, pyStart, pyEnd),
  ]);

  // Parse line items from each report
  const currentItems = parsePnlRows(currentPnl);
  const priorItems = parsePnlRows(priorPnl);
  const pyItems = parsePnlRows(pyPnl);

  // Compute month-over-month variances
  const momVariances = computeVariances(currentItems, priorItems, thresholdPct, thresholdAmt);

  // Compute year-over-year variances
  const yoyVariances = computeVariances(currentItems, pyItems, thresholdPct, thresholdAmt);

  // Summary totals
  const totalRevenue = sumBySection(currentItems, 'Income');
  const totalExpenses = sumBySection(currentItems, 'Expense');
  const priorRevenue = sumBySection(priorItems, 'Income');
  const priorExpenses = sumBySection(priorItems, 'Expense');

  const result = {
    period,
    thresholdPct,
    thresholdAmt,
    summary: {
      revenue: totalRevenue,
      expenses: totalExpenses,
      netIncome: totalRevenue - totalExpenses,
      priorRevenue,
      priorExpenses,
      priorNetIncome: priorRevenue - priorExpenses,
      revenueChangePct: priorRevenue ? ((totalRevenue - priorRevenue) / priorRevenue * 100).toFixed(1) : null,
      expenseChangePct: priorExpenses ? ((totalExpenses - priorExpenses) / priorExpenses * 100).toFixed(1) : null,
      flaggedCount: momVariances.length,
    },
    monthOverMonth: momVariances,
    yearOverYear: yoyVariances,
  };

  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'variance', $2, $3, $4)
  `, [realmId, period, JSON.stringify(result), momVariances.length]);

  return result;
}

async function fetchPnl(realmId, startDate, endDate) {
  try {
    const data = await qbFetch(realmId,
      `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&minorversion=75`
    );
    return data;
  } catch (e) {
    return null;
  }
}

// Parse QBO P&L report rows into { name, amount, section } items
function parsePnlRows(report) {
  if (!report) return [];
  const items = [];
  const rows = report.Rows?.Row || [];

  for (const section of rows) {
    const sectionHeader = section.Header?.ColData?.[0]?.value || section.group || '';
    const sectionType = sectionHeader.toLowerCase().includes('income') ? 'Income' : 'Expense';

    if (section.Rows?.Row) {
      for (const row of section.Rows.Row) {
        if (row.ColData) {
          const name = row.ColData[0]?.value || '';
          const amount = parseFloat(row.ColData[1]?.value || '0');
          if (name && name !== '') {
            items.push({ name, amount, section: sectionType });
          }
        }
        // Handle sub-sections
        if (row.Rows?.Row) {
          for (const subRow of row.Rows.Row) {
            if (subRow.ColData) {
              const name = subRow.ColData[0]?.value || '';
              const amount = parseFloat(subRow.ColData[1]?.value || '0');
              if (name && name !== '') {
                items.push({ name, amount, section: sectionType });
              }
            }
          }
        }
      }
    }

    // Summary row
    if (section.Summary?.ColData) {
      const name = section.Summary.ColData[0]?.value || '';
      const amount = parseFloat(section.Summary.ColData[1]?.value || '0');
      if (name && !name.toLowerCase().includes('total')) {
        items.push({ name, amount, section: sectionType });
      }
    }
  }

  return items;
}

function computeVariances(currentItems, priorItems, thresholdPct, thresholdAmt) {
  const priorMap = {};
  for (const item of priorItems) {
    priorMap[item.name] = item;
  }

  const variances = [];
  for (const curr of currentItems) {
    const prior = priorMap[curr.name];
    const priorAmt = prior ? prior.amount : 0;
    const changeAmt = curr.amount - priorAmt;
    const changePct = priorAmt !== 0 ? (changeAmt / Math.abs(priorAmt)) * 100 : (curr.amount !== 0 ? 100 : 0);

    if (Math.abs(changePct) >= thresholdPct || Math.abs(changeAmt) >= thresholdAmt) {
      variances.push({
        name: curr.name,
        section: curr.section,
        current: curr.amount,
        prior: priorAmt,
        changeAmt: Number(changeAmt.toFixed(2)),
        changePct: Number(changePct.toFixed(1)),
        direction: changeAmt > 0 ? 'up' : 'down',
      });
    }
  }

  // Check for items in prior but not in current
  for (const prior of priorItems) {
    if (!currentItems.find(c => c.name === prior.name) && Math.abs(prior.amount) >= thresholdAmt) {
      variances.push({
        name: prior.name,
        section: prior.section,
        current: 0,
        prior: prior.amount,
        changeAmt: Number((-prior.amount).toFixed(2)),
        changePct: -100,
        direction: 'down',
      });
    }
  }

  // Sort by absolute change amount descending
  variances.sort((a, b) => Math.abs(b.changeAmt) - Math.abs(a.changeAmt));

  return variances;
}

function sumBySection(items, section) {
  return items
    .filter(i => i.section === section)
    .reduce((sum, i) => sum + i.amount, 0);
}

function lastDayOfMonth(year, month) {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Generate a monthly close package
async function generateClosePackage(realmId, period) {
  const [year, month] = period.split('-').map(Number);
  const startDate = `${year}-01-01`;
  const endDate = lastDayOfMonth(year, month);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;

  // Fetch reports in parallel
  const [pnlData, bsData, tbData] = await Promise.all([
    qbFetch(realmId, `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Month&minorversion=75`).catch(() => null),
    qbFetch(realmId, `/reports/BalanceSheet?start_date=${monthStart}&end_date=${endDate}&minorversion=75`).catch(() => null),
    qbFetch(realmId, `/reports/TrialBalance?start_date=${monthStart}&end_date=${endDate}&minorversion=75`).catch(() => null),
  ]);

  // Get latest scan results
  const { rows: scans } = await pool.query(`
    SELECT scan_type, result_data, flag_count, scanned_at
    FROM scan_results
    WHERE realm_id = $1
    AND scanned_at > NOW() - INTERVAL '30 days'
    ORDER BY scanned_at DESC
  `, [realmId]);

  // Dedupe to latest per type
  const latestScans = {};
  for (const s of scans) {
    if (!latestScans[s.scan_type]) {
      latestScans[s.scan_type] = s;
    }
  }

  const reportData = {
    period,
    generatedAt: new Date().toISOString(),
    pnl: pnlData,
    balanceSheet: bsData,
    trialBalance: tbData,
    scans: latestScans,
    checklist: [
      { item: 'P&L by Month', status: pnlData ? 'ok' : 'missing' },
      { item: 'Balance Sheet', status: bsData ? 'ok' : 'missing' },
      { item: 'Trial Balance', status: tbData ? 'ok' : 'missing' },
      {
        item: 'Uncategorized Scan',
        status: latestScans.uncategorized ? (latestScans.uncategorized.flag_count > 0 ? 'warning' : 'ok') : 'not_run',
        flagCount: latestScans.uncategorized?.flag_count || 0,
      },
      {
        item: 'CoA Changes',
        status: latestScans.coa_changes ? (latestScans.coa_changes.flag_count > 0 ? 'warning' : 'ok') : 'not_run',
        flagCount: latestScans.coa_changes?.flag_count || 0,
      },
    ],
  };

  const { rows: [pkg] } = await pool.query(`
    INSERT INTO close_packages (realm_id, period, report_data)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [realmId, period, JSON.stringify(reportData)]);

  return pkg;
}

module.exports = { analyzeVariance, generateClosePackage };
