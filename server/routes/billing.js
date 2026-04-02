'use strict';

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// Initialize Stripe clients (read-only restricted keys)
function getStripeClient(account) {
  const Stripe = require('stripe');
  const keys = {
    sentinel_tax: process.env.STRIPE_KEY_SENTINEL_TAX,
    sentinel_pcs: process.env.STRIPE_KEY_SENTINEL_PCS,
  };
  const key = keys[account];
  if (!key) return null;
  return Stripe(key, { apiVersion: '2024-12-18.acacia' });
}

// Ensure billing config columns exist
async function ensureBillingCols() {
  await pool.query(`
    ALTER TABLE relationships
    ADD COLUMN IF NOT EXISTS billing_accounts TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS billing_emails TEXT[] DEFAULT '{}'
  `);
}

// GET /:relId/config — get billing config for this relationship
router.get('/:relId/config', async (req, res) => {
  const firmId = req.firm.id;
  const { relId } = req.params;
  try {
    await ensureBillingCols();
    const { rows } = await pool.query(
      'SELECT billing_accounts, billing_emails FROM relationships WHERE id = $1 AND firm_id = $2',
      [relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({
      billing_accounts: rows[0].billing_accounts || [],
      billing_emails: rows[0].billing_emails || [],
    });
  } catch (err) {
    console.error('GET /billing/:relId/config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /:relId/config — update billing config
router.put('/:relId/config', async (req, res) => {
  const firmId = req.firm.id;
  const { relId } = req.params;
  const { billing_accounts = [], billing_emails = [] } = req.body;
  try {
    await ensureBillingCols();
    const { rows } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    // Validate accounts
    const validAccounts = ['sentinel_tax', 'sentinel_pcs'];
    const accounts = billing_accounts.filter(a => validAccounts.includes(a));
    // Normalize emails
    const emails = billing_emails.map(e => e.trim()).filter(Boolean);

    await pool.query(
      'UPDATE relationships SET billing_accounts = $1, billing_emails = $2 WHERE id = $3',
      [accounts, emails, relId]
    );
    res.json({ billing_accounts: accounts, billing_emails: emails });
  } catch (err) {
    console.error('PUT /billing/:relId/config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:relId/summary — fetch live Stripe data for all configured emails+accounts
router.get('/:relId/summary', async (req, res) => {
  const firmId = req.firm.id;
  const { relId } = req.params;
  try {
    await ensureBillingCols();
    const { rows } = await pool.query(
      'SELECT billing_accounts, billing_emails FROM relationships WHERE id = $1 AND firm_id = $2',
      [relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { billing_accounts = [], billing_emails = [] } = rows[0];

    if (!billing_accounts.length || !billing_emails.length) {
      return res.json({ configured: false, accounts: [] });
    }

    const ACCOUNT_LABELS = {
      sentinel_tax: 'Sentinel Tax',
      sentinel_pcs: 'Sentinel Private Client Services',
    };

    const results = [];

    for (const account of billing_accounts) {
      const stripe = getStripeClient(account);
      if (!stripe) {
        results.push({ account, label: ACCOUNT_LABELS[account] || account, error: 'Stripe key not configured', customers: [] });
        continue;
      }

      const customers = [];

      for (const email of billing_emails) {
        try {
          // Search customers by email
          const custList = await stripe.customers.list({ email, limit: 5 });
          for (const cust of custList.data) {
            // Fetch active subscriptions
            const subList = await stripe.subscriptions.list({
              customer: cust.id,
              limit: 10,
              expand: ['data.items.data.price'],
            });

            // Fetch recent invoices
            const invList = await stripe.invoices.list({
              customer: cust.id,
              limit: 5,
            });

            const subscriptions = subList.data.map(sub => ({
              id: sub.id,
              status: sub.status,
              current_period_end: sub.current_period_end,
              cancel_at_period_end: sub.cancel_at_period_end,
              items: sub.items.data.map(item => ({
                description: item.price?.nickname || item.price?.product_name || item.price?.lookup_key || 'Subscription',
                amount: (item.price?.unit_amount || 0) / 100,
                currency: item.price?.currency || 'usd',
                interval: item.price?.recurring?.interval || 'month',
                quantity: item.quantity || 1,
              })),
              total_monthly: sub.items.data.reduce((sum, item) => {
                const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
                const interval = item.price?.recurring?.interval;
                return sum + (interval === 'year' ? amt / 12 : amt);
              }, 0),
            }));

            const invoices = invList.data.map(inv => ({
              id: inv.id,
              number: inv.number,
              amount_due: inv.amount_due / 100,
              amount_paid: inv.amount_paid / 100,
              status: inv.status,
              paid: inv.paid,
              created: inv.created,
              period_start: inv.period_start,
              period_end: inv.period_end,
              hosted_invoice_url: inv.hosted_invoice_url,
            }));

            customers.push({
              id: cust.id,
              name: cust.name || email,
              email: cust.email,
              subscriptions,
              invoices,
              total_monthly: subscriptions.reduce((s, sub) => s + sub.total_monthly, 0),
            });
          }
        } catch (stripeErr) {
          console.error(`Stripe error for ${account}/${email}:`, stripeErr.message);
          customers.push({ email, error: stripeErr.message });
        }
      }

      results.push({
        account,
        label: ACCOUNT_LABELS[account] || account,
        customers,
        total_monthly: customers.reduce((s, c) => s + (c.total_monthly || 0), 0),
      });
    }

    const total_mrr = results.reduce((s, a) => s + (a.total_monthly || 0), 0);
    const has_past_due = results.some(a =>
      a.customers.some(c => c.subscriptions?.some(s => s.status === 'past_due'))
    );

    console.log(`[billing] ${relId} summary: ${results.length} accounts, ${results.reduce((s,a)=>s+(a.customers?.length||0),0)} customers, MRR $${total_mrr.toFixed(2)}`);
    res.json({ configured: true, accounts: results, total_mrr, has_past_due });
  } catch (err) {
    console.error('GET /billing/:relId/summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /firm-mrr — aggregate MRR across all relationships for this firm
router.get('/firm-mrr', async (req, res) => {
  const firmId = req.firm.id;
  try {
    await ensureBillingCols();

    // Get all relationships that have billing configured
    const { rows: rels } = await pool.query(
      `SELECT billing_accounts, billing_emails FROM relationships
       WHERE firm_id=$1 AND billing_accounts IS NOT NULL AND billing_emails IS NOT NULL
         AND array_length(billing_accounts, 1) > 0 AND array_length(billing_emails, 1) > 0`,
      [firmId]
    );

    if (!rels.length) return res.json({ mrr: 0, past_due: false });

    // Collect all unique account+email pairs
    const pairs = new Map(); // account -> Set<email>
    for (const rel of rels) {
      for (const account of (rel.billing_accounts || [])) {
        if (!pairs.has(account)) pairs.set(account, new Set());
        for (const email of (rel.billing_emails || [])) {
          pairs.get(account).add(email);
        }
      }
    }

    let totalMrr = 0;
    let hasPastDue = false;

    for (const [account, emails] of pairs) {
      const stripe = getStripeClient(account);
      if (!stripe) continue;

      for (const email of emails) {
        try {
          const custList = await stripe.customers.list({ email, limit: 5 });
          for (const cust of custList.data) {
            const subList = await stripe.subscriptions.list({
              customer: cust.id,
              status: 'active',
              limit: 20,
              expand: ['data.items.data.price'],
            });
            for (const sub of subList.data) {
              if (sub.status === 'past_due') hasPastDue = true;
              for (const item of sub.items.data) {
                const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
                const interval = item.price?.recurring?.interval;
                totalMrr += interval === 'year' ? amt / 12 : amt;
              }
            }
          }
        } catch (e) {
          // Skip errors for individual customers — don't fail the whole request
          console.error(`[firm-mrr] Stripe error ${account}/${email}:`, e.message);
        }
      }
    }

    res.json({ mrr: Math.round(totalMrr * 100) / 100, past_due: hasPastDue });
  } catch (err) {
    console.error('GET /billing/firm-mrr error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
