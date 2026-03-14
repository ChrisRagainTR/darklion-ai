const express = require('express');
const path = require('path');

// Load .env if present
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (e) {
  // .env loading is optional
}

const { initDB } = require('./db');
const authRouter = require('./routes/auth');
const apiRouter = require('./routes/api');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// --- Authentication middleware ---
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS;

function requireAuth(req, res, next) {
  if (!DASH_PASS) return next(); // no password set = no auth (dev mode)

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const encoded = authHeader.split(' ')[1];
    if (encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
      if (user === DASH_USER && pass === DASH_PASS) return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="DarkLion Dashboard"');
  res.status(401).send('Authentication required');
}

// Public static files
const publicDir = path.join(__dirname, '..', 'public');
const publicFiles = ['index.html', 'connect.html', 'callback.html', 'disconnect.html', 'privacy.html', 'terms.html', 'lion-logo.png', 'CNAME'];
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
for (const file of publicFiles) {
  app.get(`/${file}`, (req, res, next) => {
    res.sendFile(path.join(publicDir, file), err => { if (err) next(); });
  });
}

// Clean URL routes (no .html extension)
app.get('/connect', (req, res) => res.sendFile(path.join(publicDir, 'connect.html')));
app.get('/callback', (req, res) => res.sendFile(path.join(publicDir, 'callback.html')));
app.get('/disconnect', (req, res) => res.sendFile(path.join(publicDir, 'disconnect.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(publicDir, 'terms.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));

// Protected dashboard (with .html)
app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(publicDir, 'dashboard.html'));
});

// API routes (protected)
app.use('/auth', authRouter);
app.use('/api', requireAuth, apiRouter);

// Health check
app.get('/health', async (req, res) => {
  const { pool } = require('./db');
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM companies');
  res.json({ status: 'ok', companies: rows[0].c });
});

// Start server after DB is ready
async function start() {
  await initDB();
  console.log('Database initialized');

  app.listen(PORT, () => {
    console.log(`DarkLion server running on port ${PORT}`);
    startScheduler();
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
