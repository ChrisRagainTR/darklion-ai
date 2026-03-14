const cron = require('node-cron');
const { Resend } = require('resend');
const { pool } = require('./db');
const { syncTransactions, getChartOfAccounts, writeBackTransaction } = require('./services/quickbooks');
const { categorizeTransactions, researchAllVendors } = require('./services/claude');

const CONFIDENCE_THRESHOLD = 0.80; // Auto-post above this

async function sendReviewEmail(realmId, lowConfTxns) {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) return;

  const { rows } = await pool.query('SELECT company_name FROM companies WHERE realm_id = $1', [realmId]);
  const companyName = rows[0]?.company_name || realmId;

  const txnRows = lowConfTxns.map(t =>
    `<tr>
      <td style="padding:8px;border-bottom:1px solid #2a3a4a;">${t.date}</td>
      <td style="padding:8px;border-bottom:1px solid #2a3a4a;">${t.vendor_name}</td>
      <td style="padding:8px;border-bottom:1px solid #2a3a4a;">$${Number(t.amount).toFixed(2)}</td>
      <td style="padding:8px;border-bottom:1px solid #2a3a4a;">${t.ai_category || 'Unknown'}</td>
      <td style="padding:8px;border-bottom:1px solid #2a3a4a;">${Math.round((t.ai_confidence || 0) * 100)}%</td>
      <td style="padding:8px;border-bottom:1px solid #2a3a4a;">${t.ai_memo || ''}</td>
    </tr>`
  ).join('');

  const dashboardUrl = process.env.APP_URL || 'https://darklion.ai';

  const html = `
    <div style="font-family:'Segoe UI',sans-serif;background:#0f1923;color:#e8edf2;padding:2rem;max-width:800px;">
      <h2 style="color:#c9a84c;margin-bottom:0.5rem;">DarkLion — Transactions Need Review</h2>
      <p style="color:#8fa3b8;margin-bottom:1.5rem;">${companyName} — ${lowConfTxns.length} transaction(s) need your attention</p>
      <table style="width:100%;border-collapse:collapse;color:#e8edf2;font-size:14px;">
        <thead>
          <tr style="color:#c9a84c;text-transform:uppercase;font-size:12px;">
            <th style="padding:8px;text-align:left;">Date</th>
            <th style="padding:8px;text-align:left;">Vendor</th>
            <th style="padding:8px;text-align:left;">Amount</th>
            <th style="padding:8px;text-align:left;">AI Suggestion</th>
            <th style="padding:8px;text-align:left;">Confidence</th>
            <th style="padding:8px;text-align:left;">Note</th>
          </tr>
        </thead>
        <tbody>${txnRows}</tbody>
      </table>
      <p style="margin-top:1.5rem;">
        <a href="${dashboardUrl}/dashboard" style="background:#c9a84c;color:#0f1923;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:700;">Review in Dashboard</a>
      </p>
      <p style="color:#8fa3b8;font-size:12px;margin-top:2rem;">DarkLion AI Bookkeeping — This is an automated notification</p>
    </div>
  `;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'DarkLion <darklion@sentineladvisors.co>',
      to: process.env.NOTIFY_EMAIL.split(',').map(e => e.trim()),
      subject: `DarkLion: ${lowConfTxns.length} transaction(s) need review — ${companyName}`,
      html,
    });
    console.log(`  Review email sent to ${process.env.NOTIFY_EMAIL}`);
  } catch (err) {
    console.error('  Failed to send email:', err.message);
  }
}

async function autoPostHighConfidence(realmId) {
  const { rows: highConf } = await pool.query(
    "SELECT * FROM transactions WHERE realm_id = $1 AND status = 'categorized' AND ai_confidence >= $2",
    [realmId, CONFIDENCE_THRESHOLD]
  );

  if (highConf.length === 0) return { posted: 0 };

  const { rows: rules } = await pool.query(
    'SELECT vendor_name, category FROM category_rules WHERE realm_id = $1', [realmId]
  );
  const ruleMap = Object.fromEntries(rules.map(r => [r.vendor_name, r.category]));

  let posted = 0;
  for (const txn of highConf) {
    const ruleCategory = ruleMap[txn.vendor_name];
    if (ruleCategory && ruleCategory !== txn.ai_category) {
      await pool.query(
        "UPDATE transactions SET ai_category = $1, status = 'reviewed', updated_at = NOW() WHERE id = $2",
        [ruleCategory, txn.id]
      );
    } else {
      await pool.query(
        "UPDATE transactions SET status = 'reviewed', updated_at = NOW() WHERE id = $1",
        [txn.id]
      );
    }

    try {
      const category = ruleCategory || txn.ai_category;
      await writeBackTransaction(realmId, txn.qb_id, category);
      posted++;
    } catch (e) {
      console.error(`    Failed to write back ${txn.qb_id}:`, e.message);
    }
  }

  return { posted };
}

// Full pipeline: sync → research → categorize → auto-post → email
async function runFullPipeline(realmId) {
  const results = { synced: 0, researched: 0, categorized: 0, posted: 0, needsReview: 0 };

  // Step 1: Sync transactions from QuickBooks
  const syncResult = await syncTransactions(realmId);
  results.synced = syncResult.synced;
  console.log(`    Synced ${results.synced} transactions`);

  // Step 2: Research unknown vendors
  const vendorResult = await researchAllVendors(realmId);
  results.researched = vendorResult.researched;
  console.log(`    Researched ${results.researched} vendors`);

  // Step 3: Categorize pending transactions
  const coa = await getChartOfAccounts(realmId);
  const catResult = await categorizeTransactions(realmId, coa);
  results.categorized = catResult.categorized;
  console.log(`    Categorized ${results.categorized} transactions`);

  // Step 4: Auto-post high-confidence transactions to QuickBooks
  const postResult = await autoPostHighConfidence(realmId);
  results.posted = postResult.posted;
  console.log(`    Auto-posted ${results.posted} high-confidence transactions`);

  // Step 5: Email low-confidence transactions for review
  const { rows: lowConf } = await pool.query(
    "SELECT * FROM transactions WHERE realm_id = $1 AND status = 'categorized' AND (ai_confidence < $2 OR ai_confidence IS NULL) ORDER BY date DESC",
    [realmId, CONFIDENCE_THRESHOLD]
  );
  results.needsReview = lowConf.length;
  if (lowConf.length > 0) {
    console.log(`    ${lowConf.length} transactions need review — sending email`);
    await sendReviewEmail(realmId, lowConf);
  } else {
    console.log(`    All transactions auto-posted — no review needed`);
  }

  return results;
}

function startScheduler() {
  // Run every 6 hours: full automated pipeline
  cron.schedule('0 */6 * * *', async () => {
    console.log(`[${new Date().toISOString()}] Overnight automation starting...`);

    const { rows: companies } = await pool.query('SELECT realm_id, company_name FROM companies');

    for (const company of companies) {
      const { realm_id, company_name } = company;
      console.log(`  Processing: ${company_name || realm_id}`);

      try {
        await runFullPipeline(realm_id);
      } catch (err) {
        console.error(`    Error processing ${company_name || realm_id}:`, err.message);
      }
    }

    console.log(`[${new Date().toISOString()}] Overnight automation complete.`);
  });

  console.log('Scheduler started — runs every 6 hours (sync → research → categorize → auto-post → email)');
}

module.exports = { startScheduler, runFullPipeline };
