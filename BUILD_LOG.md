# DarkLion — Build Log & Roadmap
> Last updated: 2026-03-28
> ⚠️ **New sessions: read `DARKLION.md` first** — it's the master context doc.
> This file has the full phase-by-phase history and is a good supplement, but DARKLION.md is the primary source.

---

## Who Is Building This

- **Chris Ragain** — Founder, CPA/PFS, Sentinel Wealth & Tax (Bonita Springs/Naples, FL)
- **Argus** — AI assistant (OpenClaw) — planning + coding
- **Nick** — Staff, primary tax workflow user
- **Viktor** — Sentinel's business AI agent, will integrate with this platform via API

---

## What We're Building

A full practice management platform to **replace TaxDome**, built on the existing DarkLion codebase. The platform is API-first — everything a human staff member can do, Viktor (the AI agent) can do via the same endpoints.

**The core insight:** TaxDome (and every competitor) bolts AI on top. We're building AI-native from the ground up.

---

## The Data Model (Foundation)

Three-level hierarchy:

```
Relationship  →  the household/group (top-level billing unit)
├── Companies →  legal entities (S-corp, LLC, 1040, Trust, etc.)
└── People    →  individuals with portal logins
    └── person_company_access (who sees which companies)
```

**Key rules:**
- Every Company belongs to one Relationship
- Every Person belongs to one Relationship
- A Person can own/access multiple Companies
- A Company can be accessed by multiple People
- Billing is at the Relationship level (Stripe)
- Portals are per-Person (spouses each have their own login, shared view)
- A Person can only move between Relationships manually (staff action or Viktor)

---

## Design Principles

1. **API-first** — UI and Viktor both call the same endpoints. No special backdoors.
2. **SOC 2 from day one** — field-level encryption, signed URLs, full audit trail, no PII in logs
3. **Nothing deleted, only added** — existing DarkLion bookkeeping features migrate into the Companies/Bookkeeping section
4. **Additive migrations** — every DB change is idempotent and non-breaking

---

## Tech Stack

- **Backend:** Node.js + Express (Railway)
- **Database:** PostgreSQL (Railway)
- **File storage:** AWS S3 (signed URLs, never direct access)
- **Auth:** JWT (staff: 24h, portal clients: 7d)
- **Encryption:** AES-256-GCM, app-level, key in `ENCRYPTION_KEY` env var
- **Email:** Resend (transactional only — notifications, no content in email body)
- **Payments:** Stripe (planned, Phase 10)
- **Existing integrations:** QuickBooks Online, Gusto

---

## Build Phases

### ✅ Phase 1 — Foundation (COMPLETE — 2026-03-20)
**What was built:**
- `server/utils/encryption.js` — AES-256-GCM field encryption (SSN, DOB, EIN)
- New DB tables: `relationships`, `people`, `person_company_access`
- New columns on `companies`: `relationship_id`, `entity_type`, `ein_encrypted`, `tax_year_end`, `stanford_tax_url`, `status`
- New columns on `firm_users`: `display_name`, expanded role to include `staff` and `agent`
- Backfill migration: every existing QBO company wrapped in a Relationship automatically
- `server/routes/relationships.js` — full CRUD + sub-routes
- `server/routes/people.js` — full CRUD + company access grant/revoke + encryption
- `GET /api/search?q=` — unified search across relationships, companies, people
- `ENCRYPTION_KEY` env var set in Railway

---

### ✅ Phase 2 — Auth + Portal Logins (COMPLETE — 2026-03-20)
**What was built:**
- `server/middleware/requirePortal.js` — client JWT validation (type:'portal', rejects staff tokens)
- `server/routes/portal-auth.js` — portal login, invite accept, forgot/reset password, firm-info
- `server/routes/portal.js` — protected client API: `/portal/me`, `/portal/companies`, `/portal/documents`
- `public/portal-login.html` — dark-themed client login page
- `public/portal.html` — client portal placeholder (welcome + company list + logout)
- `firms.slug` column — auto-generated from firm name on startup
- Portal tokens: 7-day expiry. Clients invited via token link, set password on first login.
- Forgot password: stores reset token, email sending wired up in Phase 5

**Notes:**
- Staff tokens and portal tokens are completely separate and can't be mixed
- Portal email notifications (Resend) not yet wired — storing reset tokens but not sending yet

---

### ✅ Phase 3 — Internal CRM UI (COMPLETE — 2026-03-20)
**What was built:**
- `public/crm.html` — staff CRM page at `/crm` (1,500+ lines, fully self-contained)
- Three-tab layout: Relationships, People, Companies
- Relationship detail panel (slide-in right): people list, companies list, notes with auto-save
- Person detail panel — the **360° view**: contact info, DOB masked, SSN indicator, spouse link, StanfordTax URL button, inline notes, portal invite button, company access with grant/revoke
- Modal forms: New/Edit Relationship, New/Edit Person (all fields, searchable dropdowns)
- Unified header search across all three entity types (grouped results, click to open detail)
- Toast notifications, loading states, empty states, error messages
- Mobile-responsive sidebar
- CRM link (🗂️) added to main dashboard sidebar
- `/crm` route added to `server/index.js`

**Phase 3b additions (full-page detail views):**
- `public/crm-person.html` — `/crm/person/:id`, tabs: Overview · Docs · Tax · Communication · Organizers · Workflow · Notes · Billing
- `public/crm-company.html` — `/crm/company/:id`, tabs: Overview · Docs · Tax · Bookkeeping · Communication · Organizers · Workflow · Notes. Bookkeeping tab has secondary sub-tabs: Close Package · Uncategorized · P&L Variance · Liability Health · Payroll Check · Statements · Statement Calendar
- `public/crm-relationship.html` — `/crm/relationship/:id`, tabs: Overview · Notes · Billing
- Dashboard sidebar stripped of bookkeeping items — those live inside Company → Bookkeeping tab
- `GET /api/companies/:id` and `PUT /api/companies/:id` added
- `notes` column added to companies table
- `folder_section` and `folder_category` columns added to documents table

---

### ✅ Phase 4 — Document Management (COMPLETE — 2026-03-20)
**What was built:**
- `server/services/s3.js` — uploadFile, getSignedDownloadUrl (15-min expiry), deleteFile, key builder
- `server/routes/documents.js` — list, upload (50MB, memory storage), download (signed URL), update metadata, deliver to client, delete from S3+DB. s3_key never returned.
- `server/db.js` — documents table added (idempotent)
- `server/routes/portal.js` — `GET /portal/documents/:id/download` — verifies access, generates signed URL, marks viewed_at on first view
- `public/crm.html` — real documents tab in Person Detail Panel (Personal + By Company sub-tabs), drag-and-drop upload modal, deliver toggle, delete. Also docs tab in Relationship Detail Panel.
- `public/portal.html` — client document view grouped by year/owner, download button, viewed indicator

---

### ✅ Phase 5 — Client Portal (COMPLETE — 2026-03-20)
**What was built:**
- `server/services/email.js` — Resend email service, branded HTML templates for invite, reset, notification. Graceful degradation if key missing.
- `POST /portal-auth/send-invite` — staff sends invite → client gets email with set-password link
- `POST /portal-auth/forgot-password` — now actually sends reset email via Resend
- `GET /portal/stanford-tax` — personal + company organizer URLs
- `GET /portal/messages` + `POST /portal/messages/send` — stub, ready for Phase 8
- `POST /portal/upload` — client can upload their own documents (folder_section='client_uploaded')
- `public/portal.html` — full rebuild: Overview · Documents · Organizers · Messages tabs, company cards, year-folder doc view with NEW badge, drag-drop upload, mobile-first
- `public/portal-login.html` — now handles invite (`?invite=TOKEN`) and reset (`?reset=TOKEN`) flows
- One env var needed: `APP_URL=https://darklion.ai` (for invite/reset email links)

---

### ✅ Phase 6 — Pipelines (COMPLETE — 2026-03-21)
**What was built:**
- TaxDome-style UX: pipeline list → click to open board (no "instances" or "boards" tabs)
- Year selector in board header — silently creates a new instance per year on demand
- Kanban board with drag-drop between stages, horizontal scrollbar pinned at bottom
- Job cards tied to real CRM records (companies, people, or relationships)
- Job activity log — updates with author name + timestamp, 3 most recent shown on card
- Job detail panel — stage, status, priority, assignee, due date, movement history
- Pipeline clone, archive/restore, delete from dot menu
- Stage editor — add/rename/delete stages inline
- `pipeline_job_updates` table for the activity log
- `ensure-instance` endpoint — creates year instance on demand
- All inside EJS shell (standard left nav + header)

---

### ✅ Phase 7 — Tax Return Delivery + E-Signatures (COMPLETE — 2026-03-21)
**Status:** Built but not working correctly. Will revisit after Phase 6 (Pipelines).
**Plan:**
- Deliver a document through the portal with status tracking (delivered → viewed → signed)
- E-signature flow for 8879s and engagement letters
- Dual-signer support (joint returns — both spouses sign from their own portal)
- Audit trail: IP, timestamp, user agent per signature
- Port logic from existing proposals app

---

### ✅ Phase 8 — Secure Messaging (COMPLETE — 2026-03-20)
**What was built:**
- DB tables: `message_threads`, `thread_companies` (multi-company tagging), `messages`
- `server/routes/messages.js` — full staff API: inbox, thread detail, create, reply, status/assign, company tagging, mark read
- `server/services/claude.js` — `classifyMessage()` added — Haiku classifies message content against person's companies, non-fatal
- `server/routes/portal.js` — real portal messaging: thread list, thread detail (marks read), send message (triggers classification, flips to 'open')
- `public/messages.html` — firm inbox: split-panel, filter tabs (Active/Open/Waiting/Resolved/All), search, internal note toggle, company tag management
- `public/portal.html` — real chat UI: bubbles (client right / staff left), unread badge, Enter to send
- `public/crm-person.html` — Communication tab: live thread list + detail + reply with internal note toggle
- `public/crm-company.html` — Communication tab: company-scoped threads + person picker for new threads
- 💬 Messages link added to Work section on all sidebars

---

### ⏊ Phase 9 — Proposals + Engagement Letters *(SKIPPED — not building)*
**Plan:**
- Port existing proposals app into DarkLion
- Full flow: proposal → e-sign → auto-create client record + pipeline job
- Engagement letters with e-signature

---

### ⏊ Phase 10 — Billing *(SKIPPED — not building)*
**Plan:**
- Stripe subscriptions at Relationship level
- Monthly packages (tiered), one-time fees, payment tracking
- `stripe_customer_id`, `stripe_subscription_id` already on `relationships` table

---

### ✅ Phase 11 — Viktor Full Integration (COMPLETE — 2026-03-23)
**Plan:**
- Viktor (the business AI agent) gets an `agent` role in `firm_users`
- All existing API endpoints accessible with agent JWT
- Every action logged with `role='agent'` in audit trail
- Viktor can: create/update relationships/people/companies, move pipeline jobs, send portal messages, deliver documents, request signatures
- This isn't a phase so much as a continuous thread — Viktor can use any endpoint from Phase 1 onward

---

### ✅ Phase 12 — Gmail Connector (COMPLETE — 2026-03-23)
**Plan:**
- Use Google Workspace service account with domain-wide delegation (NOT per-user OAuth)
- One-time admin setup: Google Cloud project → Gmail API → service account JSON key → Workspace Admin domain-wide delegation with `gmail.readonly` scope
- DarkLion service account impersonates each staff mailbox to pull emails automatically — no action required from staff
- Match sender/recipient to known Person records by email address
- Create message threads on matched Person records (same thread model as portal messaging)
- Viktor monitors incoming threads, alerts if a client email to one staff member should be seen by others
- De-duplicate: same email ID never creates two threads
- Stored in existing `message_threads` + `messages` tables (sender_type = 'client', source = 'gmail')
- Staff can override Viktor's company classification

**Setup needed (one-time, ~20 min):**
1. Google Cloud Console → new project "DarkLion" → enable Gmail API
2. IAM → Service Accounts → create "darklion-gmail" → download JSON key
3. Google Workspace Admin → Security → API Controls → Domain-wide Delegation → add service account Client ID with scope `https://www.googleapis.com/auth/gmail.readonly`
4. Add JSON key + staff email list to Railway env vars

**Why this approach:**
- Fully automatic — staff don't need to BCC or remember anything
- Works for entire Workspace domain in one setup
- No per-user OAuth, no Google verification needed for internal use

---

## Features NOT Being Built (skipped from TaxDome)
- Time tracking (flat-fee billing model, not hourly)
- Complex team permissions / multi-office management
- Built-in scheduling (using Cal.com)
- Built-in email marketing (using Resend weekly cron)

---

## Key Files

| File | Purpose |
|---|---|
| `SCHEMA_PLAN.md` | Full data model — every table, every field, all decisions |
| `BUILD_LOG.md` | This file — build history + roadmap |
| `server/db.js` | All DB tables and migrations |
| `server/utils/encryption.js` | AES-256-GCM field encryption |
| `server/routes/relationships.js` | Relationships CRUD API |
| `server/routes/people.js` | People CRUD + company access API |
| `server/routes/portal-auth.js` | Portal client auth (login, invite, reset) |
| `server/routes/portal.js` | Protected portal API |
| `server/middleware/requireFirm.js` | Staff JWT middleware |
| `server/middleware/requirePortal.js` | Portal client JWT middleware |
| `public/dashboard.html` | Main staff dashboard (existing bookkeeping features) |
| `public/crm.html` | CRM UI — relationships, people, 360° view (Phase 3) |
| `public/portal-login.html` | Client portal login page |
| `public/portal.html` | Client portal (placeholder, full version in Phase 5) |

---

## Environment Variables Required

| Variable | Purpose | Status |
|---|---|---|
| `JWT_SECRET` | Signs staff + portal JWTs | ✅ Set |
| `ENCRYPTION_KEY` | 64-char hex, AES-256-GCM for PII fields | ✅ Set |
| `DATABASE_URL` | PostgreSQL connection string | ✅ Set |
| `QB_CLIENT_ID` / `QB_CLIENT_SECRET` | QuickBooks OAuth | ✅ Set |
| `RESEND_API_KEY` | Email notifications (needed for Phase 5) | ⏳ Needed |
| `STRIPE_SECRET_KEY` | Payments (needed for Phase 10) | ⏳ Needed |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 file storage (needed for Phase 4) | ⏳ Needed |
| `AWS_S3_BUCKET` | S3 bucket name (needed for Phase 4) | ⏳ Needed |

---

## Current Status
All core phases complete and deployed. Remaining:
- Phase 11 — Viktor Full Integration
- Phase 12 — Gmail Connector
- Phase 13 — Native AI Layer
- Phase 14 — Engagement Tab
- Phase 6b — Pipeline Bulk Add (needs more CRM data first)

---

*This document should be kept up to date as each phase completes.*

---

### ⏳ Phase 6b — Pipeline Bulk Add
**Plan:**
- "📥 Bulk Add" button on the board header
- Opens a modal with a filterable, searchable checklist of all clients of the right type
- Filter by CRM fields (tags, entity type, status, etc.) — requires CRM to have more data first
- "Select All" + individual checkboxes
- Choose starting stage
- Skips clients already in the pipeline for that year
- One API call adds all selected clients as jobs
- **Prerequisite:** CRM needs more client attributes for meaningful filtering (Phase 6c or later)

---

### ✅ Phase 14 — Engagement Tab (COMPLETE — 2026-03-23)
**Plan:**
- New "Engagement" tab on the Relationship detail page (crm-relationship.html)
- Simple upload/view for signed engagement letters — staff uploads PDFs as they come in
- Phase 14b: AI (Claude) scans uploaded engagement letters and extracts key details:
  - Services agreed to, fee amount, effective date, signer names
  - Auto-populates fields on the Relationship record in the CRM
- Storage: S3 (same as documents), tagged with folder_section = 'engagement'
- Audit trail: who uploaded, when, what was extracted

---

### ✅ Phase 13 — Native AI Layer (COMPLETE — 2026-03-23)

**Goal:** Make DarkLion smarter so Viktor spends time on judgment calls, not mechanical work.

#### Smart Triage & Pre-processing
- Auto-classify inbound messages/emails by type (tax question, document request, billing, urgent notice, general) — upgrade from basic Haiku classification to full context-aware routing
- Auto-tag messages to the correct company based on content + sender history
- Detect urgent signals: IRS notices, deadlines, "ASAP" language → escalate immediately
- De-duplicate: detect when a client emailed twice about the same issue

#### Proactive Alert Engine
DarkLion monitors the DB and fires alerts to Viktor (or staff inbox) when:
- Tax return unsigned after X days → prompt follow-up
- Pipeline job stuck in same stage for 2+ weeks
- RMD season (Jan): flag clients 73+ with no RMD pipeline job
- IRMAA lookback: flag clients with high income 2 years prior → review for Medicare surcharge
- Client portal document unviewed 30+ days after delivery
- Client hasn't logged into portal in 60+ days
- New client created but no onboarding pipeline started

#### Data Enrichment for Viktor
- **Client brief generator**: on demand or before scheduled meetings — summarizes open pipelines, recent messages, unreviewed documents, upcoming deadlines for a given client
- **Status summary**: when Viktor asks "what's open for the Ragain Family?" → DarkLion compiles full picture across all entities
- **Document auto-classification**: when client uploads a document, Claude infers the type (W-2, 1099, bank statement, etc.) and suggests the correct folder

#### Workflow Automation (no Viktor needed)
- Tax return fully signed by all signers → auto-advance pipeline to "Delivered" stage
- New client (Person or Company) created → auto-generate standard onboarding pipeline from template
- Client uploads a document → auto-classify into correct year/category folder
- Message thread idle for 7 days with no staff reply → flag to staff inbox

#### Implementation Notes
- Alert engine runs as a cron job (2 AM UTC, same as nightly scans)
- Alerts stored in a new `ai_alerts` table: `{ firm_id, type, entity_type, entity_id, message, severity, resolved_at }`
- Staff dashboard shows active alerts; Viktor can resolve or act on them
- All automation is auditable — logged in the existing audit trail


---

## Security Checklist (added 2026-03-23)

Reviewed and confirmed done:
- ✅ JWT secret — strong, in Railway env vars
- ✅ All secrets in env vars, not in code
- ✅ S3 private with signed URLs only
- ✅ Rate limiting on all routes (staff login: 5/15min, portal login: 5/15min, register: 3/hr, API: 300/min)
- ✅ HTTPS enforced via Cloudflare on darklion.ai + subdomains
- ✅ Row-level tenant isolation (firm_id on all queries)
- ✅ S3 versioning enabled on darklion-documents
- ✅ S3 cross-region replication to darklion-documents-backup (us-west-2)
- ✅ Pretty 404 page — detail pages redirect to /404 on not-found/forbidden

### TODO — Do before real client data:
- [ ] Run `npm audit` and patch any high/critical vulnerabilities
- [ ] Verify Neon DB backup retention period and test a restore
- [ ] Audit Railway env vars — confirm JWT_SECRET is strong (rotate if needed)
- [ ] End-to-end tenant isolation test: create second test firm, try to access its data from main account — confirm 404
- [ ] Portal isolation test: invite test person, log in as them, verify they can only see their own data
- [ ] File upload server-side validation: reject executables (.exe, .sh, .bat etc.)
- [ ] Review `OR firm_id IS NULL` on QBO company queries — clean up or scope properly

---

## Session History (2026-03-21 onwards)

### 2026-03-21 — Pipelines Phase 6

**What was built:**
- Full pipeline/kanban system: pipeline list → kanban board (no "boards" or "instances" tabs)
- Year selector in board header — auto-creates instances per year on demand
- Drag-drop between stages, horizontal scroll pinned at bottom
- Job cards tied to real CRM records (companies, people, or relationships)
- Job activity log — 3 most recent shown on card
- Job detail panel — stage, status, priority, assignee, due date, history
- Pipeline clone, archive/restore, delete
- Stage editor inline (add/rename/delete)
- `pipeline_job_updates` table for activity log
- All inside EJS shell (standard nav)

---

### 2026-03-23 — Viktor, Gmail Connector, Engagement Tab, AI Layer (Phases 11–14)

**Phase 11 (Viktor Integration):** Viktor has `agent` role in `firm_users`. All API endpoints accessible with agent JWT. Every action logged with `role='agent'`.

**Phase 12 (Gmail Connector):** Design finalized. Uses Google Workspace service account with domain-wide delegation (no per-user OAuth). Matches sender/recipient to Person records, creates message threads. One-time admin setup steps documented in build log above.

**Phase 13 (Native AI Layer):** Alert engine, smart triage, client brief generator, workflow automation. See detailed section above.

**Phase 14 (Engagement Tab):** New Engagement tab on Relationship detail page. Upload/view signed engagement letters (S3, folder_section='engagement'). Phase 14b: AI extraction of key terms.

---

### 2026-03-24 — EJS Shell Migration + Messaging + Print Agent + Firm Branding + Dev Environment

**EJS Migration:**
- All CRM pages converted from static `public/*.html` to `server/views/*.ejs` using shell partials
- Pages: crm.ejs, crm-person.ejs, crm-company.ejs, crm-relationship.ejs, team.ejs
- Single 🗂️ CRM nav link (was 3 separate links for Relationships/People/Companies)
- **Critical lesson:** EJS files are source of truth — NEVER use stale public HTML files. Subagent wipeout occurred; recovery via git history. Tag before big refactors.
- `backup/post-ejs-conversion-20260324` tag created

**Docs Tab Fixes:**
- Download opens new tab (window.open)
- Delete: double-tap confirm → in-memory filter + re-render (no full reload)
- Move: inline panel per doc row

**Thread Sharing:**
- `thread_participants` table added
- @mention in reply → auto-shares thread to mentioned staff inbox
- Participants see "Shared by [Name]" badge; reply as internal-only
- Archive for participants = remove from their inbox only

**Messaging UI Cleanup:**
- Internal note checkbox hidden (auto-managed server-side)
- `📱 Send as Text` button added
- My Inbox auto-opens top thread on load
- AI 30-Day Conversation Summary: Claude Haiku, last 30 days, shown in right panel on person comm tab and My Inbox

**DarkLion Print Agent (Windows Desktop App):**
- Architecture: TCP/IP port 9100 (Windows native, no external DLLs)
- Electron app runs TCP server → receives PostScript → Ghostscript converts → PDF
- Routing popup: search client, pick year/folder, click Upload → PDF lands in DarkLion docs tab
- Batch window: multiple Drake jobs → one popup
- NSIS installer auto-installs Ghostscript
- Build process: `cd darklion-print-agent/app && npm install && npm run build:win`
- Output: `dist/DarkLionPrintAgent_Setup_1.0.0.exe`
- **CONFIRMED WORKING by Chris end-to-end**

**Firm Branding Settings:**
- New Settings tab: logo upload, display name, tagline, contact info, address, brand color
- API: GET/PUT /firms/branding + POST /firms/branding/logo
- DB columns: display_name, logo_url, primary_color, tagline, contact_email, phone, website, address

**Dev Environment Setup:**
- Railway `development` environment → `darklion-ai-development.up.railway.app`
- `dev` branch auto-deploys to dev Railway; `main` → production (darklion.ai)
- Neon `dev` branch from production (separate DB for testing)
- Test user: `test@darklion.ai` / `DarkLionTest2026!` (role: staff, id: 1402) on dev DB
- GitHub secrets: TEST_EMAIL, TEST_PASSWORD

**Playwright E2E Test Suite:**
- 190 tests across 13 spec files in `tests/e2e/`
- Global setup saves storageState to `tests/.auth/user.json`
- GitHub Actions `.github/workflows/e2e-tests.yml` — triggers on push to dev
- Currently at 173 passing / 0 failing (stable)
- **Dev → Prod policy:** tests must pass on dev before merging to main

**Viktor Dashboard:**
- Background briefing generation (not blocking page load)
- 4am UTC cron: pre-generates briefings for all active staff
- Uses Claude Haiku for batch generation
- Sessions purged nightly (Chris's preference: clean slate each morning)

**Staff Message Delete:**
- Hover own message bubble → ✕ → double-tap confirm → hard delete

---

### 2026-03-25 — DarkLion Drive (Windows) + Bulk Send + Pipeline Automation + Pipeline Settings

**DarkLion Drive (Windows Desktop App) — COMPLETE:**
- Electron + rclone + WinFsp mounts DarkLion as a folder (`C:\Users\...\DarkLion Drive`)
- Desktop shortcut auto-created (handles OneDrive sync to real Desktop path)
- Sleep/wake reconnect via powerMonitor; auto-start on boot
- Year/category scaffold (2018–current) always shown; empty folders included
- NSIS installer: `dist\DarkLionDrive_Setup_1.0.1.exe` (v1.0.1 on GitHub Releases)
- Company deliveries create company cards (entity type propagated through trigger chain)
- `folder_section=firm_uploaded` on upload — docs appear in web app correctly
- **CONFIRMED WORKING by Chris**

**Bulk Send — COMPLETE:**
- Audience builder: filters with IS/IS NOT operators, multi-select values
- Filters: relationship, service tier, billing, filing status, entity type, portal activity, pipeline stage/completion, has documents, company status
- Merge tags: {First Name}, {Last Name}, {Full Name}, {Relationship Name}, {Firm Name}, {Company Names}
- {Company Names} resolves per recipient based on pipeline filter
- Recipient preview shows company context

**Pipeline Smart Triggers — COMPLETE:**
- `pipeline_triggers` table (9 trigger types: tax, engagement, proposals, portal)
- `pipeline_stage_triggers` table (maps trigger → stage, max 2 per stage)
- `pipeline_trigger_log` for history
- Auto-move cards on trigger; auto-CREATE card if none exists
- fireTrigger supports entityType (person/company)
- ⚡ Fire Trigger button on person CRM page
- Triggers normalized to underscore convention (removed hyphenated duplicates)
- Final 12 trigger types in DB

**Pipeline Stage Actions — COMPLETE:**
- `pipeline_stage_actions` table
- Two types: `portal_message` (client thread + email) and `staff_task` (staff inbox)
- `executeStageActions` service — non-blocking, fires after card move
- Merge tags in actions: {First Name}, {Entity Name}, {Tax Year}, {Pipeline Name}, {Stage Name}
- Staff task messages: `message_type='task'`, amber-tinted in inbox, 📋 badge
- Wired into both drag-and-drop and pipelineTriggers.js

**Pipeline Settings Page — COMPLETE:**
- `/pipelines/:instanceId/settings` (replaces Edit Stages modal)
- Per-stage cards (2-column grid): Stage | ⚡ Triggers | 🎯 Actions
- Drag-and-drop stage reordering
- Default Year + Copy to Year compact section
- Explainer box at top

**Pipeline Completion History — COMPLETE:**
- `pipeline_completions` table + `is_terminal` on pipeline_stages
- Auto-archive at 10 PM nightly (scheduler.js)
- Kanban cards: "🏁 Archiving tonight at 10 PM" when in terminal stage
- Pipeline History panel on person/company/relationship CRM Overview tabs

**Immortal Card / Migration:**
- `hold_for_migration BOOLEAN` on pipeline_stages
- Scheduler skips immortal stages
- Copy to Year API: `POST /instances/:id/copy-to-year`
- "Move to Next Year →" button on card detail panel when in held stage

**Bug Fixes:**
- `#tab-communication` div never closed → organizers/workflow/notes tabs nested inside comm tab (display:none) — fixed
- Inline style.display lingered on deactivated tabs — fixed with style clear
- Notes tab race condition — textarea seeded in renderOverview()
- `const el` variable shadowing in switchTab — renamed

---

### 2026-03-26 — Tax Organizer (Dev)

**Tax Organizer — Built on dev branch:**
- 4-step portal flow: Confirm Info → Questions → Checklist → Submit
- Pre-populated from DarkLion person record (name, spouse, address, dependents)
- 8 yes/no questions with conditional follow-ups
- Checklist: 2-column, single-line items, Upload + "Not This Year" buttons
- Submit locked until all items resolved
- "Sentinel Provides" badge for Altruist accounts and firm K-1 entities

**Backend:**
- `tax_organizers` + `tax_organizer_items` tables
- `server/services/organizerParser.js` — pdf-parse (CJS, no Python subprocess)
- `server/routes/organizer.js` — full CRUD
- Auto-trigger: when doc uploaded to `folder_category=organizer`, parser fires
- Organizer folder write-locked for staff (staff use dedicated upload endpoint)
- Workpaper PDF: pdf-lib cover + Q&A + NTY list + stitched uploads

**Key parser facts:**
- Drake organizer checklist pages: payer names pre-populated from prior year
- `S_OTHER.LD` page contains 1098 mortgage lender name
- `S_TPINFO.LD2`: dependents, childcare provider names
- Sentinel Provides detection: matches `altruist` pattern OR K-1 entity in firm's relationship companies

**Test data:**
- Julia E. Carp (person_id=25) — 8 items parsed, organizer_id=1
- Alpiinrok Physiatry Inc K-1: must be in DarkLion as company to auto-flag Sentinel Provides

---

### 2026-03-27 — Tax Organizer Complete + QBO Connect + Pipeline Fixes + Prod Push

**Tax Organizer — All Items Complete (dev → prod):**
- DELETE any item (not just advisor_added)
- Real S3 upload via portal API, named after checklist item (PayerName — Section.ext)
- Submit auto-closes (status=closed), fires pipeline trigger, sends Resend email
- `organizer_submitted` trigger added to `pipeline_triggers`
- GET /:personId/all route ordering fixed (before /:personId/:year)
- Step 2 answers stored in JS `_answers{}` object (not DOM selectors) — was silently failing
- Custom questions: appended to Step 2, shown in advisor questionnaire with Yes/No pills
- Advisor CRM tab: multi-year list, Reopen (Request More Docs), trash confirm, questionnaire mirror
- Portal: 3-column grid, submitted state, prior years accordion
- Settings: Tax Season tab active_tax_year dropdown

**QBO Connect Flow — Fixed + Deployed to Prod:**
- OAuth state format: `firmId:companyId:nonce:returnOrigin`
- Callback: parses companyId → `UPDATE companies SET realm_id=... WHERE id=companyId`
- FK violation fix: delete child rows in scan_results, close_packages, category_rules, jobs, statement_schedules, employee_metadata before updating realm_id
- Redirects back to correct domain (subdomain or darklion.ai) after connect
- Detects XHR vs browser redirect; returns JSON for fetch calls
- `runInitialScans()` was dead code after return statement — fixed
- Company bookkeeping tab: shows full connect card (not empty subtabs) when no realm_id
- QBO Connected badge: checks `realm_id && realm_id.trim()` (not just truthy)

**Liability Scanner Fix:**
- QBO returns liability balances as NEGATIVE (credit-normal)
- Was flagging normal credit balances as problems
- Fix: flip sign — `displayBalance = -rawBalance`; flag only when displayBalance < 0

**Pipeline Fixes:**
- entity-jobs query: was returning all statuses → fixed to `AND pj.job_status = 'active'`
- Duplicate jobs bug: fireTrigger checked `'complete'` but DB uses `'completed'` → fixed
- Unique index: `pipeline_jobs_one_active_per_entity` (instance_id, entity_type, entity_id) WHERE active

**Pipeline — Workflow Tab (crm-person.ejs):**
- "➕ Create Card" modal replaces "Fire Trigger" button
  - Loads person-type pipeline instances, stage dropdown populates dynamically
  - Returns 409 if active card already exists
- Prev/next stage arrows on each active card (← / →)
  - Uses `window._shellToast` (not `toast()` — not available in company/person page scope)
  - Card no longer click-to-open (was swallowing button clicks)

**Prod DB Migrations Applied:**
- tax_organizers, tax_organizer_items, active_tax_year on firms, organizer_submitted trigger, pipeline_jobs_one_active_per_entity unique index
- Inizio Inc (company_id=21): connected with realm_id=410361081

**Key Technical Rules:**
- `req.firm.userId` not `req.user.id` — DarkLion JWT puts user ID on `req.firm`
- `window._shellToast` not `toast()` in CRM detail pages
- Express route ordering: specific routes before wildcard `/:id`
- Pipeline job status values: `'active'`, `'completed'`, `'archived'` (NOT `'complete'`)
- `companies.realm_id` default is `''` not NULL — check `realm_id && realm_id.trim()`

---

### 2026-03-28 — CRM Address Fields + QBO Token Keep-Alive + Bug Fix

**Address Fields (people + companies) — Added to CRM:**
- `address_line1`, `address_line2`, `city`, `state`, `zip` on both `people` and `companies` tables
- CRM list shows city/state under name; detail panels show full address block
- Person + Company edit modals have address section
- **Bug:** DB migration was missing from `db.js` — columns added to API but never migrated on prod
  - Caused `GET /api/companies/:id` to 500 → Company CRM showed "Error loading"
  - Fix: added `ALTER TABLE` migrations to `db.js`, pushed to prod

**QBO Token Keep-Alive:**
- `refreshTokens()` now clears tokens on failure (triggers Reconnect card in UI)
- `refreshAllTokens()` — refreshes all connected companies
- Nightly cron in `index.js` runs `refreshAllTokens()` before scans — connections stay alive indefinitely
- Reconnect card on bookkeeping tab and overview panel when realm exists but tokens expired
- "QBO Disconnected" badge in red when disconnected
- Reconnect flow: click Reconnect → Intuit auth → back to company page with `?connected=1`

**E2E Tests:**
- 173 passing, 0 failing (stable)

---

## Architecture Notes (Current State — 2026-03-28)

### File Structure
- `server/views/*.ejs` — ALL CRM/staff pages (EJS shell, source of truth — never use public HTML)
- `server/routes/` — API routes (api.js, relationships.js, people.js, organizer.js, auth.js, etc.)
- `server/db.js` — ALL DB migrations (idempotent DO $$ blocks)
- `server/index.js` — Express app + cron jobs + nightly scans
- `darklion-print-agent/` — Windows print agent (Electron, builds separately)
- `darklion-drive/` — Windows drive app (Electron + rclone + WinFsp)
- `tests/e2e/` — Playwright test suite (173 tests)

### CRM Pages (EJS, all use shell partials)
- `/crm` → `crm.ejs` (3-tab: Relationships, People, Companies)
- `/crm/person/:id` → `crm-person.ejs`
- `/crm/company/:id` → `crm-company.ejs`
- `/crm/relationship/:id` → `crm-relationship.ejs`
- `/team` → `team.ejs`

### Data Model (Current)
```
Firm
└── Relationships (household/group — top-level billing unit)
    ├── Companies (legal entities — S-Corp, LLC, Trust, etc.)
    │   └── person_company_access (who sees which companies)
    └── People (individuals with portal logins)
```

### Key DB Tables Added Since Phase 1
- `people`, `person_company_access`, `relationships`
- `pipeline_templates`, `pipeline_instances`, `pipeline_stages`, `pipeline_jobs`, `pipeline_job_updates`
- `pipeline_triggers`, `pipeline_stage_triggers`, `pipeline_trigger_log`
- `pipeline_stage_actions`, `pipeline_completions`
- `message_threads`, `messages`, `thread_participants`, `thread_companies`
- `tax_organizers`, `tax_organizer_items`
- `statement_schedules`, `statement_monthly_status`
- `ai_alerts` (planned)
- Columns added to `companies`: relationship_id, entity_type, ein_encrypted, tax_year_end, stanford_tax_url, status, notes, bookkeeper_id, bookkeeping_service, billing_method, address_line1/2, city, state, zip, realm_id, access_token, refresh_token, token_expires_at, connected_at, last_sync_at
- Columns added to `people`: portal_enabled, portal_invite_token, portal_password_hash, portal_reset_token, portal_reset_expires, filing_status, spouse_name, spouse_email, spouse_id, dob_encrypted, ssn_encrypted, billing_method, address_line1/2, city, state, zip
- Columns added to `firms`: slug, active_tax_year, display_name, logo_url, primary_color, tagline, contact_email, phone, website, address

### Cron Jobs (index.js)
- **10 PM nightly:** Archive terminal-stage pipeline cards, record completions
- **2 AM UTC:** Nightly QBO scans (uncategorized, P&L variance, liability health, payroll)
- **2 AM UTC (before scans):** `refreshAllTokens()` — refresh all QBO tokens to keep connections alive
- **4 AM UTC:** Pre-generate Viktor dashboard briefings for all active staff (Claude Haiku)

### Deployment Rules (NON-NEGOTIABLE)
- Push to `dev` branch only
- Chris tests on dev (`darklion-ai-development.up.railway.app`)
- NEVER merge to `main` without explicit approval from Chris
- Tests must pass (173/0) before prod push
- After prod push: always `git checkout dev` to resume work
