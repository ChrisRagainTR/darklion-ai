/**
 * Wire help center images into help-articles.js
 * Inject <figure> elements into article html blocks
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '../server/help-articles.js');

const INJECTIONS = [
  {
    searchAfter: `<h1 class="article-title">Key Concepts</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/key-concepts.png" alt="CRM overview showing Relationships, People, and Companies tabs" loading="lazy" />
  <figcaption>The three-level hierarchy: Relationships (households), People (individuals), and Companies (business entities).</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Your First Client</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/first-client.png" alt="CRM Relationships tab with New Relationship button" loading="lazy" />
  <figcaption>Start here: Create your first Relationship in the CRM.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">CRM Overview</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/crm-overview.png" alt="CRM showing Relationships, People, Companies with search and filter" loading="lazy" />
  <figcaption>The CRM dashboard: manage all your client relationships, people, and companies in one place.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Managing Relationships</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/crm-relationships.png" alt="Relationships list showing households" loading="lazy" />
  <figcaption>Relationships list — each row is a household or group billing unit.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Managing People</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/crm-people.png" alt="People list showing individual users" loading="lazy" />
  <figcaption>People list — each person can have their own portal login.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Managing Companies</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/crm-companies.png" alt="Companies list showing business entities" loading="lazy" />
  <figcaption>Companies list — S-Corps, LLCs, Trusts, and other legal entities.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Search</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/search.png" alt="Top header with search bar" loading="lazy" />
  <figcaption>Search bar in the top header — find any client, person, or company instantly.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Documents Overview</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/documents.png" alt="Documents page showing organized file list" loading="lazy" />
  <figcaption>Documents page — upload, organize, and deliver files to clients.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Uploading Documents</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/uploading-documents.png" alt="Upload button and file management controls" loading="lazy" />
  <figcaption>Click the Upload button to add new documents to your clients' folders.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Delivering to Clients</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/delivering-to-clients.png" alt="Deliver controls on documents page" loading="lazy" />
  <figcaption>Use the deliver dropdown to send documents to a specific client portal.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Folder Structure</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/document-folders.png" alt="Document folder and category organization" loading="lazy" />
  <figcaption>Documents are organized by folder section (firm or client uploaded) and category (tax, bookkeeping, other).</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Client Portal Overview</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/portal-overview.png" alt="Client portal showing documents and messages" loading="lazy" />
  <figcaption>The client portal: where your clients upload documents, send messages, and view deliverables.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Inviting Clients to the Portal</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/inviting-clients.png" alt="Invite to Portal button in Person detail view" loading="lazy" />
  <figcaption>Click the "Invite to Portal" button on any person's detail page to send them a login link.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">What Clients See</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/what-clients-see.png" alt="Client portal preview from admin view" loading="lazy" />
  <figcaption>Use "View Portal" to preview exactly what your client sees when they log in.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Client Financials Upload</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/client-financials.png" alt="Financials upload and QuickBooks connection controls" loading="lazy" />
  <figcaption>On the Company details page, clients can connect QuickBooks or upload P&L and Balance Sheet files.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Pipelines Overview</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/pipelines.png" alt="Pipelines dashboard with list of workflows" loading="lazy" />
  <figcaption>Pipelines are workflows you create to track client progress — tax returns, engagements, follow-ups, etc.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Creating Pipelines</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/creating-pipelines.png" alt="New Pipeline button on pipelines page" loading="lazy" />
  <figcaption>Click "+ New Pipeline" to create a workflow for your clients.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Pipeline Cards & The Kanban Board</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/pipeline-cards.png" alt="Kanban board showing cards across pipeline stages" loading="lazy" />
  <figcaption>The kanban board — drag cards between stages to move clients through your workflow.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Smart Triggers</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/smart-triggers.png" alt="Trigger configuration in pipeline settings" loading="lazy" />
  <figcaption>Triggers automatically fire actions (like sending messages) when specific things happen — e.g. when a card is created or completed.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Stage Actions</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/stage-actions.png" alt="Stage action configuration in pipeline settings" loading="lazy" />
  <figcaption>Stage actions run automatically when a card enters a specific stage — send messages, create tasks, etc.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Messaging Overview</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/messages.png" alt="Messaging inbox page" loading="lazy" />
  <figcaption>Secure messaging — send and receive messages directly inside DarkLion instead of email.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Your Staff Inbox</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/staff-inbox.png" alt="Staff messaging inbox with thread list" loading="lazy" />
  <figcaption>Your inbox shows all message threads with clients, sorted by activity.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Sending Messages</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/sending-messages.png" alt="Compose button for new message" loading="lazy" />
  <figcaption>Click "Compose" to start a new message thread with a client.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Internal Notes</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/internal-notes.png" alt="Internal note toggle in message thread" loading="lazy" />
  <figcaption>Toggle "Internal" before sending to hide your note from the client — staff only.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Tax Organizer Overview</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/organizer-overview.png" alt="Tax organizer management in person detail view" loading="lazy" />
  <figcaption>Tax organizers are personalized checklists your clients fill out and return with documents.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Sending an Organizer</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/sending-organizer.png" alt="Send Organizer button in person workflow tab" loading="lazy" />
  <figcaption>Click "Send Organizer" to start a new tax document checklist for your client.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Reviewing Organizer Submissions</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/reviewing-submissions.png" alt="Organizer submissions review interface" loading="lazy" />
  <figcaption>Review your client's responses and download the compiled workpaper PDF.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Proposals</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/proposals.png" alt="Proposals list showing engagement letters" loading="lazy" />
  <figcaption>Proposals are engagement letters your clients sign electronically.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Bulk Send</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/bulk-send.png" alt="Bulk send audience builder and compose form" loading="lazy" />
  <figcaption>Send a message to multiple clients at once with audience filters.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Settings & Branding</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/settings.png" alt="Settings page with firm branding and configuration" loading="lazy" />
  <figcaption>Settings: customize your firm's logo, colors, domain, and API keys.</figcaption>
</figure>

`,
  },
  {
    searchAfter: `<h1 class="article-title">Viktor AI</h1>`,
    insertBefore: `<div class="article-meta">`,
    html: `<figure class="help-screenshot">
  <img src="/images/help/viktor-ai.png" alt="Viktor AI panel on dashboard" loading="lazy" />
  <figcaption>Viktor is your AI co-worker — ask about clients, pipelines, workload, tax strategies, anything. He has full access to firm data.</figcaption>
</figure>

`,
  },
];

let content = fs.readFileSync(FILE_PATH, 'utf8');
let injected = 0;

for (const inj of INJECTIONS) {
  const idx = content.indexOf(inj.searchAfter);
  if (idx === -1) {
    console.log(`⚠️  Could not find: "${inj.searchAfter.substring(0, 50)}..."`);
    continue;
  }

  const insertIdx = content.indexOf(inj.insertBefore, idx);
  if (insertIdx === -1) {
    console.log(`⚠️  Could not find insert point after: "${inj.searchAfter.substring(0, 40)}..."`);
    continue;
  }

  // Check if image already injected
  const snippet = content.substring(idx, insertIdx);
  if (snippet.includes('<figure class="help-screenshot">')) {
    console.log(`✓  "${inj.searchAfter.substring(18, 50)}" — already has image`);
    continue;
  }

  content = content.substring(0, insertIdx) + inj.html + content.substring(insertIdx);
  injected++;
  console.log(`✅ "${inj.searchAfter.substring(18, 50)}"`);
}

fs.writeFileSync(FILE_PATH, content, 'utf8');
console.log(`\n📊 Injected ${injected} images into help articles.`);
