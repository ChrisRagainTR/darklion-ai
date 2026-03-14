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

app.listen(PORT, () => {
  console.log(`DarkLion server running on port ${PORT}`);
  startScheduler();
});
