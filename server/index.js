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

// Serve static files (landing pages + dashboard)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/auth', authRouter);
app.use('/api', apiRouter);

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
