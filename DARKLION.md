# DARKLION.md — Master Context Document
> Read this at the start of every session before touching any code.
> Last updated: 2026-04-02
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
    firms.js            — Firm settings, branding, login, integrations (Blueleaf)
    relationships.js    — Relationships CRUD
    people.js           — People CRUD + company access + portal preview
    documents.js        — Document upload/download/metadata (S3)
    messages.js         — Staff messaging inbox API
    portal.js           — Protected portal API (client-facing)
    portal-auth.js      — Portal login/invite/reset
    organizer.js        — Tax organizer flow (staff + portal routes)
    pipelines.js        — Pipeline CRUD + kanban
    pipeline-triggers.js — Trigger definitions + fire endpoint
    pipeline-actions.js  — Stage actions (portal message, staff task)
    tax-delivery.js     — Tax return delivery + e-signatures
    tax-season.js       — Tax season visibility API (organizer_visible per person)
    engagement.js       — Engagement letter upload/AI extraction
    templates.js        — Message templates
    bulk-send.js        — Bulk portal messaging
    summaries.js        — Conversation summaries
    dashboard.js        — Dashboard intel API
    forecast.js         — Revenue forecast
    billing.js          — Billing API
    proposals.js        — Proposals (internal staff)
    proposals-public.js — Proposals (public view/sign page)
    viktor.js           — Viktor firm context + getFirmContext()
    viktor-chat.js      — Viktor AI chat (streaming, tools, briefings)
    webdav.js           — WebDAV drive server
    blueleaf.js         — Blueleaf integration (households, enable FP, snapshots)
    market.js           — Finnhub market ticker (S&P 500, Dow, Nasdaq, BTC, Gold, Oil, VIX)
  services/
    s3.js               — uploadFile, getSignedDownloadUrl, deleteFile, buildKey
    email.js            — Resend email (invite, reset, notifications, statement reminders)
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
    blueleaf.js         — Blueleaf API client (fetchHouseholds, fetchPortfolio, XML parsing)
  views/                — ALL staff pages (EJS shell — source of truth)
    layout.ejs          — (unused — shell uses partials instead)
    partials/
      shell-top.ejs     — Top of every page (header, sidebar, CSS)
      shell-close.ejs   — Bottom of every page (closing tags)
    crm.ejs             — /crm — 3-tab: Relationships, People, Companies
    crm-person.ejs      — /crm/person/:id
    crm-company.ejs     — /crm/company/:id
    crm-relationship.ejs — /crm/relationship/:id
    dashboard.ejs       — /dashboard (overview + Viktor chat panel + QBO scanner sections)
    messages.ejs        — /messages
    pipelines.ejs       — /pipelines
    pipeline-settings.ejs — /pipelines/:instanceId/settings
    bulk-send.ejs       — /bulk-send
    documents.ejs       — /documents
    settings.ejs        — /settings (6 tabs: Branding, Domains, API Keys, Downloads, Tax Season, Integrations)
    team.ejs            — /team
    templates.ejs       — /templates
    statements-calendar.ejs — /statements-calendar
    conversation-summaries.ejs — /conversation-summaries
    api-docs.ejs        — /api-docs
    forecast.ejs        — /forecast
    proposals.ejs       — /proposals
    proposal-create.ejs — /proposals/new (also /proposals/:id/edit)
    proposal-detail.ejs — /proposals/:id
    tax-season.ejs      — /tax-season (per-client organizer visibility controls)
    help-layout.ejs     — /help + /help/article/:slug (public, no auth, own layout)
    people.ejs          — (redirect stub — /crm/people redirects to /crm?tab=people)
    companies.ejs       — (redirect stub — /crm/companies redirects to /crm?tab=companies)
    relationships.ejs   — (redirect stub — redirects to /crm?tab=relationships)
    404.ejs             — error page
    login-branded.ejs   — custom domain login (no logo glow/filter)
    webdav-help.ejs     — WebDAV setup guide (staff)
    webdav-help-public.ejs — WebDAV setup guide (public)
    partials/
      shell-top.ejs     — Opens every page: <html>, <head>, CSS vars, sidebar nav, top header
      shell-close.ejs   — Closes every page: </body>, </html>, global JS
      shell-globals.ejs — Global JS helpers shared across shell pages
      shell-bottom.ejs  — Bottom-of-page scripts (Pusher init, etc.)
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
| `pipeline_triggers` | 18 trigger types (underscore convention) |
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
| `blueleaf_snapshots` | Cached Blueleaf portfolio snapshots per person (timestamp + raw data) |
| `viktor_context` | Per-firm Viktor context blob (free-text, updated by staff) |
| `viktor_sessions` | Per-staff Viktor chat sessions — messages array, briefing_generated flag |
| `proposals` | Proposal records. Has: relationship_id, status (draft/sent/accepted/signed), engagement_type (tax/wealth), tiers, add_ons |
| `proposal_acceptances` | When a proposal is accepted (public sign page) |
| `proposal_engagements` | Engagement letter records linked to signed proposals. AI-extracted fields. |
| `message_templates` | Staff message templates for quick-insert in compose |
| `conversation_summaries` | Claude-generated 30-day message summaries per thread/person |
| `api_tokens` | Firm-scoped API keys for external access (Viktor, integrations) |
| `firm_domains` | Custom domains mapped to firm_id (e.g. my.sentineltax.co) |

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
| **Scheduled** | Blueleaf portfolio snapshot refresh (per firm, when Blueleaf token set) |

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
FINNHUB_API_KEY
```

> **Note:** `FINNHUB_API_KEY` is optional — if missing, the market ticker simply returns `{ available: false }` and the Investments tab hides the ticker.

---

## Features Built (Complete)

### Core Platform
| Feature | Where |
|---|---|
| Multi-tenant firm auth (JWT, staff + portal tokens) | `server/routes/firms.js`, `server/middleware/requireFirm.js`, `requirePortal.js` |
| 3-entity CRM (Relationships / Companies / People) | `server/routes/relationships.js`, `api.js`, `people.js` |
| CRM list view (3-tab: Relationships, People, Companies) | `server/views/crm.ejs` |
| CRM detail views (person, company, relationship) | `server/views/crm-person.ejs`, `crm-company.ejs`, `crm-relationship.ejs` |
| Address fields on people and companies | `crm-person.ejs`, `crm-company.ejs`, DB migrations |
| Recently visited clients (search bar shows last 5) | `server/views/partials/shell-top.ejs` |
| Team page — invite, edit name/email, copy invite link | `server/views/team.ejs`, `server/routes/auth.js` |
| Firm branding (logo, colors, address for proposals/tax letters) | `server/routes/firms.js`, `server/views/settings.ejs` |
| Custom domains (e.g. my.sentineltax.co) | `server/routes/firms.js`, `firm_domains` table, `domainFirm.js` middleware |
| API key management (generate, list, revoke) | `server/views/settings.ejs`, `api_tokens` table |
| Settings page (6 tabs: Branding, Domains, API Keys, Downloads, Tax Season, Integrations) | `server/views/settings.ejs` |
| Audit log (every action logged with actor, entity, IP, timestamp) | `audit_log` table, throughout routes |
| PWA support (Add to Home Screen, mobile nav) | `public/manifest.json`, `server/views/partials/shell-top.ejs` |

### Document Management
| Feature | Where |
|---|---|
| Document upload/download (S3, signed URLs) | `server/routes/documents.js`, `server/services/s3.js` |
| Two-column folder UI (Advisor/Client, year folders, category subfolders) | `crm-person.ejs`, `crm-company.ejs` |
| Page-wide drag-and-drop upload | `crm-person.ejs`, `crm-company.ejs` |
| Bookkeeping sub-folders by account name | `crm-company.ejs`, `portal.js` (folder_subcategory column) |
| Send to Tax Prep (QBO → branded PDF, fires trigger) | `server/routes/api.js`, `server/services/taxFinancialsPdf.js` |
| Documents page (firm-level view) | `server/views/documents.ejs` |

### Client Portal
| Feature | Where |
|---|---|
| Full portal SPA (overview, docs, messages, tax, investments) | `public/portal.html`, `server/routes/portal.js` |
| Portal auth (invite, reset, login) | `public/portal-login.html`, `server/routes/portal-auth.js` |
| Portal: document delivery + NEW badge | `portal.js`, `documents.js` |
| Portal: secure messaging (iMessage-style bubbles) | `portal.js`, `messages.js` |
| Portal: typing indicators (Pusher private channels) | `portal.js`, Pusher auth endpoint in `index.js` |
| Portal: connect QBO + send financials (client_prepared companies) | `portal.js` POST `/portal/companies/:id/tax-financials` |
| Portal: upload P&L + BS PDFs (drag & drop) | `portal.js` multipart upload |
| Portal: Statements tab (client_upload accounts) — upload monthly bank statements, see status | `portal.js` POST `/portal/companies/:id/statements/:scheduleId/:month` |
| Portal: Statements outstanding card on overview with Upload Now | `portal.html`, `portal.js` |
| Portal: Tax delivery (review copy, e-sign, download signed PDF) | `portal.js`, `public/portal.html` |
| Portal: Investments tab (Blueleaf portfolio, hide/show accounts, performance cards) | `portal.js` GET `/portal/investments`, `portal.html` |
| Portal: Market ticker on Investments tab (S&P 500, Dow, Nasdaq, BTC, Gold, Oil, VIX) | `portal.js` GET `/portal/market/ticker`, `server/routes/market.js` |
| Advisor ghost preview (“View Portal as Client”) | `server/routes/people.js` POST `/:id/portal-preview`, `public/portal.html` ghost banner |
| Custom domain portal login (my.sentineltax.co etc.) | `server/views/login-branded.ejs`, `domainFirm.js` |

### Pipelines
| Feature | Where |
|---|---|
| Kanban board (drag-drop, instances, year selector) | `server/routes/pipelines.js`, `server/views/pipelines.ejs` |
| Pipeline job cards (notes, activity log, stage nav) | `pipelines.ejs`, `pipeline_job_updates` table |
| Pipeline clone + archive | `pipelines.ejs` |
| Pipeline settings page (stage editor, triggers, actions) | `server/views/pipeline-settings.ejs` |
| Pipeline smart triggers — 18 types | `server/routes/pipeline-triggers.js`, `server/services/pipelineTriggers.js` |
| Pipeline stage actions (auto portal message, auto staff task) | `server/routes/pipeline-actions.js`, `server/services/pipelineActions.js` |
| Pipeline completion + nightly archive (10 PM) | `scheduler.js`, `pipeline_completions` table |
| Workflow tab on person + company CRM pages | `crm-person.ejs`, `crm-company.ejs` |

**Pipeline trigger keys (all 18):**
```
tax_return_deployed         — Tax Return Sent to Client
tax_return_signed           — Tax Return Signed by Client
tax_return_approved         — Tax Return Approved by Staff
engagement_letter_sent      — Engagement Letter Sent
engagement_letter_signed    — Client Signed Engagement Letter
tax_loe_signed              — Tax LOE Signed
wealth_loe_signed           — Wealth LOE Signed
client_requested_changes    — Client Requested Changes
proposal_sent               — Proposal Sent
proposal_signed             — Proposal Signed
proposal_accepted           — Proposal Accepted
portal_message_received     — Client Sent a Portal Message
portal_first_login          — Client First Portal Login
document_uploaded_by_client — Client Uploaded a Document
organizer_submitted         — Client Submitted Tax Organizer
tax_financials_generated    — Tax Financials Sent to Tax Prep
client_financials_submitted — Client Submitted Financials to Tax Prep
client_statement_uploaded   — Client Uploaded a Bank Statement
```

### Messaging
| Feature | Where |
|---|---|
| Staff inbox (TaxDome-style thread list, card messages) | `server/routes/messages.js`, `server/views/messages.ejs` |
| iMessage-style bubbles in CRM comm tab | `crm-person.ejs`, `crm-company.ejs` |
| Thread sharing (@mentions, thread_participants) | `messages.js` |
| AI company tagging on threads | `messages.js` |
| Typing indicators (Pusher) | `messages.js`, Pusher auth in `index.js` |
| Message templates (quick-insert) | `server/routes/templates.js`, `server/views/templates.ejs` |
| Bulk send with audience builder | `server/routes/bulk-send.js`, `server/views/bulk-send.ejs` |
| Conversation summaries (Claude, 30-day) | `server/routes/summaries.js`, `server/services/summaryGenerator.js` |
| Changes requested — creates staff message thread | `tax-delivery.js` |

### Tax Organizer
| Feature | Where |
|---|---|
| 4-step client organizer flow (Confirm Info, Questions, Docs, Submit) | `public/organizer.html`, `server/routes/organizer.js` |
| Drake PDF parser — auto-creates checklist from Drake organizer | `server/services/organizerParser.js` |
| Advisor organizer tab (full read-only view, stats, workpaper download) | `crm-person.ejs` |
| Custom questions per client (advisor-added) | `tax_organizers.custom_questions` JSON column |
| Custom doc items per client (advisor-added) | `tax_organizer_items.advisor_added` flag |
| Bulk PDF upload (one PDF covers entire organizer) | `organizer.js` POST `/portal/organizer/client/:year/bulk-upload` |
| “In Bulk Upload” per-item status | `tax_organizer_items` status `not_applicable` |
| “Not This Year” per-item button | `tax_organizer_items` status `not_this_year` |
| Auto-submit closes organizer, reclassifies docs to tax | `organizer.js` |
| Pipeline trigger on submit (`organizer_submitted`) | `organizer.js` → `pipelineTriggers.js` |
| Reopen organizer (Request More Docs) | `organizer.js` PUT `/:personId/:year/reopen` |
| Tax Season page — per-client organizer visibility toggle | `server/views/tax-season.ejs`, `server/routes/tax-season.js` |
| Active tax year setting (Settings → Tax Season tab) | `server/views/settings.ejs`, firms.active_tax_year |

### Tax Return Delivery
| Feature | Where |
|---|---|
| Create delivery (year dropdown, doc selector, multi-signer) | `server/routes/tax-delivery.js`, `crm-person.ejs`, `crm-company.ejs` |
| Review copy + e-signature (embedded PDF with pdf-lib) | `server/services/sign-pdf.js`, `tax-delivery.js` |
| Signed PDF stored in S3, linked to signer record | `tax_delivery_signers.signed_doc_id` |
| AI tax return analysis (Claude) | `server/services/taxAnalysis.js` |
| Edit Docs modal on draft deliveries | `crm-person.ejs` |
| Changes requested — creates staff message thread | `tax-delivery.js` |
| Delivery card shows doc links (review copy + signed per signer) | `crm-person.ejs` |
| Personal (1040) + business (company_id) deliveries | `tax-delivery.js` |

### Proposals & Engagement Letters
| Feature | Where |
|---|---|
| Proposal creation (tax or wealth engagement type, tiers, add-ons) | `server/views/proposal-create.ejs`, `server/routes/proposals.js` |
| Proposal list + stats | `server/views/proposals.ejs`, `proposals.js` GET `/stats` |
| Public proposal view + e-sign page | `public/proposal-view.html`, `public/proposal-sign.html`, `proposals-public.js` |
| Save-to-CRM (creates engagement letter, fires tax_loe_signed or wealth_loe_signed trigger) | `proposals.js` POST `/:id/save-to-crm` |
| Fires `proposal_sent` trigger on status → sent | `proposals.js` |
| Fires `proposal_signed` trigger with engagement_type context | `proposals.js` |
| Engagement letter upload + AI extraction of key terms | `server/routes/engagement.js` |
| Engagement letters listed on relationship CRM page | `crm-relationship.ejs` |

### Financial Planning & Investments (Blueleaf)
| Feature | Where |
|---|---|
| Blueleaf API integration (per-firm token) | `server/routes/blueleaf.js`, `server/services/blueleaf.js`, `firms.blueleaf_api_token` |
| Blueleaf settings in Settings → Integrations tab | `server/views/settings.ejs` |
| Enable financial planning per client (link Blueleaf household) | `blueleaf.js` POST `/api/people/:id/financial-planning/enable` |
| Portal Investments tab — account list, balances, hide/show | `public/portal.html`, `portal.js` GET `/portal/investments` |
| Hide accounts persisted to DB (`people.blueleaf_hidden_accounts`) | `portal.js`, DB column |
| Performance cards (Last Month, Last Quarter) | `portal.html` |
| Market ticker (S&P 500, Dow, Nasdaq, BTC, Gold, Oil, VIX via Finnhub) | `server/routes/market.js`, `portal.html` |
| Ticker cached 5 min server-side | `market.js` in-memory cache |
| Advisor Investments view matches portal | `crm-person.ejs` |

### Bank Statement Collection
| Feature | Where |
|---|---|
| Statement schedules (per-account, per-company) | `statement_schedules` table, `crm-company.ejs` |
| Bookkeeping method dropdown (QBO Download / Sentinel Download / Client Upload) | `crm-company.ejs` |
| Client Upload mode — start month, monthly portal upload, reminders | `portal.js`, `organizer.js`, `statement_monthly_status` table |
| Advisor status view (per-month status grid) | `crm-company.ejs` |
| Statement reminder emails | `server/services/email.js` (Resend) |
| Outstanding statements card on portal overview | `portal.html` |
| Bookkeeping sub-folders by account name (advisor + portal) | `crm-company.ejs`, `portal.js` |
| Statement calendar (firm-level monthly view) | `server/views/statements-calendar.ejs` |
| `client_statement_uploaded` pipeline trigger | `portal.js` → `pipelineTriggers.js` |

### Viktor AI
| Feature | Where |
|---|---|
| Viktor AI chat (streaming, Claude Sonnet) | `server/routes/viktor-chat.js` |
| Daily briefing (pre-generated 4 AM, Claude Haiku) | `scheduler.js`, `viktor-chat.js` POST `/briefing` |
| Viktor context blob (per-firm, staff-editable) | `server/routes/viktor.js`, `viktor_context` table |
| Viktor firm context (relationships, engagement letters, messages) | `viktor.js` GET `/context`, `/relationship/:id`, `/engagement-letters`, `/messages/:threadId` |
| Viktor embedded in dashboard right panel | `server/views/dashboard.ejs` |
| Viktor tools — CRM lookup, document access, thread reading | `viktor-chat.js` |

### Dashboard
| Feature | Where |
|---|---|
| Overview cards (pipeline, proposals, statements) | `server/views/dashboard.ejs` |
| Alert engine (uncategorized txns, payroll mismatch, P&L variance, liability issues) | `dashboard.ejs` + scanner APIs |
| QBO scanner sections (uncategorized, variance, liability, payroll) | `dashboard.ejs`, `server/routes/dashboard.js` |
| Client connection status cards | `dashboard.ejs` |
| Viktor AI chat panel (right column) | `dashboard.ejs` |
| Revenue forecast page | `server/views/forecast.ejs`, `server/routes/forecast.js` |

### Help Center
| Feature | Where |
|---|---|
| Public Help Center at `/help` (no login required) | `server/help-articles.js`, `server/views/help-layout.ejs` |
| 32+ articles across 8 modules | `server/help-articles.js` |
| Real-time full-text search | `help-layout.ejs` client-side search |
| Left sidebar navigation | `help-layout.ejs` |
| Help Center link in staff sidebar | `server/views/partials/shell-top.ejs` |

### Windows Desktop Apps
| Feature | Where |
|---|---|
| DarkLion Drive (mounts docs as Windows drive letter L:) | `darklion-drive/` — Electron + rclone + WinFsp |
| DarkLion Print Agent (virtual printer → DarkLion upload) | `darklion-print-agent/` — Electron + Ghostscript |
| Print Agent CI build (auto on main push) | `.github/workflows/build-print-agent.yml` |
| Print Agent token expiry check on search/upload | `darklion-print-agent/` |
| Desktop app download links in Settings → Downloads tab | `server/views/settings.ejs` |

### Misc / Infrastructure
| Feature | Where |
|---|---|
| QBO OAuth (connect, callback, token refresh) | `server/services/quickbooks.js`, `public/connect.html`, `callback.html` |
| QBO token keep-alive (nightly refresh + reconnect UI) | `scheduler.js`, `crm-company.ejs` |
| QBO OAuth returns to originating domain (subdomain support) | `quickbooks.js`, state param |
| Gusto payroll integration (payroll verification) | `server/services/payroll.js` |
| Pusher real-time (typing indicators, message updates) | `server/index.js` Pusher auth endpoints |
| Styled confirm modal (dlConfirm — replaces browser confirm()) | `server/views/partials/shell-globals.ejs` |
| E2E test suite (237 tests, 14 spec files, 0 failing) | `tests/e2e/`, `tests/global-setup.cjs` |

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
- Current version: **v1.0.1** (April 2026 build)
- Token expiry check on search + upload — re-prompts login if JWT expired
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

### 2026-04-01 — Proposals + Tax Season + Blueleaf + Investments + Statements + Triggers

This was a massive session covering 5 major features plus a lot of polish.

#### Proposals System (fully built)
- **Proposal creation wizard:** `server/views/proposal-create.ejs` — create tax or wealth engagement proposals with tiers, add-ons, client info, custom letter text
- **Engagement type:** `tax` or `wealth` — controls trigger routing and LOE type
- **Proposal list page:** `server/views/proposals.ejs` — stats (total, sent, accepted, signed), list with status badges
- **Proposal detail page:** `server/views/proposal-detail.ejs` — view/edit, status progression, save-to-CRM
- **Public view + sign:** `public/proposal-view.html`, `public/proposal-sign.html` — served at `/p/:token` and `/p/:token/sign`
- **Save-to-CRM:** Creates engagement letter record, fires `tax_loe_signed` or `wealth_loe_signed` trigger based on engagement_type
- **Pipeline trigger wiring:**
  - `proposal_sent` fires when status → sent
  - `proposal_signed` fires on public sign, includes `engagement_type` context
  - `engagement_letter_signed` fires on save-to-CRM
  - `tax_loe_signed` / `wealth_loe_signed` fire on save-to-CRM based on engagement type

#### Tax Season Page
- **Route:** `GET /tax-season` → `server/views/tax-season.ejs`
- **API:** `server/routes/tax-season.js`
  - `GET /api/tax-season/clients` — list all clients with organizer status + visibility state
  - `POST /api/tax-season/bulk` — show/hide all clients at once
  - `POST /api/tax-season/person/:id` — show/hide one client
- **UX:** Table of all clients, each row has toggle, bulk Show All / Hide All buttons
- **DB:** `people.organizer_visible` boolean column
- **Linked from Settings → Tax Season tab** via a gold button

#### Blueleaf Financial Planning Integration
- **Per-firm API token:** stored in `firms.blueleaf_api_token` — set in Settings → Integrations tab
- **Enable per client:** `POST /api/people/:id/financial-planning/enable` — links a Blueleaf household to a client
- **Blueleaf service:** `server/services/blueleaf.js` — `fetchHouseholds()`, `fetchPortfolio()`, XML parsing for nested account/balance structure
- **Portal Investments tab:**
  - Account list with custodian pill, account number, balance
  - Large total (excludes hidden accounts)
  - Hide/show accounts (persisted to `people.blueleaf_hidden_accounts` JSONB column)
  - Performance cards: Last Month, Last Quarter
  - Retry button on error
- **Advisor view:** `crm-person.ejs` Investments section mirrors portal
- **DB:** `blueleaf_snapshots` table for caching, `people.financial_planning_enabled`, `people.blueleaf_household_id`, `people.blueleaf_hidden_accounts`

#### Finnhub Market Ticker
- **Route:** `GET /api/market/ticker` (staff) and `GET /portal/market/ticker` (portal) — both served by `server/routes/market.js`
- **Symbols:** S&P 500 (SPY), Dow (DIA), Nasdaq (QQQ), Bitcoin (BINANCE:BTCUSDT), Gold (GLD), Oil (USO), VIX (UVXY)
- **Caching:** 5-minute server-side in-memory cache. Returns `{ available: false }` if `FINNHUB_API_KEY` not set.
- **Portal UX:** Ticker strip at top of Investments tab. Shows price + % change, color-coded green/red.

#### Bank Statement Client Upload Portal
- **Context:** Companies with `bookkeeping_service='client_upload'` need to provide bank statements monthly
- **Statement schedule setup:** Advisor sets start_month on a per-account basis in `crm-company.ejs`
- **Portal Statements tab:** Clients see one row per expected month. Upload button per month. Status: pending / uploaded / retrieved.
- **Outstanding statements card:** Shows on portal overview tab when any months are pending. "Upload Now" button.
- **Upload endpoint:** `POST /portal/companies/:id/statements/:scheduleId/:month` — saves file to S3, creates document record, fires `client_statement_uploaded` trigger
- **Advisor status view:** `crm-company.ejs` shows per-month upload status grid. Marks retrieved.
- **Reminder emails:** Sent via Resend when statements are past due
- **Bookkeeping sub-folders:** Both advisor view (`crm-company.ejs`) and portal now group bookkeeping docs by account name as sub-folders (uses `documents.folder_subcategory` column)
- **DB:** `statement_schedules` table (accounts to track), `statement_monthly_status` table (per-month status + document_id)

#### New Pipeline Triggers (bringing total to 18)
- `client_statement_uploaded` — fires when client uploads a bank statement via portal
- `tax_loe_signed` — fires when Tax LOE signed (proposal save-to-CRM)
- `wealth_loe_signed` — fires when Wealth LOE signed (proposal save-to-CRM)
- (Previously also added: `tax_financials_generated`, `client_financials_submitted`)

#### Print Agent v1.0.1
- Updated download URL in Settings → Downloads tab to point to v1.0.1 installer
- Added token expiry check in search + upload handlers — re-prompts login if token expired

#### Prod deploys on 2026-04-01
- `f53578d` — merge: bookkeeping statement upload + tests to production

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
| — | Help Center (32 articles, public, search) | 2026-03-31 |
| — | Advisor portal ghost preview (View Portal as Client) | 2026-03-31 |
| — | Tax organizer: bulk PDF upload + “In Bulk Upload” per-item button | 2026-03-31 |
| — | Tax Season page (per-client organizer visibility controls) | 2026-03-31 |
| — | Proposals system (create, send, public sign, save-to-CRM) | 2026-03-31 |
| — | Blueleaf financial planning integration + portal Investments tab | 2026-04-01 |
| — | Finnhub market ticker on Investments tab | 2026-04-01 |
| — | Bank statement client upload portal (Statements tab, reminders, advisor status view) | 2026-04-01 |
| — | Bookkeeping sub-folders by account name (advisor + portal) | 2026-04-01 |
| — | 18 pipeline triggers (added client_statement_uploaded, tax_loe_signed, wealth_loe_signed) | 2026-04-01 |
| — | Print Agent updated to v1.0.1 + token expiry check | 2026-04-01 |

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

## Tax Organizer — How It Works

### Overview
The tax organizer is a 4-step client-facing flow for collecting tax documents. Staff sends an organizer to a specific client for a specific year. The client logs into the portal and completes it.

### Key Facts
- **Sent per-client, per-year** — staff creates an organizer for a specific person + year in CRM
- **Not enabled by default** — clients only see the Organizers tab if they have at least one organizer assigned
- **NOT in active use yet** — planned launch Jan 2027. Do not build features that assume clients are using it now.
- **Organizers tab in portal** — currently always visible. TODO: hide when no organizers assigned.

### 4 Steps (client-facing at `/organizer`)
1. **Confirm Info** — name, address, filing status, spouse
2. **Questions** — custom questions set by staff (stored as JSON on `tax_organizers.custom_questions`)
3. **Documents** — checklist of expected docs. Each item can be: uploaded, marked "Not This Year" (red button), or "In Bulk Upload" (green checkmark, bulk PDF covers it). Sentinel-provided items shown as 🏢.
4. **Review & Submit** — summary of uploaded/NTY/Sentinel counts, then submits

### On Submit
- Workpaper PDF generated (all docs stitched together)
- Uploaded to S3 (`AWS_S3_BUCKET`)
- Organizer status → `closed`
- Pipeline trigger fired: `organizer_submitted`
- **No staff email** — staff use pipeline tasks/cards instead

### Database Tables
- `tax_organizers` — one row per person+year. status: `open`/`submitted`/`closed`
- `tax_organizer_items` — checklist items. status: `pending`/`uploaded`/`not_this_year`/`not_applicable`
- Documents uploaded via organizer: `folder_category='organizer'` → reclassified to `'tax'` on submit

### Files
- Client portal: `public/organizer.html`
- Staff side: `server/routes/organizer.js`
- Drake PDF parser: `server/services/organizerParser.js`

### Staff Workflow — How to Set Up Organizers Each Year

1. **Go to CRM → Person record → Organizers tab**
2. Click **"⬆ Upload Drake Organizer"** — upload the Drake PDF for that client/year
3. DarkLion parses the PDF (`organizerParser.js`) and creates checklist items automatically
4. Once created, the client sees it in their portal immediately — there is NO separate "send" button
5. To add custom questions: edit the organizer record (custom_questions JSON on tax_organizers table)
6. To set the active tax year for all clients: **Settings → Tax Year** — updates instantly, no deploy

**To reopen after submitted:** CRM → Person → Organizers tab → "🔄 Request More Docs" button

**Year note:** The upload button is currently hardcoded to `'2025'`. Update this each January for the new tax year.

### Known Issues / Decisions
- `documents` table has NO `updated_at` column — never add it to UPDATE queries on that table
- Use `AWS_S3_BUCKET` (not `S3_BUCKET`) for all S3 operations
- Progress counter uses `let TOTAL_ITEMS` (not const) so live API count can override hardcoded 17

---

## What's Next / Backlog

| Item | Notes |
|---|---|
| Phase 6b — Pipeline Bulk Add | "📥 Bulk Add" button on board header. Needs more CRM data for meaningful filtering first. |
| Gmail connector | Design complete in BUILD_LOG.md. Uses Google Workspace service account + domain-wide delegation. |
| Phase 7 refinement | Tax return delivery e-signatures need testing and polish |
| Organizer: hide tab when no organizers | `organizer_visible` flag exists; portal Organizers tab should be hidden until client has one assigned |
| Security checklist | See BUILD_LOG.md — several items flagged before real client data |
| SOC 2 audit | Design is ready; formal engagement when client volume warrants |
| Test suite updates | Portal statements spec (13 tests added 2026-04-01). Investments + Blueleaf tests not yet written. |
