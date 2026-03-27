# DarkLion Tax Organizer — User Guide
**Version:** March 2026 · Dev environment: darklion-ai-development.up.railway.app

---

## Overview

The Tax Organizer replaces the old StanfordTax document collection workflow. Clients get a personalized checklist of documents to upload based on their prior year return. Staff can monitor progress in real time, add or remove items, and receive a compiled workpaper PDF the moment the client submits.

There are two sides to the system:
- **Advisor View** — inside DarkLion CRM (staff login)
- **Client View** — inside the Client Portal (client login)

---

## Part 1 — Advisor Workflow

### Step 1: Load the Organizer for a Client

1. Log in to DarkLion at `darklion.ai` (or dev URL above)
2. Navigate to the client's CRM page: **CRM → [Client Name]**
3. Click the **Organizers** tab

If no organizer has been loaded yet, you'll see:
> "No organizer loaded yet. Upload the Drake organizer PDF to get started."

Click **⬆ Upload Drake Organizer** and select the client's Drake organizer PDF from your computer. The system will:
- Upload the PDF to S3
- Parse it automatically (reads payer names, EINs, amounts, owner T/S/J)
- Generate a checklist of document items
- Flag any Altruist accounts or firm-managed K-1s as **Sentinel Provides** (client doesn't need to upload those)

The Organizers tab will then display a card for the **2025 Tax Organizer** with all items listed.

---

### Step 2: Review the Parsed Checklist

The organizer card shows:
- **Status** — Not Started / In Progress / Submitted / Reopened
- **Stats** — count of Uploaded / Not This Year / Pending / Sentinel items
- **Progress bar** — percentage of actionable items resolved
- **Item list** — two-column grid of all checklist items by section (W-2, 1099s, K-1s, etc.)
  - 🏢 = Sentinel Provides (firm handles this)
  - ✓ = Client uploaded
  - – = Client marked Not This Year
  - ○ = Still pending
- **Client Questionnaire** — read-only mirror of the 11 yes/no questions, showing exactly what the client answered

---

### Step 3: Edit the Checklist (Optional)

**Add a document item:**
At the bottom of the organizer card, use the **Add Document Request** section:
- Enter the payer/document name
- Select the document type (W-2, 1099-R, K-1, etc.)
- Select owner (Taxpayer / Spouse / Joint)
- Click **+ Add**

The new item will appear on the client's checklist immediately.

**Remove an item:**
Each item row has a 🗑 trash icon on the right. Click once → button changes to **"✕ confirm"** (3-second window). Click again to delete. This removes it from the client's checklist.

**Add a custom question:**
Use the **Add Custom Question** section to add a yes/no question specific to this client (e.g. "Did you receive an inheritance this year?"). It will appear at the bottom of the client's questionnaire in Step 2 of the organizer flow.

**Re-parse:**
If you need to reload the checklist from a new or corrected Drake PDF, click **↻ Re-parse** and upload the updated file. This replaces all existing items.

---

### Step 4: Send the Client to Their Portal

Once the organizer is loaded, the client will see it automatically the next time they log into the portal. No manual send needed.

If the client doesn't have a portal login yet:
1. Go to their CRM person page
2. Click **Portal** tab → **Send Portal Invite**

They'll receive an email with a link to set their password and access the portal.

---

### Step 5: Monitor Progress

The Organizers tab is a live read-only view of the client's checklist. Any time the client uploads a document or answers a question, it reflects here on your next page load.

You can also see individual uploaded files in the **Docs tab** → **Uploaded by Client** → **📋 Tax Organizer Uploads** (collapsible section). Each file is named after the checklist item it was uploaded for (e.g. `AXOS BANK — 1099-INT.pdf`).

---

### Step 6: After Client Submits

When the client submits:
1. Status changes to **Closed**
2. A compiled **Workpaper PDF** is generated automatically (cover page + all uploaded docs in order)
3. The workpaper appears in the Docs tab → **Delivered by Advisor → Tax**
4. A notification email is sent to the firm
5. A **pipeline trigger** fires — if you've configured "Client Submitted Tax Organizer" as a trigger on a pipeline stage, their card moves automatically

You'll see a **⬇ Download Workpaper PDF** button on the organizer card.

---

### Step 7: Request More Documents (If Needed)

If you need additional documents after the client submits:
1. Click **🔄 Request More Docs** on the organizer card
2. Optionally type a note for the client (e.g. "We need your brokerage statement for NFS — it may have arrived after you submitted")
3. Click OK

The organizer status changes to **Reopened**. The client's portal shows a yellow banner with your note and the full checklist becomes active again. When they re-submit, the process repeats.

---

### Active Tax Year (Settings)

To open a new tax season for all clients:
1. Go to **Settings → 🗓 Tax Season**
2. Change **Active Tax Year** to the new year (e.g. 2026)
3. Click **Save**

All client portals will immediately show the new year's organizer tab. Prior years move to the **Prior Years** accordion below.

---

## Part 2 — Client Workflow

### Accessing the Organizer

1. Client logs into the portal: `darklion.ai/client-login` (or dev URL)
2. Click the **Organizers** tab in the left navigation
3. If their organizer is ready, they'll see the status dashboard
4. Click **▶ Start Organizer** (or **▶ Continue Organizer** if they've started)

---

### Step 1: Confirm Your Information

The first screen shows pre-filled personal information pulled from their DarkLion record:
- Full name, email, phone
- Mailing address
- Spouse information (if applicable)

Client reviews for accuracy. If anything is wrong, they can edit it here. Click **Everything looks right → Next** to continue.

> Note: This step is informational — changes here do not update DarkLion records. If contact info needs updating, the advisor updates it in CRM.

---

### Step 2: Quick Questions

11 yes/no questions covering life changes and less-common tax situations:

| Question | Why We Ask |
|---|---|
| Major life change (marriage, divorce, new baby, death) | Affects filing status and deductions |
| Address changed | Ensures correct state filing |
| Sold any stocks, bonds, or investments | Capital gains reporting |
| Cryptocurrency transactions *(required)* | IRS reporting requirement |
| Started, closed, or sold a business | Schedule C / business tax |
| Freelance, consulting, or side income | Schedule C |
| Bought, sold, or refinanced real estate | Capital gains / 1098 changes |
| Rental income | Schedule E |
| Foreign accounts or assets exceeding $10,000 *(required)* | FBAR filing requirement |
| Foreign income or taxes paid to a foreign country | Foreign tax credit |
| IRS or state tax notices received | Requires follow-up |

For "Yes" answers on some questions, a follow-up text box appears for details.

Click **Next: Your Documents →** to save answers and continue.

> Answers are saved immediately when clicking Next. The advisor can see responses in real time on the Organizers tab.

---

### Step 3: Your Documents

The checklist shows every document we're expecting based on the prior year return, organized by type:

**Left column:** W-2, 1099-R, 1099-DIV, 1099-INT, 1099-NEC, 1099-MISC, 1099-G

**Right column:** K-1, Schedule C, 1098 (mortgage), Childcare, Other

**For each item, the client can:**

**⬆ Upload** — Opens a file picker. Accepted formats: PDF, JPG, PNG, HEIC. The file uploads immediately and the item is marked ✓ Uploaded.

**Not This Year** — Marks the item as not applicable this year (e.g. they closed a bank account and won't receive that 1099-INT). Item is marked – Not This Year.

**Undo** — Available on both uploaded and Not This Year items. Returns the item to Pending.

**🏢 Sentinel Provides** — Items with this badge are handled by the firm (Altruist accounts, firm-prepared K-1s). Client doesn't need to do anything for these.

The progress bar and item count update in real time. The **Review & Submit** button unlocks only when every actionable item is either uploaded or marked Not This Year.

---

### Step 4: Review & Submit

The summary screen shows:
- Questionnaire answers recap
- What was uploaded vs. marked Not This Year

Click **✓ Send to Sentinel Tax** to submit.

What happens immediately:
- A compiled workpaper PDF is generated
- The organizer moves to **Submitted** status
- The advisor receives an email notification
- The client's portal Organizers tab updates to the confirmation screen

The portal then shows:
> "✅ Organizer Submitted! Received on [date]. We're reviewing your documents and will be in touch when your 2025 return is ready."

---

### If the Advisor Requests More Documents

If the advisor needs something additional, the client will see a yellow banner on their Organizers tab:

> "⚠️ Your advisor has reopened your organizer for additional documents."

Plus any note the advisor added (e.g. "We need your brokerage statement for NFS").

The checklist becomes active again. Client uploads the missing document(s) and re-submits.

---

### Prior Years

Below the active organizer, clients can expand a **Prior Years** accordion showing all past organizers with:
- Year and submitted date
- Number of items
- Link to download the compiled workpaper PDF

---

## Part 3 — API Reference (for developers)

### Staff Endpoints (`/api/organizers/...` — requires firm auth)

| Method | Path | Description |
|---|---|---|
| POST | `/api/organizers/upload/:personId` | Upload Drake PDF → auto-parse → create organizer + items |
| POST | `/api/organizers/parse-document/:documentId` | Parse a previously uploaded document |
| GET | `/api/organizers/:personId/all` | List all organizers for a person (all years, with items) |
| GET | `/api/organizers/:personId/:year` | Get one organizer + items |
| POST | `/api/organizers/:personId/:year/items` | Add a custom document item |
| DELETE | `/api/organizers/:personId/:year/items/:itemId` | Delete any item |
| PUT | `/api/organizers/:personId/:year/questions` | Add/update custom questions |
| POST | `/api/organizers/:personId/:year/reopen` | Reopen a closed organizer (with optional note) |
| POST | `/api/organizers/:personId/:year/close` | Manually close an organizer |

### Portal Endpoints (`/portal/organizer/...` — requires portal auth)

| Method | Path | Description |
|---|---|---|
| GET | `/portal/organizer/client/:year` | Get organizer + items for logged-in client |
| PUT | `/portal/organizer/client/:year/item/:itemId` | Update item status (pending/not_this_year) |
| POST | `/portal/organizer/client/:year/upload-item/:itemId` | Upload file for a checklist item |
| POST | `/portal/organizer/client/:year/answers` | Save questionnaire answers |
| POST | `/portal/organizer/client/:year/submit` | Submit organizer → generate workpaper |
| GET | `/portal/organizer/all-years` | List all organizers for logged-in client |

---

## Part 4 — Database Schema

```
tax_organizers
  id, firm_id, person_id, tax_year
  status: pending | in_progress | closed | reopened
  source_document_id     — the uploaded Drake PDF
  workpaper_document_id  — the compiled output PDF
  question_answers       — JSONB { crypto: false, life_change: true, ... }
  custom_questions       — JSONB array of advisor-added questions
  submitted_at, closed_at, reviewed_at
  reopen_note            — advisor's message to client on reopen

tax_organizer_items
  id, organizer_id
  section: w2 | 1099-r | 1099-div | 1099-int | 1099-nec | 1099-misc |
           1099-g | k1 | schedule-c | 1098 | childcare | other
  payer_name, account_number, owner (taxpayer|spouse|joint)
  prior_year_amount, ein
  sentinel_provides BOOLEAN  — firm handles this, client skips it
  advisor_added BOOLEAN      — manually added by staff (not from parse)
  status: pending | uploaded | not_this_year
  document_id                — S3 document uploaded for this item
  display_order
```

---

## Part 5 — Pipeline Integration

The organizer fires the **"Client Submitted Tax Organizer"** pipeline trigger automatically on submit.

To use it:
1. Go to **Pipelines → [Your Pipeline] → Settings**
2. On the stage you want to auto-advance to (e.g. "Organizer Received"), click **⚡ Triggers**
3. Add **Client Submitted Tax Organizer**

When any client submits their organizer, their pipeline card will move to that stage automatically.

---

## Part 6 — Known Behaviors & Edge Cases

| Situation | What Happens |
|---|---|
| Client uploads a non-PDF (JPG, PNG, HEIC) | Accepted and stored. Not appended to workpaper PDF (PDF only). |
| Client re-uploads after marking Not This Year | Undo first, then upload |
| Staff re-parses after client has already uploaded items | All items replaced. Client uploads are preserved in Docs tab but items reset to pending. |
| Sentinel Provides item — client tries to upload anyway | Not possible — no upload button shown for Sentinel items |
| Organizer submitted — workpaper not generating | Check Railway logs. Most common cause: S3 permissions or a document_id pointing to a deleted file |
| Active tax year changed mid-season | Clients with organizers already in progress are unaffected — they still see their organizer. New clients with no organizer see the new year. |

---

*Last updated: March 27, 2026 · Maintained by Argus*
