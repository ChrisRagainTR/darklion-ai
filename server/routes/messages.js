'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { classifyMessage } = require('../services/claude');
const { sendPortalNotification } = require('../services/email');

const router = Router();

// Helper: apply classification results to a thread
async function applyClassification(threadId, firmId, personId, body) {
  try {
    const result = await classifyMessage({ body, personId, firmId });

    // Update category
    if (result.category) {
      await pool.query('UPDATE message_threads SET category = $1 WHERE id = $2', [result.category, threadId]);
    }

    // Insert company tags
    for (const c of (result.companies || [])) {
      await pool.query(
        `INSERT INTO thread_companies (thread_id, company_id, ai_confidence, added_by)
         VALUES ($1, $2, $3, 'ai')
         ON CONFLICT (thread_id, company_id) DO NOTHING`,
        [threadId, c.id, c.confidence]
      );
    }
  } catch (err) {
    console.error('[messages] classification error (non-fatal):', err.message);
  }
}

// ── GET /messages — firm inbox ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const all = req.query.all === 'true';

  try {
    const statusFilter = all ? "status IN ('open','waiting','resolved')" : "status IN ('open','waiting')";

    const { rows: threads } = await pool.query(
      `SELECT
         mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at,
         mt.person_id, mt.assigned_to,
         p.first_name, p.last_name, p.email,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       WHERE mt.firm_id = $1 AND mt.${statusFilter}
       ORDER BY mt.last_message_at DESC`,
      [firmId]
    );

    // Fetch company tags for each thread
    const threadIds = threads.map(t => t.id);
    let companyMap = {};
    if (threadIds.length > 0) {
      const { rows: tcRows } = await pool.query(
        `SELECT tc.thread_id, c.id AS company_id, c.company_name
         FROM thread_companies tc
         JOIN companies c ON c.id = tc.company_id
         WHERE tc.thread_id = ANY($1)`,
        [threadIds]
      );
      for (const row of tcRows) {
        if (!companyMap[row.thread_id]) companyMap[row.thread_id] = [];
        companyMap[row.thread_id].push({ id: row.company_id, name: row.company_name });
      }
    }

    const result = threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      person: {
        id: t.person_id,
        firstName: t.first_name,
        lastName: t.last_name,
        email: t.email,
      },
      companies: companyMap[t.id] || [],
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
      assignedTo: t.assigned_to,
    }));

    res.json(result);
  } catch (err) {
    console.error('[GET /messages] error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox' });
  }
});

// ── GET /messages/person/:personId ───────────────────────────────────────────
router.get('/person/:personId', async (req, res) => {
  const firmId = req.firm.id;
  const personId = parseInt(req.params.personId);

  try {
    const { rows: threads } = await pool.query(
      `SELECT
         mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at, mt.assigned_to,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count
       FROM message_threads mt
       WHERE mt.firm_id = $1 AND mt.person_id = $2
       ORDER BY mt.last_message_at DESC`,
      [firmId, personId]
    );

    const threadIds = threads.map(t => t.id);
    let companyMap = {};
    if (threadIds.length > 0) {
      const { rows: tcRows } = await pool.query(
        `SELECT tc.thread_id, c.id AS company_id, c.company_name
         FROM thread_companies tc
         JOIN companies c ON c.id = tc.company_id
         WHERE tc.thread_id = ANY($1)`,
        [threadIds]
      );
      for (const row of tcRows) {
        if (!companyMap[row.thread_id]) companyMap[row.thread_id] = [];
        companyMap[row.thread_id].push({ id: row.company_id, name: row.company_name });
      }
    }

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      companies: companyMap[t.id] || [],
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
      assignedTo: t.assigned_to,
    })));
  } catch (err) {
    console.error('[GET /messages/person/:personId] error:', err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ── GET /messages/company/:companyId ─────────────────────────────────────────
router.get('/company/:companyId', async (req, res) => {
  const firmId = req.firm.id;
  const companyId = parseInt(req.params.companyId);

  try {
    const { rows: threads } = await pool.query(
      `SELECT
         mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at,
         mt.person_id, mt.assigned_to,
         p.first_name, p.last_name, p.email,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       JOIN thread_companies tc ON tc.thread_id = mt.id
       WHERE mt.firm_id = $1 AND tc.company_id = $2
       ORDER BY mt.last_message_at DESC`,
      [firmId, companyId]
    );

    const threadIds = threads.map(t => t.id);
    let companyMap = {};
    if (threadIds.length > 0) {
      const { rows: tcRows } = await pool.query(
        `SELECT tc.thread_id, c.id AS company_id, c.company_name
         FROM thread_companies tc
         JOIN companies c ON c.id = tc.company_id
         WHERE tc.thread_id = ANY($1)`,
        [threadIds]
      );
      for (const row of tcRows) {
        if (!companyMap[row.thread_id]) companyMap[row.thread_id] = [];
        companyMap[row.thread_id].push({ id: row.company_id, name: row.company_name });
      }
    }

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      person: { id: t.person_id, firstName: t.first_name, lastName: t.last_name, email: t.email },
      companies: companyMap[t.id] || [],
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
      assignedTo: t.assigned_to,
    })));
  } catch (err) {
    console.error('[GET /messages/company/:companyId] error:', err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ── GET /messages/:threadId ───────────────────────────────────────────────────
router.get('/:threadId', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);

  try {
    // Fetch thread
    const { rows: threadRows } = await pool.query(
      `SELECT mt.*, p.first_name, p.last_name, p.email
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       WHERE mt.id = $1 AND mt.firm_id = $2`,
      [threadId, firmId]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    const thread = threadRows[0];

    // Fetch companies
    const { rows: companies } = await pool.query(
      `SELECT tc.company_id, tc.ai_confidence, tc.added_by, c.company_name
       FROM thread_companies tc
       JOIN companies c ON c.id = tc.company_id
       WHERE tc.thread_id = $1`,
      [threadId]
    );

    // Fetch messages with sender info
    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.thread_id, m.sender_type, m.sender_id, m.body,
              m.is_internal, m.created_at, m.read_at
       FROM messages m
       WHERE m.thread_id = $1
       ORDER BY m.created_at ASC`,
      [threadId]
    );

    // Mark client messages as read (staff is reading now)
    await pool.query(
      `UPDATE messages SET read_at = NOW()
       WHERE thread_id = $1 AND sender_type = 'client' AND read_at IS NULL`,
      [threadId]
    );

    // Fetch firm users for sender name lookup
    const { rows: firmUsers } = await pool.query(
      'SELECT id, name, display_name FROM firm_users WHERE firm_id = $1',
      [firmId]
    );
    const userMap = {};
    for (const u of firmUsers) {
      userMap[u.id] = u.display_name || u.name || 'Staff';
    }

    const messages = msgs.map(m => ({
      id: m.id,
      senderType: m.sender_type,
      senderId: m.sender_id,
      senderName: m.sender_type === 'staff' ? (userMap[m.sender_id] || 'Staff') :
                  m.sender_type === 'client' ? `${thread.first_name} ${thread.last_name}` : 'Agent',
      body: m.body,
      isInternal: m.is_internal,
      createdAt: m.created_at,
      readAt: m.read_at,
    }));

    res.json({
      id: thread.id,
      subject: thread.subject,
      status: thread.status,
      category: thread.category,
      assignedTo: thread.assigned_to,
      lastMessageAt: thread.last_message_at,
      createdAt: thread.created_at,
      person: {
        id: thread.person_id,
        firstName: thread.first_name,
        lastName: thread.last_name,
        email: thread.email,
      },
      companies,
      messages,
    });
  } catch (err) {
    console.error('[GET /messages/:threadId] error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// ── POST /messages — create thread + first message ───────────────────────────
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  // Fallback: for old JWTs (owner), userId may be null — look up by email
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1', [firmId, req.firm.email]);
      if (rows[0]) userId = rows[0].id;
    } catch(e) { /* silent */ }
  }
  const { person_id, subject, body, is_internal } = req.body;

  if (!person_id || !body || !body.trim()) {
    return res.status(400).json({ error: 'person_id and body are required' });
  }

  try {
    // Verify person belongs to this firm
    const { rows: personRows } = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [person_id, firmId]
    );
    if (!personRows[0]) return res.status(404).json({ error: 'Person not found' });

    // Create thread
    const { rows: threadRows } = await pool.query(
      `INSERT INTO message_threads (firm_id, person_id, subject, status, last_message_at)
       VALUES ($1, $2, $3, 'waiting', NOW())
       RETURNING id`,
      [firmId, person_id, subject || '']
    );
    const threadId = threadRows[0].id;

    // Create first message
    await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'staff', $2, $3, $4)`,
      [threadId, userId, body.trim(), is_internal ? true : false]
    );

    // Classify asynchronously (non-blocking)
    setImmediate(() => applyClassification(threadId, firmId, person_id, body.trim()));

    res.status(201).json({ ok: true, threadId });
  } catch (err) {
    console.error('[POST /messages] error:', err);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// ── POST /messages/:threadId/reply ───────────────────────────────────────────
router.post('/:threadId/reply', async (req, res) => {
  const firmId = req.firm.id;
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1', [firmId, req.firm.email]);
      if (rows[0]) userId = rows[0].id;
    } catch(e) { /* silent */ }
  }
  const threadId = parseInt(req.params.threadId);
  const { body, is_internal } = req.body;

  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });

  try {
    // Verify thread belongs to this firm
    const { rows: threadRows } = await pool.query(
      `SELECT mt.*, p.first_name, p.last_name, p.email, f.name AS firm_name
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       JOIN firms f ON f.id = mt.firm_id
       WHERE mt.id = $1 AND mt.firm_id = $2`,
      [threadId, firmId]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });
    const thread = threadRows[0];

    // Insert message
    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'staff', $2, $3, $4)
       RETURNING id, created_at`,
      [threadId, userId, body.trim(), is_internal ? true : false]
    );

    // Update thread status + last_message_at (only for non-internal)
    if (!is_internal) {
      await pool.query(
        `UPDATE message_threads SET status = 'waiting', last_message_at = NOW() WHERE id = $1`,
        [threadId]
      );

      // Send email notification to client (non-fatal)
      try {
        await sendPortalNotification({
          to: thread.email,
          name: `${thread.first_name} ${thread.last_name}`,
          firmName: thread.firm_name,
          message: 'You have a new message from your advisor. Log in to view it.',
          portalUrl: (process.env.APP_URL || 'https://darklion.ai') + '/portal',
        });
      } catch (emailErr) {
        console.error('[reply] email notification error (non-fatal):', emailErr.message);
      }
    }

    res.json({ ok: true, messageId: msgRows[0].id });
  } catch (err) {
    console.error('[POST /messages/:threadId/reply] error:', err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ── PUT /messages/:threadId/status ───────────────────────────────────────────
router.put('/:threadId/status', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { status } = req.body;

  if (!['open', 'waiting', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const { rowCount } = await pool.query(
      'UPDATE message_threads SET status = $1 WHERE id = $2 AND firm_id = $3',
      [status, threadId, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Thread not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/status] error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ── PUT /messages/:threadId/assign ───────────────────────────────────────────
router.put('/:threadId/assign', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { assigned_to } = req.body;

  try {
    const { rowCount } = await pool.query(
      'UPDATE message_threads SET assigned_to = $1 WHERE id = $2 AND firm_id = $3',
      [assigned_to || null, threadId, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Thread not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/assign] error:', err);
    res.status(500).json({ error: 'Failed to assign thread' });
  }
});

// ── POST /messages/:threadId/companies ───────────────────────────────────────
router.post('/:threadId/companies', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { company_id } = req.body;

  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  try {
    // Verify thread belongs to firm
    const { rows } = await pool.query(
      'SELECT id FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });

    await pool.query(
      `INSERT INTO thread_companies (thread_id, company_id, ai_confidence, added_by)
       VALUES ($1, $2, 1.0, 'staff')
       ON CONFLICT (thread_id, company_id) DO NOTHING`,
      [threadId, company_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /messages/:threadId/companies] error:', err);
    res.status(500).json({ error: 'Failed to add company tag' });
  }
});

// ── DELETE /messages/:threadId/companies/:companyId ──────────────────────────
router.delete('/:threadId/companies/:companyId', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const companyId = parseInt(req.params.companyId);

  try {
    const { rows } = await pool.query(
      'SELECT id FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });

    await pool.query(
      'DELETE FROM thread_companies WHERE thread_id = $1 AND company_id = $2',
      [threadId, companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /messages/:threadId/companies/:companyId] error:', err);
    res.status(500).json({ error: 'Failed to remove company tag' });
  }
});

// ── PUT /messages/:threadId/read ─────────────────────────────────────────────
router.put('/:threadId/read', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);

  try {
    const { rows } = await pool.query(
      'SELECT id FROM message_threads WHERE id = $1 AND firm_id = $2',
      [threadId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Thread not found' });

    await pool.query(
      `UPDATE messages SET read_at = NOW()
       WHERE thread_id = $1 AND sender_type = 'client' AND read_at IS NULL`,
      [threadId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/read] error:', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

module.exports = router;
