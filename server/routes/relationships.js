const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// GET / — list all relationships for this firm with counts
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(`
      SELECT
        r.*,
        (SELECT COUNT(*) FROM companies c WHERE c.relationship_id = r.id) AS company_count,
        (SELECT COUNT(*) FROM people p WHERE p.relationship_id = r.id) AS people_count
      FROM relationships r
      WHERE r.firm_id = $1
      ORDER BY r.name ASC
    `, [firmId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /relationships error:', err);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// POST / — create a relationship
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  const {
    name,
    service_tier = 'standard',
    stripe_customer_id = '',
    stripe_subscription_id = '',
    billing_status = 'active',
    notes = '',
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const { rows } = await pool.query(`
      INSERT INTO relationships (firm_id, name, service_tier, stripe_customer_id, stripe_subscription_id, billing_status, notes, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *
    `, [firmId, name, service_tier, stripe_customer_id, stripe_subscription_id, billing_status, notes]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /relationships error:', err);
    res.status(500).json({ error: 'Failed to create relationship' });
  }
});

// GET /all-companies — must be before /:id to avoid being caught by it
router.get('/all-companies', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT c.*, r.name AS relationship_name
       FROM companies c
       LEFT JOIN relationships r ON r.id = c.relationship_id
       WHERE c.firm_id = $1
       ORDER BY c.company_name ASC`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /relationships/all-companies error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET /all-people — must be before /:id to avoid being caught by it
router.get('/all-people', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT p.*, r.name AS relationship_name
       FROM people p
       LEFT JOIN relationships r ON r.id = p.relationship_id
       WHERE p.firm_id = $1
       ORDER BY p.last_name ASC, p.first_name ASC`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /relationships/all-people error:', err);
    res.status(500).json({ error: 'Failed to fetch people' });
  }
});

// GET /:id — get single relationship with companies and people
router.get('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM relationships WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Relationship not found' });

    const relationship = rows[0];

    const [companiesRes, peopleRes] = await Promise.all([
      pool.query(
        'SELECT id, company_name, entity_type, status, realm_id FROM companies WHERE relationship_id = $1 AND firm_id = $2',
        [id, firmId]
      ),
      pool.query(
        'SELECT id, first_name, last_name, email, phone, filing_status, portal_enabled FROM people WHERE relationship_id = $1 AND firm_id = $2',
        [id, firmId]
      ),
    ]);

    relationship.companies = companiesRes.rows;
    relationship.people = peopleRes.rows;

    res.json(relationship);
  } catch (err) {
    console.error('GET /relationships/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch relationship' });
  }
});

// PUT /:id — update a relationship
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const {
    name,
    service_tier,
    stripe_customer_id,
    stripe_subscription_id,
    billing_status,
    notes,
  } = req.body;

  try {
    const { rows: existing } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Relationship not found' });

    const { rows } = await pool.query(`
      UPDATE relationships
      SET
        name = COALESCE($1, name),
        service_tier = COALESCE($2, service_tier),
        stripe_customer_id = COALESCE($3, stripe_customer_id),
        stripe_subscription_id = COALESCE($4, stripe_subscription_id),
        billing_status = COALESCE($5, billing_status),
        notes = COALESCE($6, notes),
        updated_at = NOW()
      WHERE id = $7 AND firm_id = $8
      RETURNING *
    `, [name, service_tier, stripe_customer_id, stripe_subscription_id, billing_status, notes, id, firmId]);

    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /relationships/:id error:', err);
    res.status(500).json({ error: 'Failed to update relationship' });
  }
});

// DELETE /:id — delete only if no companies or people attached
router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows: existing } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Relationship not found' });

    const [companiesRes, peopleRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM companies WHERE relationship_id = $1', [id]),
      pool.query('SELECT COUNT(*) FROM people WHERE relationship_id = $1', [id]),
    ]);

    const companyCount = parseInt(companiesRes.rows[0].count, 10);
    const peopleCount = parseInt(peopleRes.rows[0].count, 10);

    if (companyCount > 0 || peopleCount > 0) {
      return res.status(409).json({
        error: 'Cannot delete relationship with attached companies or people',
        company_count: companyCount,
        people_count: peopleCount,
      });
    }

    await pool.query('DELETE FROM relationships WHERE id = $1 AND firm_id = $2', [id, firmId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /relationships/:id error:', err);
    res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

// GET /:id/team — get assigned team members
router.get('/:id/team', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    // Auto-create table if not exists (idempotent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS relationship_team (
        relationship_id INTEGER NOT NULL,
        firm_user_id INTEGER NOT NULL,
        added_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (relationship_id, firm_user_id)
      )
    `);

    const { rows: rel } = await pool.query('SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [id, firmId]);
    if (!rel.length) return res.status(404).json({ error: 'Not found' });

    const { rows } = await pool.query(`
      SELECT fu.id, COALESCE(fu.display_name, fu.name) AS name, fu.email, fu.role, fu.avatar_url,
             fu.credentials, (fu.invite_token IS NOT NULL AND fu.accepted_at IS NULL) AS pending
      FROM relationship_team rt
      JOIN firm_users fu ON fu.id = rt.firm_user_id
      WHERE rt.relationship_id = $1
      ORDER BY rt.added_at ASC
    `, [id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /relationships/:id/team error:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// POST /:id/team — add a team member
router.post('/:id/team', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const { firm_user_id } = req.body;
  if (!firm_user_id) return res.status(400).json({ error: 'firm_user_id required' });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS relationship_team (
      relationship_id INTEGER NOT NULL, firm_user_id INTEGER NOT NULL, added_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (relationship_id, firm_user_id)
    )`);
    const { rows: rel } = await pool.query('SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [id, firmId]);
    if (!rel.length) return res.status(404).json({ error: 'Not found' });
    // Verify the user belongs to this firm
    const { rows: user } = await pool.query('SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2', [firm_user_id, firmId]);
    if (!user.length) return res.status(403).json({ error: 'User not in this firm' });

    await pool.query(`INSERT INTO relationship_team (relationship_id, firm_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, firm_user_id]);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /relationships/:id/team error:', err);
    res.status(500).json({ error: 'Failed to add team member' });
  }
});

// DELETE /:id/team/:userId — remove a team member
router.delete('/:id/team/:userId', async (req, res) => {
  const firmId = req.firm.id;
  const { id, userId } = req.params;
  try {
    const { rows: rel } = await pool.query('SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [id, firmId]);
    if (!rel.length) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM relationship_team WHERE relationship_id = $1 AND firm_user_id = $2', [id, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /relationships/:id/team error:', err);
    res.status(500).json({ error: 'Failed to remove team member' });
  }
});

// GET /:id/snapshot — tax deliveries, last 5 threads, activity feed
router.get('/:id/snapshot', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    // Verify relationship belongs to firm
    const { rows: relRows } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [id, firmId]
    );
    if (!relRows.length) return res.status(404).json({ error: 'Not found' });

    // Get all people + company IDs for this relationship
    const [peopleRes, companiesRes] = await Promise.all([
      pool.query('SELECT id FROM people WHERE relationship_id = $1 AND firm_id = $2', [id, firmId]),
      pool.query('SELECT id FROM companies WHERE relationship_id = $1 AND firm_id = $2', [id, firmId]),
    ]);

    const personIds = peopleRes.rows.map(r => r.id);
    const companyIds = companiesRes.rows.map(r => r.id);

    const [taxRes, threadsRes, activityRes, engRes] = await Promise.all([

      // ── Tax deliveries ──────────────────────────────────────────────
      pool.query(`
        SELECT td.id, td.title, td.tax_year, td.status, td.company_id, td.updated_at, td.created_at,
          co.company_name,
          (SELECT json_agg(row_to_json(s)) FROM (
            SELECT tds.person_id, p.first_name || ' ' || p.last_name AS person_name, tds.approved_at
            FROM tax_delivery_signers tds
            JOIN people p ON p.id = tds.person_id
            WHERE tds.delivery_id = td.id
          ) s) AS signers
        FROM tax_deliveries td
        LEFT JOIN companies co ON co.id = td.company_id
        WHERE td.firm_id = $1
          AND (
            td.company_id = ANY($2::int[])
            OR td.id IN (SELECT delivery_id FROM tax_delivery_signers WHERE person_id = ANY($3::int[]))
          )
        ORDER BY td.tax_year DESC, td.updated_at DESC
        LIMIT 12
      `, [firmId, companyIds, personIds]),

      // ── Last 5 threads (across all people) ─────────────────────────
      personIds.length
        ? pool.query(`
          SELECT mt.id, mt.subject, mt.status, mt.last_message_at, mt.person_id,
            p.first_name || ' ' || p.last_name AS person_name,
            (SELECT body FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT sender_type FROM messages m WHERE m.thread_id = mt.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender_type,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL)::int AS unread_count
          FROM message_threads mt
          JOIN people p ON p.id = mt.person_id
          WHERE mt.firm_id = $1 AND mt.person_id = ANY($2::int[])
          ORDER BY mt.last_message_at DESC NULLS LAST
          LIMIT 5
        `, [firmId, personIds])
        : Promise.resolve({ rows: [] }),

      // ── Activity feed (synthesized from multiple tables) ────────────
      pool.query(`
        SELECT * FROM (

          -- Documents uploaded
          SELECT
            'document' AS type,
            COALESCE(d.display_name, 'Document') AS title,
            '📄' AS icon,
            d.created_at AS event_at,
            CASE d.owner_type
              WHEN 'person' THEN (SELECT first_name || ' ' || last_name FROM people WHERE id = d.owner_id)
              WHEN 'company' THEN (SELECT company_name FROM companies WHERE id = d.owner_id)
              ELSE 'Firm'
            END AS entity_name
          FROM documents d
          WHERE d.firm_id = $1
            AND (
              (d.owner_type = 'person' AND d.owner_id = ANY($2::int[]))
              OR (d.owner_type = 'company' AND d.owner_id = ANY($3::int[]))
              OR (d.owner_type = 'relationship' AND d.owner_id = $4)
            )

          UNION ALL

          -- Tax delivery events (non-draft)
          SELECT
            'tax' AS type,
            CASE td.status
              WHEN 'sent'     THEN 'Tax return sent: ' || td.title
              WHEN 'signed'   THEN 'Tax return signed: ' || td.title
              WHEN 'approved' THEN 'Tax return approved: ' || td.title
              WHEN 'changes_requested' THEN 'Changes requested: ' || td.title
              ELSE 'Tax return updated: ' || td.title
            END AS title,
            '📊' AS icon,
            td.updated_at AS event_at,
            COALESCE(co.company_name, (
              SELECT first_name || ' ' || last_name FROM people p
              JOIN tax_delivery_signers tds ON tds.person_id = p.id
              WHERE tds.delivery_id = td.id LIMIT 1
            ), 'Personal Return') AS entity_name
          FROM tax_deliveries td
          LEFT JOIN companies co ON co.id = td.company_id
          WHERE td.firm_id = $1 AND td.status != 'draft'
            AND (
              td.company_id = ANY($3::int[])
              OR td.id IN (SELECT delivery_id FROM tax_delivery_signers WHERE person_id = ANY($2::int[]))
            )

          UNION ALL

          -- Message thread activity
          SELECT
            'message' AS type,
            COALESCE(NULLIF(mt.subject, ''), 'Message thread') AS title,
            '💬' AS icon,
            mt.last_message_at AS event_at,
            p.first_name || ' ' || p.last_name AS entity_name
          FROM message_threads mt
          JOIN people p ON p.id = mt.person_id
          WHERE mt.firm_id = $1 AND mt.person_id = ANY($2::int[])

        ) feed
        ORDER BY event_at DESC NULLS LAST
        LIMIT 10
      `, [firmId, personIds, companyIds, id]),

      // ── Active engagement letters ───────────────────────────────
      pool.query(`
        SELECT id, display_name, extracted_data, extracted_at, created_at
        FROM engagement_letters
        WHERE firm_id = $1 AND relationship_id = $2 AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 3
      `).catch(() => ({ rows: [] })),

    ]);

    res.json({
      tax_deliveries: taxRes.rows,
      threads: threadsRes.rows,
      activity: activityRes.rows,
      active_engagements: engRes.rows || [],
    });

  } catch (err) {
    console.error('GET /relationships/:id/snapshot error:', err);
    res.status(500).json({ error: 'Failed to fetch snapshot' });
  }
});

// GET /:id/companies — list companies in this relationship
router.get('/:id/companies', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows: rel } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (rel.length === 0) return res.status(404).json({ error: 'Relationship not found' });

    const { rows } = await pool.query(
      'SELECT * FROM companies WHERE relationship_id = $1 AND firm_id = $2 ORDER BY company_name ASC',
      [id, firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /relationships/:id/companies error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET /:id/people — list people in this relationship
router.get('/:id/people', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows: rel } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (rel.length === 0) return res.status(404).json({ error: 'Relationship not found' });

    const { rows } = await pool.query(`
      SELECT id, first_name, last_name, email, phone, filing_status, portal_enabled, ssn_last4,
             (ssn_encrypted IS NOT NULL AND ssn_encrypted != '') AS has_ssn,
             (date_of_birth_encrypted IS NOT NULL AND date_of_birth_encrypted != '') AS has_dob
      FROM people
      WHERE relationship_id = $1 AND firm_id = $2
      ORDER BY last_name ASC, first_name ASC
    `, [id, firmId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /relationships/:id/people error:', err);
    res.status(500).json({ error: 'Failed to fetch people' });
  }
});

module.exports = router;
