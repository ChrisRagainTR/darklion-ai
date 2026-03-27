# Tax Organizer — Build Plan

## What We're Building

A client-facing tax document collection system built into DarkLion. Clients get a personalized checklist of documents to upload based on their prior year return. Staff get visibility into what's been submitted. The output is a compiled workpaper PDF ready for the preparer.

This replaces StanfordTax for document collection. We keep their organizer link as a fallback during transition.

---

## Current State (as of 2026-03-26)

### ✅ Done and working
- **PDF parser** — `server/services/organizerParser.js` reads Drake organizer PDFs and extracts named payers, amounts, EINs, owner (T/S/J). Uses `pdf-parse` (CJS compatible). Tested on Skulina, Dunlap, Carp organizers.
- **DB schema** — `tax_organizers` and `tax_organizer_items` tables deployed on dev Neon.
- **Staff upload+parse endpoint** — `POST /api/organizers/upload/:personId` — staff uploads PDF, it saves to S3 and parses in one shot.
- **Staff view endpoint** — `GET /api/organizers/:personId/:year` — returns organizer + items.
- **Portal view endpoint** — `GET /portal/organizer/portal/:year` — returns organizer + items for logged-in client.
- **Item update endpoint** — `PUT /portal/organizer/portal/:year/item/:itemId` — mark uploaded/not_this_year/pending.
- **Question answers endpoint** — `POST /portal/organizer/portal/:year/answers`
- **Organizer folder lock** — staff cannot upload/edit/delete docs in `folder_category=organizer` via normal doc API.
- **Client portal tab** — Organizers tab shows dashboard: status card, progress bar, item preview, tax season timeline.
- **Organizer flow page** — `/organizer.html` — 4-step flow (confirm info → questions → checklist → submit). Wired to real API via portal JWT.
- **Advisor CRM tab** — Organizers tab shows client's status, item list, upload button, re-parse button.
- **Sentinel Provides detection** — Altruist accounts and firm-prepared K-1s auto-flagged.

### ⚠️ Partially done / broken
- **Client info pre-fill (Step 1)** — JS written but field IDs inconsistently applied. Needs testing.
- **Checklist from real data (Step 3)** — JS written, renders items dynamically. Not fully tested with a live portal session.
- **Submit handler (Step 4)** — Backend workpaper generator written but front-end Submit button still hardcoded and doesn't call the API.

### ❌ Not built yet
- **Email notification** — when client submits, notify staff (no email sent)
- **Pipeline trigger on submit** — move pipeline card to "Organizer Received" stage
- **Advisor upload UI** — the re-parse button is there but the upload modal for staff isn't integrated in the CRM (just a raw file input)
- **Google Drive batch import** — upload all Drake organizers at once from a folder
- **Organizer visible in docs tab** — submitted workpaper should appear in the person's docs
- **"Organizer" folder visible in CRM docs** — currently the folder_category filter hides it from the regular docs view
- **Test with real portal session** — Chris's portal password was wiped; needs to be reset

---

## The Build Plan

### Phase 1 — Make the existing flow work end-to-end *(do this first)*

**Goal:** A client can log in, see their organizer, upload documents, and submit. Staff can see what was submitted.

#### 1.1 Fix client portal auth for Chris
- Reset Chris's portal password so he can log in and test
- Verify the portal JWT resolves to person_id=25 correctly
- Test that organizer tab loads live data (not the "not ready" fallback)

#### 1.2 Fix Step 1 — Confirm Info
- Audit all `id=` attributes on Step 1 form fields
- Verify `populatePersonInfo()` fills them correctly from `/portal/me`
- Test with a logged-in portal session

#### 1.3 Fix Step 3 — Checklist
- Verify `buildChecklistFromItems()` renders correctly from the Carp organizer data
- Test upload button (file picker → API call → status update)
- Test "Not This Year" button → API call
- Verify progress bar updates and Submit unlocks at 100%

#### 1.4 Wire Step 4 — Submit
- Submit button calls `POST /portal/organizer/portal/2025/submit`
- Backend stitches uploaded docs into workpaper PDF
- Success screen shows confirmation
- Workpaper saved to person's docs folder (visible in docs tab as read-only)

#### 1.5 Staff notification on submit
- Send email to firm on submit (use Resend, `messages@sentineltax.co`)
- Body: client name, year, items summary, link to their CRM page

---

### Phase 2 — Staff workflow integration

**Goal:** Staff have a clean way to load organizers and see client progress.

#### 2.1 Clean up advisor CRM organizer tab
- Replace raw file input with a proper styled upload button/modal
- Show submitted_at timestamp and workpaper download link when submitted
- Add "View Client Portal" link so staff can see what client sees

#### 2.2 Pipeline trigger on submit
- Wire `POST /portal/organizer/portal/2025/submit` to fire `organizer_submitted` pipeline trigger
- This moves the client's pipeline card to the configured "Organizer Received" stage

#### 2.3 Organizer folder in docs tab
- Show `folder_category=organizer` docs in the Docs tab as a read-only section ("Organizers")
- Staff can view/download but not delete or upload

---

### Phase 3 — Scale and automation

**Goal:** Load all clients' organizers at once. Handle the full tax season.

#### 3.1 Google Drive batch import
- Connect to a shared Drive folder via service account
- Scan folder: each subfolder named after client → Drake organizer PDF inside
- Match folder name to DarkLion person (last name exact, first name fuzzy, ≥85% = auto-file)
- Uncertain matches → review list sent to Chris before filing
- Batch upload+parse for all matched clients in one run

#### 3.2 Bulk portal invite
- After loading all organizers, send portal invites to all clients who don't have passwords yet
- Email: "Your 2025 tax organizer is ready — click here to get started"

#### 3.3 Tax season dashboard (for staff)
- Dashboard view: all clients, organizer status at a glance
- Filters: Not Started / In Progress / Submitted / Reviewed
- Quick action: send reminder email to clients who haven't started

---

## Data Model (current)

```
tax_organizers
  id, firm_id, person_id, tax_year
  status: pending | in_progress | submitted | reviewed
  source_document_id (Drake PDF)
  workpaper_document_id (compiled output)
  question_answers JSONB
  submitted_at, reviewed_at

tax_organizer_items
  id, organizer_id
  section: w2 | 1099-r | 1099-div | 1099-int | 1099-nec | 1099-misc | 1099-g | k1 | schedule-c | 1098 | childcare | other
  payer_name, account_number, owner (taxpayer|spouse|joint)
  prior_year_amount, ein
  sentinel_provides BOOLEAN
  status: pending | uploaded | not_this_year
  document_id (uploaded file)
  display_order
```

---

## Key Technical Notes

- **Parser uses pdf-parse** (not Python, not pdfreader) — CJS compatible, works on Railway
- **Portal routes** mounted at `/portal/organizer` (requirePortal middleware)
- **Staff routes** at `/api/organizers` (requireFirm middleware)
- **Company join**: `companies.relationship_id` → `people.relationship_id` (no join table)
- **Portal token key**: `localStorage.getItem('portalToken')` in portal pages
- **Staff token key**: `localStorage.getItem('dl_token')` in CRM pages
- **apiFetch returns Response object** — always call `.json()` on result

---

## Definition of Done (Phase 1)

- [ ] Chris logs into client portal, sees Organizers tab with Carp data loaded
- [ ] Clicks "Start Organizer", sees his real name/address pre-filled in Step 1
- [ ] Advances to Step 3, sees all 8 Carp items (W-2, 1099s, K-1, Schedule C, 1098)
- [ ] Uploads a test file to one item — it saves to DB and S3
- [ ] Marks one item "Not This Year" — it saves to DB
- [ ] All 8 items resolved → Submit button unlocks
- [ ] Clicks Submit → confirmation screen, workpaper generated
- [ ] Staff gets email notification
- [ ] Advisor opens Chris's CRM Organizers tab → sees Submitted status + all items
