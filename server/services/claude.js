const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');

const client = new Anthropic();

// Model selection: Haiku for simple tasks, Sonnet for complex reasoning
const MODEL_FAST = 'claude-haiku-4-5-20251001';   // cheap — vendor lookups, simple classification
const MODEL_SMART = 'claude-sonnet-4-20250514';    // accurate — batch categorization with context

// Categorize a batch of transactions using Claude
async function categorizeTransactions(realmId, chartOfAccounts) {
  const { rows: [job] } = await pool.query(
    "INSERT INTO jobs (realm_id, job_type) VALUES ($1, 'categorize') RETURNING id",
    [realmId]
  );
  const jobId = job.id;

  try {
    // Get pending transactions
    const { rows: transactions } = await pool.query(
      "SELECT * FROM transactions WHERE realm_id = $1 AND status = 'pending' ORDER BY date DESC LIMIT 50",
      [realmId]
    );

    if (transactions.length === 0) {
      await pool.query("UPDATE jobs SET status = 'completed', completed_at = NOW() WHERE id = $1", [jobId]);
      return { categorized: 0 };
    }

    await pool.query('UPDATE jobs SET items_total = $1 WHERE id = $2', [transactions.length, jobId]);

    // Build account list for context
    const accountList = chartOfAccounts
      .filter(a => a.AccountType === 'Expense' || a.AccountType === 'Other Expense' || a.AccountType === 'Cost of Goods Sold' || a.AccountType === 'Income' || a.AccountType === 'Other Income')
      .map(a => `- ${a.FullyQualifiedName || a.Name} (${a.AccountType})`)
      .join('\n');

    // Get known vendor info for context
    const { rows: vendors } = await pool.query(
      'SELECT * FROM vendors WHERE realm_id = $1 AND business_category IS NOT NULL', [realmId]
    );
    const vendorContext = vendors.length > 0
      ? '\nKnown vendors:\n' + vendors.map(v => `- ${v.vendor_name}: ${v.business_category} — ${v.description || ''}`).join('\n')
      : '';

    // Get learned category rules (user corrections)
    const { rows: rules } = await pool.query(
      'SELECT vendor_name, category FROM category_rules WHERE realm_id = $1', [realmId]
    );
    const rulesContext = rules.length > 0
      ? '\nIMPORTANT - User-confirmed category rules (always use these exact categories for these vendors):\n' + rules.map(r => `- "${r.vendor_name}" → "${r.category}"`).join('\n')
      : '';

    // Build transaction list
    const txnList = transactions.map((t, i) =>
      `${i + 1}. Date: ${t.date} | Amount: $${t.amount} | Vendor: "${t.vendor_name}" | Description: "${t.description}" | Current Account: "${t.original_account}"`
    ).join('\n');

    const response = await client.messages.create({
      model: MODEL_SMART,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are a bookkeeper categorizing transactions for a QuickBooks Online company.

Chart of Accounts:
${accountList}
${vendorContext}
${rulesContext}

Transactions to categorize:
${txnList}

For each transaction, respond with a JSON array where each element has:
- "index": the transaction number (1-based)
- "category": the exact account name from the chart of accounts above
- "confidence": 0.0-1.0 how confident you are
- "memo": a brief note explaining why (1 sentence max)

If the current account already looks correct, use it and set confidence to 0.95.
If you're unsure, pick the best match but set confidence below 0.6.

Respond ONLY with the JSON array, no other text.`,
      }],
    });

    // Parse Claude's response
    const text = response.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Could not parse Claude response');

    const results = JSON.parse(jsonMatch[0]);

    let processed = 0;
    for (const r of results) {
      const txn = transactions[r.index - 1];
      if (txn) {
        await pool.query(
          "UPDATE transactions SET ai_category = $1, ai_confidence = $2, ai_memo = $3, status = 'categorized', updated_at = NOW() WHERE id = $4",
          [r.category, r.confidence, r.memo, txn.id]
        );
        processed++;
      }
    }

    await pool.query(
      "UPDATE jobs SET status = 'completed', items_processed = $1, completed_at = NOW() WHERE id = $2",
      [processed, jobId]
    );

    return { categorized: processed };
  } catch (err) {
    await pool.query(
      "UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err.message, jobId]
    );
    throw err;
  }
}

// Research a vendor using Claude
async function researchVendor(realmId, vendorName) {
  const response = await client.messages.create({
    model: MODEL_FAST,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `I need to categorize bookkeeping transactions for a vendor named "${vendorName}".

Please research this vendor and provide:
1. What type of business is this? (e.g., "Office Supplies", "Software/SaaS", "Restaurant", "Fuel/Gas Station")
2. A one-sentence description of what they sell/provide
3. Typical expense category for bookkeeping (e.g., "Office Supplies", "Meals & Entertainment", "Software Subscriptions")

Respond as JSON: {"business_category": "...", "description": "...", "typical_category": "..."}
Respond ONLY with the JSON, no other text.`,
    }],
  });

  const text = response.content[0]?.text || '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse vendor research');

  const info = JSON.parse(jsonMatch[0]);

  await pool.query(`
    INSERT INTO vendors (realm_id, vendor_name, business_category, description, researched_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT(realm_id, vendor_name) DO UPDATE SET
      business_category = EXCLUDED.business_category,
      description = EXCLUDED.description,
      researched_at = NOW()
  `, [realmId, vendorName, info.business_category || '', info.description || '']);

  return info;
}

// Research all unknown vendors for a company
async function researchAllVendors(realmId) {
  const { rows: [job] } = await pool.query(
    "INSERT INTO jobs (realm_id, job_type) VALUES ($1, 'vendor_research') RETURNING id",
    [realmId]
  );
  const jobId = job.id;

  try {
    // Find vendors in transactions that we haven't researched
    const { rows: unknownVendors } = await pool.query(`
      SELECT DISTINCT t.vendor_name
      FROM transactions t
      LEFT JOIN vendors v ON v.realm_id = t.realm_id AND v.vendor_name = t.vendor_name
      WHERE t.realm_id = $1 AND t.vendor_name != '' AND v.id IS NULL
      LIMIT 20
    `, [realmId]);

    await pool.query('UPDATE jobs SET items_total = $1 WHERE id = $2', [unknownVendors.length, jobId]);

    let processed = 0;
    for (const { vendor_name } of unknownVendors) {
      try {
        await researchVendor(realmId, vendor_name);
        processed++;
        await pool.query('UPDATE jobs SET items_processed = $1 WHERE id = $2', [processed, jobId]);
      } catch (e) {
        console.error(`Failed to research vendor "${vendor_name}":`, e.message);
      }
    }

    await pool.query(
      "UPDATE jobs SET status = 'completed', items_processed = $1, completed_at = NOW() WHERE id = $2",
      [processed, jobId]
    );

    return { researched: processed };
  } catch (err) {
    await pool.query(
      "UPDATE jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err.message, jobId]
    );
    throw err;
  }
}

module.exports = { categorizeTransactions, researchVendor, researchAllVendors };
