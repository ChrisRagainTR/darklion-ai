const jwt = require('jsonwebtoken');

function requirePortal(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.type !== 'portal') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    req.portal = {
      personId: payload.personId,
      firmId: payload.firmId,
      relationshipId: payload.relationshipId,
      email: payload.email,
      name: payload.name,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please log in again', expired: true });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { requirePortal };
