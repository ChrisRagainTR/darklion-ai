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
function scheduleClientNotification({ threadId, personId, toEmail, toName, firmName }) {
  if (!toEmail) return;

  // Clear any existing pending timer for this person (staff sent multiple messages quickly)
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

      // Cancel: client was active in portal in last 30 minutes
      if (portal_last_login_at && (now - new Date(portal_last_login_at).getTime()) < 30 * 60 * 1000) {
        console.log(`[notify] skipped — client ${personId} was active recently`);
        return;
      }

      // Cancel: client sent a message since we queued this notification (check thread activity)
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

      // Cancel: notified within last 2 hours
      if (last_notification_sent_at && (now - new Date(last_notification_sent_at).getTime()) < 2 * 60 * 60 * 1000) {
        console.log(`[notify] skipped — already notified ${personId} within 2 hours`);
        return;
      }

      // Send notification
      await sendPortalNotification({
        to: toEmail,
        name: toName,
        firmName,
        message: 'You have a new message from your advisor. Log in to view it.',
        portalUrl: APP_URL + '/portal',
      });

      // Update cooldown timestamp
      await pool.query(
        `UPDATE people SET last_notification_sent_at = NOW() WHERE id = $1`,
        [personId]
      );
      console.log(`[notify] sent to ${toEmail} (person ${personId})`);
    } catch (e) {
      console.error('[notify] error (non-fatal):', e.message);
    }
  }, 5 * 60 * 1000); // 5 minute delay

  _pendingNotifications.set(personId, timer);
}

// Helper: cancel pending notification when client sends (they're engaged)
function cancelPendingNotification(personId) {
  if (_pendingNotifications.has(personId)) {
    clearTimeout(_pendingNotifications.get(personId));
    _pendingNotifications.delete(personId);
    console.log(`[notify] cancelled for person ${personId} — client replied`);
  }
}

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
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count,
         EXISTS(SELECT 1 FROM messages m JOIN message_attachments ma ON ma.message_id = m.id WHERE m.thread_id = mt.id LIMIT 1) AS has_attachments,
         EXISTS(
           SELECT 1 FROM message_mentions mm
           JOIN messages m2 ON m2.id = mm.message_id
           WHERE m2.thread_id = mt.id AND mm.firm_user_id = $2
         ) AS has_mention
       FROM message_threads mt
       JOIN people p ON p.id = mt.person_id
       WHERE mt.firm_id = $1 AND mt.${statusFilter}
         AND NOT EXISTS (
           SELECT 1 FROM thread_dismissals td
           WHERE td.thread_id = mt.id AND td.firm_user_id = $2
         )
       ORDER BY mt.last_message_at DESC`,
      [firmId, req.firm.userId || 0]
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
      hasAttachments: t.has_attachments || false,
      hasMention: t.has_mention || false,
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

// ── GET /messages/attachments/:documentId/download ────────────────────────────
// NOTE: Must be registered BEFORE /:threadId to avoid being caught by the wildcard route
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

    // Fetch attachments for each message
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
      createdAt: m.created_at,
      readAt: m.read_at,
      attachments: attachmentMap[m.id] || [],
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

    // Pusher: notify staff of new thread
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
      [threadId, userId, body || '', is_internal]
    );
    const messageId = msgRows[0].id;

    // Extract @mentions and store
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
          await pool.query(
            `INSERT INTO message_mentions (message_id, firm_user_id, firm_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [messageId, mentioned[0].id, firmId]
          ).catch(() => {});
        }
      }
    }

    // Upload files and create document + attachment records
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

    // Update thread status + last_message_at (only for non-internal)
    if (!is_internal) {
      await pool.query(
        `UPDATE message_threads SET status = 'waiting', last_message_at = NOW() WHERE id = $1`,
        [threadId]
      );

      // Smart notification: delay 5 min, cancel if client responds or is online, 2hr cooldown
      scheduleClientNotification({
        threadId,
        personId: thread.person_id,
        toEmail: thread.email,
        toName: `${thread.first_name} ${thread.last_name}`,
        firmName: thread.firm_name,
      });
    }

    // Pusher: notify staff inbox and client portal
    const pusher = req.app.get('pusher');
    if (pusher && !is_internal) {
      pusher.trigger([`private-firm-${firmId}`, `private-portal-${firmId}-${thread.person_id}`], 'message-new', { threadId, senderType: 'staff' });
    } else if (pusher && is_internal) {
      pusher.trigger(`private-firm-${firmId}`, 'message-new', { threadId, senderType: 'staff' });
    }

    res.json({ ok: true, messageId });
  } catch (err) {
    console.error('[POST /messages/:threadId/reply] error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: err.message || 'Failed to send reply' });
  }
});

// ── PUT /messages/:threadId/status ───────────────────────────────────────────
router.put('/:threadId/status', async (req, res) => {
  const firmId = req.firm.id;
  const threadId = parseInt(req.params.threadId);
  const { status } = req.body;

  // Accept 'active' as alias for 'open' (UI simplified to Active/Resolved only)
  const normalizedStatus = status === 'active' ? 'open' : status;
  if (!['open', 'waiting', 'resolved'].includes(normalizedStatus)) {
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

// POST /:threadId/dismiss — personal dismiss (Resolve Me)
router.post('/:threadId/dismiss', async (req, res) => {
  try {
    const firmUserId = req.firm.userId;
    if (!firmUserId) return res.status(400).json({ error: 'No user ID' });
    await pool.query(
      `INSERT INTO thread_dismissals (thread_id, firm_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.threadId, firmUserId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:threadId/dismiss — undo personal dismiss
router.delete('/:threadId/dismiss', async (req, res) => {
  try {
    const firmUserId = req.firm.userId;
    await pool.query(
      `DELETE FROM thread_dismissals WHERE thread_id = $1 AND firm_user_id = $2`,
      [req.params.threadId, firmUserId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/sms — send an SMS to a person and log it as a message
router.post('/sms', async (req, res) => {
  const firmId = req.firm.id;
  const { person_id, body, thread_id } = req.body;

  if (!person_id || !body || !body.trim()) {
    return res.status(400).json({ error: 'person_id and body are required' });
  }

  try {
    // Get the person's phone number
    const { rows: people } = await pool.query(
      'SELECT id, first_name, last_name, phone FROM people WHERE id = $1 AND firm_id = $2',
      [parseInt(person_id), firmId]
    );
    if (!people[0]) return res.status(404).json({ error: 'Person not found' });
    const person = people[0];

    if (!person.phone) {
      return res.status(400).json({ error: 'This person has no phone number on file' });
    }

    // Clean phone number — strip non-digits, add +1 if needed
    let phone = person.phone.replace(/\D/g, '');
    if (phone.length === 10) phone = '1' + phone;
    if (!phone.startsWith('+')) phone = '+' + phone;

    // Send via Twilio
    const { sendSMS } = require('../services/twilio');
    const result = await sendSMS(phone, body.trim());

    // Log the SMS as a message in the thread (or create a thread if none)
    let useThreadId = thread_id ? parseInt(thread_id) : null;

    if (!useThreadId) {
      // Find existing open thread for this person, or create one
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

    // Insert message record with sms marker
    await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, created_at)
       VALUES ($1, 'staff', $2, $3, NOW())`,
      [useThreadId, req.firm.userId || null, `📱 SMS sent: ${body.trim()}`]
    );

    // Update thread last_message_at
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
