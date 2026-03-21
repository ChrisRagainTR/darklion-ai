const express = require('express');
const path = require('path');
// express-ejs-layouts removed — using EJS native includes instead

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

// === Safety check: refuse to start without JWT_SECRET ===
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  console.error('Add JWT_SECRET to your .env file or Railway environment variables.');
  process.exit(1);
}

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./db');
const authRouter = require('./routes/auth');
const apiRouter = require('./routes/api');
const firmsRouter = require('./routes/firms');
const { requireFirm } = require('./middleware/requireFirm');

const app = express();
const PORT = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === 'production';

// --- EJS template engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Using EJS native <%- include() %> for layout

// Trust proxy headers (Fly.io, Railway)
app.set('trust proxy', true);

// --- Security headers (Helmet) ---
app.use(helmet({
  contentSecurityPolicy: false, // Disabled to not break inline scripts in existing HTML
  crossOriginEmbedderPolicy: false,
}));

// --- CORS ---
app.use((req, res, next) => {
  const allowedOrigins = IS_PROD
    ? ['https://darklion.ai', 'https://www.darklion.ai']
    : ['http://localhost:8080', 'http://127.0.0.1:8080'];

  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// --- Force HTTPS in production ---
if (IS_PROD) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
  });
}

// --- Global API rate limiter ---
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // portal polling + normal usage needs headroom
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }, // suppress ERR_ERL_PERMISSIVE_TRUST_PROXY — we trust Railway's proxy
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.path === '/health',
});

// --- Legacy Basic Auth (backward compat — dev mode only) ---
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS;

function requireBasicAuth(req, res, next) {
  if (!DASH_PASS) return next();
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const encoded = authHeader.split(' ')[1];
    if (encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
      if (user === DASH_USER && pass === DASH_PASS) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="DarkLion Dashboard"');
  res.status(401).send('Authentication required');
}

// Dashboard auth: accept JWT Bearer OR legacy Basic Auth
function dashboardAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  // Try JWT first
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return requireFirm(req, res, next);
  }

  // Fall back to Basic Auth (dev mode)
  return requireBasicAuth(req, res, next);
}

// --- Health check (no auth) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Static files ---
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.static(publicDir, {
  index: false,
  maxAge: IS_PROD ? '1d' : 0,
}));

// --- Public page routes ---
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/connect', (req, res) => res.sendFile(path.join(publicDir, 'connect.html')));
app.get('/callback', (req, res) => res.sendFile(path.join(publicDir, 'callback.html')));
app.get('/disconnect', (req, res) => res.sendFile(path.join(publicDir, 'disconnect.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(publicDir, 'terms.html')));

// --- Auth pages (public) ---
app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(publicDir, 'register.html')));

// --- Invite page (public) ---
app.get('/invite/:token', (req, res) => res.sendFile(path.join(publicDir, 'invite.html')));

// --- Staff pages (EJS templates with unified layout) ---
// Note: auth is handled client-side (JWT in localStorage); server just serves the pages
app.get('/dashboard', (req, res) => res.render('dashboard', { title: 'Dashboard', activeNav: '' }));
app.get('/statements-calendar', (req, res) => res.render('statements-calendar', { title: 'Statement Calendar', activeNav: 'statements-calendar' }));
app.get('/dashboard.html', (req, res) => res.redirect('/dashboard'));
app.get('/theme-preview', (req, res) => res.sendFile(path.join(publicDir, 'theme-preview.html')));
// Team page — redirect to dashboard team section for now
app.get('/team', (req, res) => res.redirect('/dashboard?section=team'));
// Redirect /crm and /crm?tab=X to specific list pages
app.get('/crm', (req, res) => {
  const tab = req.query.tab || 'relationships';
  if (tab === 'people') return res.redirect('/crm/people');
  if (tab === 'companies') return res.redirect('/crm/companies');
  return res.redirect('/crm/relationships');
});
app.get('/crm.html', (req, res) => res.redirect('/crm/relationships'));
app.get('/crm/relationships', (req, res) => res.render('relationships', { title: 'Relationships', activeNav: 'relationships' }));
app.get('/crm/people', (req, res) => res.render('people', { title: 'People', activeNav: 'people' }));
app.get('/crm/companies', (req, res) => res.render('companies', { title: 'Companies', activeNav: 'companies' }));
app.get('/crm/person/:id', (req, res) => res.render('crm-person', { title: 'Person', activeNav: 'people' }));
app.get('/crm/company/:id', (req, res) => res.render('crm-company', { title: 'Company', activeNav: 'companies' }));
app.get('/crm/relationship/:id', (req, res) => res.render('crm-relationship', { title: 'Relationship', activeNav: 'relationships' }));

// Redirect route (previously required Basic Auth)
app.get('/redirect', (req, res) => res.sendFile(path.join(publicDir, 'redirect.html')));

// --- Public config endpoint ---
app.get('/api/config', (req, res) => {
  res.json({
    qb_client_id: process.env.QB_CLIENT_ID || '',
    qb_redirect_uri: process.env.QB_REDIRECT_URI || `${req.protocol}://${req.hostname}/callback.html`,
    gusto_client_id: process.env.GUSTO_CLIENT_ID || '',
    gusto_redirect_uri: process.env.GUSTO_REDIRECT_URI || '',
    gusto_app_url: process.env.GUSTO_APP_URL || 'https://app.gusto-demo.com',
  });
});

// --- Firms routes (register/login/invite-lookup are public; protected routes use requireFirm internally) ---
app.use('/firms', firmsRouter);

// --- Auth (QBO/Gusto OAuth callbacks — public) ---
app.use('/auth', authRouter);

// --- API routes (JWT required) ---
app.use('/api', requireFirm, apiLimiter, apiRouter);

const relationshipsRouter = require('./routes/relationships');
const peopleRouter = require('./routes/people');
app.use('/api/relationships', requireFirm, apiLimiter, relationshipsRouter);
app.use('/api/people', requireFirm, apiLimiter, peopleRouter);

const documentsRouter = require('./routes/documents');
app.use('/api/documents', requireFirm, apiLimiter, documentsRouter);

const messagesRouter = require('./routes/messages');
app.use('/api/messages', requireFirm, apiLimiter, messagesRouter);
app.get('/messages', (req, res) => res.render('messages', { title: 'Messages', activeNav: 'messages' }));

const pipelinesRouter = require('./routes/pipelines');
app.use('/api/pipelines', requireFirm, apiLimiter, pipelinesRouter);
app.get('/pipelines', (req, res) => res.render('pipelines', { title: 'Pipelines', activeNav: 'pipelines' }));

const taxDeliveryRouter = require('./routes/tax-delivery');
app.use('/api/tax-deliveries', requireFirm, apiLimiter, taxDeliveryRouter);

const portalAuthRouter = require('./routes/portal-auth');
const portalRouter = require('./routes/portal');
const { requirePortal } = require('./middleware/requirePortal');

// Public portal auth (no middleware)
app.use('/portal-auth', portalAuthRouter);

// Portal HTML pages (public — must come BEFORE the requirePortal middleware)
app.get('/portal', (req, res) => res.sendFile(path.join(publicDir, 'portal.html')));
app.get('/portal-login', (req, res) => res.sendFile(path.join(publicDir, 'portal-login.html')));

// Protected portal API routes (sub-paths like /portal/me, /portal/documents, etc.)
app.use('/portal', requirePortal, apiLimiter, portalRouter);

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
        try {
          const { rows: [comp] } = await pool.query(
            'SELECT gusto_access_token, gusto_company_id FROM companies WHERE realm_id = $1', [c.realm_id]
          );
          if (comp?.gusto_access_token && comp?.gusto_company_id) {
            const { verifyPayroll } = require('./services/payroll');
            await verifyPayroll(c.realm_id);
            console.log(`Nightly payroll check complete: ${c.company_name || c.realm_id}`);
          }
        } catch (e) {
          console.error(`Nightly payroll check failed for ${c.company_name || c.realm_id}:`, e.message);
        }
      }
      console.log('Nightly scans finished.');
    } catch (e) {
      console.error('Nightly scan error:', e.message);
    }
    setTimeout(runNightlyScans, msUntil2AM());
  }

  const ms = msUntil2AM();
  console.log(`Nightly scans scheduled in ${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m (2:00 AM UTC)`);
  setTimeout(runNightlyScans, ms);
}

// Start server after DB is ready
// ── Socket.io setup (per docs: https://socket.io/docs/v4/) ───────────────────
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' }, // JWT auth in handshake, no cookies, wildcard is safe
});

// Middleware: decode JWT, attach user to socket (never reject — bad token = no rooms)
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      console.warn('[socket] bad token, connecting without rooms:', e.message);
    }
  }
  next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  if (!u) return;
  const firmId = u.firmId || u.id;
  if (firmId && u.personId) {
    socket.join(`portal:${firmId}:${u.personId}`);
    console.log(`[socket] client connected → portal:${firmId}:${u.personId}`);
  } else if (firmId) {
    socket.join(`firm:${firmId}`);
    console.log(`[socket] staff connected → firm:${firmId}`);
  }
});

// Expose io to routes
app.set('io', io);
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  await initDB();
  console.log('Database initialized');

  startNightlyCron();

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`DarkLion server running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
