# DARKLION.md — Master Context Document
> Read this at the start of every session before touching any code.
> Last updated: 2026-03-31
> This is the single source of context for new sessions. BUILD_LOG.md and SCHEMA_PLAN.md have more detail but this doc covers everything you need to work safely.

---

## What Is DarkLion

A full CPA practice management platform built to replace TaxDome for Sentinel Wealth & Tax (Chris Ragain, CPA/PFS, Bonita Springs/Naples FL). Built AI-native from the ground up — everything a human staff member can do, Viktor (the AI agent) can do via the same API endpoints.

**The 3-entity hierarchy is the foundation of everything:**
```
Relationship  →  household/group — top-level billing unit
├── Companies →  legal entities (S-Corp, LLC, Trust, 1040, etc.)
└── People    →  individuals with portal logins
    └── person_company_access (who can see which companies)
```

---

## Team

| Person | Role |
|---|---|
| **Chris Ragain** | Founder, CPA/PFS — decision maker, tests on dev, approves prod pushes |
| **Nick** | Staff — primary tax workflow user |
| **Viktor** | AI agent embedded in DarkLion — has `agent` role in firm_users |
| **Argus** | AI assistant (OpenClaw) — planning + coding |

---

## Deployment

| Environment | Branch | URL | Database |
|---|---|---|---|
| **Production** | `main` | `darklion.ai` | Neon `ep-holy-snow-amiyy7tl-pooler` |
| **Development** | `dev` | `darklion-ai-development.up.railway.app` | Neon `ep-broad-butterfly-amriaidm-pooler` |

**Platform:** Railway (auto-deploys on push via GitHub Actions)
**GitHub:** https://github.com/ChrisRagainTR/darklion-ai

### Deployment Rules — NON-NEGOTIABLE
1. Always work on and push to `dev` branch
2. Chris tests on dev, gives explicit approval before prod
3. **NEVER merge to `main` without explicit "push to prod" from Chris**
4. Tests must pass (173/0) before any prod push
5. After prod push: `git checkout dev` immediately

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | PostgreSQL (Neon, via `pg`) |
| Views | EJS templates (`server/views/*.ejs`) |
| File storage | AWS S3 (signed URLs, never direct access) |
| Auth | JWT — staff: 24h, portal clients: 7d |
| Encryption | AES-256-GCM app-level (`server/utils/encryption.js`) |
| Email | Resend (`RESEND_FROM=messages@sentineltax.co`) |
| Payments | Stripe (two accounts — Sentinel PCS + Sentinel Tax) |
| QBO | QuickBooks Online OAuth |
| Payroll | Gusto |
| AI | Anthropic Claude (Haiku for batch, Sonnet for Viktor chat) |
| Tests | Playwright E2E (`tests/e2e/`, 173 tests) |

---

## File Structure — Source of Truth

```
server/
  index.js              — Express app, all route mounting, cron jobs
  db.js                 — ALL DB table definitions and migrations (idempotent)
  scheduler.js          — Cron: nightly archive, QBO refresh, Viktor briefings
  middleware/
    requireFirm.js      — Staff JWT middleware (all /api routes)
    requirePortal.js    — Portal client JWT middleware
    requireToken.js     — Token extraction middleware
    domainFirm.js       — Subdomain → firm_id resolution
  routes/
    api.js              — General API (companies CRUD, search, scan results)
    auth.js             — Staff login/register/invite
    firms.js            — Firm settings, branding, login
    relationships.js    — Relationships CRUD
    people.js           — People CRUD + company access
    documents.js        — Document upload/download/metadata (S3)
    messages.js         — Staff messaging inbox API
    portal.js           — Protected portal API (client-facing)
    portal-auth.js      — Portal login/invite/reset
    organizer.js        — Tax organizer flow
    pipelines.js        — Pipeline CRUD + kanban
    pipeline-triggers.js — Trigger definitions + fire endpoint
    pipeline-actions.js  — Stage actions (portal message, staff task)
    tax-delivery.js     — Tax return delivery + e-signatures
    engagement.js       — Engagement letter upload/AI extraction
    templates.js        — Message templates
    bulk-send.js        — Bulk portal messaging
    summaries.js        — Conversation summaries
    dashboard.js        — Dashboard intel API
    forecast.js         — Revenue forecast
    billing.js          — Billing API
    proposals.js        — Proposals (internal)
    proposals-public.js — Proposals (public view/sign)
    viktor.js           — Viktor firm context + getFirmContext()
    viktor-chat.js      — Viktor AI chat (streaming, tools)
    webdav.js           — WebDAV drive server
  services/
    s3.js               — uploadFile, getSignedDownloadUrl, deleteFile, buildKey
    email.js            — Resend email (invite, reset, notifications)
    claude.js           — Anthropic API wrapper
    quickbooks.js       — QBO OAuth + API fetch
    pdf.js              — PDF generation (puppeteer)
    taxFinancialsPdf.js — Tax financials PDF from QBO data
    pdfExtract.js       — PDF text extraction (used in tax-delivery)
    taxAnalysis.js      — AI tax return analysis (used in tax-delivery)
    organizerParser.js  — Drake organizer PDF parser
    payroll.js          — Gusto payroll data
    liability.js        — QBO liability health scanner
    variance.js         — P&L variance scanner
    reports.js          — QBO report fetching (P&L, BS, Trial Balance)
    scanner.js          — Background scan coordinator
    sign-pdf.js         — PDF e-signature embedding
    summaryGenerator.js — Claude conversation summaries
    pipelineActions.js  — Execute stage actions service
    pipelineTriggers.js — Fire triggers service
    twilio.js           — SMS sending
  views/                — ALL staff pages (EJS shell — source of truth)
    layout.ejs          — (unused — shell uses partials instead)
    partials/
      shell-top.ejs     — Top of every page (header, sidebar, CSS)
      shell-close.ejs   — Bottom of every page (closing tags)
    crm.ejs             — /crm — 3-tab: Relationships, People, Companies
    crm-person.ejs      — /crm/person/:id
    crm-company.ejs     — /crm/company/:id
    crm-relationship.ejs — /crm/relationship/:id
    dashboard.ejs       — /dashboard
    messages.ejs        — /messages
    pipelines.ejs       — /pipelines
    pipeline-settings.ejs — /pipelines/:instanceId/settings
    bulk-send.ejs       — /bulk-send
    documents.ejs       — /documents
    settings.ejs        — /settings
    team.ejs            — /team
    templates.ejs       — /templates
    statements-calendar.ejs — /statements-calendar
    conversation-summaries.ejs — /conversation-summaries
    api-docs.ejs        — /api-docs
    forecast.ejs        — /forecast
    proposals.ejs       — /proposals
    proposal-create.ejs — /proposals/new
    proposal-detail.ejs — /proposals/:id
    people.ejs          — (unused — /crm/people redirects to /crm?tab=people)
    companies.ejs       — (unused — /crm/companies redirects to /crm?tab=companies)
    relationships.ejs   — (unused — redirects to /crm?tab=relationships)
    404.ejs             — error page
    login-branded.ejs   — custom domain login
    webdav-help.ejs     — WebDAV setup guide (staff)
    webdav-help-public.ejs — WebDAV setup guide (public)
public/               — Static files (no EJS equivalents — these are ACTIVE)
  portal.html           — /portal — client portal (full app)
  portal-login.html     — /client-login — client login/invite/reset
  index.html            — / — marketing/landing
  login.html            — /login — staff login
  register.html         — /register — firm registration
  invite.html           — /invite/:token — staff invite accept
  connect.html          — /connect — QBO OAuth connect
  callback.html         — /callback — QBO OAuth callback
  disconnect.html       — /disconnect — QBO disconnect
  redirect.html         — /redirect — post-auth redirect helper
  privacy.html          — /privacy
  terms.html            — /terms
  theme-preview.html    — /theme-preview — internal branding tool
  proposal-sign.html    — proposal e-signature page
  proposal-view.html    — proposal public view
  organizer.html        — tax organizer portal page
darklion-drive/       — Windows desktop app (Electron + rclone + WinFsp)
                        Mounts DarkLion docs as drive letter. Builds separately.
darklion-print-agent/ — Windows desktop app (Electron + Ghostscript)
                        Virtual printer that routes print jobs to DarkLion.
                        CI builds installer via build-print-agent.yml on push to main.
tests/
  e2e/                  — 173 Playwright tests (173 passing, 0 failing)
  global-setup.cjs      — Generates JWT directly (bypasses rate limits)
  .auth/user.json       — Saved auth state (reused across test runs)
```

### ⚠️ Critical File Rules
- **`server/views/*.ejs` = source of truth for all staff pages.** Never use or reference any public HTML files that have an EJS equivalent.
- **`server/db.js` = source of truth for all DB schema.** All migrations are idempotent `DO $$ IF NOT EXISTS` blocks. Never run raw SQL outside this file.
- **`public/*.html` only for pages with NO EJS equivalent** (portal, login, connect, etc.)

---

## Database — Key Tables

All tables have `firm_id` for multi-tenant isolation. Every query must scope to `firm_id`.

### Core Entity Tables
| Table | Purpose |
|---|---|
| `firms` | Root tenant. Has: slug, active_tax_year, display_name, logo_url, primary_color, branding fields |
| `firm_users` | Staff accounts. Roles: owner, admin, staff, agent (Viktor) |
| `relationships` | Top-level grouping. Has: name, service_tier, billing_status, stripe fields |
| `companies` | Legal entities. Has: relationship_id, entity_type, realm_id (QBO), bookkeeping_service, billing_method, address fields, QBO tokens |
| `people` | Individuals. Has: relationship_id, filing_status, spouse_id, portal fields, encrypted DOB/SSN, address fields |
| `person_company_access` | Many-to-many: which people see which companies |

### Document Tables
| Table | Purpose |
|---|---|
| `documents` | All files. owner_type='company'/'person', folder_section='firm_uploaded'/'client_uploaded', folder_category='tax'/'bookkeeping'/'other'/'organizer', year |

### Pipeline Tables
| Table | Purpose |
|---|---|
| `pipeline_templates` | Template definition. entity_type='company'/'person'/'relationship' |
| `pipeline_stages` | Stages per template. is_terminal=true for final stages |
| `pipeline_instances` | A specific run (e.g. "2025 Business Tax Returns"). tax_year, status |
| `pipeline_jobs` | One card per entity. job_status='active'/'completed'/'archived' |
| `pipeline_job_updates` | Activity log per job |
| `pipeline_triggers` | 12 trigger types (underscore convention) |
| `pipeline_stage_triggers` | Maps trigger → stage (max 2 per stage) |
| `pipeline_trigger_log` | History of fired triggers |
| `pipeline_stage_actions` | Automated actions on stage entry (portal_message, staff_task) |
| `pipeline_completions` | Archived completion records |

### Messaging Tables
| Table | Purpose |
|---|---|
| `message_threads` | Thread per subject. status='open'/'waiting'/'resolved' |
| `messages` | Individual messages. sender_type='staff'/'client'/'agent', is_internal flag |
| `thread_participants` | Thread sharing between staff (@mentions) |
| `thread_companies` | Company tags on threads |

### Other Tables
| Table | Purpose |
|---|---|
| `tax_organizers` | Tax organizer instances. status='open'/'submitted'/'closed' |
| `tax_organizer_items` | Checklist items per organizer |
| `engagement_letters` | Engagement letter uploads + AI-extracted fields |
| `statement_schedules` | Bank statement collection tracking |
| `statement_monthly_status` | Per-month status per schedule |
| `conversation_summaries` | Claude-generated 30-day message summaries |
| `audit_log` | Every action — actor, action, entity, IP, timestamp |

---

## Critical Technical Rules

These are bugs that have been hit before. Do not repeat them.

### JWT / Auth
- `req.firm.userId` — NOT `req.user.id`. DarkLion JWT puts user ID on `req.firm`.
- Staff tokens and portal tokens are separate and incompatible. `requireFirm` rejects portal tokens.
- Portal middleware: `requirePortal.js`. Staff middleware: `requireFirm.js`.

### Pipeline
- `job_status` values: `'active'`, `'completed'`, `'archived'` — NOT `'complete'`
- `fireTrigger` checks `'completed'` — must match exactly
- Unique index on pipeline_jobs: one active job per entity per instance
- Entity type filtering: company triggers only fire company pipelines, not person pipelines

### Companies / QBO
- `companies.realm_id` defaults to `''` not NULL — always check `realm_id && realm_id.trim()`
- QBO liability balances come back as NEGATIVE (credit-normal) — flip sign for display
- QBO tokens: refreshed nightly at 2 AM UTC by `refreshAllTokens()` in scheduler

### UI / EJS
- `window._shellToast()` — not `toast()` — in crm-person.ejs, crm-company.ejs, crm-relationship.ejs pages
- Express route ordering: specific routes BEFORE wildcard `/:id`
- `express.static` runs at line 151, named routes after line 194 — static serves files by exact path
- Tabs use `data-tab` attribute; subtabs use `data-subtab` attribute

### Documents
- `folder_section` values: `'firm_uploaded'` (advisor-delivered) or `'client_uploaded'` (client-uploaded)
- `folder_category` values: `'tax'`, `'bookkeeping'`, `'other'`, `'organizer'`, `'message_docs'`
- Person portal only shows: `tax`, `other` categories. Docs with other categories must be normalized to `other`.
- Company portal shows: `tax`, `bookkeeping`, `other` categories.
- S3 keys are never returned to client — always use signed URL endpoint.

### Dev → Prod
- `req.firm.userId` not `req.user.id`
- `window._shellToast` not `toast()`
- Pipeline status: `'active'`, `'completed'`, `'archived'`
- QBO realm_id: always check `realm_id && realm_id.trim()`

---

## Cron Jobs (scheduler.js + index.js)

| Time | Job |
|---|---|
| **10 PM nightly** | Archive terminal-stage pipeline cards, record in pipeline_completions |
| **2 AM UTC** | `refreshAllTokens()` — refresh all QBO tokens |
| **2 AM UTC** | Nightly QBO scans (uncategorized, P&L variance, liability health, payroll) |
| **4 AM UTC** | Pre-generate Viktor briefings for all active staff (Claude Haiku) |

---

## Environment Variables

All set in Railway. Names only (values are in TOOLS.md / Railway dashboard).

```
JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL
QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI
GUSTO_CLIENT_ID, GUSTO_CLIENT_SECRET, GUSTO_REDIRECT_URI
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET
```

### AWS S3 Notes
- **Always use `AWS_S3_BUCKET`** — never `S3_BUCKET` (wrong name, will fall through to a non-existent default)
- Dev bucket: `darklion-documents` (same bucket for both dev and prod currently)
- All document code must use: `process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs'`
- Files are never served directly — always use signed URLs via `server/services/s3.js`

```
RESEND_API_KEY, RESEND_FROM
STRIPE_KEY_SENTINEL_PCS, STRIPE_KEY_SENTINEL_TAX
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
ANTHROPIC_API_KEY
APP_URL, PORTAL_URL
DASH_USER, DASH_PASS
NODE_ENV
PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER
```

---

## Features Built (Complete)

| Feature | Where |
|---|---|
| Multi-tenant firm auth (JWT) | `server/routes/firms.js`, `server/middleware/requireFirm.js` |
| 3-entity CRM (Relationships/Companies/People) | `server/routes/relationships.js`, `api.js`, `people.js` |
| CRM UI (full-page detail views) | `server/views/crm*.ejs` |
| Document management (S3 upload/download) | `server/routes/documents.js`, `server/services/s3.js` |
| Client portal (full SPA) | `public/portal.html`, `server/routes/portal.js`, `portal-auth.js` |
| Portal: invite/reset email | `server/services/email.js` (Resend) |
| Portal: secure messaging | `server/routes/messages.js`, `portal.js` |
| Portal: document delivery + NEW badge | `documents.js`, `portal.js` |
| Portal: connect QBO + send financials | `portal.js` — POST /portal/companies/:id/tax-financials |
| Portal: upload P&L + BS (PDF/Excel) | `portal.js` — multipart upload mode |
| Portal: switch to Docs tab on upload success | `public/portal.html` |
| Tax organizer (4-step client flow) | `server/routes/organizer.js`, `public/organizer.html` |
| Tax organizer: Drake PDF parser | `server/services/organizerParser.js` |
| Tax return delivery + e-signatures | `server/routes/tax-delivery.js` |
| Pipelines (kanban, drag-drop, instances) | `server/routes/pipelines.js`, `server/views/pipelines.ejs` |
| Pipeline smart triggers (12 types) | `server/routes/pipeline-triggers.js`, `server/services/pipelineTriggers.js` |
| Pipeline stage actions | `server/routes/pipeline-actions.js`, `server/services/pipelineActions.js` |
| Pipeline settings page | `server/views/pipeline-settings.ejs` |
| Pipeline completion + nightly archive | `scheduler.js`, `pipeline_completions` table |
| Secure messaging (staff inbox) | `server/routes/messages.js`, `server/views/messages.ejs` |
| Bulk send | `server/routes/bulk-send.js`, `server/views/bulk-send.ejs` |
| Message templates | `server/routes/templates.js` |
| Viktor AI chat (streaming) | `server/routes/viktor-chat.js`, `server/routes/viktor.js` |
| Viktor dashboard briefings | `server/routes/dashboard.js`, scheduler 4 AM |
| Firm branding (logo, colors, settings) | `server/routes/firms.js`, `server/views/settings.ejs` |
| Engagement letters + AI extraction | `server/routes/engagement.js` |
| Proposals + e-sign | `server/routes/proposals.js`, `proposals-public.js` |
| Revenue forecast | `server/routes/forecast.js` |
| WebDAV drive server | `server/routes/webdav.js` |
| QBO token keep-alive + reconnect UI | `scheduler.js`, `server/services/quickbooks.js` |
| Send to Tax Prep (QBO → PDF) | `server/routes/api.js`, `server/services/taxFinancialsPdf.js` |
| New Company modal (+New Company button in CRM) | `crm.ejs` |
| Person modal 2-column layout | `crm-person.ejs` |
| Company workflow tab (full parity) | `crm-company.ejs` |
| Auto-grant portal access on relationship add | `server/routes/api.js` |
| Help Center (`/help`) — public, no auth, 32 articles | `server/help-articles.js`, `server/views/help-layout.ejs`, `server/index.js` |
| Advisor Portal Ghost Preview ("View Portal as Client") | `server/routes/people.js` POST `/:id/portal-preview`, `public/portal.html` ghost banner |
| E2E test suite (237 tests — 7 spec files added) | `tests/e2e/`, `tests/global-setup.cjs` |
| DarkLion Drive (Windows desktop app) | `darklion-drive/` — Electron + rclone + WinFsp |
| DarkLion Print Agent (Windows desktop app) | `darklion-print-agent/` — Electron + Ghostscript |

---

## Standalone Windows Apps

Both live in the repo and build separately. Do NOT delete them. Do NOT try to import them into the main server.

### DarkLion Drive (`darklion-drive/`)
- Electron app that mounts DarkLion documents as Windows drive letter L:
- Architecture: Electron → local WebDAV server (port 7890) → proxies to darklion.ai API
- Build: `npm run build:win` → `dist/DarkLionDrive_Setup_1.0.1.exe`
- Confirmed working by Chris

### DarkLion Print Agent (`darklion-print-agent/`)
- Electron app + Windows service that installs a virtual printer "DarkLion Printer"
- Print any document → Ghostscript converts to PDF → routing popup → uploads to DarkLion
- CI: `build-print-agent.yml` builds installer on every push to main affecting `darklion-print-agent/**`
- Build: `cd darklion-print-agent/app && npm run build:win`
- Confirmed working by Chris

---

## Test Suite

```bash
# Run all tests against dev
TEST_EMAIL=test@darklion.ai TEST_PASSWORD='DarkLion2026!' \
BASE_URL=https://darklion-ai-development.up.railway.app \
npx playwright test

# Test user (dev DB only — ID 1402, firm_id=1)
Email: test@darklion.ai
Password: DarkLion2026!
JWT_SECRET (dev): k9Xm2vQpL7nR4wYtBsEuJcFhGdAzN8oWiKqT3eMjP6yDlCbOxVHrUfSgZ5I1Ma
```

- 237 tests across 14 spec files
- 0 failing (stable baseline)
- Global setup generates JWT directly to avoid rate limits
- messages.spec.js: `beforeAll` seeds a test thread if inbox is empty so data-dependent tests run
- pipelines.spec.js: `waitForFunction` on `.pipe-link` to handle async tbody population

---

## Context Docs in Repo

| File | Purpose |
|---|---|
| `DARKLION.md` | **This file** — master context for new sessions |
| `BUILD_LOG.md` | Full build history phase by phase + session history through 2026-03-28 |
| `SCHEMA_PLAN.md` | Full data model decisions and table definitions |
| `CLAUDE.md` | Original project context (may be outdated — defer to DARKLION.md) |
| `ORGANIZER_PLAN.md` | Tax organizer design doc |
| `PRINT_AGENT_SPEC.md` | Print agent spec |
| `ORGANIZER_USER_GUIDE.md` | Organizer user guide |
| `SCHEMA_PLAN.md` | Schema decisions |

---

## Session History Since BUILD_LOG (2026-03-29 to 2026-03-31)

### 2026-03-29 — Portal Financials + Company Workflow + CRM Modals

- **Send to Tax Prep (Advisor → QBO → PDF):** Button on company Docs tab. Pulls P&L + BS + Trial Balance from QBO. Generates branded PDF with firm logo and brand color. Saves to documents as firm_uploaded/tax. Fires `tax_financials_generated` trigger.
- **Client Portal — Connect QBO + Send Financials:** Only for `bookkeeping_service='client_prepared'` companies. Client can connect QBO or upload P&L/BS PDFs. Saved as client_uploaded/tax. Fires `client_financials_submitted` trigger.
- **Pipeline trigger entity_type filtering:** fireTrigger JOINs pipeline_templates and filters by entity_type. Company triggers only activate company pipelines.
- **Company Workflow Tab:** Full parity with person workflow tab — prev/next stage, Create Card, Fire Trigger.
- **New Company Modal:** +New Company button on CRM Companies tab. Full fields including bookkeeping_service.
- **Person Modal 2-column layout:** Left: personal info, Right: address + notes.
- **Auto-grant portal access:** When company or person added to relationship, portal access auto-granted.
- **Pipeline triggers added to DB (both envs):** `tax_financials_generated`, `client_financials_submitted`

### 2026-03-30 — Portal UX Fixes + Test Hardening

- **Portal bookkeeping empty state:** Shows upload option alongside QB connect
- **Test suite hardening:** JWT bypass in global-setup.cjs, skip login if valid token exists

### 2026-03-31 — Help Center + Portal Ghost Preview + Test Coverage + Refactor

#### Fixes
- **Portal doc count mismatch:** `portal.html` and `crm-person.ejs` — docs with unrecognized categories were counted but not rendered. Fixed by normalizing unknown categories to `'other'` before filtering.
- **Financials upload UX:** After upload success, portal auto-switches to Docs subtab and shows green success banner (auto-dismisses after 8s).
- **Modal button state bug:** Financials modal submit button stuck on "⏳ Sending…" after prior upload. Fixed by resetting button text/state on modal open.
- **viewPortalAsClient scope bug:** inline `onclick` couldn't find the function because it was defined inside a JS closure. Fixed by assigning to `window.viewPortalAsClient`. Also fixed to `await res.json()` before reading the URL.

#### New Feature: Help Center (`/help`)
- Public route, no login required — accessible by staff, clients, and external users
- **Route:** `GET /help` (home), `GET /help/article/:slug`
- **32 articles** across 8 modules: Getting Started, CRM, Documents, Client Portal, Pipelines, Messaging, Tax Organizer, Other (Proposals, Bulk Send, Settings, Viktor AI)
- Left sidebar with full navigation, search bar (real-time across all article content), "← Back to DarkLion" header link
- 👓 Help Center link added to staff sidebar (opens in new tab)
- **Files:** `server/help-articles.js` (article registry + search index), `server/views/help-layout.ejs` (dedicated layout, not EJS shell)
- Article 404 → renders "Article Not Found" with redirect link (not a server error)

#### New Feature: Advisor Portal Ghost Preview
- Staff can view the client portal exactly as a specific client sees it
- **Button:** Person detail → Overview tab → Portal Access section → `👁️ View Portal` (only shown when portal is fully active)
- **API:** `POST /api/people/:id/portal-preview` → returns `{ url }` with short-lived token
- **Token:** JWT with `ghostedBy: staffUserId` claim, expires in **1 hour** (vs. 7 days for real clients)
- **Portal behavior:** `?preview_token=` in URL → token stored in localStorage → purple ghost banner shown: *"Advisor Preview — viewing portal as [Client Name]"* + "← Back to DarkLion" link
- **URL cleanup:** `window.history.replaceState` removes token from address bar after pickup
- **Audit log:** Every preview logged to `audit_log` with actor, client, timestamp
- **File:** `server/routes/people.js` (new endpoint at bottom), `public/portal.html` (token pickup + banner)

#### Test Suite Expansion
Added 5 new spec files + fixed 2 existing:
- `tests/e2e/help.spec.js` — 10 tests: public routes, article pages, sidebar, search
- `tests/e2e/bulk-send.spec.js` — 6 tests: page structure, audience builder, compose
- `tests/e2e/forecast.spec.js` — 6 tests: page load, table/cards rendering
- `tests/e2e/tax-organizer.spec.js` — 3 tests: API endpoints, Organizers tab navigation
- `tests/e2e/portal-ghost.spec.js` — 5 tests: API auth, URL validation, CRM button presence
- `tests/e2e/pipelines.spec.js` — Fixed: `waitForFunction` to detect `.pipe-link` after async load
- `tests/e2e/messages.spec.js` — Fixed: `beforeAll` seeds test thread if inbox is empty

#### Refactor + Cleanup
- Deleted stale public HTML files (8 files shadowing EJS routes)
- Deleted dead `server/services/coa-monitor.js` (0 references)
- Deleted `.github/workflows/deploy-fly.yml` (Fly.io unused, Railway is active)
- Deleted 5 stale `claude/` branches from GitHub

#### Production deploys
- `e20b698` — portal UX fixes + refactor
- `f2c1a6e` — help center + portal ghost preview + tests

### 2026-03-31 (follow-up #2) — Fix Yellow Halo on Custom Branded Login Page

- **Bug:** `my.sentineltax.co` (and all custom domain login pages) showed a yellow glow/halo around the firm logo in the login card
- **Cause:** `.brand-logo` CSS in `server/views/login-branded.ejs` had `filter: drop-shadow(0 0 20px rgba(201,168,76,0.4))` — a DarkLion gold glow that makes no sense on white-label pages showing a client's own logo
- **Fix:** Removed `filter` and `transition` from `.brand-logo` and removed the `.brand-logo:hover` rule entirely. Logo now renders cleanly with no colored border, glow, or effect.
- Pushed to dev: `d975483`

### 2026-03-31 (follow-up #3) — Bulk PDF Uploader + "I don't have this" on Tax Organizer

#### Bulk PDF Uploader (Step 3 of organizer)
- **Card:** The "Have everything in one PDF?" card is now a real upload experience — click or drag & drop
- **Endpoint:** `POST /portal/organizer/client/:year/bulk-upload` — accepts PDF/JPG/PNG, saves to S3 as `organizer_bulk` doc, stores `bulk_document_id` on the `tax_organizers` row
- **UX states:** Idle → Uploading (progress bar animation) → ✅ Green success ("PDF uploaded — we'll sort it out from here") / ❌ Red error with retry
- **Demo mode:** Works without portal token — simulates upload for testing
- **Workpaper:** Cover page now notes if a bulk PDF was submitted, includes it in the doc summary

#### "I don't have this" Button (per item, Step 3)
- **Third action** added alongside Upload / Not This Year on every checklist item
- **Status:** `not_applicable` — new valid status added to `tax_organizer_items`
- **Visual:** Red ✗, strikethrough label, dimmed row (distinct from "Not This Year" which is gray/dash)
- **API:** Uses existing `PUT /portal/organizer/client/:year/item/:itemId` — allowed `not_applicable` as valid status
- **Undo:** Restores item to Pending with all 3 buttons
- **Submit:** `not_applicable` counts as resolved — no longer blocks organizer submission
- **DB:** Idempotent migration drops+re-adds `tax_organizer_items_status_check` to include `not_applicable`; also adds `bulk_document_id` column to `tax_organizers`
- Pushed to dev: `4d1ddc4`

### 2026-03-31 (follow-up #4) — Remove Eye Emoji from Portal Ghost Preview Banner

- **Bug:** Ghost preview banner in `public/portal.html` had 👁️ eye emojis — one in the static HTML `<span>` and one in the JS `bannerText.textContent` string
- **Fix:** Removed both 👁️ characters. Banner text remains intact: *"Advisor Preview — viewing portal as [Client Name]"*
- Pushed to dev: `3cacae6`

### 2026-03-31 (follow-up) — Help Center Accuracy Fix

- **Removed inaccurate "firm-level document library" references** from `server/help-articles.js`
  - `uploading-documents`: replaced callout claiming sidebar Documents shows all clients → accurate note that docs are managed from individual CRM records
  - `document-folders`: removed entire `<h2>Firm-Level Document Library</h2>` section (feature doesn't exist)
  - `delivering-to-clients`: replaced "Bulk Delivery" section claiming central Documents page has multi-select → accurate description of per-client Docs tab delivery
  - `delivering-to-clients` (QBO financials article): removed trailing claim that submitted files also appear "in the firm-level Documents page"
- Pushed to dev: `a27210f`

---

## EJS Shell — The Template That Must Not Break

Every staff page in DarkLion uses the EJS shell. **This is sacred. Do not change it without understanding the full impact.**

### Shell Partials
```
server/views/partials/shell-top.ejs   — opens the page: <html>, <head>, CSS vars, sidebar nav, top header
server/views/partials/shell-close.ejs — closes the page: </body>, </html>, global JS
```

### How Every Page Works
```ejs
<%- include('partials/shell-top', { title: 'Page Title', activeNav: 'navkey' }) %>
<style>/* page-specific styles */</style>
<main class="main">
  <!-- all page content here -->
</main>
<script>/* page-specific JS */</script>
<%- include('partials/shell-close') %>
```

### Rules for the Shell
1. **The left nav and top header are defined in `shell-top.ejs` — they NEVER change per page.** Only the `<main>` content changes.
2. **Never add page-specific nav items to the shell.** All nav links are global.
3. **activeNav** controls which sidebar item is highlighted — must match a nav key defined in shell-top.
4. **CSS variables** are defined in shell-top (--gold, --navy, --charcoal, --border, --text, --muted, --card, --bg). Use them. Never hardcode colors.
5. **`window._shellToast(message, type)`** is the toast notification function available on all EJS pages. Type: 'success', 'error', 'info'. Do NOT call `toast()` — it doesn't exist on detail pages.
6. **Never build a new staff page as a static `public/*.html`** — it won't have the shell, won't have auth, and will get stale. Always use EJS.
7. **When building a new page:** start with a blank placeholder inside the shell, confirm it renders, then add content incrementally.

### Nav Keys (activeNav values)
```
''                  — dashboard (no highlight)
'relationships'     — CRM
'people'            — CRM
'companies'         — CRM
'messages'          — Messages
'pipelines'         — Pipelines
'documents'         — Documents
'bulk-send'         — Bulk Send
'templates'         — Templates
'settings'          — Settings
'statements-calendar' — Statement Calendar
```

---

## Build History — Phase Timeline

| Phase | What | Completed |
|---|---|---|
| 1 | Foundation: schema, Relationships/Companies/People tables, encryption, CRUD APIs | 2026-03-20 |
| 2 | Auth + portal logins: JWT, portal-auth routes, invite/reset flow | 2026-03-20 |
| 3 | Internal CRM UI: crm.ejs + full-page detail views (person, company, relationship) | 2026-03-20 |
| 4 | Document management: S3 upload/download, signed URLs, folder structure | 2026-03-20 |
| 5 | Client portal: full SPA, invite emails (Resend), doc view, upload | 2026-03-20 |
| 6 | Pipelines: kanban, drag-drop, instances, stage editor, job detail | 2026-03-21 |
| 7 | Tax return delivery + e-signatures | 2026-03-21 (built, needs refinement) |
| 8 | Secure messaging: staff inbox, portal chat, thread sharing, AI classification | 2026-03-20 |
| 9 | Proposals + engagement letters | SKIPPED — not building |
| 10 | Billing (Stripe) | SKIPPED — not building |
| 11 | Viktor full integration: agent role, all endpoints, audit log | 2026-03-23 |
| 12 | Gmail connector (design complete, not yet implemented) | 2026-03-23 |
| 13 | Native AI layer: alert engine, smart triage, client brief generator, workflow automation | 2026-03-23 |
| 14 | Engagement tab: upload/view letters, AI extraction of key terms | 2026-03-23 |
| 6b | Pipeline bulk add (backlog — needs more CRM data first) | Not started |
| — | EJS shell migration: all CRM pages converted from static HTML to EJS | 2026-03-24 |
| — | Print Agent (Windows Electron app, confirmed working) | 2026-03-24 |
| — | Firm branding settings | 2026-03-24 |
| — | Dev/prod Railway environments + Playwright test suite (173 tests) | 2026-03-24 |
| — | DarkLion Drive (Windows Electron + rclone, confirmed working) | 2026-03-25 |
| — | Bulk send with audience builder | 2026-03-25 |
| — | Pipeline smart triggers (12 types) + stage actions | 2026-03-25 |
| — | Pipeline settings page | 2026-03-25 |
| — | Pipeline completion history + nightly archive | 2026-03-25 |
| — | Tax organizer (4-step portal flow, Drake PDF parser) | 2026-03-26 |
| — | QBO connect flow fixed + deployed to prod | 2026-03-27 |
| — | Send to Tax Prep: QBO → branded PDF | 2026-03-29 |
| — | Client portal: connect QBO + upload P&L/BS PDFs | 2026-03-29 |
| — | Refactor: remove stale HTML, dead services, Fly.io CI | 2026-03-31 |
| — | Remove 2nd-gen placeholder screenshots from help center (21 images + figure blocks) | 2026-03-31 |

---

## Problems We've Hit — Don't Repeat These

### 1. Subagent EJS Wipeout (2026-03-24) ⚠️ MOST DANGEROUS
**What happened:** Used a subagent to refactor EJS pages. Subagent didn't know which files were stale `public/*.html` vs. live `server/views/*.ejs` with months of work. It used the wrong files as source, stripping content from the real EJS files.
**Recovery:** `git show <hash>:server/views/<file>.ejs` to retrieve from git history.
**Rule:** **Never use subagents for EJS page edits.** Do them directly. The context to know what's "stale public HTML" vs "live EJS with real work in it" doesn't survive being passed to a subagent.
**Rule:** Create a git tag before any multi-file refactor: `git tag backup/pre-<description>-$(date +%Y%m%d)`
**Rule:** After any refactor, check `wc -l` — a 1300-line EJS file should not become 400 lines.

### 2. Static HTML Shadowing EJS Routes (found 2026-03-31)
**What happened:** `express.static` is registered at line 151 in `server/index.js`, BEFORE named routes at line 194+. So `/crm.html` served the stale `public/crm.html` directly, bypassing the EJS route — even though an explicit redirect existed.
**Fix:** Deleted all stale `public/*.html` files that had EJS equivalents.
**Rule:** If you're adding a new EJS page, make sure there's no `public/<name>.html` file with the same base name.

### 3. DB Migration Missing From db.js (2026-03-28)
**What happened:** Added columns to API code (`address_line1`, etc.) and tested locally, but forgot to add the `ALTER TABLE` migration to `server/db.js`. Prod didn't have the columns, causing 500 errors on the company page.
**Rule:** Every schema change goes in `server/db.js` as an idempotent `ALTER TABLE IF NOT EXISTS` or `ADD COLUMN IF NOT EXISTS`. Never expect columns to exist without a migration.

### 4. Pipeline Status Typo (2026-03-27)
**What happened:** `fireTrigger` was checking for `job_status = 'complete'` but the DB stores `'completed'`. Trigger never fired, duplicate jobs were created.
**Rule:** Pipeline job_status values are exactly: `'active'`, `'completed'`, `'archived'`. Not 'complete', not 'done'.

### 5. QBO Realm ID Null Check (2026-03-27)
**What happened:** `companies.realm_id` defaults to `''` (empty string), not NULL. Code checking `if (company.realm_id)` evaluates to true for empty string in some contexts. Caused false "connected" states.
**Rule:** Always check `realm_id && realm_id.trim()` — not just `realm_id`.

### 6. QBO Liability Balances Are Negative (2026-03-27)
**What happened:** QBO returns liability balances as negative numbers (credit-normal accounting). Code was flagging normal credit balances as problems because it compared raw values directly.
**Fix:** Flip sign for display: `displayBalance = -rawBalance`. Only flag when `displayBalance < 0`.

### 7. Toast Function Not Available on Detail Pages (2026-03-25)
**What happened:** Calling `toast()` from crm-person.ejs / crm-company.ejs context threw "toast is not defined".
**Rule:** On EJS detail pages, use `window._shellToast(message, type)`. The `toast()` function only exists in the shell's global scope under a different name.

### 8. Express Route Ordering (recurring)
**Rule:** Always register specific routes before wildcard `/:id` routes. Express matches in order — if `/:id` is first, it swallows everything including `/all`, `/settings`, `/search`.
**Example:** `GET /api/organizers/:personId/all` must come before `GET /api/organizers/:personId/:year`.

### 9. Tab/Display:none Race Condition (2026-03-25)
**What happened:** `#tab-communication` div was never closed in the HTML, so the organizers/workflow/notes tabs were nested inside the communication tab. They appeared to work (display:none kept them hidden) but their JS initialized inside the wrong container.
**Rule:** Always validate HTML structure when adding new tabs. Each tab panel must be a proper sibling, not nested.

### 10. Inline Style Not Cleared on Tab Switch (2026-03-25)
**What happened:** Some tab panels had `style="display:none"` set inline. Tab switching code toggled a class, but the inline style took priority over class-based styles — panels stayed hidden even when "active".
**Rule:** When hiding/showing elements programmatically, be consistent. Either use only classes OR only inline styles — don't mix. Or explicitly clear inline style: `el.style.display = ''`.

### 11. Subagent Variable Shadowing (2026-03-25)
**What happened:** `const el = document.getElementById(...)` inside a loop — the variable name `el` was reused in an inner scope, shadowing the outer variable and causing tab switch failures.
**Rule:** Use descriptive variable names in JS. Don't reuse `el`, `btn`, `res` as generic names inside closures or nested functions.

### 12. Organizer Step 2 Answers Lost (2026-03-27)
**What happened:** Step 2 yes/no answers were being read from DOM input selectors at submit time. The selectors were slightly wrong, so answers were silently lost — organizer submitted with empty answers.
**Fix:** Store answers in a JS object (`_answers{}`) keyed by question ID as the user clicks, not at submit time.
**Rule:** For multi-step forms, write state to JS objects as the user interacts. Don't rely on reading DOM values at the end — selectors can be wrong silently.

---

## What's Next / Backlog

| Item | Notes |
|---|---|
| Phase 6b — Pipeline Bulk Add | "📥 Bulk Add" button on board header. Needs more CRM data for meaningful filtering first. |
| Gmail connector | Design complete in BUILD_LOG.md. Uses Google Workspace service account + domain-wide delegation. |
| Phase 7 refinement | Tax return delivery e-signatures need testing and polish |
| Security checklist | See BUILD_LOG.md — several items flagged before real client data |
| SOC 2 audit | Design is ready; formal engagement when client volume warrants |
