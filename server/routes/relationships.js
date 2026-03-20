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

// GET /all-companies — all CRM companies for this firm with relationship name
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

// GET /all-people — all CRM people for this firm with relationship name
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

module.exports = router;
