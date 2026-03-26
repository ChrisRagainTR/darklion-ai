const { Router } = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { auditLog } = require('./firms');
const { requireFirm } = require('../middleware/requireFirm');
const { sendPortalInvite, sendPasswordReset } = require('../services/email');

// PORTAL_URL is used for client-facing invite/reset links — can differ from APP_URL in dev
// Set PORTAL_URL in Railway dev to https://darklion-ai-development.up.railway.app
const APP_URL = (process.env.APP_URL || 'https://darklion.ai').replace(/\/+$/, '');
const PORTAL_URL = (process.env.PORTAL_URL || process.env.APP_URL || 'https://darklion.ai').replace(/\/+$/, '');

const router = Router();

const BCRYPT_ROUNDS = 12;
const PORTAL_JWT_EXPIRES_IN = '7d';

// --- Rate limiter for portal login ---
const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// --- Password validation ---
function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}

// --- Build portal JWT ---
function buildPortalToken(person, firmId, signerRole = 'taxpayer') {
  return jwt.sign(
    {
      personId: person.id,
      firmId: firmId,
      relationshipId: person.relationship_id || null,
      email: person.email,
      name: `${person.first_name} ${person.last_name}`.trim(),
      type: 'portal',
      signerRole,
    },
    process.env.JWT_SECRET,
    { expiresIn: PORTAL_JWT_EXPIRES_IN }
  );
}

// --- POST /portal-auth/login ---
router.post('/login', portalLoginLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const firmSlug = (req.body.firmSlug || '').trim().toLowerCase();

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    let query;
    let params;

    if (firmSlug) {
      // Firm-scoped lookup via slug — matches primary OR spouse email
      query = `
        SELECT p.*,
          CASE WHEN LOWER(p.email) = LOWER($1) THEN 'taxpayer' ELSE 'spouse' END as signer_role,
          f.name as firm_name, f.id as firm_id_val
        FROM people p
        JOIN firms f ON f.id = p.firm_id
        WHERE f.slug = $2
          AND (
            (LOWER(p.email) = LOWER($1) AND p.portal_enabled = true AND p.portal_password_hash IS NOT NULL)
            OR
            (LOWER(p.spouse_email) = LOWER($1) AND p.spouse_portal_enabled = true AND p.spouse_portal_password_hash IS NOT NULL)
          )
        LIMIT 1
      `;
      params = [email, firmSlug];
    } else {
      // Global lookup — matches primary OR spouse email
      query = `
        SELECT p.*,
          CASE WHEN LOWER(p.email) = LOWER($1) THEN 'taxpayer' ELSE 'spouse' END as signer_role,
          f.name as firm_name, f.id as firm_id_val
        FROM people p
        JOIN firms f ON f.id = p.firm_id
        WHERE (
          (LOWER(p.email) = LOWER($1) AND p.portal_enabled = true AND p.portal_password_hash IS NOT NULL)
          OR
          (LOWER(p.spouse_email) = LOWER($1) AND p.spouse_portal_enabled = true AND p.spouse_portal_password_hash IS NOT NULL)
        )
        ORDER BY p.portal_last_login_at DESC NULLS LAST
        LIMIT 1
      `;
      params = [email];
    }

    const { rows } = await pool.query(query, params);
    const person = rows[0];
    const signerRole = person?.signer_role || 'taxpayer';

    // Timing-safe: always run bcrypt
    const dummyHash = '$2b$12$invalidhashfortiming0000000000000000000000000000000000000';
    let hashToCheck = dummyHash;
    if (person) {
      hashToCheck = signerRole === 'spouse'
        ? (person.spouse_portal_password_hash || dummyHash)
        : (person.portal_password_hash || dummyHash);
    }
    const match = person
      ? await bcrypt.compare(password, hashToCheck)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!person || !match) {
      await auditLog(person?.firm_id || null, 'portal_login_fail', `Failed portal login: ${email}`, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login timestamp for the appropriate login type
    if (signerRole === 'spouse') {
      await pool.query('UPDATE people SET spouse_portal_last_login_at = NOW() WHERE id = $1', [person.id]);
    } else {
      await pool.query('UPDATE people SET portal_last_login_at = NOW() WHERE id = $1', [person.id]);
    }
    await auditLog(person.firm_id, 'portal_login_success', `Portal login (${signerRole}): ${email}`, ip);

    const token = buildPortalToken(person, person.firm_id, signerRole);

    res.json({
      token,
      person: {
        id: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        firmId: person.firm_id,
        firmName: person.firm_name,
        relationshipId: person.relationship_id,
        signerRole,
      },
    });
  } catch (err) {
    console.error('Portal login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// --- GET /portal-auth/invite/:token ---
router.get('/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    // Check primary invite token first, then spouse invite token
    const { rows } = await pool.query(
      `SELECT p.email, p.first_name, p.last_name, p.portal_enabled,
              p.portal_invite_expires_at, f.name as firm_name,
              p.spouse_name, p.spouse_email, p.spouse_portal_enabled,
              p.spouse_portal_invite_expires_at,
              CASE WHEN p.portal_invite_token = $1 THEN 'taxpayer' ELSE 'spouse' END as invite_type
       FROM people p
       JOIN firms f ON f.id = p.firm_id
       WHERE p.portal_invite_token = $1 OR p.spouse_portal_invite_token = $1`,
      [token]
    );

    if (rows.length === 0) {
      return res.json({ valid: false, expired: false, alreadyAccepted: false });
    }

    const inv = rows[0];
    const isSpouse = inv.invite_type === 'spouse';
    const expired = isSpouse
      ? (inv.spouse_portal_invite_expires_at && new Date(inv.spouse_portal_invite_expires_at) < new Date())
      : (inv.portal_invite_expires_at && new Date(inv.portal_invite_expires_at) < new Date());
    const alreadyAccepted = isSpouse ? !!inv.spouse_portal_enabled : !!inv.portal_enabled;
    const displayEmail = isSpouse ? inv.spouse_email : inv.email;
    const displayName = isSpouse ? (inv.spouse_name || 'Spouse') : `${inv.first_name} ${inv.last_name}`.trim();

    res.json({
      valid: !expired && !alreadyAccepted,
      email: displayEmail,
      firstName: displayName.split(' ')[0] || inv.first_name,
      lastName: displayName.split(' ').slice(1).join(' ') || inv.last_name,
      firmName: inv.firm_name,
      expired: !!expired,
      alreadyAccepted,
    });
  } catch (err) {
    console.error('Invite lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /portal-auth/invite/:token/accept ---
router.post('/invite/:token/accept', async (req, res) => {
  const ip = req.ip;
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    // Check primary portal_invite_token first, then spouse_portal_invite_token
    let { rows } = await pool.query(
      `SELECT p.*, f.name as firm_name, 'taxpayer' as signer_role
       FROM people p
       JOIN firms f ON f.id = p.firm_id
       WHERE p.portal_invite_token = $1`,
      [token]
    );

    if (rows.length === 0) {
      // Try spouse token
      const spouseResult = await pool.query(
        `SELECT p.*, f.name as firm_name, 'spouse' as signer_role
         FROM people p
         JOIN firms f ON f.id = p.firm_id
         WHERE p.spouse_portal_invite_token = $1`,
        [token]
      );
      rows = spouseResult.rows;
    }

    if (rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
    const person = rows[0];
    const signerRole = person.signer_role;

    if (signerRole === 'spouse') {
      const expired = person.spouse_portal_invite_expires_at && new Date(person.spouse_portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Invite link has expired' });
      if (person.spouse_portal_enabled && person.spouse_portal_password_hash) return res.status(409).json({ error: 'Invite already accepted' });

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await pool.query(
        `UPDATE people SET
           spouse_portal_enabled = true,
           spouse_portal_password_hash = $1,
           spouse_portal_invite_token = NULL,
           spouse_portal_invite_expires_at = NULL,
           spouse_portal_last_login_at = NOW()
         WHERE id = $2`,
        [passwordHash, person.id]
      );
      await auditLog(person.firm_id, 'portal_invite_accepted', `${person.spouse_email} accepted spouse portal invite`, ip);
    } else {
      const expired = person.portal_invite_expires_at && new Date(person.portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Invite link has expired' });
      if (person.portal_enabled) return res.status(409).json({ error: 'Invite already accepted' });

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await pool.query(
        `UPDATE people SET
           portal_enabled = true,
           portal_password_hash = $1,
           portal_invite_token = NULL,
           portal_invite_expires_at = NULL,
           portal_last_login_at = NOW()
         WHERE id = $2`,
        [passwordHash, person.id]
      );
      await auditLog(person.firm_id, 'portal_invite_accepted', `${person.email} accepted portal invite`, ip);
    }

    const jwtToken = buildPortalToken(person, person.firm_id, signerRole);

    res.json({
      token: jwtToken,
      person: {
        id: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        firmId: person.firm_id,
        firmName: person.firm_name,
        relationshipId: person.relationship_id,
        signerRole,
      },
    });
  } catch (err) {
    console.error('Invite accept error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// --- POST /portal-auth/forgot-password ---
router.post('/forgot-password', async (req, res) => {
  const ip = req.ip;
  try {
    const email = (req.body.email || '').trim().toLowerCase();

    // Always return ok to prevent email enumeration
    if (!email) return res.json({ ok: true });

    // Check primary email first, then spouse email
    let { rows } = await pool.query(
      `SELECT p.*, 'taxpayer' as signer_role FROM people p
       WHERE LOWER(p.email) = $1 AND p.portal_enabled = true
       LIMIT 1`,
      [email]
    );

    if (rows.length === 0) {
      const spouseResult = await pool.query(
        `SELECT p.*, 'spouse' as signer_role FROM people p
         WHERE LOWER(p.spouse_email) = $1 AND p.spouse_portal_enabled = true
         LIMIT 1`,
        [email]
      );
      rows = spouseResult.rows;
    }

    if (rows.length > 0) {
      const person = rows[0];
      const signerRole = person.signer_role;
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      if (signerRole === 'spouse') {
        await pool.query(
          `UPDATE people SET spouse_portal_invite_token = $1, spouse_portal_invite_expires_at = $2 WHERE id = $3`,
          [resetToken, expiresAt, person.id]
        );
      } else {
        await pool.query(
          `UPDATE people SET portal_invite_token = $1, portal_invite_expires_at = $2 WHERE id = $3`,
          [resetToken, expiresAt, person.id]
        );
      }

      await auditLog(person.firm_id, 'portal_password_reset_requested', `Password reset requested: ${email} (${signerRole})`, ip);

      // Send reset email (graceful — don't fail if email service is down)
      try {
        const { rows: firmRows } = await pool.query('SELECT name FROM firms WHERE id = $1', [person.firm_id]);
        const firmName = firmRows[0]?.name || 'Your Advisory Firm';
        const resetUrl = `${PORTAL_URL}/portal-login?reset=${resetToken}`;
        const toEmail = signerRole === 'spouse' ? person.spouse_email : person.email;
        const toName = signerRole === 'spouse'
          ? (person.spouse_name || 'Spouse')
          : `${person.first_name} ${person.last_name}`.trim();
        await sendPasswordReset({
          to: toEmail,
          name: toName,
          firmName,
          firmId: person.firm_id,
          resetUrl,
        });
      } catch (emailErr) {
        console.error('Password reset email failed (non-fatal):', emailErr.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Request failed. Please try again.' });
  }
});

// --- POST /portal-auth/reset-password/:token ---
router.post('/reset-password/:token', async (req, res) => {
  const ip = req.ip;
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    // Check primary token first, then spouse token
    let { rows } = await pool.query(
      `SELECT p.*, f.name as firm_name, 'taxpayer' as signer_role
       FROM people p
       JOIN firms f ON f.id = p.firm_id
       WHERE p.portal_invite_token = $1`,
      [token]
    );

    if (rows.length === 0) {
      const spouseResult = await pool.query(
        `SELECT p.*, f.name as firm_name, 'spouse' as signer_role
         FROM people p
         JOIN firms f ON f.id = p.firm_id
         WHERE p.spouse_portal_invite_token = $1`,
        [token]
      );
      rows = spouseResult.rows;
    }

    if (rows.length === 0) return res.status(404).json({ error: 'Invalid or expired reset link' });
    const person = rows[0];
    const signerRole = person.signer_role;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    if (signerRole === 'spouse') {
      const expired = person.spouse_portal_invite_expires_at && new Date(person.spouse_portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Reset link has expired' });

      await pool.query(
        `UPDATE people SET
           spouse_portal_password_hash = $1,
           spouse_portal_invite_token = NULL,
           spouse_portal_invite_expires_at = NULL,
           spouse_portal_last_login_at = NOW()
         WHERE id = $2`,
        [passwordHash, person.id]
      );
      await auditLog(person.firm_id, 'portal_password_reset', `Spouse password reset completed: ${person.spouse_email}`, ip);
    } else {
      const expired = person.portal_invite_expires_at && new Date(person.portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Reset link has expired' });

      await pool.query(
        `UPDATE people SET
           portal_password_hash = $1,
           portal_invite_token = NULL,
           portal_invite_expires_at = NULL,
           portal_last_login_at = NOW()
         WHERE id = $2`,
        [passwordHash, person.id]
      );
      await auditLog(person.firm_id, 'portal_password_reset', `Password reset completed: ${person.email}`, ip);
    }

    const jwtToken = buildPortalToken(person, person.firm_id, signerRole);

    res.json({
      token: jwtToken,
      person: {
        id: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        firmId: person.firm_id,
        firmName: person.firm_name,
        relationshipId: person.relationship_id,
        signerRole,
      },
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// --- GET /portal-auth/firm-info ---
router.get('/firm-info', async (req, res) => {
  try {
    const slug = (req.query.slug || '').trim().toLowerCase();

    let query;
    let params;

    if (slug) {
      query = 'SELECT id, name, slug FROM firms WHERE slug = $1 LIMIT 1';
      params = [slug];
    } else {
      query = 'SELECT id, name, slug FROM firms ORDER BY id ASC LIMIT 1';
      params = [];
    }

    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Firm not found' });
    }

    const firm = rows[0];
    res.json({
      firmName: firm.name,
      slug: firm.slug || '',
      logoUrl: null,
    });
  } catch (err) {
    console.error('Firm info error:', err);
    res.status(500).json({ error: 'Failed to fetch firm info' });
  }
});

// --- POST /portal-auth/send-invite (staff only — requires firm JWT) ---
router.post('/send-invite', requireFirm, async (req, res) => {
  const ip = req.ip;
  try {
    const { personId, spouse = false } = req.body;
    if (!personId) return res.status(400).json({ error: 'personId is required' });

    const firmId = req.firm.id;

    // Look up person (must belong to this firm)
    const { rows: personRows } = await pool.query(
      `SELECT p.*, f.name as firm_name
       FROM people p
       JOIN firms f ON f.id = p.firm_id
       WHERE p.id = $1 AND p.firm_id = $2`,
      [personId, firmId]
    );

    if (personRows.length === 0) return res.status(404).json({ error: 'Person not found' });
    const person = personRows[0];

    // Generate invite token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    if (spouse) {
      // Spouse invite
      if (!person.spouse_email) return res.status(400).json({ error: 'Person has no spouse email address' });

      await pool.query(
        `UPDATE people SET
           spouse_portal_invite_token = $1,
           spouse_portal_invite_expires_at = $2
         WHERE id = $3`,
        [token, expiresAt, person.id]
      );

      await auditLog(firmId, 'portal_invite_sent', `Spouse portal invite sent to ${person.spouse_email}`, ip);

      const inviteUrl = `${PORTAL_URL}/portal-login?invite=${token}`;

      try {
        await sendPortalInvite({
          to: person.spouse_email,
          name: person.spouse_name || 'Spouse',
          firmName: person.firm_name,
          firmId: person.firm_id,
          inviteUrl,
        });
      } catch (emailErr) {
        console.error('Spouse portal invite email failed (non-fatal):', emailErr.message);
      }

      res.json({ ok: true, inviteUrl });
    } else {
      // Primary taxpayer invite
      if (!person.email) return res.status(400).json({ error: 'Person has no email address' });

      await pool.query(
        `UPDATE people SET
           portal_invite_token = $1,
           portal_invite_expires_at = $2,
           portal_enabled = false
         WHERE id = $3`,
        [token, expiresAt, person.id]
      );

      await auditLog(firmId, 'portal_invite_sent', `Portal invite sent to ${person.email}`, ip);

      const inviteUrl = `${PORTAL_URL}/portal-login?invite=${token}`;

      try {
        await sendPortalInvite({
          to: person.email,
          name: `${person.first_name} ${person.last_name}`.trim(),
          firmName: person.firm_name,
          firmId: person.firm_id,
          inviteUrl,
        });
      } catch (emailErr) {
        console.error('Portal invite email failed (non-fatal):', emailErr.message);
      }

      res.json({ ok: true, inviteUrl });
    }
  } catch (err) {
    console.error('Send invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

module.exports = router;
