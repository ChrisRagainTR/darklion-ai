# DARKLION.md — Master Context Document
> Read this at the start of every session before touching any code.
> Last updated: 2026-03-31

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
| E2E test suite (173 tests) | `tests/e2e/`, `tests/global-setup.cjs` |
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

- 173 passing / 0 failing (stable baseline)
- 29 skipped (data-dependent — pipelines/messages need real records)
- Global setup generates JWT directly to avoid rate limits

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

### 2026-03-31 — Refactor + Doc Count Fix + Financials UX

- **Portal doc count mismatch (fixed):** `portal.html` and `crm-person.ejs` — docs with categories not in the valid cat list were counted but not rendered. Fixed by normalizing unknown categories to 'other' before filtering.
- **Financials upload UX:** After upload success, portal auto-switches to Docs subtab and shows green success banner (auto-dismisses after 8s).
- **Modal button state bug (fixed):** Financials modal submit button stuck on "⏳ Sending…" after prior upload. Fixed by resetting button text/state on modal open.
- **Refactor:** Deleted stale public HTML files (8 files shadowing EJS routes), dead `coa-monitor.js` service, Fly.io deployment workflow.
- **Branch cleanup:** Deleted all stale `claude/` branches from GitHub.
- **Prod push:** All above merged to main and deployed.
