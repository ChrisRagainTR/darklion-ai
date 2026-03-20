'use strict';

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { getSignedDownloadUrl, uploadFile, buildKey, sanitizeFilename } = require('../services/s3');

const router = Router();

// Multer: memory storage for client uploads (max 50 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
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

      if (companyIds.length > 0) {
        query = `
          SELECT id, firm_id, owner_type, owner_id, company_id, doc_type,
                 display_name, file_name, mime_type, size_bytes, is_delivered,
                 delivered_at, viewed_at, tax_year AS year, notes,
                 folder_section, created_at, updated_at
          FROM documents
          WHERE is_delivered = true
            AND (
              (owner_type = 'person' AND owner_id = $1)
              OR (owner_type = 'company' AND owner_id = ANY($2))
            )
          ORDER BY created_at DESC
        `;
        params = [personId, companyIds];
      } else {
        query = `
          SELECT id, firm_id, owner_type, owner_id, company_id, doc_type,
                 display_name, file_name, mime_type, size_bytes, is_delivered,
                 delivered_at, viewed_at, tax_year AS year, notes,
                 folder_section, created_at, updated_at
          FROM documents
          WHERE is_delivered = true
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

// --- GET /portal/messages ---
router.get('/messages', async (req, res) => {
  const personId = req.portal.personId;

  try {
    const { rows } = await pool.query(
      `SELECT mt.id, mt.subject, mt.status, mt.created_at, mt.updated_at,
              (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id) AS message_count
       FROM message_threads mt
       WHERE mt.person_id = $1
       ORDER BY mt.updated_at DESC`,
      [personId]
    );
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01') {
      // Tables don't exist yet
      return res.json([]);
    }
    console.error('Portal /messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// --- POST /portal/messages/send ---
router.post('/messages/send', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const { subject, body, threadId } = req.body;

  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Message body is required' });
  }

  try {
    let resolvedThreadId = threadId;

    if (!resolvedThreadId) {
      // Create a new thread
      const { rows } = await pool.query(
        `INSERT INTO message_threads (firm_id, person_id, subject, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'open', NOW(), NOW())
         RETURNING id`,
        [firmId, personId, subject || 'New Message']
      );
      resolvedThreadId = rows[0].id;
    } else {
      // Update existing thread timestamp
      await pool.query(
        'UPDATE message_threads SET updated_at = NOW() WHERE id = $1',
        [resolvedThreadId]
      );
    }

    // Insert message
    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, created_at)
       VALUES ($1, 'client', $2, $3, NOW())
       RETURNING id, thread_id, body, created_at`,
      [resolvedThreadId, personId, body.trim()]
    );

    res.json({ ok: true, threadId: resolvedThreadId, message: msgRows[0] });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Messaging is not yet available' });
    }
    console.error('Portal /messages/send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// --- POST /portal/upload ---
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const { year, folder_category } = req.body;

  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  const filename = sanitizeFilename(req.file.originalname || 'upload');
  const docType = ['tax', 'bookkeeping', 'other'].includes(folder_category) ? folder_category : 'other';

  const key = buildKey({
    firmId,
    ownerType: 'person',
    ownerId: personId,
    year: year || '',
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
         (firm_id, owner_type, owner_id, doc_type, display_name, file_name,
          mime_type, size_bytes, s3_key, s3_bucket,
          folder_section, uploaded_by_type, uploaded_by_id,
          is_delivered, created_at, updated_at)
       VALUES ($1, 'person', $2, $3, $4, $5, $6, $7, $8, $9, 'client_uploaded', 'client', $2, true, NOW(), NOW())
       RETURNING id, firm_id, owner_type, owner_id, doc_type, display_name, file_name,
                 mime_type, size_bytes, folder_section, is_delivered, created_at`,
      [firmId, personId, docType, displayName, filename,
       req.file.mimetype, req.file.size, key, bucket]
    );

    res.json({ ok: true, document: rows[0] });
  } catch (err) {
    console.error('Portal /upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
