'use strict';
const express = require('express');
const router = express.Router();

const STRIPE_ACCOUNTS = [
  { key: process.env.STRIPE_KEY_SENTINEL_TAX, label: 'Sentinel Tax' },
  { key: process.env.STRIPE_KEY_SENTINEL_PCS, label: 'Sentinel PCS' },
].filter(a => a.key);

function getStripe(key) {
  return require('stripe')(key, { apiVersion: '2024-12-18.acacia' });
}

// GET /api/forecast?year=2026
router.get('/', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();

  try {
    // Collect all customers + subscriptions + invoices from both accounts (in parallel)
    const allCustomers = [];

    await Promise.all(STRIPE_ACCOUNTS.map(async (acct) => {
      const stripe = getStripe(acct.key);

      // Page through all active subscriptions
      let subs = [];
      let starting_after = undefined;
      while (true) {
        const params = { status: 'active', limit: 100, expand: ['data.items.data.price', 'data.customer'] };
        if (starting_after) params.starting_after = starting_after;
        const page = await stripe.subscriptions.list(params);
        subs.push(...page.data);
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }

      // Also get past_due subscriptions
      let pastDueSubs = [];
      starting_after = undefined;
      while (true) {
        const params = { status: 'past_due', limit: 100, expand: ['data.items.data.price', 'data.customer'] };
        if (starting_after) params.starting_after = starting_after;
        const page = await stripe.subscriptions.list(params);
        pastDueSubs.push(...page.data);
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }

      const allSubs = [...subs, ...pastDueSubs];

      // Group by customer
      const custMap = {};
      for (const sub of allSubs) {
        const cust = sub.customer;
        const custId = typeof cust === 'string' ? cust : cust.id;
        const email = (typeof cust === 'object' ? cust.email : null) || '';
        const name = (typeof cust === 'object' ? cust.name : null) || email;

        if (!custMap[custId]) {
          custMap[custId] = { custId, email, name, account: acct.label, subscriptions: [], monthlyAmount: 0 };
        }

        // Calculate monthly amount
        let monthly = 0;
        const lineItems = sub.items.data.map(item => {
          const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
          const interval = item.price?.recurring?.interval;
          const monthly_equiv = interval === 'year' ? amt / 12 : amt;
          monthly += monthly_equiv;
          return {
            description: item.price?.nickname || item.price?.lookup_key || 'Subscription',
            amount: amt,
            interval: interval || 'month',
            monthly_equiv,
          };
        });

        custMap[custId].subscriptions.push({
          id: sub.id,
          status: sub.status,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end,
          billing_cycle_anchor: sub.billing_cycle_anchor,
          items: lineItems,
          monthly,
        });
        custMap[custId].monthlyAmount += monthly;
      }

      // Fetch invoices for all customers in parallel (10 at a time to avoid rate limits)
      const yearStart = Math.floor(new Date(year, 0, 1).getTime() / 1000);
      const yearEnd = Math.floor(new Date(year + 1, 0, 1).getTime() / 1000);
      const custEntries = Object.entries(custMap);

      // Batch into groups of 10 for parallel fetching
      for (let i = 0; i < custEntries.length; i += 10) {
        const batch = custEntries.slice(i, i + 10);
        await Promise.all(batch.map(async ([custId, cust]) => {
          try {
            const invList = await stripe.invoices.list({
              customer: custId,
              created: { gte: yearStart, lt: yearEnd },
              limit: 24,
            });
            cust.invoices = invList.data.map(inv => ({
              id: inv.id,
              // Use amount_paid if collected, otherwise amount_due (covers ACH delay, net terms)
              amount: inv.paid ? (inv.amount_paid || inv.amount_due) / 100 : inv.amount_due / 100,
              status: inv.status,
              paid: inv.paid,
              period_start: inv.period_start,
              period_end: inv.period_end,
              due_date: inv.due_date,
              created: inv.created,
            }));
          } catch(e) {
            cust.invoices = [];
          }
        }));
      }

      for (const cust of Object.values(custMap)) {
        allCustomers.push(cust);
      }
    })); // end Promise.all accounts

    // Sort by monthly amount descending
    allCustomers.sort((a, b) => b.monthlyAmount - a.monthlyAmount);

    // Build monthly grid for the requested year
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    const customers = allCustomers.map(cust => {
      const months = Array.from({ length: 12 }, (_, i) => {
        const monthStart = Math.floor(new Date(year, i, 1).getTime() / 1000);
        const monthEnd = Math.floor(new Date(year, i + 1, 1).getTime() / 1000);

        // Find invoice for this month — skip $0 invoices (prorations/credits/glitches)
        const inv = (cust.invoices || []).find(inv =>
          inv.amount > 0 && (
            (inv.period_start >= monthStart && inv.period_start < monthEnd) ||
            ((!inv.period_start) && inv.created >= monthStart && inv.created < monthEnd)
          )
        );

        let status, amount;
        if (inv) {
          status = inv.paid ? 'paid' : (inv.status === 'open' ? 'past_due' : inv.status);
          amount = inv.amount;
        } else if (year > currentYear || (year === currentYear && i > currentMonth)) {
          // Future month — use projected amount if subscription is active
          const hasActiveSub = cust.subscriptions.some(s => s.status === 'active' || s.status === 'past_due');
          status = hasActiveSub ? 'upcoming' : 'none';
          amount = hasActiveSub ? cust.monthlyAmount : 0;
        } else if (year < currentYear) {
          status = 'none';
          amount = 0;
        } else {
          // Past month this year with no invoice — could be annual billing or gap
          status = 'none';
          amount = 0;
        }

        return { status, amount: amount || 0 };
      });

      const collected = months.filter(m => m.status === 'paid').reduce((s, m) => s + m.amount, 0);
      const pastDue = months.filter(m => m.status === 'past_due').reduce((s, m) => s + m.amount, 0);
      const upcoming = months.filter(m => m.status === 'upcoming').reduce((s, m) => s + m.amount, 0);
      const annual = cust.monthlyAmount * 12;

      return {
        custId: cust.custId,
        email: cust.email,
        name: cust.name,
        account: cust.account,
        monthlyAmount: cust.monthlyAmount,
        annual,
        collected,
        pastDue,
        upcoming,
        months,
        subscriptions: cust.subscriptions,
      };
    }).filter(c => c.monthlyAmount > 0); // only customers with active subscriptions

    // Summary totals
    const totals = {
      annual: customers.reduce((s, c) => s + c.annual, 0),
      collected: customers.reduce((s, c) => s + c.collected, 0),
      pastDue: customers.reduce((s, c) => s + c.pastDue, 0),
      upcoming: customers.reduce((s, c) => s + c.upcoming, 0),
    };

    res.json({ year, customers, totals });
  } catch (err) {
    console.error('[GET /forecast] error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
