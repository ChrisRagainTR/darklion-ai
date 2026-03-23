'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { generateDailySummary } = require('../services/summaryGenerator');

// GET /api/summaries?month=2026-03 - calendar data for a month
// Returns array of { date, viewed, thread_count }
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM

  try {
    const { rows } = await pool.query(`
      SELECT
        cs.summary_date::text as date,
        cs.summary_json->>'thread_count' as thread_count,
        EXISTS(SELECT 1 FROM summary_views sv WHERE sv.firm_id=$1 AND sv.summary_date=cs.summary_date AND sv.firm_user_id=$2) as viewed
      FROM conversation_summaries cs
      WHERE cs.firm_id = $1
        AND TO_CHAR(cs.summary_date, 'YYYY-MM') = $3
        AND (cs.summary_json->>'thread_count')::int > 0
      ORDER BY cs.summary_date DESC
    `, [firmId, userId, month]);

    res.json(rows);
  } catch(err) {
    console.error('[GET /summaries] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/summaries/generate - manually trigger for a date (owner only)
router.post('/generate', async (req, res) => {
  if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const firmId = req.firm.id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);

  try {
    const result = await generateDailySummary(firmId, date);
    res.json({ ok: true, result });
  } catch(err) {
    console.error('[POST /summaries/generate] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summaries/:date - full summary for a specific date
// Also marks as viewed for this user
router.get('/:date', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const date = req.params.date; // YYYY-MM-DD

  try {
    const { rows } = await pool.query(
      'SELECT * FROM conversation_summaries WHERE firm_id=$1 AND summary_date=$2',
      [firmId, date]
    );

    if (!rows.length) return res.status(404).json({ error: 'No summary for this date' });

    // Mark as viewed
    await pool.query(`
      INSERT INTO summary_views (firm_id, summary_date, firm_user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (firm_id, summary_date, firm_user_id) DO NOTHING
    `, [firmId, date, userId]);

    // Filter out the logged-in user's own threads from the response —
    // "I can see everyone else's summaries, but my own threads are in My Inbox"
    const row = rows[0];
    if (row.summary_json && row.summary_json.by_staff && userId) {
      const filtered = {
        ...row.summary_json,
        by_staff: row.summary_json.by_staff.filter(s => s.staff_user_id !== userId),
      };
      // Recompute thread_count to reflect filtered view
      filtered.thread_count = filtered.by_staff.reduce((sum, s) => sum + (s.threads ? s.threads.length : 0), 0);
      return res.json({ ...row, summary_json: filtered });
    }

    res.json(row);
  } catch(err) {
    console.error('[GET /summaries/:date] error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
