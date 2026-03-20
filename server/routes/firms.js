const { Router } = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { pool } = require('../db');
const { requireFirm } = require('../middleware/requireFirm');
const { uploadFile, getSignedDownloadUrl } = require('../services/s3');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { cb(null, file.mimetype.startsWith('image/')); },
});

const router = Router();

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = '24h';

// --- Rate limiters ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many registration attempts. Please try again later.' },
});

// --- Input validation ---
function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}

function validateEmail(email) {
  if (!email || !email.includes('@') || !email.includes('.')) return 'Invalid email address';
  return null;
}

// --- Audit logging helper ---
async function auditLog(firmId, action, detail, ip) {
  try {
    await pool.query(
      'INSERT INTO audit_log (firm_id, action, detail, ip) VALUES ($1, $2, $3, $4)',
      [firmId || null, action, detail || null, ip || null]
    );
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// --- Build JWT payload from firm_users row + firm row ---
function buildToken(firmUser, firmName) {
  return jwt.sign(
    {
      firmId: firmUser.firm_id,
      userId: firmUser.id,
      role: firmUser.role,
      email: firmUser.email,
      name: firmUser.name || firmName || '',
    },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// --- POST /firms/register ---
router.post('/register', registerLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!name) return res.status(400).json({ error: 'Firm name is required' });

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    const existing = await pool.query('SELECT id FROM firms WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await auditLog(null, 'register_fail', `Duplicate email: ${email}`, ip);
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create firm
    const { rows: [firm] } = await pool.query(
      'INSERT INTO firms (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, plan, created_at',
      [name, email, password_hash]
    );

    // Create owner firm_user
    const { rows: [firmUser] } = await pool.query(
      `INSERT INTO firm_users (firm_id, name, email, password_hash, role, accepted_at)
       VALUES ($1, $2, $3, $4, 'owner', NOW())
       RETURNING id, firm_id, name, email, role`,
      [firm.id, name, email, password_hash]
    );

    const token = buildToken(firmUser, firm.name);
    await auditLog(firm.id, 'register', `Firm registered: ${name} (${email})`, ip);

    res.status(201).json({
      token,
      firm: { id: firm.id, name: firm.name, email: firm.email, plan: firm.plan },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// --- POST /firms/login ---
router.post('/login', loginLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Look up in firm_users first
    const { rows } = await pool.query(
      `SELECT fu.id, fu.firm_id, fu.name, fu.email, fu.password_hash, fu.role, fu.accepted_at,
              f.name as firm_name, f.plan
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE fu.email = $1`,
      [email]
    );

    const firmUser = rows[0];

    // Timing-safe: always run bcrypt
    const dummyHash = '$2b$12$invalidhashfortiming0000000000000000000000000000000000000';
    const match = firmUser
      ? await bcrypt.compare(password, firmUser.password_hash || dummyHash)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!firmUser || !match || !firmUser.accepted_at) {
      await auditLog(firmUser?.firm_id || null, 'login_fail', `Failed login: ${email}`, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last_login_at
    await pool.query('UPDATE firm_users SET last_login_at = NOW() WHERE id = $1', [firmUser.id]);

    const token = buildToken(firmUser, firmUser.firm_name);
    await auditLog(firmUser.firm_id, 'login_success', `Login: ${email}`, ip);

    res.json({
      token,
      firm: { id: firmUser.firm_id, name: firmUser.firm_name, email: firmUser.email, plan: firmUser.plan },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// --- GET /firms/me ---
router.get('/me', requireFirm, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, plan, created_at FROM firms WHERE id = $1',
      [req.firm.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Firm not found' });
    res.json({ ...rows[0], userId: req.firm.userId, role: req.firm.role, userName: req.firm.name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch firm info' });
  }
});

// --- POST /firms/invite ---
router.post('/invite', requireFirm, async (req, res) => {
  const ip = req.ip;
  try {
    const { email, name, role } = req.body;
    const firmId = req.firm.id;

    if (!email) return res.status(400).json({ error: 'Email is required' });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    const validRole = ['owner', 'admin'].includes(role) ? role : 'admin';
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Insert or update pending invite
    await pool.query(
      `INSERT INTO firm_users (firm_id, name, email, role, invite_token, invite_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (firm_id, email) DO UPDATE SET
         invite_token = EXCLUDED.invite_token,
         invite_expires_at = EXCLUDED.invite_expires_at,
         role = EXCLUDED.role,
         name = COALESCE(NULLIF(EXCLUDED.name,''), firm_users.name)`,
      [firmId, name || '', email.trim().toLowerCase(), validRole, inviteToken, expiresAt]
    );

    await auditLog(firmId, 'invite_sent', `Invited ${email} as ${validRole}`, ip);

    const inviteUrl = `/invite/${inviteToken}`;
    res.json({ inviteUrl, token: inviteToken });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// --- GET /firms/team ---
router.get('/team', requireFirm, async (req, res) => {
  try {
    const firmId = req.firm.id;
    const { rows: users } = await pool.query(
      `SELECT id, firm_id, name, email, role, accepted_at, created_at, last_login_at, invite_expires_at,
              avatar_url,
              (invite_token IS NOT NULL AND accepted_at IS NULL) as pending
       FROM firm_users
       WHERE firm_id = $1
       ORDER BY created_at ASC`,
      [firmId]
    );

    // Fetch company access for each user
    const userIds = users.map(u => u.id);
    let companyMap = {};
    if (userIds.length > 0) {
      const { rows: access } = await pool.query(
        `SELECT firm_user_id, realm_id FROM firm_user_companies WHERE firm_user_id = ANY($1)`,
        [userIds]
      );
      for (const a of access) {
        if (!companyMap[a.firm_user_id]) companyMap[a.firm_user_id] = [];
        companyMap[a.firm_user_id].push(a.realm_id);
      }
    }

    const result = users.map(u => ({
      ...u,
      allowed_realm_ids: companyMap[u.id] || [], // empty = all access
    }));

    res.json(result);
  } catch (err) {
    console.error('Team fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// --- PUT /firms/team/:userId (edit name/email) ---
router.put('/team/:userId', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can edit team members' });
    const { name, email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const targetId = parseInt(req.params.userId);
    if (targetId === req.firm.userId) return res.status(400).json({ error: 'Cannot edit your own account this way' });
    // Check email not already taken by another user in this firm
    const existing = await pool.query(
      'SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 AND id != $3',
      [req.firm.id, email.toLowerCase().trim(), targetId]
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already in use by another team member' });
    await pool.query(
      'UPDATE firm_users SET name = $1, email = $2 WHERE id = $3 AND firm_id = $4',
      [name?.trim() || '', email.toLowerCase().trim(), targetId, req.firm.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DELETE /firms/team/:userId ---
router.delete('/team/:userId', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can remove team members' });

    const targetUserId = parseInt(req.params.userId);
    if (targetUserId === req.firm.userId) return res.status(400).json({ error: 'Cannot remove yourself' });

    const { rowCount } = await pool.query(
      'DELETE FROM firm_users WHERE id = $1 AND firm_id = $2',
      [targetUserId, req.firm.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'User not found' });

    await auditLog(req.firm.id, 'team_remove', `Removed user ${targetUserId}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /firms/team/:userId/role ---
router.put('/team/:userId/role', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can change roles' });

    const targetUserId = parseInt(req.params.userId);
    const { role } = req.body;
    if (!['owner', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const { rowCount } = await pool.query(
      'UPDATE firm_users SET role = $1 WHERE id = $2 AND firm_id = $3',
      [role, targetUserId, req.firm.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'User not found' });

    await auditLog(req.firm.id, 'team_role_change', `User ${targetUserId} → ${role}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /firms/team/:userId/companies ---
router.put('/team/:userId/companies', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can manage company access' });

    const targetUserId = parseInt(req.params.userId);
    const realmIds = Array.isArray(req.body.realmIds) ? req.body.realmIds : [];

    // Verify user belongs to this firm
    const { rows } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [targetUserId, req.firm.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    // Replace all access rows
    await pool.query('DELETE FROM firm_user_companies WHERE firm_user_id = $1', [targetUserId]);

    if (realmIds.length > 0) {
      const insertValues = realmIds.map((_, i) => `($1, $${i + 2})`).join(',');
      await pool.query(
        `INSERT INTO firm_user_companies (firm_user_id, realm_id) VALUES ${insertValues} ON CONFLICT DO NOTHING`,
        [targetUserId, ...realmIds]
      );
    }

    await auditLog(req.firm.id, 'team_company_access', `User ${targetUserId} companies: ${realmIds.length ? realmIds.join(',') : 'ALL'}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /invite/:token (public) ---
router.get('/invite-lookup/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { rows } = await pool.query(
      `SELECT fu.email, fu.name, f.name as firm_name, fu.invite_expires_at, fu.accepted_at
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE fu.invite_token = $1`,
      [token]
    );

    if (rows.length === 0) return res.json({ valid: false, firmName: '', email: '' });

    const inv = rows[0];
    const expired = inv.invite_expires_at && new Date(inv.invite_expires_at) < new Date();
    const alreadyAccepted = !!inv.accepted_at;

    res.json({
      valid: !expired && !alreadyAccepted,
      firmName: inv.firm_name,
      email: inv.email,
      name: inv.name,
      expired,
      alreadyAccepted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /invite/:token/accept (public) ---
router.post('/invite-lookup/:token/accept', async (req, res) => {
  const ip = req.ip;
  try {
    const { token } = req.params;
    const { name, password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    const { rows } = await pool.query(
      `SELECT fu.*, f.name as firm_name, f.plan
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE fu.invite_token = $1`,
      [token]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
    const firmUser = rows[0];

    const expired = firmUser.invite_expires_at && new Date(firmUser.invite_expires_at) < new Date();
    if (expired) return res.status(410).json({ error: 'Invite link has expired' });
    if (firmUser.accepted_at) return res.status(409).json({ error: 'Invite already accepted' });

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const displayName = (name || '').trim() || firmUser.name || firmUser.email;

    await pool.query(
      `UPDATE firm_users SET name = $1, password_hash = $2, accepted_at = NOW(), invite_token = NULL, invite_expires_at = NULL, last_login_at = NOW()
       WHERE id = $3`,
      [displayName, password_hash, firmUser.id]
    );

    const jwtToken = buildToken({ ...firmUser, name: displayName }, firmUser.firm_name);
    await auditLog(firmUser.firm_id, 'invite_accepted', `${firmUser.email} accepted invite`, ip);

    res.json({
      token: jwtToken,
      firm: { id: firmUser.firm_id, name: firmUser.firm_name, email: firmUser.email, plan: firmUser.plan },
    });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// --- POST /firms/team/:userId/avatar ---
router.post('/team/:userId/avatar', requireFirm, upload.single('avatar'), async (req, res) => {
  try {
    const firmId = req.firm.id;
    const targetUserId = parseInt(req.params.userId);

    // Verify user belongs to this firm
    const { rows } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [targetUserId, firmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const mime = req.file.mimetype;
    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext = extMap[mime] || 'jpg';
    const key = `avatars/${firmId}/${targetUserId}.${ext}`;
    const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';

    await uploadFile({ buffer: req.file.buffer, key, mimeType: mime, bucket });

    await pool.query(
      'UPDATE firm_users SET avatar_url = $1 WHERE id = $2 AND firm_id = $3',
      [key, targetUserId, firmId]
    );

    const signedUrl = await getSignedDownloadUrl({ key, bucket });
    res.json({ ok: true, avatar_url: signedUrl });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Avatar upload failed: ' + err.message });
  }
});

// --- GET /firms/team/:userId/avatar ---
router.get('/team/:userId/avatar', requireFirm, async (req, res) => {
  try {
    const firmId = req.firm.id;
    const targetUserId = parseInt(req.params.userId);

    const { rows } = await pool.query(
      'SELECT avatar_url FROM firm_users WHERE id = $1 AND firm_id = $2',
      [targetUserId, firmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const key = rows[0].avatar_url;
    if (!key) return res.json({ url: null });

    const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
    const url = await getSignedDownloadUrl({ key, bucket });
    res.json({ url });
  } catch (err) {
    console.error('Avatar fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch avatar: ' + err.message });
  }
});

module.exports = router;
module.exports.auditLog = auditLog;
