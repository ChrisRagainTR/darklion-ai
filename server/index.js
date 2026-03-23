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
app.use(express.urlencoded({ extended: false })); // needed for Pusher auth endpoint

// --- Custom domain firm resolution ---
const { domainFirmMiddleware } = require('./middleware/domainFirm');
app.use(domainFirmMiddleware);

// Make domain firm available to all EJS views
app.use((req, res, next) => {
  res.locals.firmBranding = req.domainFirm || null;
  next();
});

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

// Custom domain root — show branded landing with staff + client options
app.get('/', (req, res, next) => {
  if (req.domainFirm) {
    const firm = req.domainFirm;
    return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${firm.name}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1923;color:#e8edf2;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.wrap{text-align:center;padding:2rem;max-width:400px;width:100%;}
.logo{width:64px;height:64px;object-fit:contain;margin-bottom:1.5rem;}
h1{font-size:1.4rem;font-weight:800;margin-bottom:0.4rem;}
.sub{color:#8fa3b8;font-size:0.88rem;margin-bottom:2.5rem;}
.btn{display:block;width:100%;padding:0.9rem;border-radius:10px;font-size:0.95rem;font-weight:700;text-decoration:none;margin-bottom:0.85rem;transition:opacity 0.15s;}
.btn-gold{background:#c9a84c;color:#0f1923;}
.btn-outline{border:1px solid rgba(255,255,255,0.15);color:#e8edf2;background:transparent;}
.btn:hover{opacity:0.85;}
</style></head><body><div class="wrap">
<img src="/sentinel-favicon.png" class="logo" alt="${firm.name}">
<h1>${firm.name}</h1>
<p class="sub">Welcome. Please sign in to continue.</p>
<a href="/client-login" class="btn btn-gold">Client Portal →</a>
<a href="/login" class="btn btn-outline">Staff Sign In</a>
</div></body></html>`);
  }
  next();
});

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/connect', (req, res) => res.sendFile(path.join(publicDir, 'connect.html')));
app.get('/callback', (req, res) => res.sendFile(path.join(publicDir, 'callback.html')));
app.get('/disconnect', (req, res) => res.sendFile(path.join(publicDir, 'disconnect.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(publicDir, 'terms.html')));

// --- Auth pages (public) ---

// Branded login for custom domains — must come BEFORE the default /login route
app.get('/login', (req, res, next) => {
  if (req.domainFirm) {
    return res.render('login-branded', {
      title: `${req.domainFirm.name} — Sign In`,
      firmName: req.domainFirm.name,
      firmDomain: req.domainFirm.domain,
      firmId: req.domainFirm.id,
    });
  }
  next();
});

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
app.get('/team', (req, res) => res.sendFile(path.join(publicDir, 'team.html')));
// Redirect /crm and /crm?tab=X to specific list pages
app.get('/crm', (req, res) => res.sendFile(path.join(publicDir, 'crm.html')));
app.get('/crm.html', (req, res) => res.redirect('/crm'));
app.get('/crm/relationships', (req, res) => res.redirect('/crm?tab=relationships'));
app.get('/crm/people', (req, res) => res.redirect('/crm?tab=people'));
app.get('/crm/companies', (req, res) => res.redirect('/crm?tab=companies'));
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
// Staff list route registered AFTER requireToken (see below)

// --- Auth (QBO/Gusto OAuth callbacks — public) ---
app.use('/auth', authRouter);

// --- Public API routes (no auth) — MUST be before requireFirm mounts ---
const proposalsPublicRouter = require('./routes/proposals-public');
app.use('/api/proposals/public', apiLimiter, proposalsPublicRouter);

// --- Token auth middleware — runs before requireFirm, sets req.firm for API token holders ---
const { requireToken } = require('./middleware/requireToken');
app.use('/api', requireToken);

// Staff list — after requireToken so API key auth works
const { pool: _pool } = require('./db');
app.get('/api/staff', requireFirm, apiLimiter, async (req, res) => {
  try {
    const { rows } = await _pool.query(
      `SELECT id, name, display_name, email, role, last_login_at, created_at
       FROM firm_users WHERE firm_id = $1 AND accepted_at IS NOT NULL ORDER BY name ASC`,
      [req.firm.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch staff' }); }
});

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

const templatesRouter = require('./routes/templates');
app.use('/api/templates', requireFirm, apiLimiter, templatesRouter);

const dashboardRouter = require('./routes/dashboard');
app.use('/api/dashboard', requireFirm, apiLimiter, dashboardRouter);
app.get('/templates', (req, res) => res.render('templates', { title: 'Message Templates', activeNav: 'templates' }));
app.get('/settings', (req, res) => res.render('settings', { title: 'Settings', activeNav: 'settings' }));
app.get('/api-docs', (req, res) => res.render('api-docs', { title: 'DarkLion API Documentation' }));

const pipelinesRouter = require('./routes/pipelines');
app.use('/api/pipelines', requireFirm, apiLimiter, pipelinesRouter);
app.get('/pipelines', (req, res) => res.render('pipelines', { title: 'Pipelines', activeNav: 'pipelines' }));

const engagementRouter = require('./routes/engagement');
app.use('/api/engagement', requireFirm, apiLimiter, engagementRouter);

const billingRouter = require('./routes/billing');
app.use('/api/billing', requireFirm, apiLimiter, billingRouter);

const taxDeliveryRouter = require('./routes/tax-delivery');
app.use('/api/tax-deliveries', requireFirm, apiLimiter, taxDeliveryRouter);

// Proposals — staff (auth required)
const proposalsRouter = require('./routes/proposals');
app.use('/api/proposals', requireFirm, apiLimiter, proposalsRouter);

// Viktor context endpoint
const viktorRouter = require('./routes/viktor');
app.use('/api/viktor', requireFirm, apiLimiter, viktorRouter);

const viktorChatRouter = require('./routes/viktor-chat');
app.use('/api/viktor-chat', requireFirm, apiLimiter, viktorChatRouter);

// Proposal pages (staff)
app.get('/proposals', (req, res) => res.render('proposals', { title: 'Proposals', activeNav: 'proposals' }));
app.get('/proposals/new', (req, res) => res.render('proposal-create', { title: 'New Proposal', activeNav: 'proposals' }));
app.get('/proposals/:id([0-9]+)', (req, res) => res.render('proposal-detail', { title: 'Proposal', activeNav: 'proposals' }));
app.get('/proposals/:id([0-9]+)/edit', (req, res) => res.render('proposal-create', { title: 'Edit Proposal', activeNav: 'proposals' }));

// Public client-facing proposal pages (no auth)
app.get('/p/:token', (req, res) => res.sendFile(path.join(publicDir, 'proposal-view.html')));
app.get('/p/:token/sign', (req, res) => res.sendFile(path.join(publicDir, 'proposal-sign.html')));

const portalAuthRouter = require('./routes/portal-auth');
const portalRouter = require('./routes/portal');
const { requirePortal } = require('./middleware/requirePortal');

// Public portal auth (no middleware)
app.use('/portal-auth', portalAuthRouter);

// Portal HTML pages (public — must come BEFORE the requirePortal middleware)
app.get('/portal', (req, res) => res.sendFile(path.join(publicDir, 'portal.html')));
// /client-login is canonical; /portal-login kept as alias for backwards compatibility
function serveClientLogin(req, res) {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../public/portal-login.html'), 'utf8');
  if (req.domainFirm) {
    const firmScript = `<script>window.__FIRM__ = ${JSON.stringify({ name: req.domainFirm.name, id: req.domainFirm.id })};</script>`;
    return res.send(firmScript + html);
  }
  res.send(html);
}
app.get('/client-login', serveClientLogin);
app.get('/portal-login', serveClientLogin); // alias — don't break existing links

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

// ── Pusher setup ─────────────────────────────────────────────────────────────
const Pusher = require('pusher');
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});
app.set('pusher', pusher);

// Pusher auth endpoints — token passed as query param (Pusher sends body as form-urlencoded)
// Staff: authorizes private-firm-{id} and private-portal-{firmId}-* channels
app.post('/pusher/auth/staff', (req, res) => {
  const jwt = require('jsonwebtoken');
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const firmId = payload.firmId || payload.id;
    const channelName = req.body.channel_name;
    const allowed = channelName === `private-firm-${firmId}` ||
                    channelName.startsWith(`private-portal-${firmId}-`);
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    res.json(pusher.authorizeChannel(req.body.socket_id, channelName));
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Portal: authorizes private-portal-{firmId}-{personId} channel
app.post('/pusher/auth/portal', (req, res) => {
  const jwt = require('jsonwebtoken');
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'portal') return res.status(403).json({ error: 'Forbidden' });
    const channelName = req.body.channel_name;
    const expected = `private-portal-${payload.firmId}-${payload.personId}`;
    if (channelName !== expected) return res.status(403).json({ error: 'Forbidden' });
    res.json(pusher.authorizeChannel(req.body.socket_id, channelName));
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

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
