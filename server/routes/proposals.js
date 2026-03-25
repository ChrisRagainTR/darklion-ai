'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { fireTrigger } = require('../services/pipelineTriggers');

// Helper: fire trigger for all people in a proposal's relationship (non-blocking)
async function fireProposalTrigger(firmId, triggerKey, proposalId, context = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS person_id
       FROM proposals pr
       JOIN relationships r ON r.id = pr.relationship_id
       JOIN people p ON (p.relationship_id = r.id OR
         p.id IN (SELECT person_id FROM person_company_access pca
                  JOIN companies c ON c.id = pca.company_id
                  WHERE c.relationship_id = r.id))
       WHERE pr.id = $1 AND pr.firm_id = $2`,
      [proposalId, firmId]
    );
    for (const row of rows) {
      fireTrigger(firmId, triggerKey, row.person_id, { proposal_id: proposalId, ...context })
        .catch(e => console.error(`[proposals] fireTrigger ${triggerKey} non-fatal:`, e));
    }
  } catch (e) {
    console.error('[proposals] fireProposalTrigger non-fatal:', e);
  }
}

// GET / — list proposals for firm
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT p.*, r.name AS relationship_name
       FROM proposals p
       LEFT JOIN relationships r ON r.id = p.relationship_id
       WHERE p.firm_id = $1
       ORDER BY p.created_at DESC`,
      [firmId]
    );

    // Attach firm's primary custom domain to all proposals
    const { rows: domRows } = await pool.query(
      'SELECT domain FROM firm_domains WHERE firm_id = $1 AND verified_at IS NOT NULL ORDER BY created_at ASC LIMIT 1',
      [firmId]
    );
    const customDomain = domRows[0]?.domain || null;
    const enriched = rows.map(p => ({ ...p, custom_domain: customDomain }));

    res.json(enriched);
  } catch (err) {
    console.error('GET /proposals error:', err);
    res.status(500).json({ error: 'Failed to fetch proposals' });
  }
});

// POST / — create proposal
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const {
    title = 'Service Engagement Proposal',
    client_name = '',
    client_email = '',
    client_phone = '',
    client_address = '',
    client_city_state_zip = '',
    engagement_type = 'tax',
    tiers = [],
    add_ons = [],
    backwork = [],
    aum_fee_percent = 0.69,
    require_dual_signature = false,
    notes = '',
    status = 'draft',
    relationship_id = null,
    expires_at = null,
  } = req.body;

  try {
    const public_token = crypto.randomBytes(8).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO proposals (
        firm_id, relationship_id, title, client_name, client_email, client_phone,
        client_address, client_city_state_zip, engagement_type, tiers, add_ons,
        backwork, aum_fee_percent, require_dual_signature, notes, status,
        public_token, expires_at, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [
        firmId, relationship_id || null, title, client_name, client_email, client_phone,
        client_address, client_city_state_zip, engagement_type,
        JSON.stringify(tiers), JSON.stringify(add_ons), JSON.stringify(backwork),
        aum_fee_percent, require_dual_signature, notes, status,
        public_token, expires_at || null, userId || null,
      ]
    );
    const proposal = rows[0];

    // Get firm's primary custom domain (if any)
    const { rows: domRows } = await pool.query(
      'SELECT domain FROM firm_domains WHERE firm_id = $1 AND verified_at IS NOT NULL ORDER BY created_at ASC LIMIT 1',
      [firmId]
    );
    proposal.custom_domain = domRows[0]?.domain || null;

    res.status(201).json(proposal);
  } catch (err) {
    console.error('POST /proposals error:', err);
    res.status(500).json({ error: 'Failed to create proposal' });
  }
});

// GET /:id — single proposal with acceptance + engagement
router.get('/:id([0-9]+)', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT p.*, r.name AS relationship_name
       FROM proposals p
       LEFT JOIN relationships r ON r.id = p.relationship_id
       WHERE p.id = $1 AND p.firm_id = $2`,
      [id, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const proposal = rows[0];

    const { rows: acceptances } = await pool.query(
      'SELECT * FROM proposal_acceptances WHERE proposal_id = $1 ORDER BY accepted_at DESC LIMIT 1',
      [id]
    );
    const { rows: engagements } = await pool.query(
      'SELECT * FROM proposal_engagements WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1',
      [id]
    );

    // Get firm's primary custom domain (if any)
    const { rows: domRows } = await pool.query(
      'SELECT domain FROM firm_domains WHERE firm_id = $1 AND verified_at IS NOT NULL ORDER BY created_at ASC LIMIT 1',
      [firmId]
    );
    proposal.custom_domain = domRows[0]?.domain || null;

    res.json({
      ...proposal,
      acceptance: acceptances[0] || null,
      engagement: engagements[0] || null,
    });
  } catch (err) {
    console.error('GET /proposals/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch proposal' });
  }
});

// PUT /:id — update proposal
router.put('/:id([0-9]+)', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const {
    title,
    client_name,
    client_email,
    client_phone,
    client_address,
    client_city_state_zip,
    engagement_type,
    tiers,
    add_ons,
    backwork,
    aum_fee_percent,
    require_dual_signature,
    notes,
    status,
    relationship_id,
    expires_at,
  } = req.body;

  try {
    // Check current status — if accepted/signed, reset
    const { rows: current } = await pool.query(
      'SELECT status FROM proposals WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (!current.length) return res.status(404).json({ error: 'Not found' });

    const wasSignedOrAccepted = ['accepted', 'signed'].includes(current[0].status);
    if (wasSignedOrAccepted) {
      await pool.query('DELETE FROM proposal_acceptances WHERE proposal_id = $1', [id]);
      await pool.query('DELETE FROM proposal_engagements WHERE proposal_id = $1', [id]);
    }

    const newStatus = wasSignedOrAccepted ? 'sent' : (status || current[0].status);

    const { rows } = await pool.query(
      `UPDATE proposals SET
        title = COALESCE($1, title),
        client_name = COALESCE($2, client_name),
        client_email = COALESCE($3, client_email),
        client_phone = COALESCE($4, client_phone),
        client_address = COALESCE($5, client_address),
        client_city_state_zip = COALESCE($6, client_city_state_zip),
        engagement_type = COALESCE($7, engagement_type),
        tiers = COALESCE($8, tiers),
        add_ons = COALESCE($9, add_ons),
        backwork = COALESCE($10, backwork),
        aum_fee_percent = COALESCE($11, aum_fee_percent),
        require_dual_signature = COALESCE($12, require_dual_signature),
        notes = COALESCE($13, notes),
        status = $14,
        relationship_id = $15,
        expires_at = $16,
        updated_at = NOW()
      WHERE id = $17 AND firm_id = $18
      RETURNING *`,
      [
        title, client_name, client_email, client_phone, client_address, client_city_state_zip,
        engagement_type,
        tiers !== undefined ? JSON.stringify(tiers) : null,
        add_ons !== undefined ? JSON.stringify(add_ons) : null,
        backwork !== undefined ? JSON.stringify(backwork) : null,
        aum_fee_percent, require_dual_signature, notes,
        newStatus,
        relationship_id !== undefined ? (relationship_id || null) : undefined,
        expires_at || null,
        id, firmId,
      ]
    );

    // Fire proposal_sent trigger when status becomes 'sent' (non-blocking)
    if (newStatus === 'sent' && rows[0].relationship_id) {
      fireProposalTrigger(firmId, 'proposal_sent', parseInt(id), { status: newStatus });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /proposals/:id error:', err);
    res.status(500).json({ error: 'Failed to update proposal' });
  }
});

// DELETE /:id — delete proposal
router.delete('/:id([0-9]+)', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'DELETE FROM proposals WHERE id = $1 AND firm_id = $2 RETURNING id',
      [id, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /proposals/:id error:', err);
    res.status(500).json({ error: 'Failed to delete proposal' });
  }
});

// POST /:id/save-to-crm — save signed engagement to relationship's engagement tab
router.post('/:id([0-9]+)/save-to-crm', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT p.*, pe.*,
              p.id AS proposal_id_val,
              pe.id AS engagement_id_val
       FROM proposals p
       JOIN proposal_engagements pe ON pe.proposal_id = p.id
       WHERE p.id = $1 AND p.firm_id = $2 AND pe.status = 'signed' AND pe.saved_to_crm = false`,
      [id, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Signed engagement not found or already saved' });

    const eng = rows[0];
    if (!eng.relationship_id) return res.status(400).json({ error: 'No relationship linked to this proposal' });

    // Ensure engagement_letters table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS engagement_letters (
        id SERIAL PRIMARY KEY,
        firm_id INTEGER NOT NULL,
        relationship_id INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL DEFAULT '',
        s3_key TEXT NOT NULL DEFAULT '',
        s3_bucket TEXT NOT NULL DEFAULT '',
        mime_type TEXT DEFAULT 'text/html',
        size_bytes INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        extracted_data JSONB,
        extracted_at TIMESTAMPTZ,
        retired_at TIMESTAMPTZ,
        retired_by INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by INTEGER
      )
    `);

    const displayName = `${eng.engagement_type === 'wealth' ? 'Wealth Management' : 'Tax Services'} Engagement — ${eng.company_name || eng.client_name} (${new Date().getFullYear()})`;

    const extractedData = {
      engagement_type: eng.engagement_type,
      company_name: eng.company_name,
      client_name: eng.client_name,
      contact_email: eng.contact_email,
      entity_type: eng.entity_type,
      owners: eng.owners,
      monthly_price: eng.monthly_price,
      signed_by_name: eng.signed_by_name,
      signed_at: eng.signed_at,
      signed2_by_name: eng.signed2_by_name,
      signed2_at: eng.signed2_at,
      ai_summary: `Signed ${displayName}. Monthly: $${eng.monthly_price}. Signer: ${eng.signed_by_name}.`,
    };

    const { rows: letter } = await pool.query(
      `INSERT INTO engagement_letters (firm_id, relationship_id, display_name, s3_key, s3_bucket, mime_type, size_bytes, status, extracted_data, extracted_at, created_by)
       VALUES ($1, $2, $3, '', '', 'text/html', 0, 'active', $4, NOW(), $5)
       RETURNING id`,
      [firmId, eng.relationship_id, displayName, JSON.stringify(extractedData), userId || null]
    );

    // Mark saved
    await pool.query(
      'UPDATE proposal_engagements SET saved_to_crm = true WHERE id = $1',
      [eng.engagement_id_val]
    );

    res.json({ ok: true, engagement_letter_id: letter[0].id });
  } catch (err) {
    console.error('POST /proposals/:id/save-to-crm error:', err);
    res.status(500).json({ error: 'Failed to save to CRM' });
  }
});

// GET /stats — summary stats for the firm
router.get('/stats', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM proposals WHERE firm_id = $1) AS total,
        (SELECT COUNT(*) FROM proposals WHERE firm_id = $1 AND status = 'sent') AS sent,
        (SELECT COUNT(*) FROM proposals WHERE firm_id = $1 AND status IN ('accepted','signed')) AS accepted_signed,
        (SELECT COALESCE(SUM(monthly_price), 0) FROM proposal_engagements WHERE firm_id = $1 AND status = 'signed') AS mrr`,
      [firmId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /proposals/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
