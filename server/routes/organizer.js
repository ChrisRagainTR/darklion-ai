/**
 * organizer.js — Tax Organizer API routes
 *
 * Staff routes (firm auth):
 *   POST   /api/organizers/parse-document/:documentId  — parse uploaded Drake PDF → create organizer + items
 *   GET    /api/organizers/:personId/:year              — get organizer + items for a person/year
 *   GET    /api/organizers/:personId/:year/items        — just the items
 *
 * Portal routes (portal auth, mounted separately):
 *   GET    /portal/organizer/:year                      — client gets their organizer
 *   PUT    /portal/organizer/:year/item/:itemId         — mark item uploaded / not_this_year
 *   POST   /portal/organizer/:year/submit               — submit organizer, generate workpaper
 *   POST   /portal/organizer/:year/answers              — save question answers
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { pool } = require('../db');
const { parseOrganizerPdf } = require('../services/organizerParser');
const { requireFirm } = require('../middleware/requireFirm');
const { requirePortal } = require('../middleware/requirePortal');
const { uploadFile, downloadFile, buildKey, sanitizeFilename } = require('../services/s3');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { fireTrigger } = require('../services/pipelineTriggers');
const Resend = require('resend').Resend;
const resend = new Resend(process.env.RESEND_API_KEY);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─────────────────────────────────────────────────────────────
// STAFF: Parse a document and create/update organizer + items
// ─────────────────────────────────────────────────────────────
router.post('/parse-document/:documentId', requireFirm, async (req, res) => {
  const { documentId } = req.params;
  const firmId = req.firm.id;

  try {
    // Fetch document record
    const docRes = await pool.query(
      'SELECT * FROM documents WHERE id = $1 AND firm_id = $2',
      [documentId, firmId]
    );
    if (!docRes.rows.length) return res.status(404).json({ error: 'Document not found' });
    const doc = docRes.rows[0];

    // Get person_id from owner (must be a person)
    if (doc.owner_type !== 'person') {
      return res.status(400).json({ error: 'Organizer must be owned by a person' });
    }
    const personId = doc.owner_id;
    const taxYear = doc.year || '2025';

    // Download PDF from S3
    const pdfBuffer = await downloadFile({ key: doc.s3_key, bucket: doc.s3_bucket });

    // Get company names in the relationship for Sentinel Provides detection
    const companiesRes = await pool.query(`
      SELECT c.company_name AS name FROM companies c
      JOIN people p ON p.relationship_id = c.relationship_id
      WHERE p.id = $1 AND c.firm_id = $2
    `, [personId, firmId]);
    const firmCompanyNames = companiesRes.rows.map(r => r.name);

    // Parse the PDF
    const { clientName, items } = await parseOrganizerPdf(pdfBuffer, firmCompanyNames);

    // Upsert organizer record
    const orgRes = await pool.query(`
      INSERT INTO tax_organizers (firm_id, person_id, tax_year, status, source_document_id)
      VALUES ($1, $2, $3, 'pending', $4)
      ON CONFLICT (person_id, tax_year)
      DO UPDATE SET source_document_id = $4, status = 'pending', updated_at = NOW()
      RETURNING *
    `, [firmId, personId, taxYear, documentId]);
    const organizer = orgRes.rows[0];

    // Delete existing items and re-insert
    await pool.query('DELETE FROM tax_organizer_items WHERE organizer_id = $1', [organizer.id]);

    for (const item of items) {
      await pool.query(`
        INSERT INTO tax_organizer_items
          (organizer_id, section, payer_name, account_number, owner, prior_year_amount, ein, sentinel_provides, display_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        organizer.id,
        item.section,
        item.payerName,
        item.accountNumber || '',
        item.owner || 'joint',
        item.prior_year_amount || null,
        item.ein || '',
        item.sentinel_provides || false,
        item.display_order || 0,
      ]);
    }

    res.json({
      organizer,
      itemCount: items.length,
      sentinelCount: items.filter(i => i.sentinel_provides).length,
      message: `Parsed ${items.length} items for ${clientName}`,
    });

  } catch (err) {
    console.error('Organizer parse error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STAFF: Upload a Drake organizer PDF directly → auto-parse
// POST /api/organizers/upload/:personId
// ─────────────────────────────────────────────────────────────
router.post('/upload/:personId', requireFirm, upload.single('file'), async (req, res) => {
  const { personId } = req.params;
  const firmId = req.firm.id;
  const year = req.body.year || '2025';

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Must be a PDF' });

  try {
    // Save to S3 in organizer folder
    const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
    const filename = sanitizeFilename(req.file.originalname || 'organizer.pdf');
    const key = buildKey ? buildKey({ firmId, ownerType: 'person', ownerId: parseInt(personId), year, docType: 'organizer', filename })
      : `firms/${firmId}/people/${personId}/organizer/${year}/${filename}`;

    await uploadFile({ buffer: req.file.buffer, key, bucket, mimeType: 'application/pdf' });

    // Save document record
    const docRes = await pool.query(`
      INSERT INTO documents (firm_id, owner_type, owner_id, year, doc_type, display_name,
        s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, uploaded_by_id,
        folder_section, folder_category)
      VALUES ($1,'person',$2,$3,'organizer',$4,$5,$6,'application/pdf',$7,'staff',$8,'firm_uploaded','organizer')
      RETURNING *
    `, [firmId, parseInt(personId), year, req.file.originalname || filename,
        bucket, key, req.file.size, req.firm.userId]);
    const savedDoc = docRes.rows[0];

    // Get firm companies for Sentinel Provides detection
    const companiesRes = await pool.query(`
      SELECT c.company_name AS name FROM companies c
      JOIN people p ON p.relationship_id = c.relationship_id
      WHERE p.id = $1 AND c.firm_id = $2
    `, [parseInt(personId), firmId]);
    const firmCompanyNames = companiesRes.rows.map(r => r.name);

    // Parse the PDF
    const { clientName, items } = await parseOrganizerPdf(req.file.buffer, firmCompanyNames);

    // Upsert organizer
    const orgRes = await pool.query(`
      INSERT INTO tax_organizers (firm_id, person_id, tax_year, status, source_document_id)
      VALUES ($1, $2, $3, 'pending', $4)
      ON CONFLICT (person_id, tax_year)
      DO UPDATE SET source_document_id = $4, status = 'pending', updated_at = NOW()
      RETURNING *
    `, [firmId, parseInt(personId), year, savedDoc.id]);
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

    res.json({
      success: true,
      organizer_id: organizer.id,
      document_id: savedDoc.id,
      client_name: clientName,
      item_count: items.length,
      sentinel_count: items.filter(i => i.sentinel_provides).length,
      items: items.map(i => ({ section: i.section, payer: i.payerName, owner: i.owner, sentinel: i.sentinel_provides })),
    });

  } catch (err) {
    console.error('Organizer upload+parse error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PORTAL: List all organizers (all years) — for Prior Years accordion
// GET /portal/organizer/all-years
// ─────────────────────────────────────────────────────────────
router.get('/all-years', requirePortal, async (req, res) => {
  const personId = req.portal.personId;
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.tax_year, o.status, o.submitted_at, o.closed_at, o.reopen_note,
              o.workpaper_document_id,
              d.display_name AS workpaper_name,
              (SELECT COUNT(*) FROM tax_organizer_items WHERE organizer_id = o.id) AS item_count,
              (SELECT COUNT(*) FROM tax_organizer_items WHERE organizer_id = o.id AND status = 'uploaded') AS uploaded_count
       FROM tax_organizers o
       LEFT JOIN documents d ON d.id = o.workpaper_document_id
       WHERE o.person_id = $1
       ORDER BY o.tax_year DESC`,
      [personId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PORTAL: Get organizer for the logged-in client
// ─────────────────────────────────────────────────────────────
router.get('/client/:year', requirePortal, async (req, res) => {
  const { year } = req.params;
  const personId = req.portal.personId;

  try {
    const orgRes = await pool.query(
      'SELECT * FROM tax_organizers WHERE person_id = $1 AND tax_year = $2',
      [personId, year]
    );
    if (!orgRes.rows.length) return res.status(404).json({ error: 'No organizer available yet' });
    const organizer = orgRes.rows[0];

    const itemsRes = await pool.query(
      'SELECT * FROM tax_organizer_items WHERE organizer_id = $1 ORDER BY display_order',
      [organizer.id]
    );

    // Calculate progress
    const items = itemsRes.rows;
    const actionable = items.filter(i => !i.sentinel_provides);
    const resolved = actionable.filter(i => i.status !== 'pending').length;

    res.json({
      organizer,
      items,
      progress: {
        total: actionable.length,
        resolved,
        percent: actionable.length ? Math.round((resolved / actionable.length) * 100) : 0,
        allDone: resolved >= actionable.length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STAFF: Add a custom document item to a client's organizer
// POST /api/organizers/:personId/:year/items
// ─────────────────────────────────────────────────────────────
router.post('/:personId/:year/items', requireFirm, async (req, res) => {
  const { personId, year } = req.params;
  const firmId = req.firm.id;
  const { payer_name, section, owner, note } = req.body;

  if (!payer_name || !section) return res.status(400).json({ error: 'payer_name and section required' });

  try {
    const orgRes = await pool.query(
      'SELECT id FROM tax_organizers WHERE person_id = $1 AND tax_year = $2 AND firm_id = $3',
      [parseInt(personId), year, firmId]
    );
    if (!orgRes.rows.length) return res.status(404).json({ error: 'No organizer found' });
    const organizerId = orgRes.rows[0].id;

    // Get current max display_order
    const orderRes = await pool.query(
      'SELECT COALESCE(MAX(display_order),0)+1 as next FROM tax_organizer_items WHERE organizer_id = $1',
      [organizerId]
    );

    const result = await pool.query(`
      INSERT INTO tax_organizer_items
        (organizer_id, section, payer_name, owner, sentinel_provides, advisor_added, display_order)
      VALUES ($1, $2, $3, $4, false, true, $5)
      RETURNING *
    `, [organizerId, section, payer_name, owner || 'taxpayer', orderRes.rows[0].next]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STAFF: Delete any item from a client's organizer
// DELETE /api/organizers/:personId/:year/items/:itemId
// ─────────────────────────────────────────────────────────────
router.delete('/:personId/:year/items/:itemId', requireFirm, async (req, res) => {
  const { personId, year, itemId } = req.params;
  const firmId = req.firm.id;

  try {
    const result = await pool.query(`
      DELETE FROM tax_organizer_items toi
      USING tax_organizers to2
      WHERE toi.id = $1 AND toi.organizer_id = to2.id
        AND to2.person_id = $2 AND to2.tax_year = $3 AND to2.firm_id = $4
      RETURNING toi.id
    `, [parseInt(itemId), parseInt(personId), year, firmId]);

    if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STAFF: Add / update custom questions for a client's organizer
// PUT /api/organizers/:personId/:year/questions
// ─────────────────────────────────────────────────────────────
router.put('/:personId/:year/questions', requireFirm, async (req, res) => {
  const { personId, year } = req.params;
  const firmId = req.firm.id;
  const { questions } = req.body; // array of { key, label, required }

  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions must be an array' });

  try {
    await pool.query(
      'UPDATE tax_organizers SET custom_questions = $1, updated_at = NOW() WHERE person_id = $2 AND tax_year = $3 AND firm_id = $4',
      [JSON.stringify(questions), parseInt(personId), year, firmId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// STAFF: List all organizers for a person (all years)
// GET /api/organizers/:personId/all
// ─────────────────────────────────────────────────────────────
router.get('/:personId/all', requireFirm, async (req, res) => {
  const { personId } = req.params;
  const firmId = req.firm.id;

  try {
    const orgRes = await pool.query(
      `SELECT o.*,
              d.s3_key AS workpaper_key, d.s3_bucket AS workpaper_bucket, d.display_name AS workpaper_name,
              (SELECT COUNT(*) FROM tax_organizer_items WHERE organizer_id = o.id) AS item_count,
              (SELECT COUNT(*) FROM tax_organizer_items WHERE organizer_id = o.id AND status = 'uploaded') AS uploaded_count,
              (SELECT COUNT(*) FROM tax_organizer_items WHERE organizer_id = o.id AND sentinel_provides = TRUE) AS sentinel_count
       FROM tax_organizers o
       LEFT JOIN documents d ON d.id = o.workpaper_document_id
       WHERE o.person_id = $1 AND o.firm_id = $2
       ORDER BY o.tax_year DESC`,
      [parseInt(personId), firmId]
    );
    const organizers = orgRes.rows;

    // Attach items to each organizer for the CRM advisor view
    for (const org of organizers) {
      const itemsRes = await pool.query(
        'SELECT * FROM tax_organizer_items WHERE organizer_id = $1 ORDER BY display_order',
        [org.id]
      );
      org.items = itemsRes.rows;
    }

    res.json(organizers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// STAFF: Get organizer + items for a person/year
// ─────────────────────────────────────────────────────────────
router.get('/:personId/:year', requireFirm, async (req, res) => {
  const { personId, year } = req.params;
  const firmId = req.firm.id;

  try {
    const orgRes = await pool.query(
      'SELECT * FROM tax_organizers WHERE person_id = $1 AND tax_year = $2 AND firm_id = $3',
      [personId, year, firmId]
    );
    if (!orgRes.rows.length) return res.status(404).json({ error: 'No organizer found' });
    const organizer = orgRes.rows[0];

    const itemsRes = await pool.query(
      'SELECT * FROM tax_organizer_items WHERE organizer_id = $1 ORDER BY display_order',
      [organizer.id]
    );

    res.json({ organizer, items: itemsRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PORTAL: Update a checklist item status
// ─────────────────────────────────────────────────────────────
router.put('/client/:year/item/:itemId', requirePortal, async (req, res) => {
  const { year, itemId } = req.params;
  const { status, document_id } = req.body;
  const personId = req.portal.personId;

  if (!['pending', 'uploaded', 'not_this_year', 'not_applicable'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    // Verify item belongs to this person's organizer
    const check = await pool.query(`
      SELECT toi.id FROM tax_organizer_items toi
      JOIN tax_organizers to2 ON to2.id = toi.organizer_id
      WHERE toi.id = $1 AND to2.person_id = $2 AND to2.tax_year = $3
    `, [itemId, personId, year]);
    if (!check.rows.length) return res.status(403).json({ error: 'Not authorized' });

    const updates = { status, updated_at: 'NOW()' };
    if (document_id) updates.document_id = document_id;

    await pool.query(`
      UPDATE tax_organizer_items
      SET status = $1, document_id = $2, updated_at = NOW()
      WHERE id = $3
    `, [status, document_id || null, itemId]);

    // Update organizer status to in_progress if not already submitted
    await pool.query(`
      UPDATE tax_organizers SET status = 'in_progress', updated_at = NOW()
      WHERE person_id = $1 AND tax_year = $2 AND status = 'pending'
    `, [personId, year]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PORTAL: Save question answers
// ─────────────────────────────────────────────────────────────
router.post('/client/:year/answers', requirePortal, async (req, res) => {
  const { year } = req.params;
  const { answers } = req.body; // { crypto: false, foreign_accounts: false, ... }
  const personId = req.portal.personId;

  try {
    await pool.query(`
      UPDATE tax_organizers
      SET question_answers = $1, updated_at = NOW()
      WHERE person_id = $2 AND tax_year = $3
    `, [JSON.stringify(answers), personId, year]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PORTAL: Upload a file for a specific checklist item
// POST /portal/organizer/client/:year/upload-item/:itemId
// ─────────────────────────────────────────────────────────────
router.post('/client/:year/upload-item/:itemId', requirePortal, upload.single('file'), async (req, res) => {
  const { year, itemId } = req.params;
  const personId = req.portal.personId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];
  if (!allowedMimes.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Invalid file type. Please upload a PDF or image.' });
  }

  try {
    // Verify item belongs to this person's organizer
    const check = await pool.query(`
      SELECT toi.id, toi.organizer_id, to2.firm_id FROM tax_organizer_items toi
      JOIN tax_organizers to2 ON to2.id = toi.organizer_id
      WHERE toi.id = $1 AND to2.person_id = $2 AND to2.tax_year = $3
    `, [itemId, personId, year]);
    if (!check.rows.length) return res.status(403).json({ error: 'Not authorized' });
    const { firm_id } = check.rows[0];

    // Upload file to S3
    const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs';
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const safeFilename = sanitizeFilename ? sanitizeFilename(req.file.originalname) : req.file.originalname;
    const key = `firms/${firm_id}/people/${personId}/organizer/${year}/items/${itemId}-${Date.now()}.${ext}`;
    await uploadFile({ buffer: req.file.buffer, key, bucket, mimeType: req.file.mimetype });

    // Build a meaningful display name: "PayerName — Section (year).ext"
    // Use the item's payer_name so staff can see what it is at a glance.
    // Exception: if the client gave the file a real name (not a UUID/generic), append it in parens.
    const itemRes = await pool.query('SELECT payer_name, section FROM tax_organizer_items WHERE id = $1', [itemId]);
    const itemRow = itemRes.rows[0];
    const SECTION_LABELS = {
      'w2':'W-2','1099-r':'1099-R','1099-div':'1099-DIV','1099-int':'1099-INT',
      'k1':'K-1','schedule-c':'Sch-C','1098':'1098','1099-nec':'1099-NEC',
      'childcare':'Childcare','other':'Other','1099-misc':'1099-MISC','1099-g':'1099-G',
    };
    const sectionLabel = itemRow ? (SECTION_LABELS[itemRow.section] || itemRow.section) : '';
    const payerName = itemRow ? itemRow.payer_name : '';
    const isGenericName = /^[0-9a-f-]{30,}$/i.test(req.file.originalname.replace(/\.[^.]+$/, ''));
    const clientOriginal = isGenericName ? '' : req.file.originalname.replace(/\.[^.]+$/, '');
    const displayName = `${payerName}${sectionLabel ? ` — ${sectionLabel}` : ''}${clientOriginal ? ` (${clientOriginal})` : ''}.${ext}`;

    // Save document record
    const docRes = await pool.query(`
      INSERT INTO documents (firm_id, owner_type, owner_id, year, doc_type, display_name,
        s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, folder_section, folder_category)
      VALUES ($1, 'person', $2, $3, 'organizer_item', $4, $5, $6, $7, $8, 'client', 'client_uploaded', 'organizer')
      RETURNING id
    `, [firm_id, personId, year, displayName, bucket, key, req.file.mimetype, req.file.size]);
    const documentId = docRes.rows[0].id;

    // Update item status to uploaded with document_id
    await pool.query(`
      UPDATE tax_organizer_items SET status = 'uploaded', document_id = $1, updated_at = NOW()
      WHERE id = $2
    `, [documentId, itemId]);

    // Bump organizer to in_progress if still pending
    await pool.query(`
      UPDATE tax_organizers SET status = 'in_progress', updated_at = NOW()
      WHERE person_id = $1 AND tax_year = $2 AND status = 'pending'
    `, [personId, year]);

    res.json({ success: true, document_id: documentId, filename: safeFilename });
  } catch (err) {
    console.error('Portal item upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PORTAL: Bulk PDF upload — one file covering all documents
// POST /portal/organizer/client/:year/bulk-upload
// ─────────────────────────────────────────────────────────────
router.post('/client/:year/bulk-upload', requirePortal, upload.single('file'), async (req, res) => {
  const { year } = req.params;
  const personId = req.portal.personId;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowedMimes.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Please upload a PDF or image file.' });
  }

  try {
    // Verify organizer exists for this client
    const orgRes = await pool.query(
      'SELECT * FROM tax_organizers WHERE person_id = $1 AND tax_year = $2',
      [personId, year]
    );
    if (!orgRes.rows.length) return res.status(404).json({ error: 'No organizer found' });
    const organizer = orgRes.rows[0];
    const firmId = organizer.firm_id;

    // Upload bulk PDF to S3
    const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs';
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const safeFilename = sanitizeFilename ? sanitizeFilename(req.file.originalname) : req.file.originalname;
    const key = `firms/${firmId}/people/${personId}/organizer/${year}/bulk-${Date.now()}.${ext}`;
    await uploadFile({ buffer: req.file.buffer, key, bucket, mimeType: req.file.mimetype });

    // Get person name for display_name
    const personRes = await pool.query('SELECT first_name, last_name FROM people WHERE id = $1', [personId]);
    const person = personRes.rows[0];
    const clientName = person ? `${person.first_name} ${person.last_name}` : 'Client';
    const displayName = `${year} Bulk Tax Documents — ${clientName}.${ext}`;

    // Save document record
    const docRes = await pool.query(`
      INSERT INTO documents (firm_id, owner_type, owner_id, year, doc_type, display_name,
        s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, folder_section, folder_category)
      VALUES ($1, 'person', $2, $3, 'organizer_bulk', $4, $5, $6, $7, $8, 'client', 'client_uploaded', 'organizer')
      RETURNING id
    `, [firmId, personId, year, displayName, bucket, key, req.file.mimetype, req.file.size]);
    const documentId = docRes.rows[0].id;

    // Store bulk_document_id on the organizer and bump to in_progress
    await pool.query(`
      UPDATE tax_organizers SET bulk_document_id = $1, status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END, updated_at = NOW()
      WHERE id = $2
    `, [documentId, organizer.id]);

    res.json({ success: true, document_id: documentId, filename: safeFilename });
  } catch (err) {
    console.error('Portal bulk upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PORTAL: Submit organizer — build workpaper PDF
// ─────────────────────────────────────────────────────────────
router.post('/client/:year/submit', requirePortal, async (req, res) => {
  const { year } = req.params;
  const personId = req.portal.personId;

  try {
    const orgRes = await pool.query(
      'SELECT * FROM tax_organizers WHERE person_id = $1 AND tax_year = $2',
      [personId, year]
    );
    if (!orgRes.rows.length) return res.status(404).json({ error: 'No organizer found' });
    const organizer = orgRes.rows[0];

    const itemsRes = await pool.query(
      'SELECT * FROM tax_organizer_items WHERE organizer_id = $1 ORDER BY display_order',
      [organizer.id]
    );
    const items = itemsRes.rows;

    // Check all actionable items are resolved (uploaded, not_this_year, or not_applicable)
    const pending = items.filter(i => !i.sentinel_provides && i.status === 'pending');
    if (pending.length > 0) {
      return res.status(400).json({ error: `${pending.length} items still pending`, pending: pending.map(i => i.payer_name) });
    }

    // Get person name
    const personRes = await pool.query('SELECT first_name, last_name FROM people WHERE id = $1', [personId]);
    const person = personRes.rows[0];
    const clientName = `${person.first_name} ${person.last_name}`;

    // Build workpaper PDF
    const workpaperDoc = await PDFDocument.create();
    const font = await workpaperDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await workpaperDoc.embedFont(StandardFonts.HelveticaBold);

    // --- Cover page ---
    const coverPage = workpaperDoc.addPage([612, 792]);
    const { width, height } = coverPage.getSize();

    // Header
    coverPage.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: rgb(0.059, 0.098, 0.149) });
    coverPage.drawText('SENTINEL WEALTH & TAX', { x: 40, y: height - 35, size: 16, font: boldFont, color: rgb(0.788, 0.659, 0.298) });
    coverPage.drawText(`${year} TAX ORGANIZER WORKPAPER`, { x: 40, y: height - 58, size: 11, font, color: rgb(0.9, 0.9, 0.9) });

    // Client info
    coverPage.drawText(`Client: ${clientName}`, { x: 40, y: height - 110, size: 13, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
    coverPage.drawText(`Tax Year: ${year}`, { x: 40, y: height - 130, size: 11, font, color: rgb(0.3, 0.3, 0.3) });
    coverPage.drawText(`Submitted: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`, { x: 40, y: height - 148, size: 11, font, color: rgb(0.3, 0.3, 0.3) });

    // Divider
    coverPage.drawLine({ start: { x: 40, y: height - 165 }, end: { x: width - 40, y: height - 165 }, thickness: 1, color: rgb(0.8, 0.7, 0.3) });

    // Document summary
    const uploaded = items.filter(i => i.status === 'uploaded');
    const notThisYear = items.filter(i => i.status === 'not_this_year');
    const notApplicable = items.filter(i => i.status === 'not_applicable');
    const resolvedByBulk = items.filter(i => i.status === 'not_this_year' || i.status === 'not_applicable');
    const sentinelItems = items.filter(i => i.sentinel_provides);

    // Check for a bulk upload note on this organizer
    const bulkDocId = organizer.bulk_document_id;

    coverPage.drawText('DOCUMENT SUMMARY', { x: 40, y: height - 195, size: 10, font: boldFont, color: rgb(0.4, 0.4, 0.4) });
    coverPage.drawText(`v ${uploaded.length} documents uploaded`, { x: 40, y: height - 215, size: 11, font, color: rgb(0.18, 0.7, 0.45) });
    if (bulkDocId) {
      coverPage.drawText(`Bulk PDF uploaded (client provided combined file)`, { x: 40, y: height - 233, size: 10, font, color: rgb(0.4, 0.6, 0.9) });
    }
    coverPage.drawText(`- ${notThisYear.length} marked Not This Year`, { x: 40, y: bulkDocId ? height - 251 : height - 233, size: 11, font, color: rgb(0.4, 0.4, 0.4) });
    coverPage.drawText(`x ${notApplicable.length} marked Not Applicable`, { x: 40, y: bulkDocId ? height - 269 : height - 251, size: 11, font, color: rgb(0.5, 0.4, 0.4) });
    coverPage.drawText(`${sentinelItems.length} provided by Sentinel`, { x: 40, y: bulkDocId ? height - 287 : height - 269, size: 11, font, color: rgb(0.788, 0.659, 0.298) });

    const summaryEndY = bulkDocId ? height - 300 : height - 282;

    // Not This Year list
    const declaredNA = [...notThisYear, ...notApplicable];
    if (declaredNA.length > 0) {
      coverPage.drawLine({ start: { x: 40, y: summaryEndY - 10 }, end: { x: width - 40, y: summaryEndY - 10 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
      coverPage.drawText('CLIENT DECLARED N/A:', { x: 40, y: summaryEndY - 30, size: 9, font: boldFont, color: rgb(0.5, 0.5, 0.5) });
      declaredNA.forEach((item, i) => {
        const label = item.status === 'not_applicable' ? 'x' : '-';
        coverPage.drawText(`  ${label} ${item.payer_name}`, { x: 40, y: summaryEndY - 48 - (i * 15), size: 9, font, color: rgb(0.5, 0.5, 0.5) });
      });
    }

    // Question answers
    const answers = organizer.question_answers || {};
    const answerY = height - 310 - (notThisYear.length * 15) - 20;
    if (Object.keys(answers).length > 0) {
      coverPage.drawLine({ start: { x: 40, y: answerY }, end: { x: width - 40, y: answerY }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
      coverPage.drawText('QUESTIONNAIRE ANSWERS:', { x: 40, y: answerY - 20, size: 9, font: boldFont, color: rgb(0.5, 0.5, 0.5) });
      const qLabels = {
        life_change: 'Major life change',
        address_change: 'Address changed',
        investments_sold: 'Sold investments',
        crypto: 'Cryptocurrency transactions',
        new_business: 'New/closed business',
        freelance: 'Freelance/side income',
        real_estate: 'Real estate transaction',
        rental: 'Rental income',
        foreign_accounts: 'Foreign accounts >$10k',
        foreign_income: 'Foreign income',
        irs_notice: 'IRS/state notices',
      };
      let qRow = 0;
      for (const [key, val] of Object.entries(answers)) {
        const label = qLabels[key] || key;
        const display = val === true ? 'v YES' : val === false ? '- No' : String(val);
        const color = val === true ? rgb(0.18, 0.7, 0.45) : rgb(0.4, 0.4, 0.4);
        coverPage.drawText(`  ${label}: ${display}`, { x: 40, y: answerY - 38 - (qRow * 13), size: 9, font, color });
        qRow++;
      }
    }

    // Now append all uploaded documents
    for (const item of uploaded) {
      if (!item.document_id) continue;
      try {
        const docRes = await pool.query('SELECT * FROM documents WHERE id = $1', [item.document_id]);
        if (!docRes.rows.length) continue;
        const doc = docRes.rows[0];
        const docBuffer = await downloadFile({ key: doc.s3_key, bucket: doc.s3_bucket });

        if (doc.mime_type === 'application/pdf') {
          const srcDoc = await PDFDocument.load(docBuffer);
          const pages = await workpaperDoc.copyPages(srcDoc, srcDoc.getPageIndices());
          // Add section label page
          const labelPage = workpaperDoc.addPage([612, 792]);
          labelPage.drawRectangle({ x: 0, y: 340, width: 612, height: 112, color: rgb(0.059, 0.098, 0.149) });
          labelPage.drawText(item.payer_name, { x: 40, y: 420, size: 18, font: boldFont, color: rgb(0.788, 0.659, 0.298) });
          labelPage.drawText(item.section.toUpperCase(), { x: 40, y: 395, size: 11, font, color: rgb(0.6, 0.6, 0.6) });
          labelPage.drawText(`${clientName} · ${year}`, { x: 40, y: 372, size: 10, font, color: rgb(0.5, 0.5, 0.5) });
          pages.forEach(p => workpaperDoc.addPage(p));
        }
        // Images would need conversion — skip for now, note on cover
      } catch (docErr) {
        console.warn('Could not append document', item.document_id, docErr.message);
      }
    }

    // Save workpaper PDF
    const workpaperBytes = await workpaperDoc.save();
    const workpaperBuffer = Buffer.from(workpaperBytes);

    // Upload to S3
    const s3Key = `firms/${organizer.firm_id}/people/${personId}/organizer/${year}/workpaper.pdf`;
    const bucket = process.env.S3_BUCKET || 'darklion-docs';
    await uploadFile({ buffer: workpaperBuffer, key: s3Key, bucket, mimeType: 'application/pdf' });

    // Save document record
    const wpDocRes = await pool.query(`
      INSERT INTO documents (firm_id, owner_type, owner_id, year, doc_type, display_name,
        s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, folder_section, folder_category)
      VALUES ($1, 'person', $2, $3, 'organizer', $4, $5, $6, 'application/pdf', $7, 'client', 'client_uploaded', 'organizer')
      RETURNING id
    `, [
      organizer.firm_id, personId, year,
      `${year} Tax Organizer Workpaper — ${clientName}.pdf`,
      bucket, s3Key, workpaperBuffer.length
    ]);

    // Update organizer to closed — submit = done unless staff reopens
    await pool.query(`
      UPDATE tax_organizers
      SET status = 'closed', submitted_at = NOW(), closed_at = NOW(), workpaper_document_id = $1, updated_at = NOW()
      WHERE id = $2
    `, [wpDocRes.rows[0].id, organizer.id]);

    // ── Reclassify individual uploads → client_uploaded/tax ─
    // Move the source docs out of the organizer holding area so they appear
    // normally in the Docs tab after submit. Workpaper stays firm_uploaded/tax.
    await pool.query(`
      UPDATE documents
      SET folder_category = 'tax', folder_section = 'client_uploaded', updated_at = NOW()
      WHERE owner_type = 'person' AND owner_id = $1
        AND folder_category = 'organizer'
        AND doc_type = 'organizer_item'
        AND year = $2
    `, [personId, year]);

    // ── Fire pipeline trigger (non-fatal) ──────────────────
    fireTrigger(organizer.firm_id, 'organizer_submitted', personId, { organizer_id: organizer.id })
      .catch(e => console.error('[organizer] fireTrigger organizer_submitted non-fatal:', e));

    // ── Email notification to firm (non-fatal) ─────────────
    try {
      const firmRes = await pool.query('SELECT name, contact_email FROM firms WHERE id = $1', [organizer.firm_id]);
      const firm = firmRes.rows[0];
      const notifyEmail = firm?.contact_email || process.env.RESEND_NOTIFY_EMAIL;
      if (notifyEmail && process.env.RESEND_API_KEY) {
        const uploadedCount = items.filter(i => i.status === 'uploaded').length;
        const ntyCount = items.filter(i => i.status === 'not_this_year').length;
        const sentinelCount = items.filter(i => i.sentinel_provides).length;
        await resend.emails.send({
          from: process.env.RESEND_FROM || `${firm?.name || 'DarkLion'} <messages@sentineltax.co>`,
          to: notifyEmail,
          subject: `[Organizer Submitted] ${clientName} — ${year}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
              <h2 style="color:#0f1926;">Tax Organizer Submitted</h2>
              <p><strong>${clientName}</strong> has submitted their ${year} tax organizer.</p>
              <table style="border-collapse:collapse;width:100%;margin:1rem 0;">
                <tr><td style="padding:0.4rem 0.75rem;border:1px solid #ddd;">Documents uploaded</td><td style="padding:0.4rem 0.75rem;border:1px solid #ddd;font-weight:700;">${uploadedCount}</td></tr>
                <tr><td style="padding:0.4rem 0.75rem;border:1px solid #ddd;">Marked Not This Year</td><td style="padding:0.4rem 0.75rem;border:1px solid #ddd;">${ntyCount}</td></tr>
                <tr><td style="padding:0.4rem 0.75rem;border:1px solid #ddd;">Provided by Sentinel</td><td style="padding:0.4rem 0.75rem;border:1px solid #ddd;">${sentinelCount}</td></tr>
              </table>
              <p><a href="https://darklion.ai/crm/person/${personId}" style="background:#c9a84c;color:#fff;padding:0.5rem 1rem;border-radius:6px;text-decoration:none;">View in DarkLion →</a></p>
            </div>
          `,
        });
      }
    } catch (emailErr) {
      console.error('[organizer] submit email non-fatal:', emailErr.message);
    }

    res.json({ success: true, workpaper_document_id: wpDocRes.rows[0].id });

  } catch (err) {
    console.error('Organizer submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STAFF: Reopen an organizer (submitted/reviewed → reopened)
// POST /api/organizers/:personId/:year/reopen
// ─────────────────────────────────────────────────────────────
router.post('/:personId/:year/reopen', requireFirm, async (req, res) => {
  const { personId, year } = req.params;
  const firmId = req.firm.id;
  const { note } = req.body; // optional message to client

  try {
    const orgRes = await pool.query(
      `SELECT id, status FROM tax_organizers WHERE person_id = $1 AND tax_year = $2 AND firm_id = $3`,
      [parseInt(personId), year, firmId]
    );
    if (!orgRes.rows.length) return res.status(404).json({ error: 'No organizer found' });
    const org = orgRes.rows[0];

    if (!['submitted', 'reviewed', 'closed'].includes(org.status)) {
      return res.status(400).json({ error: `Cannot reopen organizer with status '${org.status}'` });
    }

    await pool.query(
      `UPDATE tax_organizers SET status = 'reopened', reopen_note = $1, updated_at = NOW() WHERE id = $2`,
      [note || '', org.id]
    );

    // Fire portal notification if portal exists (non-fatal)
    try {
      const personRes = await pool.query(
        `SELECT first_name, last_name FROM people WHERE id = $1`,
        [parseInt(personId)]
      );
      const person = personRes.rows[0];
      const clientName = person ? `${person.first_name} ${person.last_name}` : 'Client';

      await pool.query(
        `INSERT INTO portal_notifications (firm_id, person_id, message, type, created_at)
         VALUES ($1, $2, $3, 'organizer_reopened', NOW())
         ON CONFLICT DO NOTHING`,
        [firmId, parseInt(personId),
         note
           ? `Your advisor has requested additional documents for your ${year} organizer: "${note}"`
           : `Your advisor has reopened your ${year} tax organizer for additional documents.`]
      );
    } catch (_) { /* portal_notifications table may not exist yet */ }

    res.json({ success: true, status: 'reopened' });
  } catch (err) {
    console.error('Organizer reopen error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STAFF: Close an organizer (any status → closed)
// POST /api/organizers/:personId/:year/close
// ─────────────────────────────────────────────────────────────
router.post('/:personId/:year/close', requireFirm, async (req, res) => {
  const { personId, year } = req.params;
  const firmId = req.firm.id;

  try {
    const orgRes = await pool.query(
      `SELECT id, status FROM tax_organizers WHERE person_id = $1 AND tax_year = $2 AND firm_id = $3`,
      [parseInt(personId), year, firmId]
    );
    if (!orgRes.rows.length) return res.status(404).json({ error: 'No organizer found' });

    await pool.query(
      `UPDATE tax_organizers SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [orgRes.rows[0].id]
    );

    res.json({ success: true, status: 'closed' });
  } catch (err) {
    console.error('Organizer close error:', err);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
