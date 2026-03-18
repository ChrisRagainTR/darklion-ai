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

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy headers on Fly.io (X-Forwarded-For, X-Forwarded-Proto)
app.set('trust proxy', true);

app.use(express.json());

// --- Force HTTPS in production ---
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.path === '/health') return next(); // allow healthcheck over HTTP
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}

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

// --- Health check (must be before auth, no auth required) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Public static files ---
const publicDir = path.join(__dirname, '..', 'public');

// Serve all static assets (images, etc.)
app.use(express.static(publicDir, {
  index: false, // We handle index.html routing manually
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
}));

// Public page routes
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/connect', (req, res) => res.sendFile(path.join(publicDir, 'connect.html')));
app.get('/callback', (req, res) => res.sendFile(path.join(publicDir, 'callback.html')));
app.get('/disconnect', (req, res) => res.sendFile(path.join(publicDir, 'disconnect.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(publicDir, 'terms.html')));

// Protected dashboard (both /dashboard and /dashboard.html)
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));
app.get('/dashboard.html', requireAuth, (req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));

// Public config endpoint (non-sensitive values only)
app.get('/api/config', (req, res) => {
  res.json({
    qb_client_id: process.env.QB_CLIENT_ID || '',
    qb_redirect_uri: process.env.QB_REDIRECT_URI || `${req.protocol}://${req.hostname}/callback.html`,
  });
});

// API routes
app.use('/auth', authRouter);
app.use('/api', requireAuth, apiRouter);

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Nightly scan cron (runs at 2 AM UTC) ---
function startNightlyCron() {
  const { pool } = require('./db');
  const { scanUncategorized } = require('./services/scanner');
  const { generateClosePackage } = require('./services/reports');
  const { scanVariance } = require('./services/variance');
  const { scanLiabilities } = require('./services/liability');

  function msUntil2AM() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(2, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  async function runNightlyScans() {
    console.log('Starting nightly scans...');
    try {
      const { rows: companies } = await pool.query('SELECT realm_id, company_name FROM companies');
      const now = new Date();
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      for (const c of companies) {
        try {
          await scanUncategorized(c.realm_id);
          console.log(`Nightly uncategorized scan complete: ${c.company_name || c.realm_id}`);
        } catch (e) {
          console.error(`Nightly scan failed for ${c.company_name || c.realm_id}:`, e.message);
        }
        try {
          await generateClosePackage(c.realm_id, period);
          console.log(`Nightly close package complete: ${c.company_name || c.realm_id} (${period})`);
        } catch (e) {
          console.error(`Nightly close package failed for ${c.company_name || c.realm_id}:`, e.message);
        }
        try {
          await scanVariance(c.realm_id);
          console.log(`Nightly variance scan complete: ${c.company_name || c.realm_id}`);
        } catch (e) {
          console.error(`Nightly variance scan failed for ${c.company_name || c.realm_id}:`, e.message);
        }
        try {
          await scanLiabilities(c.realm_id);
          console.log(`Nightly liability check complete: ${c.company_name || c.realm_id}`);
        } catch (e) {
          console.error(`Nightly liability check failed for ${c.company_name || c.realm_id}:`, e.message);
        }
      }
      console.log('Nightly scans finished.');
    } catch (e) {
      console.error('Nightly scan error:', e.message);
    }

    // Schedule next run
    setTimeout(runNightlyScans, msUntil2AM());
  }

  // Schedule first run
  const ms = msUntil2AM();
  console.log(`Nightly scans scheduled in ${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m (2:00 AM UTC)`);
  setTimeout(runNightlyScans, ms);
}

// Start server after DB is ready
async function start() {
  await initDB();
  console.log('Database initialized');

  startNightlyCron();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DarkLion server running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
