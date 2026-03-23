'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { getSignedDownloadUrl } = require('../services/s3');
const { sendEmail, sendPortalNotification } = require('../services/email');

const router = Router();

// ── Helper: compute overall delivery status from signers ──────────────────
function computeDeliveryStatus(signers, currentStatus) {
  if (currentStatus === 'draft') return 'draft';
  if (currentStatus === 'complete') return 'complete';
  if (signers.length === 0) return currentStatus;

  const anyNeedsChanges = signers.some(s => s.needs_changes_at);
  if (anyNeedsChanges) return 'needs_changes';

  const allSigned = signers.every(s => s.signed_at);
  if (allSigned) return 'signed';

  const allApproved = signers.every(s => s.approved_at);
  if (allApproved && !signers.some(s => s.signed_at)) return 'approved';

  return 'sent';
}

// ── Helper: advance pipeline job to next stage ────────────────────────────
async function advancePipelineJob(jobId) {
  try {
    const { rows: jobRows } = await pool.query('SELECT * FROM pipeline_jobs WHERE id = $1', [jobId]);
    if (!jobRows[0]) return;
    const job = jobRows[0];

    const { rows: stages } = await pool.query(
      `SELECT ps.* FROM pipeline_stages ps
       JOIN pipeline_instances pi ON pi.template_id = ps.template_id
       JOIN pipeline_jobs pj ON pj.instance_id = pi.id
       WHERE pj.id = $1
       ORDER BY ps.position ASC`,
      [jobId]
    );

    const currentIdx = stages.findIndex(s => s.id === job.current_stage_id);
    if (currentIdx >= 0 && currentIdx < stages.length - 1) {
      const nextStage = stages[currentIdx + 1];
      await pool.query(
        'UPDATE pipeline_jobs SET current_stage_id = $1, updated_at = NOW() WHERE id = $2',
        [nextStage.id, jobId]
      );
      await pool.query(
        'INSERT INTO pipeline_job_history (job_id, from_stage_id, to_stage_id, moved_by, note) VALUES ($1, $2, $3, $4, $5)',
        [jobId, job.current_stage_id, nextStage.id, null, 'Auto-advanced on e-sign completion']
      );
    }
  } catch (err) {
    console.error('[tax-delivery] advancePipelineJob error:', err);
  }
}

// ── GET /tax-deliveries?company_id=X or ?person_id=X ─────────────────────
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const { company_id, person_id } = req.query;

  try {
    let query = `
      SELECT td.*, co.company_name,
        (SELECT json_agg(row_to_json(s)) FROM (
          SELECT tds.person_id, p.first_name || ' ' || p.last_name AS person_name,
                 tds.approved_at, tds.signed_at, tds.needs_changes_at, tds.signed_doc_id
          FROM tax_delivery_signers tds
          JOIN people p ON p.id = tds.person_id
          WHERE tds.delivery_id = td.id
        ) s) AS signers
      FROM tax_deliveries td
      LEFT JOIN companies co ON co.id = td.company_id
      WHERE td.firm_id = $1
    `;
    const params = [firmId];

    if (company_id) {
      params.push(parseInt(company_id));
      query += ` AND td.company_id = $${params.length}`;
    } else if (person_id) {
      // Return deliveries for all companies this person is linked to (as signer or via company access)
      params.push(parseInt(person_id));
      query += ` AND (
        td.id IN (SELECT delivery_id FROM tax_delivery_signers WHERE person_id = $${params.length})
        OR td.company_id IN (
          SELECT company_id FROM person_company_access WHERE person_id = $${params.length}
        )
      )`;
    }

    query += ' ORDER BY td.created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[tax-delivery] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch deliveries' });
  }
});

// ── POST /tax-deliveries ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const {
    company_id, person_id, tax_year, title, intro_note, tax_summary,
    review_doc_id, signature_doc_id, signer_person_ids = [], pipeline_job_id
  } = req.body;

  if (!tax_year) {
    return res.status(400).json({ error: 'tax_year is required' });
  }
  if (!company_id && !person_id) {
    return res.status(400).json({ error: 'company_id or person_id is required' });
  }

  try {
    // Verify company belongs to firm (if company delivery)
    if (company_id) {
      const { rows: co } = await pool.query(
        'SELECT id FROM companies WHERE id = $1 AND firm_id = $2', [company_id, firmId]
      );
      if (!co[0]) return res.status(404).json({ error: 'Company not found' });
    }

    // Verify person belongs to firm (if personal delivery)
    if (person_id && !company_id) {
      const { rows: pe } = await pool.query(
        'SELECT id FROM people WHERE id = $1 AND firm_id = $2', [person_id, firmId]
      );
      if (!pe[0]) return res.status(404).json({ error: 'Person not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO tax_deliveries
         (firm_id, company_id, tax_year, title, intro_note, tax_summary, review_doc_id, signature_doc_id, pipeline_job_id, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
       RETURNING *`,
      [firmId, company_id || null, tax_year, title || '', intro_note || '',
       JSON.stringify(tax_summary || {}), review_doc_id || null, signature_doc_id || null,
       pipeline_job_id || null, userId || null]
    );
    const delivery = rows[0];

    // Add signers — always include person_id for personal returns
    const allSigners = [...new Set([
      ...(person_id ? [parseInt(person_id)] : []),
      ...signer_person_ids.map(p => parseInt(p)),
    ])];
    for (const pid of allSigners) {
      await pool.query(
        'INSERT INTO tax_delivery_signers (delivery_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [delivery.id, pid]
      );
    }

    res.status(201).json(delivery);
  } catch (err) {
    console.error('[tax-delivery] POST / error:', err);
    res.status(500).json({ error: 'Failed to create delivery' });
  }
});

// ── GET /tax-deliveries/:id ───────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.*, co.company_name,
         (SELECT json_agg(row_to_json(x)) FROM (
           SELECT tds.id, tds.person_id, tds.approved_at, tds.approved_ip,
                  tds.signed_at, tds.signed_ip, tds.signature_type,
                  tds.needs_changes_at, tds.needs_changes_note,
                  tds.signed_doc_id,
                  p.first_name, p.last_name, p.email,
                  p.first_name || ' ' || p.last_name AS person_name
           FROM tax_delivery_signers tds
           JOIN people p ON p.id = tds.person_id
           WHERE tds.delivery_id = td.id
         ) x) AS signers,
         rd.display_name AS review_doc_name,
         sd.display_name AS signature_doc_name
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       LEFT JOIN documents rd ON rd.id = td.review_doc_id
       LEFT JOIN documents sd ON sd.id = td.signature_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[tax-delivery] GET /:id error:', err);
    res.status(500).json({ error: 'Failed to fetch delivery' });
  }
});

// ── PUT /tax-deliveries/:id ───────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  const {
    title, intro_note, tax_summary, review_doc_id, signature_doc_id, signer_person_ids
  } = req.body;

  try {
    const { rows: existing } = await pool.query(
      'SELECT id, status FROM tax_deliveries WHERE id = $1 AND firm_id = $2', [id, firmId]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (existing[0].status !== 'draft') return res.status(400).json({ error: 'Only draft deliveries can be edited' });

    await pool.query(
      `UPDATE tax_deliveries SET
         title = COALESCE($1, title),
         intro_note = COALESCE($2, intro_note),
         tax_summary = COALESCE($3, tax_summary),
         review_doc_id = COALESCE($4, review_doc_id),
         signature_doc_id = COALESCE($5, signature_doc_id),
         updated_at = NOW()
       WHERE id = $6 AND firm_id = $7`,
      [title, intro_note, tax_summary ? JSON.stringify(tax_summary) : null,
       review_doc_id || null, signature_doc_id || null, id, firmId]
    );

    if (Array.isArray(signer_person_ids)) {
      await pool.query('DELETE FROM tax_delivery_signers WHERE delivery_id = $1', [id]);
      for (const pid of signer_person_ids) {
        await pool.query(
          'INSERT INTO tax_delivery_signers (delivery_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, pid]
        );
      }
    }

    const { rows } = await pool.query('SELECT * FROM tax_deliveries WHERE id = $1', [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('[tax-delivery] PUT /:id error:', err);
    res.status(500).json({ error: 'Failed to update delivery' });
  }
});

// ── POST /tax-deliveries/:id/send ─────────────────────────────────────────
router.post('/:id/send', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows: existing } = await pool.query(
      `SELECT td.*, co.company_name, f.name AS firm_name
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       JOIN firms f ON f.id = td.firm_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (existing[0].status !== 'draft') return res.status(400).json({ error: 'Only draft deliveries can be sent' });

    const delivery = existing[0];

    await pool.query(
      "UPDATE tax_deliveries SET status = 'sent', updated_at = NOW() WHERE id = $1",
      [id]
    );

    // Mark attached docs as delivered so they appear in client portal
    if (delivery.review_doc_id) {
      await pool.query(
        "UPDATE documents SET is_delivered = true, delivered_at = NOW() WHERE id = $1",
        [delivery.review_doc_id]
      );
    }
    if (delivery.signature_doc_id) {
      await pool.query(
        "UPDATE documents SET is_delivered = true, delivered_at = NOW() WHERE id = $1",
        [delivery.signature_doc_id]
      );
    }

    // Fetch signers with their person info
    const { rows: signers } = await pool.query(
      `SELECT tds.person_id, p.first_name, p.last_name, p.email, p.firm_id
       FROM tax_delivery_signers tds
       JOIN people p ON p.id = tds.person_id
       WHERE tds.delivery_id = $1`,
      [id]
    );

    const portalUrl = process.env.PORTAL_URL || 'https://darklion.ai/portal';

    for (const signer of signers) {
      const fullName = `${signer.first_name} ${signer.last_name}`.trim();

      // Send portal notification email
      if (signer.email) {
        try {
          await sendPortalNotification({
            to: signer.email,
            name: fullName,
            firmName: delivery.firm_name,
            message: `Your ${delivery.tax_year} tax return from ${delivery.firm_name} is ready for your review. Log in to your portal to review and sign.`,
            portalUrl,
          });
        } catch (emailErr) {
          console.error('[tax-delivery] send notification email error:', emailErr);
        }
      }

      // Create a portal message thread with intro note
      try {
        if (delivery.intro_note) {
          const { rows: threadRows } = await pool.query(
            `INSERT INTO message_threads (firm_id, person_id, subject, status, category, last_message_at)
             VALUES ($1, $2, $3, 'open', 'tax', NOW())
             RETURNING id`,
            [firmId, signer.person_id, `${delivery.tax_year} Tax Return — Ready for Review`]
          );
          if (threadRows[0]) {
            await pool.query(
              `INSERT INTO messages (thread_id, sender_type, sender_id, body)
               VALUES ($1, 'staff', $2, $3)`,
              [threadRows[0].id, req.firm.userId || 0, delivery.intro_note]
            );
          }
        }
      } catch (msgErr) {
        console.error('[tax-delivery] create message thread error:', msgErr);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[tax-delivery] POST /:id/send error:', err);
    res.status(500).json({ error: 'Failed to send delivery' });
  }
});

// ── DELETE /tax-deliveries/:id ────────────────────────────────────────────
// ── POST /tax-deliveries/:id/cancel ──────────────────────────────────────
router.post('/:id/cancel', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      'SELECT id, status FROM tax_deliveries WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (rows[0].status === 'complete') return res.status(400).json({ error: 'Cannot cancel a completed delivery' });
    const { rows: cancelRows } = await pool.query(
      'SELECT review_doc_id, signature_doc_id FROM tax_deliveries WHERE id = $1',
      [id]
    );
    await pool.query(
      "UPDATE tax_deliveries SET status = 'draft', updated_at = NOW(), needs_changes_note = '' WHERE id = $1",
      [id]
    );
    // Clear signer needs_changes so they start fresh
    await pool.query(
      "UPDATE tax_delivery_signers SET needs_changes_at = NULL, needs_changes_note = '', approved_at = NULL WHERE delivery_id = $1",
      [id]
    );
    // Un-deliver the docs
    const cancelDel = cancelRows[0];
    if (cancelDel?.review_doc_id) await pool.query("UPDATE documents SET is_delivered = false WHERE id = $1", [cancelDel.review_doc_id]);
    if (cancelDel?.signature_doc_id) await pool.query("UPDATE documents SET is_delivered = false WHERE id = $1", [cancelDel.signature_doc_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      'SELECT id, status FROM tax_deliveries WHERE id = $1 AND firm_id = $2', [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft deliveries can be deleted' });

    await pool.query('DELETE FROM tax_deliveries WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tax-delivery] DELETE /:id error:', err);
    res.status(500).json({ error: 'Failed to delete delivery' });
  }
});

// ── POST /tax-deliveries/:id/cancel ──────────────────────────────────────
router.post('/:id/cancel', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      'SELECT id, status FROM tax_deliveries WHERE id = $1 AND firm_id = $2', [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    if (!['sent', 'needs_changes', 'approved'].includes(rows[0].status)) {
      return res.status(400).json({ error: 'Cannot cancel a delivery in this state' });
    }

    // Reset signer fields
    await pool.query(
      `UPDATE tax_delivery_signers SET
         approved_at = NULL, approved_ip = '',
         signed_at = NULL, signed_ip = '', signature_data = '',
         needs_changes_at = NULL, needs_changes_note = ''
       WHERE delivery_id = $1`,
      [id]
    );

    await pool.query(
      "UPDATE tax_deliveries SET status = 'draft', needs_changes_note = '', updated_at = NOW() WHERE id = $1",
      [id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[tax-delivery] POST /:id/cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel delivery' });
  }
});

// ── GET /tax-deliveries/:id/download-review ───────────────────────────────
router.get('/:id/download-review', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.review_doc_id, d.s3_key, d.s3_bucket
       FROM tax_deliveries td
       JOIN documents d ON d.id = td.review_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Review document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[tax-delivery] GET /:id/download-review error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── GET /tax-deliveries/:id/download-signature ────────────────────────────
router.get('/:id/download-signature', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.signature_doc_id, d.s3_key, d.s3_bucket
       FROM tax_deliveries td
       JOIN documents d ON d.id = td.signature_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Signature document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[tax-delivery] GET /:id/download-signature error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── POST /tax-deliveries/:id/generate-summary ────────────────────────────
router.post('/:id/generate-summary', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT td.*, d.s3_key, d.s3_bucket
       FROM tax_deliveries td
       LEFT JOIN documents d ON d.id = td.review_doc_id
       WHERE td.id = $1 AND td.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    const delivery = rows[0];
    if (!delivery.s3_key) return res.status(400).json({ error: 'No review document attached' });

    await pool.query(
      "UPDATE tax_deliveries SET tax_report_status = 'processing', updated_at = NOW() WHERE id = $1",
      [id]
    );

    res.json({ ok: true, status: 'processing' });

    setImmediate(async () => {
      try {
        const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
        const s3Client = new S3Client({
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        });
        const { extractPdfText } = require('../services/pdfExtract');
        const { analyzeTaxReturn } = require('../services/taxAnalysis');

        const cmd = new GetObjectCommand({ Bucket: delivery.s3_bucket, Key: delivery.s3_key });
        const s3Res = await s3Client.send(cmd);

        const chunks = [];
        for await (const chunk of s3Res.Body) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        const pdfText = await extractPdfText(buffer);
        const reportData = await analyzeTaxReturn(pdfText);

        await pool.query(
          "UPDATE tax_deliveries SET tax_report_data = $1, tax_report_status = 'completed', updated_at = NOW() WHERE id = $2",
          [JSON.stringify(reportData), id]
        );
      } catch (err) {
        console.error('[tax-delivery] generate-summary async error:', err);
        await pool.query(
          "UPDATE tax_deliveries SET tax_report_status = 'error', updated_at = NOW() WHERE id = $1",
          [id]
        ).catch(() => {});
      }
    });

  } catch (err) {
    console.error('[tax-delivery] POST /:id/generate-summary error:', err);
    res.status(500).json({ error: 'Failed to start summary generation' });
  }
});

// ── GET /tax-deliveries/:id/summary ──────────────────────────────────────
router.get('/:id/summary', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      'SELECT tax_report_data, tax_report_status FROM tax_deliveries WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery not found' });
    res.json({
      status: rows[0].tax_report_status || 'none',
      data: rows[0].tax_report_data || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

module.exports = router;
module.exports.advancePipelineJob = advancePipelineJob;
