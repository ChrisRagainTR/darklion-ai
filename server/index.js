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

// Custom domain root — redirect straight to advisor login
app.get('/', (req, res, next) => {
  if (req.domainFirm) return res.redirect('/login');
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
app.get('/documents', (req, res) => res.render('documents', { title: 'Documents', activeNav: 'documents' }));
app.get('/dashboard.html', (req, res) => res.redirect('/dashboard'));
app.get('/theme-preview', (req, res) => res.sendFile(path.join(publicDir, 'theme-preview.html')));
// Team page — redirect to dashboard team section for now
app.get('/team', (req, res) => res.render('team', { title: 'Team', activeNav: '' }));
// CRM pages — EJS shell
app.get('/crm', (req, res) => res.render('crm', { title: 'CRM', activeNav: 'relationships' }));
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

// --- WebDAV drive (handles its own Basic auth) ---
// WebDAV removed — replaced by DarkLion Drive desktop app

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

const bulkSendRouter = require('./routes/bulk-send');
app.use('/api/bulk-send', requireFirm, apiLimiter, bulkSendRouter);
app.get('/bulk-send', (req, res) => res.render('bulk-send', { title: 'Bulk Send', activeNav: 'bulk-send' }));

const summariesRouter = require('./routes/summaries');
app.use('/api/summaries', requireFirm, apiLimiter, summariesRouter);
app.get('/conversation-summaries', (req, res) => res.render('conversation-summaries', { title: 'Conversation Summaries', activeNav: 'conversation-summaries' }));

const templatesRouter = require('./routes/templates');
app.use('/api/templates', requireFirm, apiLimiter, templatesRouter);

const dashboardRouter = require('./routes/dashboard');
app.use('/api/dashboard', requireFirm, apiLimiter, dashboardRouter);
app.get('/templates', (req, res) => res.render('templates', { title: 'Message Templates', activeNav: 'templates' }));
app.get('/settings', (req, res) => res.render('settings', { title: 'Settings', activeNav: 'settings' }));
// webdav-help removed
app.get('/api-docs', (req, res) => res.render('api-docs', { title: 'DarkLion API Documentation' }));

const pipelinesRouter = require('./routes/pipelines');
app.use('/api/pipelines', requireFirm, apiLimiter, pipelinesRouter);

const pipelineTriggersRouter = require('./routes/pipeline-triggers');
app.use('/api/pipeline-triggers', requireFirm, apiLimiter, pipelineTriggersRouter);

const pipelineActionsRouter = require('./routes/pipeline-actions');
app.use('/api/pipeline-actions', requireFirm, apiLimiter, pipelineActionsRouter);
app.get('/pipelines', (req, res) => res.render('pipelines', { title: 'Pipelines', activeNav: 'pipelines' }));
app.get('/pipelines/:instanceId/settings', (req, res) => res.render('pipeline-settings', { title: 'Pipeline Settings', activeNav: 'pipelines' }));

const engagementRouter = require('./routes/engagement');
app.use('/api/engagement', requireFirm, apiLimiter, engagementRouter);

const billingRouter = require('./routes/billing');
app.use('/api/billing', requireFirm, apiLimiter, billingRouter);

const forecastRouter = require('./routes/forecast');
app.use('/api/forecast', requireFirm, apiLimiter, forecastRouter);
app.get('/forecast', (req, res) => res.render('forecast', { title: 'Revenue Forecast', activeNav: 'forecast' }));

const taxDeliveryRouter = require('./routes/tax-delivery');
app.use('/api/tax-deliveries', requireFirm, apiLimiter, taxDeliveryRouter);

const organizerRouter = require('./routes/organizer');
app.use('/api/organizers', requireFirm, apiLimiter, organizerRouter);

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

// Portal organizer routes (organizerRouter already required above)
app.use('/portal/organizer', requirePortal, apiLimiter, organizerRouter);

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

// ── Viktor briefing pre-generation (runs at 4 AM UTC = midnight EDT) ─────────
// Pre-generates morning briefings for all active firm users so they're
// instant when staff open the app at 8am.
function startViktorBriefingCron() {
  const { pool } = require('./db');
  const Anthropic = require('@anthropic-ai/sdk');
  const { getFirmContext } = require('./routes/viktor');

  function msUntil4AM() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(4, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  async function runBriefings() {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[briefing-cron] Starting Viktor briefing pre-generation for ${today}...`);

    try {
      // Get all active firm users (accepted, not archived)
      const { rows: users } = await pool.query(`
        SELECT fu.id as user_id, fu.firm_id, fu.name, fu.email
        FROM firm_users fu
        WHERE fu.accepted_at IS NOT NULL
          AND fu.archived_at IS NULL
        ORDER BY fu.firm_id, fu.id
      `);

      console.log(`[briefing-cron] Generating briefings for ${users.length} users...`);

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error('[briefing-cron] ANTHROPIC_API_KEY not set — skipping.');
        setTimeout(runBriefings, msUntil4AM());
        return;
      }

      const client = new Anthropic({ apiKey });

      for (const user of users) {
        try {
          // Skip if already generated today
          const { rows: existing } = await pool.query(
            'SELECT briefing_generated FROM viktor_sessions WHERE firm_id = $1 AND user_id = $2 AND session_date = $3',
            [user.firm_id, user.user_id, today]
          );
          if (existing[0]?.briefing_generated) {
            console.log(`[briefing-cron] Already done: user ${user.user_id} (${user.email})`);
            continue;
          }

          // Fetch firm context
          const context = await getFirmContext(user.firm_id).catch(() => ({}));

          // Build context summary
          const contextParts = [];
          if (context.pipelineJobs?.length) contextParts.push(`Pipeline jobs: ${context.pipelineJobs.length} active`);
          if (context.unsignedReturns?.length) contextParts.push(`Unsigned returns: ${context.unsignedReturns.length} waiting`);
          if (context.stalledMessages?.length) contextParts.push(`Stalled messages: ${context.stalledMessages.length} threads >48h`);
          if (context.openProposals?.length) contextParts.push(`Open proposals: ${context.openProposals.length}`);
          if (context.expiringEngagements?.length) contextParts.push(`Expiring engagements: ${context.expiringEngagements.length}`);
          const contextSummary = contextParts.join('\n') || 'No urgent items at this time.';

          const greeting = 'Good morning';
          const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

          const { buildSystemPrompt } = require('./routes/viktor-chat');
          const systemPrompt = await buildSystemPrompt(user.firm_id).catch(() => 'You are Viktor, an AI advisor assistant for a CPA/wealth management firm.');

          const response = await client.messages.create({
            model: 'claude-haiku-4-5-20251001', // use Haiku for cron — faster + cheaper
            max_tokens: 1000,
            system: systemPrompt,
            messages: [{
              role: 'user',
              content: `${greeting}. Generate my daily briefing for today (${dateStr}).\n\nCurrent firm data:\n${contextSummary}\n\nProvide a concise, actionable morning briefing with prioritized tasks.`
            }]
          });

          const briefingText = response.content[0]?.text || 'Good morning! Ready when you are.';
          const messages = [
            { role: 'assistant', content: briefingText, timestamp: new Date().toISOString() }
          ];

          await pool.query(
            `INSERT INTO viktor_sessions (firm_id, user_id, session_date, messages, briefing_generated)
             VALUES ($1, $2, $3, $4, TRUE)
             ON CONFLICT (firm_id, user_id, session_date)
             DO UPDATE SET messages = $4, briefing_generated = TRUE, updated_at = NOW()`,
            [user.firm_id, user.user_id, today, JSON.stringify(messages)]
          );

          console.log(`[briefing-cron] Done: ${user.email}`);

          // Small delay between users to avoid hammering the API
          await new Promise(r => setTimeout(r, 500));

        } catch (e) {
          console.error(`[briefing-cron] Failed for user ${user.user_id} (${user.email}):`, e.message);
        }
      }

      console.log('[briefing-cron] All briefings generated.');
    } catch (e) {
      console.error('[briefing-cron] Fatal error:', e.message);
    }

    setTimeout(runBriefings, msUntil4AM());
  }

  const ms = msUntil4AM();
  console.log(`[briefing-cron] Scheduled in ${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m (4:00 AM UTC / midnight EDT)`);
  setTimeout(runBriefings, ms);
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

// ── 404 handler ──────────────────────────────────────────────────────────────
app.get('/404', (req, res) => res.status(404).render('404'));

// Catch-all: unknown routes → 404 page (only for non-API, non-asset requests)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/portal/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Let static files 404 normally
  if (req.path.match(/\.(js|css|png|jpg|ico|svg|woff|woff2|ttf|map)$/)) return next();
  res.status(404).render('404');
});

async function start() {
  // Start listening immediately so healthcheck passes while DB initializes
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DarkLion server running on port ${PORT}`);
  });

  await initDB();
  console.log('Database initialized');

  startNightlyCron();
  startViktorBriefingCron();

  const { scheduleAt10PM } = require('./scheduler');
  scheduleAt10PM();
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
