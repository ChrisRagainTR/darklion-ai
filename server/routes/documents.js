'use strict';

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { uploadFile, getSignedDownloadUrl, deleteFile, buildKey, sanitizeFilename } = require('../services/s3');

const router = Router();

// Multer: memory storage only (no disk writes on Railway)
// ── Allowed file types (MIME + extension allowlist) ──────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  // Archives (for tax packages)
  'application/zip',
  'application/x-zip-compressed',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.heic', '.heif', '.zip',
]);

function fileFilter(req, file, cb) {
  const ext = require('path').extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type not allowed: ${ext || file.mimetype}. Allowed: PDF, Word, Excel, images, CSV, ZIP.`));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter,
});

const SAFE_COLUMNS = `
  id, firm_id, owner_type, owner_id, year, doc_type, display_name,
  mime_type, size_bytes, uploaded_by_type, uploaded_by_id,
  folder_section, folder_category, folder_subcategory,
  is_delivered, delivered_at, viewed_at, created_at
`;

// ── GET /documents ──────────────────────────────────────────────────
// Query: owner_type (required), owner_id (required), year?, doc_type?, is_delivered?
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const { owner_type, owner_id, year, doc_type, is_delivered, folder_category, folder_section } = req.query;

  if (!owner_type || !owner_id) {
    return res.status(400).json({ error: 'owner_type and owner_id are required' });
  }

  const params = [firmId, owner_type, parseInt(owner_id)];
  let where = 'firm_id = $1 AND owner_type = $2 AND owner_id = $3';

  if (year) { params.push(year); where += ` AND year = $${params.length}`; }
  if (doc_type) { params.push(doc_type); where += ` AND doc_type = $${params.length}`; }
  if (folder_category) { params.push(folder_category); where += ` AND folder_category = $${params.length}`; }
  if (folder_section) { params.push(folder_section); where += ` AND folder_section = $${params.length}`; }
  if (is_delivered !== undefined) {
    params.push(is_delivered === 'true' || is_delivered === '1');
    where += ` AND is_delivered = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM documents WHERE ${where} ORDER BY year DESC, created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /documents error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ── POST /documents/upload ──────────────────────────────────────────
router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { owner_type, owner_id, year, doc_type, display_name, folder_section, folder_category } = req.body;

  if (!owner_type || !owner_id) {
    return res.status(400).json({ error: 'owner_type and owner_id are required' });
  }

  // Organizer folder is locked — staff cannot upload or overwrite directly.
  // Writes come exclusively from the backend auto-trigger on organizer submission.
  if (folder_category === 'organizer' || doc_type === 'organizer') {
    return res.status(403).json({ error: 'Organizer folder is managed automatically. Staff cannot upload directly.' });
  }

  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  const filename = sanitizeFilename(req.file.originalname || 'upload');
  const key = buildKey({
    firmId,
    ownerType: owner_type,
    ownerId: parseInt(owner_id),
    year: year || '',
    docType: doc_type || 'other',
    filename,
  });

  try {
    await uploadFile({
      buffer: req.file.buffer,
      key,
      mimeType: req.file.mimetype,
      bucket,
    });

    const { rows } = await pool.query(
      `INSERT INTO documents
         (firm_id, owner_type, owner_id, year, doc_type, display_name,
          s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, uploaded_by_id,
          folder_section, folder_category, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       RETURNING ${SAFE_COLUMNS}`,
      [
        firmId,
        owner_type,
        parseInt(owner_id),
        year || '',
        doc_type || 'other',
        display_name || filename,
        bucket,
        key,
        req.file.mimetype,
        req.file.size,
        userId ? 'staff' : 'staff',
        userId || null,
        folder_section || 'firm_uploaded',
        folder_category || doc_type || 'other',
      ]
    );

    const savedDoc = rows[0];
    res.status(201).json(savedDoc);

    // === ORGANIZER AUTO-PARSE TRIGGER ===
    // If this upload lands in the 'organizer' folder category and belongs to a person,
    // automatically kick off the parser to build their digital checklist.
    if (
      (folder_category === 'organizer' || doc_type === 'organizer') &&
      owner_type === 'person' &&
      savedDoc.mime_type === 'application/pdf'
    ) {
      setImmediate(async () => {
        try {
          const { parseOrganizerPdf } = require('../services/organizerParser');
          const { downloadFile } = require('../services/s3');
          const pdfBuffer = await downloadFile({ key: savedDoc.s3_key, bucket: savedDoc.s3_bucket });

          // Get firm companies for Sentinel Provides detection
          const companiesRes = await pool.query(`
            SELECT c.company_name AS name FROM companies c
            JOIN people p ON p.relationship_id = c.relationship_id
            WHERE p.id = $1 AND c.firm_id = $2
          `, [parseInt(owner_id), firmId]);
          const firmCompanyNames = companiesRes.rows.map(r => r.name);

          const taxYear = savedDoc.year || year || '2025';
          const { clientName, items } = await parseOrganizerPdf(pdfBuffer, firmCompanyNames);

          // Upsert organizer
          const orgRes = await pool.query(`
            INSERT INTO tax_organizers (firm_id, person_id, tax_year, status, source_document_id)
            VALUES ($1, $2, $3, 'pending', $4)
            ON CONFLICT (person_id, tax_year)
            DO UPDATE SET source_document_id = $4, status = 'pending', updated_at = NOW()
            RETURNING *
          `, [firmId, parseInt(owner_id), taxYear, savedDoc.id]);
          const organizer = orgRes.rows[0];

          // Replace items
          await pool.query('DELETE FROM tax_organizer_items WHERE organizer_id = $1', [organizer.id]);
          for (const item of items) {
            await pool.query(`
              INSERT INTO tax_organizer_items
                (organizer_id, section, payer_name, account_number, owner, prior_year_amount, ein, sentinel_provides, display_order)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `, [organizer.id, item.section, item.payerName, item.accountNumber || '',
                item.owner || 'joint', item.prior_year_amount || null,
                item.ein || '', item.sentinel_provides || false, item.display_order || 0]);
          }
          console.log(`[organizer] Auto-parsed ${items.length} items for ${clientName} (person ${owner_id}, year ${taxYear})`);
        } catch (parseErr) {
          console.error('[organizer] Auto-parse failed:', parseErr.message);
        }
      });
    }

  } catch (err) {
    console.error('POST /documents/upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload document' });
  }
});

// ── GET /documents/:id/url ── (alias for download, returns JSON)
router.get('/:id/url', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate URL' });
  }
});

// ── GET /documents/:id/open ── (302 redirect — iOS Safari safe)
router.get('/:id/open', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).send('Document not found');
    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.redirect(302, url);
  } catch (err) {
    res.status(500).send('Failed to open document');
  }
});

// ── GET /documents/:id/download ─────────────────────────────────────
router.get('/:id/download', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('GET /documents/:id/download error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate download URL' });
  }
});

// ── PUT /documents/:id ──────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const { display_name, doc_type, year, is_delivered, folder_section, folder_category } = req.body;

  const sets = [];
  const params = [];

  if (display_name !== undefined)    { params.push(display_name);    sets.push(`display_name = $${params.length}`); }
  if (doc_type !== undefined)        { params.push(doc_type);        sets.push(`doc_type = $${params.length}`); }
  if (year !== undefined)            { params.push(year);            sets.push(`year = $${params.length}`); }
  if (folder_section !== undefined)  { params.push(folder_section);  sets.push(`folder_section = $${params.length}`); }
  if (folder_category !== undefined) { params.push(folder_category); sets.push(`folder_category = $${params.length}`); }
  if (is_delivered !== undefined) {
    const val = is_delivered === true || is_delivered === 'true' || is_delivered === 1;
    params.push(val);
    sets.push(`is_delivered = $${params.length}`);
    if (val) {
      sets.push(`delivered_at = NOW()`);
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(parseInt(id));
  params.push(firmId);

  try {
    // Check if this is an organizer doc — locked from staff edits
    const lockCheck = await pool.query(
      'SELECT folder_category FROM documents WHERE id = $1 AND firm_id = $2',
      [parseInt(id), firmId]
    );
    if (lockCheck.rows[0]?.folder_category === 'organizer') {
      return res.status(403).json({ error: 'Organizer documents cannot be edited by staff.' });
    }

    const { rows } = await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND firm_id = $${params.length} RETURNING ${SAFE_COLUMNS}`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /documents/:id error:', err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// ── DELETE /documents/:id ───────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket, folder_category FROM documents WHERE id = $1 AND firm_id = $2',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });

    // Organizer docs are locked — staff cannot delete
    if (rows[0].folder_category === 'organizer') {
      return res.status(403).json({ error: 'Organizer documents cannot be deleted by staff.' });
    }

    // Delete from S3
    try {
      await deleteFile({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    } catch (s3Err) {
      console.error('S3 delete failed (continuing DB delete):', s3Err.message);
    }

    await pool.query('DELETE FROM documents WHERE id = $1 AND firm_id = $2', [parseInt(id), firmId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /documents/:id error:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ── POST /documents/:id/deliver ─────────────────────────────────────
router.post('/:id/deliver', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `UPDATE documents SET is_delivered = true, delivered_at = NOW()
       WHERE id = $1 AND firm_id = $2 RETURNING ${SAFE_COLUMNS}`,
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /documents/:id/deliver error:', err);
    res.status(500).json({ error: 'Failed to mark as delivered' });
  }
});

module.exports = router;
