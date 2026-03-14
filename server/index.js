const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');

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

const db = require('./db');
const authRouter = require('./routes/auth');
const apiRouter = require('./routes/api');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// --- Authentication middleware ---
// Dashboard + API require login. Public pages (landing, connect, privacy, terms) do not.
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

// Public static files (landing page, connect, privacy, terms, callback, logo)
const publicDir = path.join(__dirname, '..', 'public');
const publicFiles = ['index.html', 'connect.html', 'callback.html', 'disconnect.html', 'privacy.html', 'terms.html', 'lion-logo.png', 'CNAME'];
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
for (const file of publicFiles) {
  app.get(`/${file}`, (req, res, next) => {
    res.sendFile(path.join(publicDir, file), err => { if (err) next(); });
  });
}

// Protected dashboard
app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(publicDir, 'dashboard.html'));
});

// API routes (protected)
app.use('/auth', authRouter);
app.use('/api', requireAuth, apiRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', companies: db.prepare('SELECT COUNT(*) as c FROM companies').get().c });
});

// SSL support: if cert files exist, serve HTTPS; otherwise HTTP
const fs = require('fs');
const sslCert = process.env.SSL_CERT || path.join(__dirname, '..', 'certs', 'fullchain.pem');
const sslKey = process.env.SSL_KEY || path.join(__dirname, '..', 'certs', 'privkey.pem');

if (fs.existsSync(sslCert) && fs.existsSync(sslKey)) {
  const httpsPort = process.env.HTTPS_PORT || 443;
  const credentials = { key: fs.readFileSync(sslKey), cert: fs.readFileSync(sslCert) };

  https.createServer(credentials, app).listen(httpsPort, () => {
    console.log(`DarkLion HTTPS server running on port ${httpsPort}`);
    startScheduler();
  });

  // Redirect HTTP to HTTPS
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
  }).listen(PORT, () => {
    console.log(`HTTP -> HTTPS redirect on port ${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`DarkLion server running on port ${PORT} (no SSL certs found — set SSL_CERT/SSL_KEY or place in certs/)`);
    startScheduler();
  });
}
