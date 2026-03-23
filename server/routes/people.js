const { Router } = require('express');
const { pool } = require('../db');
const { encrypt, decrypt } = require('../utils/encryption');
const crypto = require('crypto');
const { sendPasswordReset } = require('../services/email');

const APP_URL = (process.env.APP_URL || 'https://darklion.ai').replace(/\/+$/, '');

const router = Router();

// Strip sensitive fields and add computed flags for GET responses
function sanitizePerson(row) {
  const person = { ...row };
  delete person.ssn_encrypted;
  delete person.ssn_last4;
  delete person.portal_password_hash;
  // Decrypt DOB for staff display
  if (row.date_of_birth_encrypted) {
    try { person.date_of_birth = decrypt(row.date_of_birth_encrypted); } catch(e) { person.date_of_birth = null; }
  } else {
    person.date_of_birth = null;
  }
  delete person.date_of_birth_encrypted;
  person.has_dob = !!person.date_of_birth;
  return person;
}

// GET / — list all people for this firm (with relationship name)
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(`
      SELECT
        p.*,
        r.name AS relationship_name,
        COALESCE((
          SELECT SUM((SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.sender_type = 'client' AND m.read_at IS NULL AND m.is_internal = false))
          FROM message_threads mt WHERE mt.person_id = p.id AND mt.firm_id = p.firm_id AND mt.status != 'archived'
        ), 0) AS unread_count
      FROM people p
      LEFT JOIN relationships r ON r.id = p.relationship_id
      WHERE p.firm_id = $1
      ORDER BY p.last_name ASC, p.first_name ASC
    `, [firmId]);
    res.json(rows.map(sanitizePerson));
  } catch (err) {
    console.error('GET /people error:', err);
    res.status(500).json({ error: 'Failed to fetch people' });
  }
});

// POST / — create a person
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  const {
    relationship_id,
    first_name = '',
    last_name = '',
    email = '',
    phone = '',
    filing_status = '',
    spouse_id = null,
    portal_enabled = false,
    stanford_tax_url = '',
    notes = '',
    date_of_birth,
  } = req.body;

  if (!relationship_id) return res.status(400).json({ error: 'relationship_id is required' });

  try {
    // Verify relationship belongs to this firm
    const { rows: relRows } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [relationship_id, firmId]
    );
    if (relRows.length === 0) return res.status(404).json({ error: 'Relationship not found' });

    const date_of_birth_encrypted = date_of_birth ? encrypt(date_of_birth) : '';

    const { rows } = await pool.query(`
      INSERT INTO people (
        firm_id, relationship_id, first_name, last_name, email, phone,
        date_of_birth_encrypted,
        filing_status, spouse_id, portal_enabled, stanford_tax_url, notes,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      RETURNING *
    `, [
      firmId, relationship_id, first_name, last_name, email, phone,
      date_of_birth_encrypted,
      filing_status, spouse_id, portal_enabled, stanford_tax_url, notes,
    ]);

    res.status(201).json(sanitizePerson(rows[0]));
  } catch (err) {
    console.error('POST /people error:', err);
    res.status(500).json({ error: 'Failed to create person' });
  }
});

// GET /:id — get a person with company access list
router.get('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Person not found' });

    const person = sanitizePerson(rows[0]);

    // Include company access list
    const { rows: accessRows } = await pool.query(`
      SELECT
        pca.id,
        pca.company_id,
        pca.access_level,
        pca.ownership_pct,
        pca.created_at,
        c.company_name,
        c.entity_type,
        c.realm_id
      FROM person_company_access pca
      JOIN companies c ON c.id = pca.company_id
      WHERE pca.person_id = $1
      ORDER BY c.company_name ASC
    `, [id]);

    person.company_access = accessRows;

    // Include spouse data if set
    if (person.spouse_id) {
      const { rows: spouseRows } = await pool.query(
        'SELECT id, first_name, last_name, email, phone, filing_status, portal_enabled FROM people WHERE id = $1 AND firm_id = $2',
        [person.spouse_id, firmId]
      );
      person.spouse = spouseRows[0] || null;
    } else {
      person.spouse = null;
    }

    res.json(person);
  } catch (err) {
    console.error('GET /people/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch person' });
  }
});

// PUT /:id — update a person
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const {
    relationship_id,
    first_name,
    last_name,
    email,
    phone,
    filing_status,
    spouse_id,
    portal_enabled,
    stanford_tax_url,
    notes,
    date_of_birth,
  } = req.body;

  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Person not found' });

    // If relationship_id is being updated, verify it belongs to this firm
    if (relationship_id) {
      const { rows: relRows } = await pool.query(
        'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
        [relationship_id, firmId]
      );
      if (relRows.length === 0) return res.status(404).json({ error: 'Relationship not found' });
    }

    const date_of_birth_encrypted = date_of_birth !== undefined ? encrypt(date_of_birth) : undefined;

    const { rows } = await pool.query(`
      UPDATE people
      SET
        relationship_id = COALESCE($1, relationship_id),
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        email = COALESCE($4, email),
        phone = COALESCE($5, phone),
        filing_status = COALESCE($6, filing_status),
        spouse_id = CASE WHEN $14::BOOLEAN THEN $7::INT ELSE spouse_id END,
        portal_enabled = COALESCE($8, portal_enabled),
        stanford_tax_url = COALESCE($9, stanford_tax_url),
        notes = COALESCE($10, notes),
        date_of_birth_encrypted = CASE WHEN $11::TEXT IS NOT NULL THEN $11 ELSE date_of_birth_encrypted END,
        updated_at = NOW()
      WHERE id = $12 AND firm_id = $13
      RETURNING *
    `, [
      relationship_id || null,
      first_name || null,
      last_name || null,
      email !== undefined ? email : null,
      phone !== undefined ? phone : null,
      filing_status || null,
      spouse_id !== undefined ? spouse_id : null,    // $7
      portal_enabled !== undefined ? portal_enabled : null,
      stanford_tax_url !== undefined ? stanford_tax_url : null,
      notes !== undefined ? notes : null,
      date_of_birth_encrypted !== undefined ? date_of_birth_encrypted : null,
      id,
      firmId,
      spouse_id !== undefined,                        // $14: whether spouse_id was explicitly passed
    ]);

    const updated = rows[0];

    // ── Bidirectional spouse linking ──
    // If spouse_id is being explicitly set (including null to clear it):
    if (spouse_id !== undefined) {
      const prevSpouseId = existing[0].spouse_id;

      // If we had an old spouse and it's changing, clear the reverse link on the old spouse
      if (prevSpouseId && prevSpouseId !== spouse_id) {
        await pool.query(
          'UPDATE people SET spouse_id = NULL, updated_at = NOW() WHERE id = $1 AND firm_id = $2 AND spouse_id = $3',
          [prevSpouseId, firmId, id]
        );
      }

      // If setting a new spouse, set the reverse link on them too
      if (spouse_id) {
        await pool.query(
          'UPDATE people SET spouse_id = $1, updated_at = NOW() WHERE id = $2 AND firm_id = $3',
          [id, spouse_id, firmId]
        );
      }
    }

    // ── Bidirectional Stanford Tax URL sync ──
    // If the URL was explicitly set (including cleared), sync it to the spouse too
    // Check both directions: this person's spouse_id AND anyone who has this person as their spouse
    if (stanford_tax_url !== undefined) {
      const spouseId = updated.spouse_id;
      if (spouseId) {
        await pool.query(
          'UPDATE people SET stanford_tax_url = $1, updated_at = NOW() WHERE id = $2 AND firm_id = $3',
          [stanford_tax_url || null, spouseId, firmId]
        );
      }
      // Also sync to anyone who lists this person as their spouse (reverse link)
      await pool.query(
        'UPDATE people SET stanford_tax_url = $1, updated_at = NOW() WHERE spouse_id = $2 AND firm_id = $3',
        [stanford_tax_url || null, id, firmId]
      );
    }

    res.json(sanitizePerson(updated));
  } catch (err) {
    console.error('PUT /people/:id error:', err);
    res.status(500).json({ error: 'Failed to update person' });
  }
});

// DELETE /:id — delete only if no portal activity
router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows: existing } = await pool.query(
      'SELECT * FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Person not found' });

    const person = existing[0];
    if (person.portal_last_login_at) {
      return res.status(409).json({ error: 'Cannot delete person with portal login history' });
    }

    // Remove company access first (cascade handles this, but explicit for clarity)
    await pool.query('DELETE FROM person_company_access WHERE person_id = $1', [id]);
    await pool.query('DELETE FROM people WHERE id = $1 AND firm_id = $2', [id, firmId]);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /people/:id error:', err);
    res.status(500).json({ error: 'Failed to delete person' });
  }
});

// POST /:id/company-access — grant company access
router.post('/:id/company-access', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const { company_id, access_level = 'full', ownership_pct } = req.body;

  if (!company_id) return res.status(400).json({ error: 'company_id is required' });

  try {
    // Verify person belongs to this firm
    const { rows: personRows } = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (personRows.length === 0) return res.status(404).json({ error: 'Person not found' });

    // Verify company belongs to this firm
    const { rows: companyRows } = await pool.query(
      'SELECT id FROM companies WHERE id = $1 AND firm_id = $2',
      [company_id, firmId]
    );
    if (companyRows.length === 0) return res.status(404).json({ error: 'Company not found' });

    const { rows } = await pool.query(`
      INSERT INTO person_company_access (person_id, company_id, access_level, ownership_pct, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (person_id, company_id) DO UPDATE
        SET access_level = EXCLUDED.access_level,
            ownership_pct = EXCLUDED.ownership_pct
      RETURNING *
    `, [id, company_id, access_level, ownership_pct || null]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /people/:id/company-access error:', err);
    res.status(500).json({ error: 'Failed to grant company access' });
  }
});

// DELETE /:id/company-access/:companyId — revoke company access
router.delete('/:id/company-access/:companyId', async (req, res) => {
  const firmId = req.firm.id;
  const { id, companyId } = req.params;

  try {
    // Verify person belongs to this firm
    const { rows: personRows } = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (personRows.length === 0) return res.status(404).json({ error: 'Person not found' });

    const { rowCount } = await pool.query(
      'DELETE FROM person_company_access WHERE person_id = $1 AND company_id = $2',
      [id, companyId]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'Access record not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /people/:id/company-access/:companyId error:', err);
    res.status(500).json({ error: 'Failed to revoke company access' });
  }
});

// ── POST /:id/portal-reset — staff-initiated password reset email ─────────────
router.post('/:id/portal-reset', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.email, p.first_name, p.last_name, p.portal_enabled, f.name AS firm_name
       FROM people p JOIN firms f ON f.id = p.firm_id
       WHERE p.id = $1 AND p.firm_id = $2`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = rows[0];

    if (!person.portal_enabled) {
      return res.status(400).json({ error: 'Portal is not enabled for this person' });
    }
    if (!person.email) {
      return res.status(400).json({ error: 'Person has no email address' });
    }

    // Generate reset token (same mechanism as forgot-password flow)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await pool.query(
      `UPDATE people SET portal_invite_token = $1, portal_invite_expires_at = $2 WHERE id = $3`,
      [resetToken, expires, id]
    );

    const resetUrl = `${APP_URL}/portal-login?reset=${resetToken}`;

    try {
      await sendPasswordReset({
        to: person.email,
        name: `${person.first_name} ${person.last_name}`.trim(),
        firmName: person.firm_name,
        resetUrl,
      });
    } catch (emailErr) {
      console.error('[portal-reset] email failed (non-fatal):', emailErr.message);
      // Still return ok — token is set, they can use the link
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /people/:id/portal-reset error:', err);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// ── POST /:id/portal-disable — disable portal access ─────────────────────────
router.post('/:id/portal-disable', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);

  try {
    const { rowCount } = await pool.query(
      `UPDATE people
       SET portal_enabled = false,
           portal_invite_token = NULL,
           portal_invite_expires_at = NULL
       WHERE id = $1 AND firm_id = $2`,
      [id, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Person not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /people/:id/portal-disable error:', err);
    res.status(500).json({ error: 'Failed to disable portal' });
  }
});

module.exports = router;
