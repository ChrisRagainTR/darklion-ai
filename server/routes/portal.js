const { Router } = require('express');
const { pool } = require('../db');
const { getSignedDownloadUrl } = require('../services/s3');

const router = Router();

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
          SELECT id, firm_id, owner_type, owner_id, company_id, document_type,
                 display_name, file_name, content_type, file_size, is_delivered,
                 delivered_at, tax_year, notes, created_at, updated_at
          FROM documents
          WHERE is_delivered = true
            AND (
              (owner_type = 'person' AND owner_id = $1)
              OR (owner_type = 'company' AND company_id = ANY($2))
            )
          ORDER BY created_at DESC
        `;
        params = [personId, companyIds];
      } else {
        query = `
          SELECT id, firm_id, owner_type, owner_id, company_id, document_type,
                 display_name, file_name, content_type, file_size, is_delivered,
                 delivered_at, tax_year, notes, created_at, updated_at
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
      // documents table may not exist yet — return empty array
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
// Verify the person has access to this document, generate signed URL, mark viewed
router.get('/documents/:id/download', async (req, res) => {
  const personId = req.portal.personId;
  const docId = parseInt(req.params.id);

  try {
    // Get document
    const { rows: docRows } = await pool.query(
      'SELECT id, owner_type, owner_id, s3_key, s3_bucket, is_delivered, viewed_at FROM documents WHERE id = $1 AND is_delivered = true',
      [docId]
    );
    if (!docRows[0]) return res.status(404).json({ error: 'Document not found' });

    const doc = docRows[0];

    // Verify access: document must belong to this person directly, or to a company they have access to
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

    // Mark viewed_at if first view
    if (!doc.viewed_at) {
      await pool.query('UPDATE documents SET viewed_at = NOW() WHERE id = $1', [docId]);
    }

    res.json({ url });
  } catch (err) {
    console.error('Portal /documents/:id/download error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate download URL' });
  }
});

module.exports = router;
