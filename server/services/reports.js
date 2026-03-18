const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

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

  // Get latest uncategorized scan
  const { rows: scans } = await pool.query(`
    SELECT scan_type, result_data, flag_count, scanned_at
    FROM scan_results
    WHERE realm_id = $1 AND scan_type = 'uncategorized'
    AND scanned_at > NOW() - INTERVAL '30 days'
    ORDER BY scanned_at DESC
    LIMIT 1
  `, [realmId]);

  const latestUncatScan = scans[0] || null;

  const reportData = {
    period,
    generatedAt: new Date().toISOString(),
    pnl: pnlData,
    balanceSheet: bsData,
    trialBalance: tbData,
    checklist: [
      { item: 'P&L by Month', status: pnlData ? 'ok' : 'missing' },
      { item: 'Balance Sheet', status: bsData ? 'ok' : 'missing' },
      { item: 'Trial Balance', status: tbData ? 'ok' : 'missing' },
      {
        item: 'Uncategorized Scan',
        status: latestUncatScan ? (latestUncatScan.flag_count > 0 ? 'warning' : 'ok') : 'not_run',
        flagCount: latestUncatScan?.flag_count || 0,
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

module.exports = { generateClosePackage };
