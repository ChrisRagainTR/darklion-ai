'use strict';

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { classifyMessage } = require('../services/claude');
const { sendPortalNotification } = require('../services/email');
const { uploadFile, buildKey, sanitizeFilename, getSignedDownloadUrl } = require('../services/s3');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 8 },
});

const APP_URL = (process.env.APP_URL || 'https://darklion.ai').replace(/\/+$/, '');

// Track pending notification timers keyed by personId
const _pendingNotifications = new Map();

/**
 * Smart notification scheduler:
 * - Waits 5 minutes before sending
 * - Cancels if client sends a message during that window (they're engaged)
 * - Cancels if client was active in portal in last 30 minutes
 * - Enforces 2-hour cooldown between notifications to same person
 */
function scheduleClientNotification({ threadId, personId, toEmail, toName, firmName, messagePreview }) {
  if (!toEmail) return;

  if (_pendingNotifications.has(personId)) {
    clearTimeout(_pendingNotifications.get(personId));
  }

  const timer = setTimeout(async () => {
    _pendingNotifications.delete(personId);
    try {
      const { rows } = await pool.query(
        `SELECT portal_last_login_at, last_notification_sent_at FROM people WHERE id = $1`,
        [personId]
      );
      if (!rows[0]) return;
      const { portal_last_login_at, last_notification_sent_at } = rows[0];
      const now = Date.now();

      if (portal_last_login_at && (now - new Date(portal_last_login_at).getTime()) < 30 * 60 * 1000) {
        console.log(`[notify] skipped — client ${personId} was active recently`);
        return;
      }

      const { rows: recentMsgs } = await pool.query(
        `SELECT 1 FROM messages m
         JOIN message_threads mt ON mt.id = m.thread_id
         WHERE mt.person_id = $1 AND m.sender_type = 'client'
         AND m.created_at > NOW() - INTERVAL '5 minutes'
         LIMIT 1`,
        [personId]
      );
      if (recentMsgs.length > 0) {
        console.log(`[notify] skipped — client ${personId} replied in last 5 min`);
        return;
      }

      if (last_notification_sent_at && (now - new Date(last_notification_sent_at).getTime()) < 2 * 60 * 60 * 1000) {
        console.log(`[notify] skipped — already notified ${personId} within 2 hours`);
        return;
      }

      // Build message preview — show first 300 chars, truncate cleanly
      const preview = messagePreview
        ? (messagePreview.length > 300 ? messagePreview.slice(0, 297).trimEnd() + '…' : messagePreview)
        : 'You have a new message from your advisor.';

      await sendPortalNotification({
        to: toEmail,
        name: toName,
        firmName,
        message: preview,
        portalUrl: APP_URL + '/portal',
      });

      await pool.query(
        `UPDATE people SET last_notification_sent_at = NOW() WHERE id = $1`,
        [personId]
      );
      console.log(`[notify] sent to ${toEmail} (person ${personId})`);
    } catch (e) {
      console.error('[notify] error (non-fatal):', e.message);
    }
  }, 5 * 60 * 1000);

  _pendingNotifications.set(personId, timer);
}

function cancelPendingNotification(personId) {
  if (_pendingNotifications.has(personId)) {
    clearTimeout(_pendingNotifications.get(personId));
    _pendingNotifications.delete(personId);
    console.log(`[notify] cancelled for person ${personId} — client replied`);
  }
}

async function applyClassification(threadId, firmId, personId, body) {
  try {
    const result = await classifyMessage({ body, personId, firmId });
    if (result.category) {
      await pool.query('UPDATE message_threads SET category = $1 WHERE id = $2', [result.category, threadId]);
    }
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

// ── GET /messages/staff-list — active staff for the firm (used by portal) ────
router.get('/staff-list', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(display_name, name, email) as name, email, avatar_url
       FROM firm_users
       WHERE firm_id = $1 AND archived_at IS NULL
       ORDER BY name`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /messages/staff-list] error:', err);
    res.status(500).json({ error: 'Failed to fetch staff list' });
  }
});

// ── GET /messages/all — all firm threads (for conversation summaries, any staff) ──
router.get('/all', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows: threads } = await pool.query(
      `SELECT mt.*,
         p.first_name, p.last_name, p.email as person_email,
         fu.name as staff_name,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT created_at FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at_sub,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) as unread_count
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       WHERE mt.firm_id = $1 AND mt.status != 'archived'
       ORDER BY mt.last_message_at DESC NULLS LAST`,
      [firmId]
    );

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      staffUserId: t.staff_user_id,
      staffName: t.staff_name || null,
      person: {
        id: t.person_id,
        firstName: t.first_name,
        lastName: t.last_name,
        email: t.person_email,
      },
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
    })));
  } catch (err) {
    console.error('[GET /messages/all] error:', err);
    res.status(500).json({ error: 'Failed to fetch all threads' });
  }
});

// ── GET /messages — My Inbox (threads assigned to current staff user) ─────────
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1', [firmId, req.firm.email]);
      if (rows[0]) userId = rows[0].id;
    } catch(e) { /* silent */ }
  }

  try {
    const { rows: threads } = await pool.query(
      `SELECT mt.*,
         p.first_name, p.last_name, p.email as person_email,
         fu.name as staff_name,
         (mt.staff_user_id != $2) as is_participant,
         tp.added_by_id,
         adder.name as shared_by_name,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT message_type FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) as last_message_type,
         (SELECT created_at FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at_sub,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) as unread_count,
         (SELECT COUNT(*) > 0 FROM messages m WHERE m.thread_id = mt.id AND m.message_type = 'task' LIMIT 1) as has_task_messages
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       JOIN firm_users fu ON fu.id = mt.staff_user_id
       LEFT JOIN thread_participants tp ON tp.thread_id = mt.id AND tp.firm_user_id = $2 AND tp.archived_at IS NULL
       LEFT JOIN firm_users adder ON adder.id = tp.added_by_id
       WHERE mt.firm_id = $1
         AND mt.status != 'archived'
         AND (mt.staff_user_id = $2 OR tp.id IS NOT NULL)
       ORDER BY mt.last_message_at DESC NULLS LAST`,
      [firmId, userId]
    );

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      staffUserId: t.staff_user_id,
      staffName: t.staff_name,
      isParticipant: t.is_participant,
      sharedByName: t.shared_by_name || null,
      person: {
        id: t.person_id,
        firstName: t.first_name,
        lastName: t.last_name,
        email: t.person_email,
      },
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
      hasTaskMessages: t.has_task_messages === true || t.has_task_messages === 'true',
    })));
  } catch (err) {
    console.error('[GET /messages] error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox' });
  }
});

// ── POST /messages/person/:personId/summary — AI digest of last 30 days ──────
router.post('/person/:personId/summary', async (req, res) => {
  const firmId = req.firm.id;
  const personId = parseInt(req.params.personId);
  try {
    const { rows: personRows } = await pool.query(
      'SELECT first_name, last_name FROM people WHERE id = $1 AND firm_id = $2', [personId, firmId]
    );
    if (!personRows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = personRows[0];

    // Pull last 30 days of non-internal messages (both directions)
    const { rows: msgs } = await pool.query(`
      SELECT m.body, m.sender_type, m.created_at,
             CASE WHEN m.sender_type='staff' THEN COALESCE(fu.display_name, fu.name, 'Staff') ELSE $3 END AS sender_name
      FROM messages m
      JOIN message_threads mt ON mt.id = m.thread_id
      LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
      WHERE mt.person_id = $1 AND mt.firm_id = $2
        AND m.is_internal = false
        AND m.created_at > NOW() - INTERVAL '30 days'
        AND m.body IS NOT NULL AND m.body != ''
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [personId, firmId, `${person.first_name} ${person.last_name}`]);

    if (!msgs.length) return res.json({ summary: null, message: 'No messages in the last 30 days.' });

    const transcript = msgs.map(m =>
      `[${new Date(m.created_at).toLocaleDateString('en-US', {month:'short', day:'numeric'})} - ${m.sender_name}]: ${m.body.slice(0, 500)}`
    ).join('\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const claudeClient = new Anthropic();
    const response = await claudeClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are summarizing recent client communication for an advisor before a meeting or call.

Client: ${person.first_name} ${person.last_name}

Last 30 days of messages:
${transcript}

Write a concise, structured summary with these sections (only include sections that have content):
**Recent Topics** — key subjects discussed
**Action Items** — anything promised, requested, or outstanding  
**Documents** — any documents mentioned, sent, or requested
**Client Mood/Concerns** — any worries, questions, or tone worth noting

Be brief and actionable. No fluff.`
      }]
    });

    const summary = response.content[0]?.text || 'Unable to generate summary.';
    res.json({ summary, messageCount: msgs.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[POST /messages/person/:personId/summary] error:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ── GET /messages/person/:personId ───────────────────────────────────────────
router.get('/person/:personId', async (req, res) => {
  const firmId = req.firm.id;
  const personId = parseInt(req.params.personId);

  try {
    const { rows: threads } = await pool.query(
      `SELECT
         mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at,
         mt.staff_user_id,
         fu.name as staff_name,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count
       FROM message_threads mt
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       WHERE mt.firm_id = $1 AND mt.person_id = $2
       ORDER BY mt.last_message_at DESC`,
      [firmId, personId]
    );

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      staffUserId: t.staff_user_id,
      staffName: t.staff_name || null,
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
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
         mt.person_id, mt.staff_user_id,
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

    res.json(threads.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      category: t.category,
      lastMessageAt: t.last_message_at,
      createdAt: t.created_at,
      person: { id: t.person_id, firstName: t.first_name, lastName: t.last_name, email: t.email },
      staffUserId: t.staff_user_id,
      lastPreview: t.last_body ? t.last_body.slice(0, 80) : '',
      unreadCount: parseInt(t.unread_count, 10) || 0,
    })));
  } catch (err) {
    console.error('[GET /messages/company/:companyId] error:', err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ── GET /messages/attachments/:documentId/download ────────────────────────────
router.get('/attachments/:documentId/download', async (req, res) => {
  const firmId = req.firm.id;
  const documentId = parseInt(req.params.documentId);

  try {
    const { rows } = await pool.query(
      'SELECT id, s3_key, s3_bucket, firm_id FROM documents WHERE id = $1 AND firm_id = $2',
      [documentId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[GET /messages/attachments/:documentId/download] error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── DELETE /messages/message/:messageId ──────────────────────────────────────
// Staff can delete their own messages only — must be before /:threadId wildcard
router.delete('/message/:messageId', async (req, res) => {
  const firmId = req.firm.id;
  const staffId = req.firm.userId;
  const messageId = parseInt(req.params.messageId);

  try {
    const { rows } = await pool.query(
      `SELECT m.id FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       WHERE m.id = $1 AND m.sender_id = $2 AND m.sender_type = 'staff' AND mt.firm_id = $3`,
      [messageId, staffId, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Message not found or not yours' });

    await pool.query('DELETE FROM message_attachments WHERE message_id = $1', [messageId]);
    await pool.query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
    await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /messages/message/:messageId] error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ── GET /messages/:threadId ───────────────────────────────────────────────────
router.get('/:threadId', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);

  try {
    // Resolve caller's userId for participant check
    let callerUserId = req.firm.userId;
    if (!callerUserId) {
      try { const { rows: ur } = await pool.query('SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1', [firmId, req.firm.email]); if (ur[0]) callerUserId = ur[0].id; } catch(e) {}
    }
    const { rows: threadRows } = await pool.query(
      `SELECT mt.*, p.first_name, p.last_name, p.email,
              fu.name as staff_name, fu.display_name as staff_display_name,
              (mt.staff_user_id != $3) as is_participant_check,
              (SELECT COUNT(*) > 0 FROM messages m WHERE m.thread_id = mt.id AND m.message_type = 'task') as has_task_messages
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       LEFT JOIN firm_users fu ON fu.id = mt.staff_user_id
       WHERE mt.id = $1 AND mt.firm_id = $2`,
      [threadId, firmId, callerUserId || 0]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    const thread = threadRows[0];

    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.thread_id, m.sender_type, m.sender_id, m.body,
              m.is_internal, m.message_type, m.created_at, m.read_at
       FROM messages m
       WHERE m.thread_id = $1
       ORDER BY m.created_at ASC`,
      [threadId]
    );

    await pool.query(
      `UPDATE messages SET read_at = NOW()
       WHERE thread_id = $1 AND sender_type = 'client' AND read_at IS NULL`,
      [threadId]
    );

    await pool.query(
      `DELETE FROM message_mentions mm
       USING messages m
       WHERE mm.message_id = m.id AND m.thread_id = $1 AND mm.firm_user_id = $2`,
      [threadId, req.firm.userId]
    ).catch(() => {});

    const { rows: firmUsers } = await pool.query(
      'SELECT id, name, display_name FROM firm_users WHERE firm_id = $1',
      [firmId]
    );
    const userMap = {};
    for (const u of firmUsers) {
      userMap[u.id] = u.display_name || u.name || 'Staff';
    }

    const msgIds = msgs.map(m => m.id);
    const attachmentMap = {};
    if (msgIds.length > 0) {
      const { rows: attRows } = await pool.query(
        `SELECT ma.message_id, ma.id, d.display_name, d.mime_type, d.size_bytes, ma.document_id
         FROM message_attachments ma
         JOIN documents d ON d.id = ma.document_id
         WHERE ma.message_id = ANY($1)`,
        [msgIds]
      );
      for (const att of attRows) {
        if (!attachmentMap[att.message_id]) attachmentMap[att.message_id] = [];
        attachmentMap[att.message_id].push({
          id: att.id,
          documentId: att.document_id,
          displayName: att.display_name,
          mimeType: att.mime_type,
          sizeBytes: att.size_bytes,
        });
      }
    }

    const messages = msgs.map(m => ({
      id: m.id,
      senderType: m.sender_type,
      senderId: m.sender_id,
      senderName: m.sender_type === 'staff' ? (userMap[m.sender_id] || 'Staff') :
                  m.sender_type === 'client' ? `${thread.first_name} ${thread.last_name}` : 'Agent',
      body: m.body,
      isInternal: m.is_internal,
      messageType: m.message_type || 'message',
      createdAt: m.created_at,
      readAt: m.read_at,
      attachments: attachmentMap[m.id] || [],
    }));

    res.json({
      id: thread.id,
      subject: thread.subject,
      status: thread.status,
      category: thread.category,
      hasTaskMessages: thread.has_task_messages === true || thread.has_task_messages === 'true',
      staffUserId: thread.staff_user_id,
      isParticipant: thread.is_participant_check || false,
      staffName: thread.staff_display_name || thread.staff_name || null,
      lastMessageAt: thread.last_message_at,
      createdAt: thread.created_at,
      person: {
        id: thread.person_id,
        firstName: thread.first_name,
        lastName: thread.last_name,
        email: thread.email,
      },
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
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1', [firmId, req.firm.email]);
      if (rows[0]) userId = rows[0].id;
    } catch(e) { /* silent */ }
  }
  const { person_id, staff_user_id, subject, body, is_internal } = req.body;

  if (!person_id || !body || !body.trim()) {
    return res.status(400).json({ error: 'person_id and body are required' });
  }

  // staff_user_id required
  const staffId = parseInt(staff_user_id) || userId;
  if (!staffId) {
    return res.status(400).json({ error: 'staff_user_id is required' });
  }

  try {
    // Verify person belongs to this firm
    const { rows: personRows } = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [person_id, firmId]
    );
    if (!personRows[0]) return res.status(404).json({ error: 'Person not found' });

    // Validate staff_user_id belongs to this firm
    const { rows: staffRows } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [staffId, firmId]
    );
    if (!staffRows[0]) return res.status(404).json({ error: 'Staff user not found' });

    // Check if a non-archived thread already exists for this person + staff pair
    const { rows: existingRows } = await pool.query(
      `SELECT id FROM message_threads
       WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3 AND status != 'archived'
       LIMIT 1`,
      [person_id, staffId, firmId]
    );

    let threadId;
    if (existingRows.length > 0) {
      threadId = existingRows[0].id;
    } else {
      const { rows: threadRows } = await pool.query(
        `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, last_message_at)
         VALUES ($1, $2, $3, $4, 'open', NOW())
         RETURNING id`,
        [firmId, person_id, staffId, subject || '']
      );
      threadId = threadRows[0].id;
    }

    // Create message
    await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'staff', $2, $3, $4)`,
      [threadId, userId, body.trim(), is_internal ? true : false]
    );

    // Update last_message_at
    await pool.query(
      `UPDATE message_threads SET last_message_at = NOW() WHERE id = $1`,
      [threadId]
    );

    setImmediate(() => applyClassification(threadId, firmId, person_id, body.trim()));

    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(`private-firm-${firmId}`, 'thread-new', { threadId, personId: person_id });
    }

    res.status(201).json({ ok: true, threadId });
  } catch (err) {
    console.error('[POST /messages] error:', err);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// ── POST /messages/:threadId/reply ───────────────────────────────────────────
router.post('/:threadId/reply', upload.array('files', 8), async (req, res) => {
  const firmId = req.firm.id;
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 LIMIT 1', [firmId, req.firm.email]);
      if (rows[0]) userId = rows[0].id;
    } catch(e) { /* silent */ }
  }
  const threadId = parseInt(req.params.threadId);
  const body = (req.body.body || '').trim();
  const is_internal = req.body.is_internal === 'true';
  const files = req.files || [];

  if (!body && files.length === 0) {
    return res.status(400).json({ error: 'Message body or at least one file is required' });
  }

  try {
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

    // Authorization: internal notes can be posted by anyone in the firm;
    // external replies only by the thread's assigned staff_user_id
    if (!is_internal && thread.staff_user_id && thread.staff_user_id !== userId) {
      return res.status(403).json({ error: 'Only the assigned staff member can send external replies on this thread' });
    }

    // Any message containing @mentions is always internal — staff coordination never reaches the client
    const hasMentions = body && /@[A-Za-z]/.test(body);
    const effectiveInternal = is_internal || hasMentions;

    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'staff', $2, $3, $4)
       RETURNING id, created_at`,
      [threadId, userId, body || '', effectiveInternal]
    );
    const messageId = msgRows[0].id;

    if (body) {
      const mentionPattern = /@([A-Za-z]+(?: [A-Za-z]+)?)/g;
      let mentionMatch;
      while ((mentionMatch = mentionPattern.exec(body)) !== null) {
        const mentionedName = mentionMatch[1];
        const { rows: mentioned } = await pool.query(
          `SELECT id FROM firm_users WHERE firm_id=$1 AND (name ILIKE $2 OR display_name ILIKE $2) LIMIT 1`,
          [firmId, mentionedName]
        );
        if (mentioned.length) {
          const mentionedUserId = mentioned[0].id;
          await pool.query(
            `INSERT INTO message_mentions (message_id, firm_user_id, firm_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [messageId, mentionedUserId, firmId]
          ).catch(() => {});
          // Auto-share thread with mentioned staff member (skip if they're the owner)
          if (mentionedUserId !== thread.staff_user_id) {
            await pool.query(
              `INSERT INTO thread_participants (thread_id, firm_user_id, added_by_id, firm_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (thread_id, firm_user_id) DO UPDATE SET archived_at = NULL, added_by_id = $3, added_at = NOW()`,
              [threadId, mentionedUserId, userId, firmId]
            ).catch(() => {});
          }
        }
      }
    }

    if (files.length > 0) {
      const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
      const year = String(new Date().getFullYear());
      for (const f of files) {
        const key = buildKey({
          firmId,
          ownerType: 'person',
          ownerId: thread.person_id,
          year,
          docType: 'message_docs',
          filename: f.originalname,
        });
        await uploadFile({ buffer: f.buffer, key, mimeType: f.mimetype, bucket });
        const { rows: docRows } = await pool.query(
          `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type, size_bytes,
            s3_key, s3_bucket, year, folder_section, folder_category, uploaded_by_type, uploaded_by_id,
            is_delivered, created_at)
           VALUES ($1, 'person', $2, 'other', $3, $4, $5, $6, $7, $8, 'firm_uploaded', 'message_docs', 'staff', $9, true, NOW())
           RETURNING id`,
          [firmId, thread.person_id, f.originalname, f.mimetype, f.size, key, bucket, year, userId]
        );
        await pool.query(
          'INSERT INTO message_attachments (message_id, document_id) VALUES ($1, $2)',
          [messageId, docRows[0].id]
        );
      }
    }

    if (!effectiveInternal) {
      await pool.query(
        `UPDATE message_threads SET status = 'open', last_message_at = NOW() WHERE id = $1`,
        [threadId]
      );

      scheduleClientNotification({
        threadId,
        personId: thread.person_id,
        toEmail: thread.email,
        toName: `${thread.first_name} ${thread.last_name}`,
        firmName: thread.firm_name,
        messagePreview: body ? body.trim() : null,
      });
    }

    const pusher = req.app.get('pusher');
    if (pusher && !effectiveInternal) {
      pusher.trigger([`private-firm-${firmId}`, `private-portal-${firmId}-${thread.person_id}`], 'message-new', { threadId, senderType: 'staff' });
    } else if (pusher && effectiveInternal) {
      pusher.trigger(`private-firm-${firmId}`, 'message-new', { threadId, senderType: 'staff' });
    }

    res.json({ ok: true, messageId });
  } catch (err) {
    console.error('[POST /messages/:threadId/reply] error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: err.message || 'Failed to send reply' });
  }
});

// ── POST /messages/:threadId/share — add a participant (called on @mention) ──
router.post('/:threadId/share', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  let userId = req.firm.userId;
  if (!userId) {
    try { const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1', [firmId, req.firm.email]); if (rows[0]) userId = rows[0].id; } catch(e) {}
  }
  const { staff_user_id } = req.body;
  if (!staff_user_id) return res.status(400).json({ error: 'staff_user_id required' });

  try {
    // Verify thread belongs to this firm
    const { rows: threadRows } = await pool.query('SELECT id, staff_user_id FROM message_threads WHERE id=$1 AND firm_id=$2', [threadId, firmId]);
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });
    // Don't add the owner as a participant
    if (threadRows[0].staff_user_id === parseInt(staff_user_id)) return res.json({ ok: true, skipped: true });

    await pool.query(
      `INSERT INTO thread_participants (thread_id, firm_user_id, added_by_id, firm_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (thread_id, firm_user_id) DO UPDATE SET archived_at = NULL, added_by_id = $3, added_at = NOW()`,
      [threadId, staff_user_id, userId, firmId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /messages/:threadId/share] error:', err);
    res.status(500).json({ error: 'Failed to share thread' });
  }
});

// ── PUT /messages/:threadId/archive — archive a thread ───────────────────────
// Owners: archive the whole thread. Participants: remove themselves from thread.
router.put('/:threadId/archive', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  let userId = req.firm.userId;
  if (!userId) {
    try { const { rows } = await pool.query('SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1', [firmId, req.firm.email]); if (rows[0]) userId = rows[0].id; } catch(e) {}
  }

  try {
    const { rows: threadRows } = await pool.query('SELECT staff_user_id FROM message_threads WHERE id=$1 AND firm_id=$2', [threadId, firmId]);
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    if (threadRows[0].staff_user_id === userId) {
      // Owner: archive the whole thread
      await pool.query(`UPDATE message_threads SET status = 'archived' WHERE id = $1 AND firm_id = $2`, [threadId, firmId]);
    } else {
      // Participant: just remove themselves
      await pool.query(`UPDATE thread_participants SET archived_at = NOW() WHERE thread_id = $1 AND firm_user_id = $2`, [threadId, userId]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/archive] error:', err);
    res.status(500).json({ error: 'Failed to archive thread' });
  }
});

// ── PUT /messages/:threadId/status ───────────────────────────────────────────
router.put('/:threadId/status', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { status } = req.body;

  const normalizedStatus = status === 'active' ? 'open' : status;
  if (!['open', 'resolved', 'archived'].includes(normalizedStatus)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const { rowCount } = await pool.query(
      'UPDATE message_threads SET status = $1 WHERE id = $2 AND firm_id = $3',
      [normalizedStatus, threadId, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Thread not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /messages/:threadId/status] error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ── POST /messages/:threadId/companies ───────────────────────────────────────
router.post('/:threadId/companies', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { company_id } = req.body;

  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  try {
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

// ── DELETE /messages/message/:messageId ──────────────────────────────────────
// Staff can delete their own messages only
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

// ── POST /messages/sms ───────────────────────────────────────────────────────
router.post('/sms', async (req, res) => {
  const firmId = req.firm.id;
  const { person_id, body, thread_id } = req.body;

  if (!person_id || !body || !body.trim()) {
    return res.status(400).json({ error: 'person_id and body are required' });
  }

  try {
    const { rows: people } = await pool.query(
      'SELECT id, first_name, last_name, phone FROM people WHERE id = $1 AND firm_id = $2',
      [parseInt(person_id), firmId]
    );
    if (!people[0]) return res.status(404).json({ error: 'Person not found' });
    const person = people[0];

    if (!person.phone) {
      return res.status(400).json({ error: 'This person has no phone number on file' });
    }

    let phone = person.phone.replace(/\D/g, '');
    if (phone.length === 10) phone = '1' + phone;
    if (!phone.startsWith('+')) phone = '+' + phone;

    const { sendSMS } = require('../services/twilio');
    const result = await sendSMS(phone, body.trim());

    let useThreadId = thread_id ? parseInt(thread_id) : null;

    if (!useThreadId) {
      const { rows: threads } = await pool.query(
        `SELECT id FROM message_threads WHERE firm_id = $1 AND person_id = $2 AND status = 'open' ORDER BY last_message_at DESC LIMIT 1`,
        [firmId, person_id]
      );
      if (threads[0]) {
        useThreadId = threads[0].id;
      } else {
        const { rows: newThread } = await pool.query(
          `INSERT INTO message_threads (firm_id, person_id, subject, status, category, last_message_at)
           VALUES ($1, $2, $3, 'open', 'general', NOW()) RETURNING id`,
          [firmId, person_id, `Messages with ${person.first_name} ${person.last_name}`]
        );
        useThreadId = newThread[0].id;
      }
    }

    await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, created_at)
       VALUES ($1, 'staff', $2, $3, NOW())`,
      [useThreadId, req.firm.userId || null, `📱 SMS sent: ${body.trim()}`]
    );

    await pool.query(
      'UPDATE message_threads SET last_message_at = NOW() WHERE id = $1',
      [useThreadId]
    );

    res.json({ ok: true, sid: result.sid, status: result.status, thread_id: useThreadId });
  } catch (err) {
    console.error('[POST /api/messages/sms] error:', err);
    res.status(500).json({ error: err.message || 'Failed to send SMS' });
  }
});

module.exports = router;
module.exports.cancelPendingNotification = cancelPendingNotification;
