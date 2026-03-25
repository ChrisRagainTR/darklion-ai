'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { sendPortalNotification } = require('../services/email');

const router = Router();

const APP_URL = (process.env.APP_URL || 'https://darklion.ai').replace(/\/+$/, '');

// ── GET /api/bulk-send/filters — data for filter dropdowns ───────────────────
router.get('/filters', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const [relationships, pipelines, templates, filingStatuses, entityTypes, companyStatuses] = await Promise.all([
      pool.query(
        `SELECT id, name, service_tier, billing_status FROM relationships WHERE firm_id = $1 ORDER BY name`,
        [firmId]
      ),
      pool.query(
        `SELECT pi.id, pi.name, pi.tax_year,
           json_agg(json_build_object('id', ps.id, 'name', ps.name, 'position', ps.position) ORDER BY ps.position) as stages
         FROM pipeline_instances pi
         JOIN pipeline_stages ps ON ps.template_id = pi.template_id
         WHERE pi.firm_id = $1 AND pi.status = 'active'
         GROUP BY pi.id, pi.name, pi.tax_year
         ORDER BY pi.name`,
        [firmId]
      ),
      pool.query(
        `SELECT id, name, body FROM message_templates WHERE firm_id = $1 ORDER BY name`,
        [firmId]
      ),
      pool.query(
        `SELECT DISTINCT filing_status FROM people
         WHERE firm_id = $1 AND filing_status IS NOT NULL AND filing_status != ''
         ORDER BY filing_status`,
        [firmId]
      ),
      pool.query(
        `SELECT DISTINCT entity_type FROM companies
         WHERE firm_id = $1 AND entity_type IS NOT NULL AND entity_type != ''
         ORDER BY entity_type`,
        [firmId]
      ),
      pool.query(
        `SELECT DISTINCT status FROM companies
         WHERE firm_id = $1 AND status IS NOT NULL AND status != ''
         ORDER BY status`,
        [firmId]
      ),
    ]);

    // Unique service tiers and billing statuses
    const serviceTiers = [...new Set(relationships.rows.map(r => r.service_tier).filter(Boolean))].sort();
    const billingStatuses = [...new Set(relationships.rows.map(r => r.billing_status).filter(Boolean))].sort();

    res.json({
      relationships: relationships.rows.map(r => ({ id: r.id, name: r.name })),
      pipelines: pipelines.rows,
      serviceTiers,
      billingStatuses,
      templates: templates.rows,
      filingStatuses: filingStatuses.rows.map(r => r.filing_status),
      entityTypes: entityTypes.rows.map(r => r.entity_type),
      companyStatuses: companyStatuses.rows.map(r => r.status),
    });
  } catch (err) {
    console.error('[GET /api/bulk-send/filters] error:', err);
    res.status(500).json({ error: 'Failed to load filters' });
  }
});

// ── POST /api/bulk-send/preview — count + list matching recipients ────────────
router.post('/preview', async (req, res) => {
  const firmId = req.firm.id;
  const { filters } = req.body;

  try {
    const { query, params } = buildAudienceQuery(firmId, filters, false);
    const { rows } = await pool.query(query, params);

    res.json({
      count: rows.length,
      recipients: rows.slice(0, 200).map(r => ({
        id: r.id,
        type: r.entity_type,
        name: r.display_name,
        email: r.email,
        relationship: r.relationship_name,
      })),
    });
  } catch (err) {
    console.error('[POST /api/bulk-send/preview] error:', err);
    res.status(500).json({ error: 'Failed to build audience preview' });
  }
});

// ── POST /api/bulk-send/send — execute the bulk send ─────────────────────────
router.post('/send', async (req, res) => {
  const firmId = req.firm.id;
  let userId = req.firm.userId;
  if (!userId) {
    try {
      const { rows } = await pool.query(
        'SELECT id FROM firm_users WHERE firm_id=$1 AND email=$2 LIMIT 1',
        [firmId, req.firm.email]
      );
      if (rows[0]) userId = rows[0].id;
    } catch (e) { /* silent */ }
  }

  const { subject, message, filters } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message body is required' });
  }

  try {
    // Get firm name for notifications
    const { rows: firmRows } = await pool.query('SELECT name FROM firms WHERE id=$1', [firmId]);
    const firmName = firmRows[0]?.name || 'Your Advisor';

    // Get recipients
    const { query, params } = buildAudienceQuery(firmId, filters, false);
    const { rows: recipients } = await pool.query(query, params);

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients match the selected filters' });
    }

    // Create bulk_sends record
    const { rows: bsRows } = await pool.query(
      `INSERT INTO bulk_sends (firm_id, subject, message, filter_criteria, recipient_count, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [firmId, subject || '', message.trim(), JSON.stringify(filters || {}), recipients.length, userId]
    );
    const bulkSendId = bsRows[0].id;

    // Send to each person
    const results = [];
    for (const recipient of recipients) {
      if (recipient.entity_type !== 'person') continue; // only people have portal threads
      const personId = recipient.id;

      try {
        // Find or create thread
        const { rows: existingThreads } = await pool.query(
          `SELECT id FROM message_threads
           WHERE firm_id=$1 AND person_id=$2 AND staff_user_id=$3 AND status!='archived'
           LIMIT 1`,
          [firmId, personId, userId]
        );

        let threadId;
        if (existingThreads.length > 0) {
          threadId = existingThreads[0].id;
        } else {
          const { rows: newThread } = await pool.query(
            `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, last_message_at)
             VALUES ($1, $2, $3, $4, 'open', NOW()) RETURNING id`,
            [firmId, personId, userId, subject || 'Message from your advisor']
          );
          threadId = newThread[0].id;
        }

        // Substitute merge tags for this recipient
        const firstName = (recipient.first_name || '').trim() || (recipient.display_name || '').split(' ')[0] || 'there';
        const lastName = (recipient.last_name || '').trim();
        const fullName = recipient.display_name || `${firstName} ${lastName}`.trim();
        const personalizedMessage = message.trim()
          .replace(/\{First Name\}/gi, firstName)
          .replace(/\{Last Name\}/gi, lastName)
          .replace(/\{Full Name\}/gi, fullName)
          .replace(/\{first_name\}/gi, firstName)
          .replace(/\{last_name\}/gi, lastName);

        // Insert message
        await pool.query(
          `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
           VALUES ($1, 'staff', $2, $3, false)`,
          [threadId, userId, personalizedMessage]
        );

        // Update last_message_at
        await pool.query(
          'UPDATE message_threads SET last_message_at=NOW() WHERE id=$1',
          [threadId]
        );

        // Record recipient
        await pool.query(
          `INSERT INTO bulk_send_recipients (bulk_send_id, person_id, thread_id)
           VALUES ($1, $2, $3)`,
          [bulkSendId, personId, threadId]
        );

        // Send notification (immediate for bulk sends)
        if (recipient.email) {
          sendPortalNotification({
            to: recipient.email,
            name: recipient.display_name,
            firmName,
            message: 'You have a new message from your advisor. Log in to view it.',
            portalUrl: APP_URL + '/portal',
          }).catch(e => console.error('[bulk-send] notify error:', e.message));
        }

        results.push({ personId, threadId, ok: true });
      } catch (e) {
        console.error(`[bulk-send] error sending to person ${personId}:`, e.message);
        results.push({ personId, ok: false, error: e.message });
      }
    }

    const sentCount = results.filter(r => r.ok).length;
    res.json({ ok: true, bulkSendId, sentCount, total: recipients.length });
  } catch (err) {
    console.error('[POST /api/bulk-send/send] error:', err);
    res.status(500).json({ error: 'Failed to execute bulk send' });
  }
});

// ── GET /api/bulk-send/history — past bulk sends ─────────────────────────────
router.get('/history', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT bs.id, bs.subject, bs.recipient_count, bs.sent_at,
              fu.name as sent_by_name
       FROM bulk_sends bs
       LEFT JOIN firm_users fu ON fu.id = bs.sent_by
       WHERE bs.firm_id = $1
       ORDER BY bs.sent_at DESC
       LIMIT 50`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/bulk-send/history] error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// ── Helper: build audience SQL query ─────────────────────────────────────────
function buildAudienceQuery(firmId, filters = {}, countOnly = false) {
  const conditions = ['p.firm_id = $1', 'p.portal_enabled = true'];
  const params = [firmId];
  let paramIdx = 2;

  // Relationship filter
  if (filters.relationship_id) {
    conditions.push(`p.relationship_id = $${paramIdx++}`);
    params.push(parseInt(filters.relationship_id));
  }

  // Service tier
  if (filters.service_tier) {
    conditions.push(`r.service_tier = $${paramIdx++}`);
    params.push(filters.service_tier);
  }

  // Billing status
  if (filters.billing_status) {
    conditions.push(`r.billing_status = $${paramIdx++}`);
    params.push(filters.billing_status);
  }

  // Portal active (last login within N days)
  if (filters.portal_active_days) {
    const days = parseInt(filters.portal_active_days);
    conditions.push(`p.portal_last_login_at > NOW() - INTERVAL '${days} days'`);
  }

  // Portal never logged in
  if (filters.portal_never_logged_in === true || filters.portal_never_logged_in === 'true') {
    conditions.push(`p.portal_last_login_at IS NULL`);
  }

  // Pipeline stage filter
  if (filters.pipeline_instance_id && filters.pipeline_stage_id) {
    conditions.push(`EXISTS (
      SELECT 1 FROM pipeline_jobs pj
      WHERE pj.instance_id = $${paramIdx++}
        AND pj.current_stage_id = $${paramIdx++}
        AND pj.entity_type = 'person'
        AND pj.entity_id = p.id
    )`);
    params.push(parseInt(filters.pipeline_instance_id));
    params.push(parseInt(filters.pipeline_stage_id));
  }

  // Proposal status filter
  if (filters.proposal_status) {
    conditions.push(`EXISTS (
      SELECT 1 FROM proposals prop
      WHERE prop.firm_id = $1
        AND prop.relationship_id = p.relationship_id
        AND prop.status = $${paramIdx++}
    )`);
    params.push(filters.proposal_status);
  }

  // Filing status filter (from people table)
  if (filters.filing_status) {
    conditions.push(`p.filing_status = $${paramIdx++}`);
    params.push(filters.filing_status);
  }

  // Entity type filter (via company association)
  if (filters.entity_type === 'individual') {
    // People with no company associations
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM person_company_access pca WHERE pca.person_id = p.id
    )`);
  } else if (filters.entity_type) {
    // People associated with companies of this entity type
    conditions.push(`EXISTS (
      SELECT 1 FROM person_company_access pca
      JOIN companies co ON co.id = pca.company_id
      WHERE pca.person_id = p.id AND co.entity_type = $${paramIdx++}
    )`);
    params.push(filters.entity_type);
  }

  // Company status filter (via company association)
  if (filters.company_status) {
    conditions.push(`EXISTS (
      SELECT 1 FROM person_company_access pca
      JOIN companies co ON co.id = pca.company_id
      WHERE pca.person_id = p.id
        AND co.status = $${paramIdx++}
        AND co.firm_id = $1
    )`);
    params.push(filters.company_status);
  }

  // Has documents filter
  if (filters.has_documents === true || filters.has_documents === 'true') {
    conditions.push(`EXISTS (
      SELECT 1 FROM documents d
      WHERE d.owner_type = 'person'
        AND d.owner_id = p.id
        AND d.firm_id = $1
    )`);
  }

  const whereClause = conditions.join(' AND ');

  const query = `
    SELECT
      p.id,
      'person' AS entity_type,
      p.first_name,
      p.last_name,
      (p.first_name || ' ' || p.last_name) AS display_name,
      p.email,
      r.name AS relationship_name
    FROM people p
    LEFT JOIN relationships r ON r.id = p.relationship_id
    WHERE ${whereClause}
    ORDER BY p.last_name, p.first_name
  `;

  return { query, params };
}

module.exports = router;
