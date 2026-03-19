const jwt = require('jsonwebtoken');
const { pool } = require('../db');

function requireFirm(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Support both old JWT format { id, email, name } and new { firmId, userId, role, email, name }
    const firmId = payload.firmId || payload.id;
    const userId = payload.userId || null;
    const role = payload.role || 'owner';
    const email = payload.email;
    const name = payload.name;

    req.firm = { id: firmId, userId, role, email, name };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please log in again', expired: true });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { requireFirm };
