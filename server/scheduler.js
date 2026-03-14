const cron = require('node-cron');
const db = require('./db');
const { syncTransactions, getChartOfAccounts } = require('./services/quickbooks');
const { categorizeTransactions, researchAllVendors } = require('./services/claude');

function startScheduler() {
  // Run every 6 hours: sync, research vendors, categorize
  cron.schedule('0 */6 * * *', async () => {
    console.log(`[${new Date().toISOString()}] Scheduled job starting...`);

    const companies = db.prepare('SELECT realm_id, company_name FROM companies').all();

    for (const company of companies) {
      const { realm_id, company_name } = company;
      console.log(`  Processing: ${company_name || realm_id}`);

      try {
        // Step 1: Sync transactions from QuickBooks
        const syncResult = await syncTransactions(realm_id);
        console.log(`    Synced ${syncResult.synced} transactions`);

        // Step 2: Research unknown vendors
        const vendorResult = await researchAllVendors(realm_id);
        console.log(`    Researched ${vendorResult.researched} vendors`);

        // Step 3: Categorize pending transactions
        const coa = await getChartOfAccounts(realm_id);
        const catResult = await categorizeTransactions(realm_id, coa);
        console.log(`    Categorized ${catResult.categorized} transactions`);
      } catch (err) {
        console.error(`    Error processing ${company_name || realm_id}:`, err.message);
      }
    }

    console.log(`[${new Date().toISOString()}] Scheduled job complete.`);
  });

  console.log('Scheduler started — runs every 6 hours');
}

module.exports = { startScheduler };
