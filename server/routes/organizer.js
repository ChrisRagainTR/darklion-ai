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
const router = express.Router();
const { pool } = require('../db');
const { parseOrganizerPdf } = require('../services/organizerParser');
const { requireFirm } = require('../middleware/requireFirm');
const { requirePortal } = require('../middleware/requirePortal');
const { uploadFile, downloadFile, buildKey } = require('../services/s3');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

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
      SELECT c.name FROM companies c
      JOIN relationship_companies rc ON rc.company_id = c.id
      JOIN relationships r ON r.id = rc.relationship_id
      JOIN relationship_people rp ON rp.relationship_id = r.id
      WHERE rp.person_id = $1 AND c.firm_id = $2
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
// PORTAL: Get organizer for the logged-in client
// ─────────────────────────────────────────────────────────────
router.get('/portal/:year', requirePortal, async (req, res) => {
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
// PORTAL: Update a checklist item status
// ─────────────────────────────────────────────────────────────
router.put('/portal/:year/item/:itemId', requirePortal, async (req, res) => {
  const { year, itemId } = req.params;
  const { status, document_id } = req.body;
  const personId = req.portal.personId;

  if (!['pending', 'uploaded', 'not_this_year'].includes(status)) {
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
router.post('/portal/:year/answers', requirePortal, async (req, res) => {
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
// PORTAL: Submit organizer — build workpaper PDF
// ─────────────────────────────────────────────────────────────
router.post('/portal/:year/submit', requirePortal, async (req, res) => {
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

    // Check all actionable items are resolved
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
    const sentinelItems = items.filter(i => i.sentinel_provides);

    coverPage.drawText('DOCUMENT SUMMARY', { x: 40, y: height - 195, size: 10, font: boldFont, color: rgb(0.4, 0.4, 0.4) });
    coverPage.drawText(`✓ ${uploaded.length} documents uploaded`, { x: 40, y: height - 215, size: 11, font, color: rgb(0.18, 0.7, 0.45) });
    coverPage.drawText(`– ${notThisYear.length} marked Not This Year`, { x: 40, y: height - 233, size: 11, font, color: rgb(0.4, 0.4, 0.4) });
    coverPage.drawText(`🏢 ${sentinelItems.length} provided by Sentinel`, { x: 40, y: height - 251, size: 11, font, color: rgb(0.788, 0.659, 0.298) });

    // Not This Year list
    if (notThisYear.length > 0) {
      coverPage.drawLine({ start: { x: 40, y: height - 270 }, end: { x: width - 40, y: height - 270 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
      coverPage.drawText('NOT THIS YEAR — CLIENT CONFIRMED N/A:', { x: 40, y: height - 290, size: 9, font: boldFont, color: rgb(0.5, 0.5, 0.5) });
      notThisYear.forEach((item, i) => {
        coverPage.drawText(`  – ${item.payer_name}`, { x: 40, y: height - 308 - (i * 15), size: 9, font, color: rgb(0.5, 0.5, 0.5) });
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
        const display = val === true ? '✓ YES' : val === false ? '– No' : String(val);
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

    // Update organizer to submitted
    await pool.query(`
      UPDATE tax_organizers
      SET status = 'submitted', submitted_at = NOW(), workpaper_document_id = $1, updated_at = NOW()
      WHERE id = $2
    `, [wpDocRes.rows[0].id, organizer.id]);

    res.json({ success: true, workpaper_document_id: wpDocRes.rows[0].id });

  } catch (err) {
    console.error('Organizer submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
