# DarkLion — Build Log & Roadmap
> Last updated: 2026-03-20
> Context document — if session resets, read this + SCHEMA_PLAN.md to get back up to speed.

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

### ⏳ Phase 5 — Client Portal (full)
**Plan:**
- Full portal UI replacing the placeholder from Phase 2
- Client sees: their documents (delivered only), their companies, StanfordTax organizer link
- Secure chat widget (portal side)
- Email notifications via Resend when:
  - Staff sends a portal message
  - Document is delivered
  - Signature is requested
- Subdomain routing: `{slug}.darklion.ai` → detects firm from hostname

---

### ⏳ Phase 6 — Pipelines
**Plan:**
- DB tables: `pipeline_templates`, `pipeline_stages`, `pipeline_instances`, `pipeline_jobs`, `pipeline_job_history`
- Staff UI: Kanban board (templates + instances + jobs)
- Pipeline types: fully customizable stages, entity_type locked per template (company/person/relationship)
- Jobs manually added — no auto-population
- Viktor can read and move jobs via API
- Reference: existing TaxDome pipeline had 11 stages for business tax returns (see SCHEMA_PLAN.md)
- Bookkeeping pipeline uses 12 stages (Jan–Dec months)

---

### ⏳ Phase 7 — Tax Return Delivery + E-Signatures
**Plan:**
- Deliver a document through the portal with status tracking (delivered → viewed → signed)
- E-signature flow for 8879s and engagement letters
- Dual-signer support (joint returns — both spouses sign from their own portal)
- Audit trail: IP, timestamp, user agent per signature
- Port logic from existing proposals app

---

### ⏳ Phase 8 — Secure Messaging
**Plan:**
- DB tables: `message_threads`, `messages`, `email_log` (all in schema)
- Staff unified inbox — all open threads across all clients
- Thread status: open → waiting → resolved
- Viktor auto-tags thread category (bookkeeping/tax/general/billing)
- Client sends message → thread goes to `open`, appears in team inbox
- Staff replies → flips to `waiting`
- `is_internal` flag on messages — staff-only notes never shown to client
- Email notification to client when staff sends (via Resend)

---

### ⏳ Phase 9 — Proposals + Engagement Letters
**Plan:**
- Port existing proposals app into DarkLion
- Full flow: proposal → e-sign → auto-create client record + pipeline job
- Engagement letters with e-signature

---

### ⏳ Phase 10 — Billing
**Plan:**
- Stripe subscriptions at Relationship level
- Monthly packages (tiered), one-time fees, payment tracking
- `stripe_customer_id`, `stripe_subscription_id` already on `relationships` table

---

### ⏳ Phase 11 — Viktor Full Integration
**Plan:**
- Viktor (the business AI agent) gets an `agent` role in `firm_users`
- All existing API endpoints accessible with agent JWT
- Every action logged with `role='agent'` in audit trail
- Viktor can: create/update relationships/people/companies, move pipeline jobs, send portal messages, deliver documents, request signatures
- This isn't a phase so much as a continuous thread — Viktor can use any endpoint from Phase 1 onward

---

### ⏳ Phase 12+ — Gmail Connector
**Plan:**
- OAuth per staff Gmail account
- System pulls emails, matches sender to known Person by email address
- Viktor classifies email content → tags to most likely Company
- Stored in `email_log` table
- Staff can override Viktor's classification

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
- Phases 1 & 2 deployed and live at darklion.ai
- Phase 3 building now
- No downtime caused by any phase — all migrations are additive

---

*This document should be kept up to date as each phase completes.*
