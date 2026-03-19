const { Router } = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');

const router = Router();

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = '24h';

// --- Rate limiters ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  // Use default IP key generator (handles IPv6 correctly)
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
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

// --- POST /firms/register ---
router.post('/register', registerLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    // Validate
    if (!name) return res.status(400).json({ error: 'Firm name is required' });

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    // Check duplicate email
    const existing = await pool.query('SELECT id FROM firms WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await auditLog(null, 'register_fail', `Duplicate email: ${email}`, ip);
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash & create
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      'INSERT INTO firms (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, plan, created_at',
      [name, email, password_hash]
    );
    const firm = rows[0];

    const token = jwt.sign(
      { id: firm.id, email: firm.email, name: firm.name },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

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

    const { rows } = await pool.query(
      'SELECT id, name, email, password_hash, plan FROM firms WHERE email = $1',
      [email]
    );

    const firm = rows[0];

    // Always run bcrypt to prevent timing attacks
    const dummyHash = '$2b$12$invalidhashfortimingnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn';
    const match = firm
      ? await bcrypt.compare(password, firm.password_hash)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!firm || !match) {
      await auditLog(firm?.id || null, 'login_fail', `Failed login: ${email}`, ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: firm.id, email: firm.email, name: firm.name },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    await auditLog(firm.id, 'login_success', `Login: ${email}`, ip);

    res.json({
      token,
      firm: { id: firm.id, name: firm.name, email: firm.email, plan: firm.plan },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// --- GET /firms/me — get current firm info (requires auth, used by dashboard) ---
router.get('/me', async (req, res) => {
  // requireFirm middleware attached in index.js for this route
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, plan, created_at FROM firms WHERE id = $1',
      [req.firm.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Firm not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch firm info' });
  }
});

module.exports = router;
module.exports.auditLog = auditLog;
