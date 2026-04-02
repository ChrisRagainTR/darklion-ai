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

// ── Daily Conversation Summaries at 10 PM Eastern ────────────────────────────
function scheduleAt10PM() {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  // Next 10 PM Eastern
  const next = new Date(eastern);
  next.setHours(22, 0, 0, 0);
  if (eastern >= next) next.setDate(next.getDate() + 1); // already past 10pm, schedule tomorrow

  const msUntil = next.getTime() - eastern.getTime();

  setTimeout(async () => {
    // Get all firm IDs
    try {
      const { generateDailySummary } = require('./services/summaryGenerator');
      const { rows: firms } = await pool.query('SELECT id FROM firms');
      const today = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }).split(',')[0];
      // Parse to YYYY-MM-DD
      const [m, d, y] = today.split('/');
      const dateStr = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;

      for (const firm of firms) {
        try {
          await generateDailySummary(firm.id, dateStr);
        } catch(e) {
          console.error(`[scheduler] Summary failed for firm ${firm.id}:`, e.message);
        }
      }
      console.log(`[scheduler] Daily summaries complete for ${dateStr}`);
    } catch(e) {
      console.error('[scheduler] Daily summary job error:', e.message);
    }

    // ── Archive pipeline jobs sitting in terminal stages ──────────────────
    try {
      const { rows: terminalJobs } = await pool.query(`
        SELECT pj.id, pj.entity_type, pj.entity_id, pj.instance_id, pj.current_stage_id,
               pi.firm_id, pi.name AS instance_name, pi.tax_year,
               pt.name AS template_name
        FROM pipeline_jobs pj
        JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
        JOIN pipeline_instances pi ON pi.id = pj.instance_id
        JOIN pipeline_templates pt ON pt.id = pi.template_id
        WHERE ps.is_terminal = true
          AND COALESCE(ps.hold_for_migration, false) = false
          AND pj.job_status NOT IN ('archived', 'complete')
      `);

      let archived = 0;
      for (const job of terminalJobs) {
        try {
          await pool.query(
            `UPDATE pipeline_jobs SET job_status = 'archived', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );
          const taxYearInt = job.tax_year ? parseInt(job.tax_year) : null;
          await pool.query(
            `INSERT INTO pipeline_completions
               (firm_id, entity_type, entity_id, pipeline_instance_id, pipeline_name, tax_year, job_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT DO NOTHING`,
            [job.firm_id, job.entity_type, job.entity_id, job.instance_id,
             job.instance_name || job.template_name, taxYearInt, job.id]
          );
          archived++;
        } catch(e) {
          console.error(`[scheduler] Archive job ${job.id} error:`, e.message);
        }
      }
      if (archived > 0) console.log(`[scheduler] Archived ${archived} pipeline jobs in terminal stages`);
    } catch(e) {
      console.error('[scheduler] Pipeline archival job error:', e.message);
    }

    // Schedule next run (tomorrow at 10 PM)
    scheduleAt10PM();
  }, msUntil);

  console.log(`[scheduler] Daily summary scheduled in ${Math.round(msUntil/1000/60)} minutes (10 PM Eastern)`);
}

// ── Blueleaf nightly sync — midnight UTC (8 PM ET) ───────────────────────────
function startBlueleafSync() {
  const blueleafService = require('./services/blueleaf');

  cron.schedule('0 0 * * *', async () => {
    try {
      const { rows: people } = await pool.query(
        `SELECT p.id, p.firm_id, p.blueleaf_household_id, f.blueleaf_api_token
         FROM people p
         JOIN firms f ON f.id = p.firm_id
         WHERE p.financial_planning_enabled = true
           AND p.blueleaf_household_id IS NOT NULL
           AND f.blueleaf_api_token IS NOT NULL
           AND f.blueleaf_api_token != ''`
      );
      for (const person of people) {
        try {
          await blueleafService.syncPerson(person.blueleaf_api_token, person.id, person.blueleaf_household_id, person.firm_id, pool);
        } catch (e) {
          console.error(`[blueleaf] Sync failed for person ${person.id}:`, e.message);
        }
      }
      console.log(`[blueleaf] Nightly sync complete: ${people.length} people synced`);
    } catch (e) {
      console.error('[blueleaf] Nightly sync error:', e.message);
    }
  });

  console.log('[blueleaf] Nightly sync scheduled (0 0 * * * UTC)');
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

// ── Nightly statement reminder — runs at 9 AM Eastern ───────────────────────
// For each client_upload account where today == statement_day,
// send a reminder email to all portal-enabled people on that company.
function startStatementReminders() {
  // Run daily at 9 AM Eastern (14:00 UTC)
  cron.schedule('0 14 * * *', async () => {
    try {
      const { sendStatementReminder } = require('./services/email');
      const now = new Date();
      const todayDay = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', day: 'numeric' }));
      // Current month-to-remind about = previous month (statements due this month are for last month)
      const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const remindMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

      // Find all client_upload accounts where statement_day matches today
      const { rows: schedules } = await pool.query(
        `SELECT ss.id, ss.realm_id, ss.account_name, ss.start_month, ss.statement_day,
                c.id AS company_id, c.company_name, c.firm_id,
                f.display_name AS firm_name
         FROM statement_schedules ss
         JOIN companies c ON c.realm_id = ss.realm_id
         JOIN firms f ON f.id = c.firm_id
         WHERE ss.access_method = 'client_upload'
           AND ss.statement_day = $1
           AND ss.start_month IS NOT NULL
           AND ss.start_month <> ''
           AND ss.start_month <= $2`,
        [todayDay, remindMonth]
      );

      let sent = 0;
      for (const sched of schedules) {
        // Skip if already uploaded for this month
        const { rows: existing } = await pool.query(
          `SELECT 1 FROM statement_monthly_status
           WHERE schedule_id = $1 AND month = $2 AND status IN ('uploaded','received')`,
          [sched.id, remindMonth]
        );
        if (existing.length) continue;

        // Find portal-enabled people with access to this company
        const { rows: people } = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.email, p.portal_invite_token
           FROM people p
           JOIN person_company_access pca ON pca.person_id = p.id
           WHERE pca.company_id = $1
             AND p.portal_enabled = true
             AND p.email IS NOT NULL
             AND p.email <> ''`,
          [sched.company_id]
        );

        const portalBase = process.env.PORTAL_URL || process.env.APP_URL || 'https://darklion.ai';
        const portalUrl = `${portalBase}/portal?tab=co-${sched.company_id}&subtab=statements`;

        // Fetch firm logo once per schedule
        let logoUrl = null;
        try {
          const { getFirmLogoUrl } = require('./services/email');
          logoUrl = await getFirmLogoUrl(sched.firm_id);
        } catch(e) { /* non-fatal */ }

        for (const person of people) {
          try {
            await sendStatementReminder({
              to: person.email,
              name: [person.first_name, person.last_name].filter(Boolean).join(' '),
              firmName: sched.firm_name,
              firmId: sched.firm_id,
              logoUrl,
              companyName: sched.company_name,
              accountName: sched.account_name,
              month: remindMonth,
              portalUrl,
            });
            sent++;
          } catch(e) {
            console.error(`[statements] Reminder email failed for person ${person.id}:`, e.message);
          }
        }
      }

      if (sent > 0) console.log(`[statements] Sent ${sent} statement reminder email(s) for ${remindMonth}`);
    } catch(e) {
      console.error('[statements] Reminder job error:', e.message);
    }
  });

  console.log('[statements] Nightly reminder cron scheduled (9 AM Eastern daily)');
}

// ── Weekly MRR sync — Sunday 3 AM UTC ────────────────────────────────────────
function startWeeklyMRRSync() {
  cron.schedule('0 3 * * 0', async () => {
    console.log('[mrr-sync] Starting weekly MRR sync...');
    try {
      const { syncAllMRR } = require('./routes/billing');
      const { rows: firms } = await pool.query('SELECT id FROM firms');
      for (const firm of firms) {
        await syncAllMRR(firm.id).catch(e =>
          console.error(`[mrr-sync] firm ${firm.id}:`, e.message)
        );
      }
      console.log('[mrr-sync] Weekly MRR sync complete.');
    } catch(e) {
      console.error('[mrr-sync] Weekly sync error:', e.message);
    }
  });
  console.log('[mrr-sync] Weekly MRR sync scheduled (Sunday 3 AM UTC)');
}

module.exports = { startScheduler, runFullPipeline, scheduleAt10PM, startBlueleafSync, startStatementReminders, startWeeklyMRRSync };
