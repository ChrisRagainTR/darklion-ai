# DarkLion — Schema Plan
> Status: APPROVED FOR BUILD (pending Chris sign-off)
> Last updated: 2026-03-20

---

## Decisions Locked In

| Topic | Decision |
|---|---|
| File storage | **AWS S3** (existing credentials, SOC 2 compliant) |
| PII encryption | **App-level encryption** for SSN, DOB, EIN — ciphertext in DB even if DB is compromised |
| Security posture | **SOC 2 design from day one** — signed URLs, full audit log, no PII in logs, TLS everywhere |
| Portal URLs | `{slug}.darklion.ai` default → CNAME to custom domain when ready |
| Email notifications | **Resend** (already in stack) — transactional only, no sensitive content in email body |
| Gmail connector | **Backlog (Phase 8+)** — connect staff Gmail, auto-match emails to People/Companies via Viktor |
| Portal chat notifications | Email alert when staff sends portal message, delivers doc, or requests signature |
| Entity naming | **Relationships / Companies / People** |
| Core principle | **API-first** — everything a human can do, Viktor can do via the same endpoints |

---

## Overview

This document defines the full data model for the rebuilt DarkLion platform. Everything
is designed around three principles:

1. **Relationships → Companies → People** is the core hierarchy. Everything else hangs off it.
2. **API-first.** Every action a human can do, an agent (Viktor) can do via the same API.
3. **Backwards-compatible.** Existing DarkLion data (QBO companies, transactions, etc.)
   maps cleanly into the new structure without data loss.

---

## Entity Hierarchy

```
Relationship        ← top-level grouping (the "household" or "group")
├── Companies       ← legal entities (LLC, S-corp, 1040, Trust, etc.)
│   └── (all existing bookkeeping data lives here)
└── People          ← individuals with portal logins
    └── person_company_access  ← which companies a person can see, and at what level
```

**Key rules:**
- A Company belongs to exactly one Relationship
- A Person belongs to exactly one Relationship
- A Person can have access to many Companies within their Relationship
- A Company can be accessed by many People
- Billing lives at the Relationship level (one Stripe subscription per household)
- Portals are per-Person — spouses each have their own login but may see the same data
- A Person can only belong to one Relationship. If a business splits, new Relationships are
  created manually and data is migrated (by staff or Viktor).

---

## Security Architecture

All of the following are built in from day one, not bolted on later:

- **App-level field encryption** — SSN, DOB, EIN encrypted using a server-managed key.
  Stored as ciphertext in Postgres. Decrypted only in application memory when needed.
- **S3 signed URLs** — documents are never served directly from S3. Every download
  generates a short-lived signed URL (15 min expiry) server-side. Shared links don't work.
- **TLS enforced everywhere** — no HTTP, ever.
- **Audit log on every action** — actor (staff/client/agent), action, entity, IP, timestamp.
  Viktor's actions are logged with role='agent' so they're distinguishable from human actions.
- **No PII in logs** — application logs never contain SSN, DOB, EIN, or tax data.
- **Role-based access at API layer** — not just UI guards. Every endpoint checks permissions
  server-side regardless of how it's called.
- **Portal notification emails contain no sensitive data** — email says "you have a message,
  log in to view it." Content stays inside the portal.

---

## Build Phases

| Phase | What | Notes |
|---|---|---|
| 1 | Foundation — schema + API skeleton | Relationships, Companies, People, access model |
| 2 | Auth + permissions | Staff logins, portal logins, role middleware |
| 3 | Internal CRM UI | Staff manages relationships, companies, people. 360° contact dashboard. |
| 4 | Document management | S3 upload, signed URLs, organized by owner/year/type |
| 5 | Client portal | Login, view docs, businesses, StanfordTax link, portal chat notifications via Resend |
| 6 | Pipelines | Kanban templates, stages, jobs, Viktor can read/move |
| 7 | Tax return delivery + e-signatures | Deliver via portal, 8879 dual-signer, audit trail |
| 8 | Secure messaging | Portal chat, staff unified inbox, email notification on new message |
| 9 | Proposals + engagement letters | Port from existing proposals app |
| 10 | Billing | Stripe subscriptions at relationship level |
| 11 | Viktor full integration | All endpoints accessible, agent role, full capabilities |
| 12+ | Gmail connector | Connect staff Gmail, Viktor classifies emails to People/Companies |

**The API is not a phase — it's built alongside every phase. Every feature gets its
endpoints at the same time as its UI.**

---

## Table Definitions

---

### `relationships`
The household or group. Top-level billing and organizational unit.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | which firm owns this relationship |
| name | TEXT | e.g. "Ragain Family", "Smith Group" |
| service_tier | TEXT | e.g. 'legacy_blueprint', 'tax_only', 'full_service' |
| stripe_customer_id | TEXT | for billing |
| stripe_subscription_id | TEXT | |
| billing_status | TEXT | 'active', 'past_due', 'cancelled' |
| notes | TEXT | internal staff notes |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `companies`
Legal entities — S-corps, LLCs, partnerships, trusts, joint 1040s, sole props.
**This table already exists.** We are expanding it, not replacing it.

New columns added to existing table:

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | ← already exists |
| realm_id | TEXT UNIQUE | QBO realm — already exists, stays as QBO link |
| company_name | TEXT | ← already exists |
| firm_id | INTEGER FK → firms | ← already exists |
| **relationship_id** | **INTEGER FK → relationships** | **NEW** |
| **entity_type** | **TEXT** | **NEW — '1040', 's_corp', 'llc', 'partnership', 'trust', 'sole_prop', 'other'** |
| **ein_encrypted** | **TEXT** | **NEW — app-level encrypted** |
| **tax_year_end** | **TEXT** | **NEW — e.g. '12/31', '06/30'** |
| **stanford_tax_url** | **TEXT** | **NEW — organizer link for this entity** |
| **status** | **TEXT** | **NEW — 'active', 'inactive', 'dissolved'** |
| access_token | TEXT | QBO — already exists |
| refresh_token | TEXT | QBO — already exists |
| token_expires_at | BIGINT | QBO — already exists |
| gusto_* | various | Gusto — already exists |
| connected_at | TIMESTAMPTZ | ← already exists |
| last_sync_at | TIMESTAMPTZ | ← already exists |

**Migration:** Every existing `companies` row gets a new `relationship_id`. We create one
Relationship per existing company (1:1 initially), then staff can merge/reorganize as needed.

---

### `people`
Individuals — clients, spouses, business owners. Each gets their own portal login.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| relationship_id | INTEGER FK → relationships | |
| first_name | TEXT | |
| last_name | TEXT | |
| email | TEXT | portal login + notification email |
| phone | TEXT | |
| date_of_birth_encrypted | TEXT | app-level encrypted |
| ssn_last4 | TEXT | last 4 digits only, for identification |
| ssn_encrypted | TEXT | full SSN, app-level encrypted |
| filing_status | TEXT | 'single', 'mfj', 'mfs', 'hoh', 'qw' |
| spouse_id | INTEGER FK → people | self-referencing — points to spouse in same relationship |
| portal_enabled | BOOLEAN | default false until invited |
| portal_password_hash | TEXT | |
| portal_invite_token | TEXT | |
| portal_invite_expires_at | TIMESTAMPTZ | |
| portal_last_login_at | TIMESTAMPTZ | |
| stanford_tax_url | TEXT | personal organizer link (individual 1040) |
| notes | TEXT | internal staff notes |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `person_company_access`
Who can see what. Many-to-many between People and Companies.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| person_id | INTEGER FK → people | |
| company_id | INTEGER FK → companies | |
| access_level | TEXT | 'view' (read/download only), 'full' (upload + message), 'sign' (can e-sign) |
| ownership_pct | NUMERIC(5,2) | optional — percentage ownership if applicable |
| created_at | TIMESTAMPTZ | |

**Constraint:** UNIQUE(person_id, company_id)

---

### `firm_users` (existing — minor additions)
Staff accounts. Already exists. No breaking changes.

New columns:
| Column | Type | Notes |
|---|---|---|
| *(all existing columns unchanged)* | | |
| **role** | **TEXT** | expanded: 'owner', 'admin', 'staff', **'agent'** |
| **display_name** | **TEXT** | friendly name shown in UI and audit logs |

The **'agent'** role is for Viktor. Same permission level as 'admin' but flagged distinctly
in audit logs so every Viktor action is clearly identifiable.

---

## Pipeline Tables

---

### `pipeline_templates`
Defines a reusable pipeline type with its stages. Created once, used for many instances.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| name | TEXT | e.g. "Business Tax Return", "Bookkeeping Monthly" |
| entity_type | TEXT | 'company', 'person', 'relationship' — all jobs must match this type |
| description | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `pipeline_stages`
Ordered stages for a template. Fully customizable — add, remove, reorder any time.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| template_id | INTEGER FK → pipeline_templates | |
| name | TEXT | e.g. "Prepare Return", "E-Sign Documents" |
| position | INTEGER | sort order |
| color | TEXT | hex color for UI card |
| is_terminal | BOOLEAN | true = final stage (Delivered, Archived) |
| created_at | TIMESTAMPTZ | |

---

### `pipeline_instances`
A specific run of a template — e.g. "2025 Business Tax Returns".

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| template_id | INTEGER FK → pipeline_templates | |
| name | TEXT | e.g. "2025 Business Tax Returns" |
| tax_year | TEXT | e.g. '2025' (optional) |
| status | TEXT | 'active', 'archived' |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `pipeline_jobs`
One card in a pipeline. One entity moving through stages. Manually added — no auto-population.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| instance_id | INTEGER FK → pipeline_instances | |
| entity_type | TEXT | 'company', 'person', 'relationship' — must match template |
| entity_id | INTEGER | FK to companies.id, people.id, or relationships.id |
| current_stage_id | INTEGER FK → pipeline_stages | |
| assigned_to | INTEGER FK → firm_users | staff member responsible |
| notes | TEXT | the "NB:" note visible on the card |
| priority | TEXT | 'normal', 'high', 'urgent' |
| due_date | DATE | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `pipeline_job_history`
Full audit trail of every stage movement.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| job_id | INTEGER FK → pipeline_jobs | |
| from_stage_id | INTEGER FK → pipeline_stages | nullable on first move |
| to_stage_id | INTEGER FK → pipeline_stages | |
| moved_by | INTEGER FK → firm_users | staff or agent (Viktor) |
| moved_at | TIMESTAMPTZ | |
| note | TEXT | optional comment on the move |

---

## Document Tables

---

### `documents`
All files in the system. Owned by either a company or a person.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| owner_type | TEXT | 'company' or 'person' |
| owner_id | INTEGER | FK to companies.id or people.id |
| year | TEXT | tax/fiscal year e.g. '2024' |
| doc_type | TEXT | 'tax_return', 'w2', '1099', 'engagement_letter', 'organizer', 'statement', 'other' |
| display_name | TEXT | friendly filename shown in UI |
| s3_bucket | TEXT | S3 bucket name |
| s3_key | TEXT | S3 object key (never exposed directly to client) |
| mime_type | TEXT | |
| size_bytes | INTEGER | |
| uploaded_by_type | TEXT | 'staff', 'client', 'agent' |
| uploaded_by_id | INTEGER | FK to firm_users.id or people.id |
| is_delivered | BOOLEAN | true = visible to client in their portal |
| delivered_at | TIMESTAMPTZ | |
| viewed_at | TIMESTAMPTZ | when client first opened it |
| created_at | TIMESTAMPTZ | |

**Note:** Files are served exclusively via server-generated S3 signed URLs (15-minute expiry).
The `s3_key` is never returned to the client directly.

---

## Messaging Tables

---

### `message_threads`
One thread per subject. Belongs to a relationship, company, or person.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| subject | TEXT | |
| context_type | TEXT | 'relationship', 'company', 'person' |
| context_id | INTEGER | FK to the relevant entity |
| status | TEXT | 'open' (needs response), 'waiting' (staff replied, awaiting client), 'resolved' (done, off inbox) |
| category | TEXT | 'bookkeeping', 'tax', 'general', 'billing', 'other' — set by staff or auto-tagged by Viktor |
| assigned_to | INTEGER FK → firm_users | staff member who claimed this thread (nullable) |
| created_at | TIMESTAMPTZ | |
| last_message_at | TIMESTAMPTZ | used for inbox sort order |

**Team inbox behavior:**
- Client sends message → thread flips to `open`, appears in shared team inbox
- Staff replies → flips to `waiting` (our turn is done)
- Client replies again → flips back to `open`
- Staff marks resolved → flips to `resolved`, disappears from inbox
- All threads remain permanently on the person's portal record regardless of status
- Viktor auto-tags `category` as messages arrive based on content; staff can override

**Staff inbox view:** Filters to `status = 'open'`, sorted oldest-first (most overdue at top).
Filterable by category so Nick sees bookkeeping threads, Chris sees tax threads, etc.

---

### `messages`
Individual messages in a thread.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| thread_id | INTEGER FK → message_threads | |
| sender_type | TEXT | 'staff', 'client', 'agent' |
| sender_id | INTEGER | FK to firm_users.id or people.id |
| body | TEXT | |
| is_internal | BOOLEAN | true = staff-only note, never shown to client |
| created_at | TIMESTAMPTZ | |
| read_at | TIMESTAMPTZ | when recipient first read it |

**Notification trigger:** When staff or agent sends a non-internal message to a client thread,
a transactional email fires via Resend: "You have a new message — log in to view it."
No message content in the email.

---

### `email_log`
Inbound client emails captured from Gmail connectors (Phase 12+).
Table created early so the schema is ready when the feature is built.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| person_id | INTEGER FK → people | matched by from-address |
| staff_user_id | INTEGER FK → firm_users | whose Gmail account received it |
| from_email | TEXT | |
| subject | TEXT | |
| body_text | TEXT | |
| ai_company_id | INTEGER FK → companies | Viktor's best guess at which company it's about |
| ai_confidence | REAL | 0–1 |
| received_at | TIMESTAMPTZ | |
| linked_thread_id | INTEGER FK → message_threads | if linked to a portal thread |

---

## E-Signature Tables

---

### `signature_requests`
A document sent for signature. Supports multiple signers (joint 8879, couples, partners).

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| document_id | INTEGER FK → documents | |
| title | TEXT | e.g. "2024 Form 8879 — Ragain" |
| status | TEXT | 'pending', 'partial', 'complete', 'declined' |
| created_by | INTEGER FK → firm_users | |
| expires_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

---

### `signature_request_signers`
Each person required to sign, with their individual status and full audit trail.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| request_id | INTEGER FK → signature_requests | |
| person_id | INTEGER FK → people | |
| status | TEXT | 'pending', 'signed', 'declined' |
| signed_at | TIMESTAMPTZ | |
| ip_address | TEXT | SOC 2 audit trail |
| user_agent | TEXT | SOC 2 audit trail |
| signature_data | TEXT | drawn/typed signature (base64 or text) |

---

## Notification Tables

---

### `notifications`
In-app notification queue for both staff and portal users.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| firm_id | INTEGER FK → firms | |
| recipient_type | TEXT | 'staff' or 'client' |
| recipient_id | INTEGER | FK to firm_users.id or people.id |
| type | TEXT | 'new_message', 'document_delivered', 'signature_requested', 'signature_complete', 'job_moved' |
| title | TEXT | short description |
| body | TEXT | longer detail |
| link | TEXT | deep link to the relevant item |
| read_at | TIMESTAMPTZ | null = unread |
| email_sent_at | TIMESTAMPTZ | when Resend notification fired |
| created_at | TIMESTAMPTZ | |

---

## Existing Tables — Unchanged

These tables continue to work exactly as today. The only connection to the new structure
is that `companies.relationship_id` is added — all `realm_id` foreign keys remain intact:

| Table | What it does |
|---|---|
| `transactions` | QBO bookkeeping transactions |
| `vendors` | Researched vendor records |
| `category_rules` | Auto-categorization rules |
| `jobs` | Background processing jobs (sync, research, categorize) |
| `scan_results` | Variance/anomaly scan output |
| `close_packages` | Monthly close reports |
| `statement_schedules` | Bank statement collection tracking |
| `statement_monthly_status` | Per-month status per statement schedule |
| `employee_metadata` | Gusto employee flags (officer status) |
| `audit_log` | System-wide action log — every action by staff, client, or agent |
| `firms` | The accounting firm (multi-tenant root) |

---

## Portal URL Model

- Every firm gets `{slug}.darklion.ai` by default (e.g. `sentineladvisors.darklion.ai`)
- Custom domain: firm adds a CNAME record pointing their domain to their DarkLion subdomain
- App detects the incoming hostname and serves the correct firm's portal
- SSL handled automatically via Let's Encrypt / Railway's cert provisioning

---

## Migration Plan

All steps are additive. No tables dropped. No downtime. Existing features keep working.

1. Add new columns to `companies` (all nullable initially)
2. Create `relationships` table
3. Backfill — create one Relationship per existing company (1:1)
4. Set `companies.relationship_id` for all existing rows
5. Make `relationship_id` NOT NULL on `companies`
6. Create all new tables (`people`, `person_company_access`, pipeline tables, document tables, etc.)
7. Staff uses new CRM UI to clean up relationships, merge where appropriate, add People

---

## Open Items (backlog, not blockers)

- **Gmail connector** (Phase 12+) — OAuth per staff user, Viktor classifies emails to People/Companies
- **StanfordTax API** — when they launch one, replace URL field with native integration
- **SOC 2 audit** — design is ready; formal audit engagement when client volume warrants it
- **Time-based pipeline recurrence** — auto-create new instance each year (currently manual)

---

*Schema approved. Ready to build on Chris's go-ahead.*
