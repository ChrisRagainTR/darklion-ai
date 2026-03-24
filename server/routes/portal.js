'use strict';

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { getSignedDownloadUrl, uploadFile, downloadFile, buildKey, sanitizeFilename } = require('../services/s3');
const { embedSignature } = require('../services/sign-pdf');
const { classifyMessage } = require('../services/claude');
const { sendEmail, sendPortalNotification } = require('../services/email');
const { advancePipelineJob } = require('./tax-delivery');
// Lazy require to avoid circular dependency
function cancelPendingNotification(personId) {
  try { require('./messages').cancelPendingNotification(personId); } catch(e) { /* non-fatal */ }
}

const router = Router();

// ── Allowed file types ────────────────────────────────────────────────────────
const _ALLOWED_MIME = new Set([
  'application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/csv',
  'image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
  'application/zip','application/x-zip-compressed',
]);
const _ALLOWED_EXT = new Set([
  '.pdf','.doc','.docx','.xls','.xlsx','.txt','.csv',
  '.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.zip',
]);
function _fileFilter(req, file, cb) {
  const ext = require('path').extname(file.originalname || '').toLowerCase();
  if (!_ALLOWED_MIME.has(file.mimetype) || !_ALLOWED_EXT.has(ext)) {
    return cb(new Error(`File type not allowed: ${ext || file.mimetype}. Allowed: PDF, Word, Excel, images, CSV, ZIP.`));
  }
  cb(null, true);
}

// Multer: memory storage for client uploads (max 50 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: _fileFilter,
});

// --- GET /portal/me ---
router.get('/me', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, firm_id, relationship_id, first_name, last_name, email, phone,
              filing_status, portal_enabled, portal_last_login_at, created_at
       FROM people
       WHERE id = $1`,
      [req.portal.personId]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = rows[0];

    res.json({
      id: person.id,
      firmId: person.firm_id,
      relationshipId: person.relationship_id,
      firstName: person.first_name,
      lastName: person.last_name,
      email: person.email,
      phone: person.phone,
      filingStatus: person.filing_status,
      portalEnabled: person.portal_enabled,
      lastLogin: person.portal_last_login_at,
      createdAt: person.created_at,
    });
  } catch (err) {
    console.error('Portal /me error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// --- GET /portal/companies ---
router.get('/companies', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.company_name, c.entity_type,
              pca.access_level, pca.ownership_pct
       FROM person_company_access pca
       JOIN companies c ON c.id = pca.company_id
       WHERE pca.person_id = $1
       ORDER BY c.company_name ASC`,
      [req.portal.personId]
    );

    res.json(rows);
  } catch (err) {
    console.error('Portal /companies error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// --- GET /portal/documents ---
router.get('/documents', async (req, res) => {
  try {
    const personId = req.portal.personId;

    // Get accessible company IDs
    const { rows: accessRows } = await pool.query(
      'SELECT company_id FROM person_company_access WHERE person_id = $1',
      [personId]
    );
    const companyIds = accessRows.map(r => r.company_id);

    let documents = [];
    try {
      let query;
      let params;

      // Show: delivered docs from advisor (firm_uploaded/private) + ALL client-uploaded docs
      if (companyIds.length > 0) {
        query = `
          SELECT id, firm_id, owner_type, owner_id, doc_type,
                 display_name, mime_type, size_bytes, is_delivered,
                 delivered_at, viewed_at, year, folder_section, folder_category, created_at
          FROM documents
          WHERE (
            (is_delivered = true AND folder_section != 'client_uploaded')
            OR folder_section = 'client_uploaded'
          )
            AND (
              (owner_type = 'person' AND owner_id = $1)
              OR (owner_type = 'company' AND owner_id = ANY($2))
            )
          ORDER BY created_at DESC
        `;
        params = [personId, companyIds];
      } else {
        query = `
          SELECT id, firm_id, owner_type, owner_id, doc_type,
                 display_name, mime_type, size_bytes, is_delivered,
                 delivered_at, viewed_at, year, folder_section, folder_category, created_at
          FROM documents
          WHERE (
            (is_delivered = true AND folder_section != 'client_uploaded')
            OR folder_section = 'client_uploaded'
          )
            AND owner_type = 'person'
            AND owner_id = $1
          ORDER BY created_at DESC
        `;
        params = [personId];
      }

      const { rows: docs } = await pool.query(query, params);
      documents = docs;
    } catch (e) {
      if (e.code === '42P01') {
        documents = [];
      } else {
        throw e;
      }
    }

    res.json(documents);
  } catch (err) {
    console.error('Portal /documents error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// --- GET /portal/documents/:id/download ---
router.get('/documents/:id/download', async (req, res) => {
  const personId = req.portal.personId;
  const docId = parseInt(req.params.id);

  try {
    const { rows: docRows } = await pool.query(
      'SELECT id, owner_type, owner_id, s3_key, s3_bucket, is_delivered, viewed_at, display_name FROM documents WHERE id = $1 AND is_delivered = true',
      [docId]
    );
    if (!docRows[0]) return res.status(404).json({ error: 'Document not found' });

    const doc = docRows[0];

    // Verify access
    let hasAccess = false;

    if (doc.owner_type === 'person' && doc.owner_id === personId) {
      hasAccess = true;
    } else if (doc.owner_type === 'company') {
      const { rows: accessRows } = await pool.query(
        'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
        [personId, doc.owner_id]
      );
      hasAccess = accessRows.length > 0;
    }

    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    // Generate signed URL
    const url = await getSignedDownloadUrl({ key: doc.s3_key, bucket: doc.s3_bucket });

    // Mark viewed_at if first view + log it
    if (!doc.viewed_at) {
      await pool.query('UPDATE documents SET viewed_at = NOW() WHERE id = $1', [docId]);
      console.log('Client first-viewed document:', doc.display_name);
    }

    res.json({ url });
  } catch (err) {
    console.error('Portal /documents/:id/download error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate download URL' });
  }
});

// --- GET /portal/stanford-tax ---
router.get('/stanford-tax', async (req, res) => {
  const personId = req.portal.personId;

  try {
    // Personal URL
    let personal_url = null;
    try {
      const { rows } = await pool.query(
        'SELECT stanford_tax_url FROM people WHERE id = $1',
        [personId]
      );
      personal_url = rows[0]?.stanford_tax_url || null;
    } catch (e) {
      if (e.code !== '42703') throw e; // 42703 = undefined_column, ignore if col doesn't exist
    }

    // Company URLs
    let companies = [];
    try {
      const { rows } = await pool.query(
        `SELECT c.company_name, c.stanford_tax_url AS url
         FROM person_company_access pca
         JOIN companies c ON c.id = pca.company_id
         WHERE pca.person_id = $1
           AND c.stanford_tax_url IS NOT NULL
           AND c.stanford_tax_url != ''
         ORDER BY c.company_name ASC`,
        [personId]
      );
      companies = rows;
    } catch (e) {
      if (e.code !== '42703') throw e;
    }

    res.json({ personal_url, companies });
  } catch (err) {
    console.error('Portal /stanford-tax error:', err);
    res.status(500).json({ error: 'Failed to fetch organizer links' });
  }
});

// --- GET /portal/messages --- returns all firm staff with thread info (unread counts)
router.get('/messages', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';

  try {
    // Get all active staff for the firm (include pending invites — show all team members)
    const { rows: staffRows } = await pool.query(
      `SELECT id, COALESCE(display_name, name, email) as name, email, avatar_url, credentials
       FROM firm_users
       WHERE firm_id = $1 AND archived_at IS NULL
       ORDER BY name`,
      [firmId]
    );

    // Get threads for this person (one per staff member)
    const { rows: threadRows } = await pool.query(
      `SELECT mt.id, mt.staff_user_id, mt.status, mt.last_message_at,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id AND m.is_internal = false ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'staff' AND m.is_internal = false AND m.read_at IS NULL) as unread_count
       FROM message_threads mt
       WHERE mt.person_id = $1 AND mt.firm_id = $2 AND mt.status != 'archived'`,
      [personId, firmId]
    );

    // Build a map staffUserId -> thread
    const threadMap = {};
    for (const t of threadRows) {
      if (t.staff_user_id) threadMap[t.staff_user_id] = t;
    }

    // Sign avatar URLs and merge with thread data
    const result = await Promise.all(staffRows.map(async (s) => {
      let avatar_url = null;
      if (s.avatar_url) {
        try { avatar_url = await getSignedDownloadUrl({ key: s.avatar_url, bucket }); } catch(e) { /* non-fatal */ }
      }
      const thread = threadMap[s.id];
      return {
        id: s.id,
        name: s.name,
        email: s.email,
        avatar_url,
        credentials: s.credentials || '',
        threadId: thread ? thread.id : null,
        lastMessageAt: thread ? thread.last_message_at : null,
        lastPreview: thread && thread.last_body ? thread.last_body.slice(0, 80) : '',
        unreadCount: thread ? (parseInt(thread.unread_count, 10) || 0) : 0,
      };
    }));

    res.json(result);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('Portal /messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// --- GET /portal/team --- staff who have messaged this client, with signed avatar URLs
router.get('/team', async (req, res) => {
  const personId = req.portal.personId;
  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT fu.id, COALESCE(fu.display_name, fu.name, fu.email) AS name, fu.email, fu.avatar_url, fu.credentials
       FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       JOIN firm_users fu ON fu.id = m.sender_id
       WHERE mt.person_id = $1 AND m.sender_type = 'staff' AND m.is_internal = false`,
      [personId]
    );
    const result = await Promise.all(rows.map(async (member) => {
      let avatar_url = null;
      if (member.avatar_url) {
        try { avatar_url = await getSignedDownloadUrl({ key: member.avatar_url, bucket }); } catch(e) { /* non-fatal */ }
      }
      return { id: member.id, name: member.name, email: member.email, credentials: member.credentials || '', avatar_url };
    }));
    res.json(result);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('Portal /team error:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// --- GET /portal/firm-team --- up to 5 staff, priority: owner → messaged this client → others
router.get('/firm-team', async (req, res) => {
  const firmId = req.portal.firmId;
  const personId = req.portal.personId;
  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  try {
    // All active firm staff, left-joined with message counts for this client.
    // Owner(s) first (sort_order = 1), then everyone else sorted by message count desc.
    // Staff who've never messaged this client are still included (count = 0).
    const { rows: rawRows } = await pool.query(
      `SELECT fu.id,
              COALESCE(fu.display_name, fu.name, fu.email) AS name,
              fu.email, fu.avatar_url, fu.credentials, fu.role,
              COALESCE(msg_counts.msg_count, 0) AS sort_order,
              CASE WHEN fu.role = 'owner' THEN 0 ELSE 1 END AS role_order
       FROM firm_users fu
       LEFT JOIN (
         SELECT m.sender_id, COUNT(m.id) AS msg_count
         FROM messages m
         JOIN message_threads mt ON mt.id = m.thread_id
         WHERE mt.person_id = $2 AND m.sender_type = 'staff' AND m.is_internal = false
         GROUP BY m.sender_id
       ) msg_counts ON msg_counts.sender_id = fu.id
       WHERE fu.firm_id = $1
       ORDER BY role_order ASC, sort_order DESC
       LIMIT 5`,
      [firmId, personId]
    );
    const merged = rawRows;

    const result = await Promise.all(merged.map(async (member) => {
      let avatar_url = null;
      if (member.avatar_url) {
        try { avatar_url = await getSignedDownloadUrl({ key: member.avatar_url, bucket }); } catch(e) { /* non-fatal */ }
      }
      return { id: member.id, name: member.name, email: member.email, credentials: member.credentials || '', role: member.role, avatar_url };
    }));
    res.json(result);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('Portal /firm-team error:', err);
    res.status(500).json({ error: 'Failed to fetch firm team' });
  }
});

// --- GET /portal/messages/staff-contacts --- KEPT FOR BACKWARD COMPAT (redirects to /messages)
router.get('/messages/staff-contacts', async (req, res) => {
  // Redirect callers to the new /messages endpoint which returns staff list
  res.redirect(307, '/portal/messages');
});

// --- GET /portal/messages/thread/:staffUserId --- messages for the thread with this staff member
router.get('/messages/thread/:staffUserId', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const staffUserId = parseInt(req.params.staffUserId);

  try {
    // Find the thread for this person + staff pair
    const { rows: threadRows } = await pool.query(
      `SELECT id FROM message_threads
       WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3 AND status != 'archived'
       LIMIT 1`,
      [personId, staffUserId, firmId]
    );

    if (!threadRows[0]) {
      return res.json({ threadId: null, messages: [] });
    }

    const threadId = threadRows[0].id;

    // Fetch non-internal messages
    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.sender_type, m.sender_id, m.body, m.created_at, m.read_at,
              CASE WHEN m.sender_type = 'staff' THEN COALESCE(fu.display_name, fu.name, fu.email) ELSE NULL END AS sender_name
       FROM messages m
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE m.thread_id = $1 AND m.is_internal = false
       ORDER BY m.created_at ASC`,
      [threadId]
    );

    // Mark staff messages as read by client
    await pool.query(
      `UPDATE messages SET read_at = NOW()
       WHERE thread_id = $1 AND sender_type = 'staff' AND is_internal = false AND read_at IS NULL`,
      [threadId]
    );

    // Fetch attachments
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

    res.json({
      threadId,
      messages: msgs.map(m => ({ ...m, attachments: attachmentMap[m.id] || [] })),
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ threadId: null, messages: [] });
    console.error('Portal /messages/thread/:staffUserId error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// --- GET /portal/messages/:threadId --- full thread by threadId (legacy, kept for compat)
router.get('/messages/:threadId', async (req, res) => {
  const personId = req.portal.personId;
  const threadId = parseInt(req.params.threadId);

  try {
    const { rows: threadRows } = await pool.query(
      'SELECT id, subject, status, last_message_at, created_at FROM message_threads WHERE id = $1 AND person_id = $2',
      [threadId, personId]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.sender_type, m.sender_id, m.body, m.created_at, m.read_at,
              CASE WHEN m.sender_type = 'staff' THEN COALESCE(fu.display_name, fu.name, fu.email) ELSE NULL END AS sender_name
       FROM messages m
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE m.thread_id = $1 AND m.is_internal = false
       ORDER BY m.created_at ASC`,
      [threadId]
    );

    await pool.query(
      `UPDATE messages SET read_at = NOW()
       WHERE thread_id = $1 AND sender_type = 'staff' AND is_internal = false AND read_at IS NULL`,
      [threadId]
    );

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

    res.json({
      thread: threadRows[0],
      messages: msgs.map(m => ({ ...m, attachments: attachmentMap[m.id] || [] })),
    });
  } catch (err) {
    console.error('Portal /messages/:threadId error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// --- POST /portal/messages/send ---
router.post('/messages/send', upload.array('files', 8), async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const body = (req.body.body || '').trim();
  const files = req.files || [];
  const staffUserId = req.body.staff_user_id ? parseInt(req.body.staff_user_id) : null;

  if (!body && files.length === 0) {
    return res.status(400).json({ error: 'Message body or at least one file is required' });
  }

  if (!staffUserId) {
    return res.status(400).json({ error: 'staff_user_id is required' });
  }

  try {
    // Validate staff_user_id belongs to this firm
    const { rows: staffCheck } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [staffUserId, firmId]
    );
    if (!staffCheck[0]) return res.status(404).json({ error: 'Staff member not found' });

    // Find or create the permanent thread for this person + staff pair
    const { rows: existingRows } = await pool.query(
      `SELECT id FROM message_threads
       WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3 AND status != 'archived'
       LIMIT 1`,
      [personId, staffUserId, firmId]
    );

    let threadId;
    let isNewThread = false;

    if (existingRows.length > 0) {
      threadId = existingRows[0].id;
    } else {
      // Create new thread for this person + staff pair
      const { rows } = await pool.query(
        `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, last_message_at)
         VALUES ($1, $2, $3, $4, 'open', NOW())
         RETURNING id`,
        [firmId, personId, staffUserId, 'Client message']
      );
      threadId = rows[0].id;
      isNewThread = true;
    }

    // Insert message
    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'client', $2, $3, false)
       RETURNING id`,
      [threadId, personId, body || '']
    );
    const messageId = msgRows[0].id;

    // Upload files
    if (files.length > 0) {
      const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
      const year = String(new Date().getFullYear());
      for (const f of files) {
        const key = buildKey({
          firmId,
          ownerType: 'person',
          ownerId: personId,
          year,
          docType: 'message_docs',
          filename: f.originalname,
        });
        await uploadFile({ buffer: f.buffer, key, mimeType: f.mimetype, bucket });
        const { rows: docRows } = await pool.query(
          `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type, size_bytes,
            s3_key, s3_bucket, year, folder_section, folder_category, uploaded_by_type, uploaded_by_id,
            is_delivered, created_at)
           VALUES ($1, 'person', $2, 'other', $3, $4, $5, $6, $7, $8, 'client_uploaded', 'message_docs', 'client', $2, false, NOW())
           RETURNING id`,
          [firmId, personId, f.originalname, f.mimetype, f.size, key, bucket, year]
        );
        await pool.query(
          'INSERT INTO message_attachments (message_id, document_id) VALUES ($1, $2)',
          [messageId, docRows[0].id]
        );
      }
    }

    // Flip thread status to 'open' (client needs response)
    await pool.query(
      `UPDATE message_threads SET status = 'open', last_message_at = NOW() WHERE id = $1`,
      [threadId]
    );

    cancelPendingNotification(personId);

    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(`private-firm-${firmId}`, 'message-new', { threadId, senderType: 'client' });
    }

    if (isNewThread && body) {
      setImmediate(async () => {
        try {
          const result = await classifyMessage({ body, personId, firmId });
          if (result.category) {
            await pool.query('UPDATE message_threads SET category = $1 WHERE id = $2', [result.category, threadId]);
          }
          for (const c of (result.companies || [])) {
            await pool.query(
              `INSERT INTO thread_companies (thread_id, company_id, ai_confidence, added_by)
               VALUES ($1, $2, $3, 'ai') ON CONFLICT (thread_id, company_id) DO NOTHING`,
              [threadId, c.id, c.confidence]
            );
          }
        } catch (e) {
          console.error('[portal send] classification error (non-fatal):', e.message);
        }
      });
    }

    res.json({ ok: true, threadId });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Messaging is not yet available' });
    }
    console.error('Portal /messages/send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// --- GET /portal/attachments/:documentId/download ---
router.get('/attachments/:documentId/download', async (req, res) => {
  const personId = req.portal.personId;
  const documentId = parseInt(req.params.documentId);

  try {
    const { rows } = await pool.query(
      'SELECT id, s3_key, s3_bucket, owner_type, owner_id FROM documents WHERE id = $1',
      [documentId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];

    // Verify access: must belong to this person directly, or to a company the person has access to
    let hasAccess = false;
    if (doc.owner_type === 'person' && doc.owner_id === personId) {
      hasAccess = true;
    } else if (doc.owner_type === 'company') {
      const { rows: accessRows } = await pool.query(
        'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
        [personId, doc.owner_id]
      );
      hasAccess = accessRows.length > 0;
    }
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    const url = await getSignedDownloadUrl({ key: doc.s3_key, bucket: doc.s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('Portal /attachments/:documentId/download error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── TAX DELIVERY PORTAL ENDPOINTS ────────────────────────────────────────

// ── Helper: verify signer access ─────────────────────────────────────────
async function getSignerForDelivery(deliveryId, personId) {
  const { rows } = await pool.query(
    'SELECT * FROM tax_delivery_signers WHERE delivery_id = $1 AND person_id = $2',
    [deliveryId, personId]
  );
  return rows[0] || null;
}

// --- GET /portal/tax-deliveries ---
router.get('/tax-deliveries', async (req, res) => {
  const personId = req.portal.personId;
  try {
    // Show deliveries where:
    // 1. This person is a named signer, OR
    // 2. This person has portal access to the company the delivery belongs to
    // In both cases, show their own signer row if it exists (for approve/sign actions),
    // otherwise show null signer fields (view-only for company-access members)
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (td.id)
              td.id, td.title, td.tax_year, td.status, td.intro_note, td.tax_summary,
              co.company_name,
              tds.approved_at, tds.signed_at, tds.needs_changes_at, tds.needs_changes_note
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       LEFT JOIN tax_delivery_signers tds ON tds.delivery_id = td.id AND tds.person_id = $1
       WHERE td.status IN ('sent','approved','needs_changes','signed')
         AND (
           tds.person_id = $1
           OR td.company_id IN (
             SELECT company_id FROM person_company_access WHERE person_id = $1
           )
         )
       ORDER BY td.id, td.created_at DESC`,
      [personId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[portal] GET /tax-deliveries error:', err);
    res.status(500).json({ error: 'Failed to fetch tax deliveries' });
  }
});

// --- GET /portal/tax-deliveries/:id/summary ---
router.get('/tax-deliveries/:id/summary', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId);
    if (!signer) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query(
      'SELECT tax_report_data, tax_report_status FROM tax_deliveries WHERE id = $1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ status: rows[0].tax_report_status || 'none', data: rows[0].tax_report_data || null });
  } catch (err) {
    console.error('[portal] GET /tax-deliveries/:id/summary error:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// --- GET /portal/tax-deliveries/:id/download-review ---
router.get('/tax-deliveries/:id/download-review', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await pool.query(
      `SELECT d.s3_key, d.s3_bucket FROM tax_deliveries td
       JOIN documents d ON d.id = td.review_doc_id
       WHERE td.id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Review document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[portal] GET /tax-deliveries/:id/download-review error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// --- GET /portal/tax-deliveries/:id/download-signature ---
router.get('/tax-deliveries/:id/download-signature', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await pool.query(
      `SELECT d.s3_key, d.s3_bucket FROM tax_deliveries td
       JOIN documents d ON d.id = td.signature_doc_id
       WHERE td.id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Signature document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[portal] GET /tax-deliveries/:id/download-signature error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// --- POST /portal/tax-deliveries/:id/approve ---
router.post('/tax-deliveries/:id/approve', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      `UPDATE tax_delivery_signers SET approved_at = NOW(), approved_ip = $1
       WHERE delivery_id = $2 AND person_id = $3`,
      [req.ip, id, personId]
    );

    await pool.query(
      'UPDATE people SET portal_last_login_at = NOW() WHERE id = $1',
      [personId]
    );

    // Check if ALL signers have now approved
    const { rows: allSigners } = await pool.query(
      'SELECT approved_at FROM tax_delivery_signers WHERE delivery_id = $1',
      [id]
    );
    const allApproved = allSigners.every(s => s.approved_at);
    if (allApproved) {
      await pool.query(
        "UPDATE tax_deliveries SET status = 'approved', updated_at = NOW() WHERE id = $1",
        [id]
      );
      console.log(`[tax-delivery] All signers approved delivery ${id} — status → approved`);
    }

    res.json({ ok: true, allApproved });
  } catch (err) {
    console.error('[portal] POST /tax-deliveries/:id/approve error:', err);
    res.status(500).json({ error: 'Failed to approve delivery' });
  }
});

// --- POST /portal/tax-deliveries/:id/needs-changes ---
router.post('/tax-deliveries/:id/needs-changes', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });

  try {
    const signer = await getSignerForDelivery(id, personId);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      `UPDATE tax_delivery_signers SET needs_changes_at = NOW(), needs_changes_note = $1
       WHERE delivery_id = $2 AND person_id = $3`,
      [note, id, personId]
    );

    await pool.query(
      "UPDATE tax_deliveries SET status = 'needs_changes', needs_changes_note = $1, updated_at = NOW() WHERE id = $2",
      [note, id]
    );

    // Fetch delivery and person info for notification
    const { rows: deliveryRows } = await pool.query(
      `SELECT td.tax_year, td.firm_id, co.company_name,
              p.first_name, p.last_name,
              f.email AS firm_email, f.name AS firm_name
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       JOIN people p ON p.id = $2
       JOIN firms f ON f.id = td.firm_id
       WHERE td.id = $1`,
      [id, personId]
    );
    if (deliveryRows[0]) {
      const d = deliveryRows[0];
      const clientName = `${d.first_name} ${d.last_name}`.trim();
      const entityLabel = d.company_name || clientName;

      // Email firm
      try {
        await sendEmail({
          to: d.firm_email,
          subject: `Changes Requested: ${d.tax_year} Return for ${entityLabel}`,
          html: `<p><strong>${clientName}</strong> has requested changes to their ${d.tax_year} tax return for ${entityLabel}:</p><blockquote>${note}</blockquote><p>Log in to DarkLion to review.</p>`,
        });
      } catch (emailErr) {
        console.error('[portal] needs-changes email error:', emailErr);
      }

      // Create a staff message thread so it appears in team inbox
      try {
        const subject = `⚠️ Changes Requested: ${clientName} — ${d.tax_year} Tax Return`;
        const body = `${clientName} has requested changes to their ${d.tax_year} tax return.\n\n"${note}"\n\nGo to the Tax tab on their record to review and resend.`;
        const { rows: threadRows } = await pool.query(
          `INSERT INTO message_threads (firm_id, person_id, subject, status, category, last_message_at)
           VALUES ($1, $2, $3, 'open', 'tax', NOW()) RETURNING id`,
          [d.firm_id, personId, subject]
        );
        if (threadRows[0]) {
          await pool.query(
            `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
             VALUES ($1, 'client', $2, $3, false)`,
            [threadRows[0].id, personId, body]
          );
        }
      } catch (msgErr) {
        console.error('[portal] needs-changes message thread error:', msgErr);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] POST /tax-deliveries/:id/needs-changes error:', err);
    res.status(500).json({ error: 'Failed to submit changes request' });
  }
});

// --- POST /portal/tax-deliveries/:id/sign ---
router.post('/tax-deliveries/:id/sign', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  const { signature_data, signature_type = 'drawn' } = req.body;
  if (!signature_data) return res.status(400).json({ error: 'signature_data is required' });

  try {
    const signer = await getSignerForDelivery(id, personId);
    if (!signer) return res.status(403).json({ error: 'Access denied' });
    if (!signer.approved_at) return res.status(400).json({ error: 'You must approve the return before signing' });

    await pool.query(
      `UPDATE tax_delivery_signers SET
         signed_at = NOW(), signed_ip = $1, signature_data = $2, signature_type = $3
       WHERE delivery_id = $4 AND person_id = $5`,
      [req.ip, signature_data, signature_type, id, personId]
    );

    // Generate signed PDF for this signer
    try {
      const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
      // Get delivery + person info
      const { rows: [delivInfo] } = await pool.query(
        `SELECT td.signature_doc_id, td.tax_year, td.firm_id, f.name AS firm_name,
                p.first_name, p.last_name, p.email AS person_email
         FROM tax_deliveries td
         JOIN firms f ON f.id = td.firm_id
         JOIN people p ON p.id = $2
         WHERE td.id = $1`,
        [id, personId]
      );
      if (delivInfo && delivInfo.signature_doc_id) {
        const { rows: [sigDoc] } = await pool.query(
          'SELECT s3_key, s3_bucket FROM documents WHERE id = $1', [delivInfo.signature_doc_id]
        );
        if (sigDoc) {
          const originalPdf = await downloadFile({ key: sigDoc.s3_key, bucket: sigDoc.s3_bucket || bucket });
          const signedPdf = await embedSignature(originalPdf, {
            name: `${delivInfo.first_name} ${delivInfo.last_name}`.trim(),
            email: delivInfo.person_email,
            signedAt: new Date().toISOString(),
            signedIp: req.ip,
            signatureData: signature_data,
            signatureType: signature_type,
            taxYear: delivInfo.tax_year,
            firmName: delivInfo.firm_name,
          });
          // Store signed PDF as new document
          const signedKey = buildKey(delivInfo.firm_id, 'tax_signed', `signed_${Date.now()}.pdf`);
          await uploadFile({ buffer: signedPdf, key: signedKey, mimeType: 'application/pdf', bucket });
          const { rows: [newDoc] } = await pool.query(
            `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type,
               size_bytes, s3_key, s3_bucket, folder_section, folder_category, year, is_delivered, delivered_at)
             VALUES ($1, 'person', $2, 'signed_return', $3, 'application/pdf', $4, $5, $6,
                     'firm_uploaded', 'tax', $7, true, NOW())
             RETURNING id`,
            [delivInfo.firm_id, personId,
             `${delivInfo.tax_year} Tax Return — Signed by ${delivInfo.first_name} ${delivInfo.last_name}.pdf`,
             signedPdf.length, signedKey, bucket, delivInfo.tax_year]
          );
          // Link signed doc to the signer record
          await pool.query(
            'UPDATE tax_delivery_signers SET signed_doc_id = $1 WHERE delivery_id = $2 AND person_id = $3',
            [newDoc.id, id, personId]
          );
        }
      }
    } catch(pdfErr) {
      console.error('[portal] sign PDF embed error (non-fatal):', pdfErr);
      // Non-fatal — signature is still recorded even if PDF embed fails
    }

    // Check if ALL signers have now signed
    const { rows: allSigners } = await pool.query(
      'SELECT signed_at FROM tax_delivery_signers WHERE delivery_id = $1',
      [id]
    );
    const allSigned = allSigners.every(s => s.signed_at);

    if (allSigned) {
      await pool.query(
        "UPDATE tax_deliveries SET status = 'signed', updated_at = NOW() WHERE id = $1",
        [id]
      );

      // Fetch delivery info for notifications and pipeline advance
      const { rows: deliveryRows } = await pool.query(
        `SELECT td.*, co.company_name, f.email AS firm_email, f.name AS firm_name
         FROM tax_deliveries td
         LEFT JOIN companies co ON co.id = td.company_id
         JOIN firms f ON f.id = td.firm_id
         WHERE td.id = $1`,
        [id]
      );

      if (deliveryRows[0]) {
        const d = deliveryRows[0];

        // Advance pipeline job if linked
        if (d.pipeline_job_id) {
          await advancePipelineJob(d.pipeline_job_id);
        }

        // Notify firm
        try {
          await sendEmail({
            to: d.firm_email,
            subject: `All Signed: ${d.tax_year} Return for ${d.company_name}`,
            html: `<p>All parties have signed the ${d.tax_year} tax return for <strong>${d.company_name}</strong>. Ready to e-file.</p>`,
          });
        } catch (emailErr) {
          console.error('[portal] sign complete email error:', emailErr);
        }
      }
    }

    res.json({ ok: true, allSigned });
  } catch (err) {
    console.error('[portal] POST /tax-deliveries/:id/sign error:', err);
    res.status(500).json({ error: 'Failed to submit signature' });
  }
});

// --- POST /portal/upload ---
router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const { year, folder_category } = req.body;

  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  const filename = sanitizeFilename(req.file.originalname || 'upload');
  const docType = ['tax', 'bookkeeping', 'other'].includes(folder_category) ? folder_category : 'other';

  const safeYear = year || String(new Date().getFullYear());
  const key = buildKey({
    firmId,
    ownerType: 'person',
    ownerId: personId,
    year: safeYear,
    docType,
    filename,
  });

  try {
    await uploadFile({
      buffer: req.file.buffer,
      key,
      mimeType: req.file.mimetype,
      bucket,
    });

    const displayName = req.file.originalname || filename;

    const { rows } = await pool.query(
      `INSERT INTO documents
         (firm_id, owner_type, owner_id, doc_type, display_name,
          mime_type, size_bytes, s3_key, s3_bucket, year,
          folder_section, folder_category, uploaded_by_type, uploaded_by_id,
          is_delivered, created_at)
       VALUES ($1, 'person', $2, $3, $4, $5, $6, $7, $8, $9, 'client_uploaded', $10, 'client', $2, false, NOW())
       RETURNING id, firm_id, owner_type, owner_id, doc_type, display_name,
                 mime_type, size_bytes, year, folder_section, folder_category, is_delivered, created_at`,
      [firmId, personId, docType, displayName,
       req.file.mimetype, req.file.size, key, bucket, safeYear, docType]
    );

    res.json({ ok: true, document: rows[0] });
  } catch (err) {
    console.error('Portal /upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
