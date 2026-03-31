'use strict';

/**
 * DarkLion Help Center — Article Registry
 * Each article has: slug, title, section, keywords, body (plain text for search), and html content.
 */

const articles = [

  // ─── GETTING STARTED ───────────────────────────────────────────────────────

  {
    slug: 'what-is-darklion',
    title: 'What Is DarkLion?',
    section: 'Getting Started',
    keywords: ['overview', 'introduction', 'platform', 'taxdome', 'replace'],
    prev: null,
    next: { slug: 'key-concepts', title: 'Key Concepts' },
    body: 'DarkLion is a full practice management platform for CPA firms. It replaces TaxDome with a system built AI-native from the ground up.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Getting Started</span><span class="sep">›</span>
  <span>What Is DarkLion?</span>
</div>
<h1 class="article-title">What Is DarkLion?</h1>
<div class="article-meta">Section: Getting Started</div>
<div class="article-body">

<p>DarkLion is a full practice management platform built for Sentinel Wealth & Tax. It's designed to replace TaxDome as the central hub for managing clients, documents, workflows, messaging, and tax preparation — with AI built in from the ground up rather than bolted on top.</p>

<h2>What You Can Do in DarkLion</h2>

<ul>
  <li><strong>CRM</strong> — Manage every client household (Relationship), their individual members (People), and their business entities (Companies) in one place.</li>
  <li><strong>Documents</strong> — Upload, organize, and deliver documents to clients securely. Clients download them from their portal.</li>
  <li><strong>Client Portal</strong> — Every client gets a secure login where they can view documents, send messages, upload financials, and sign returns.</li>
  <li><strong>Pipelines</strong> — Track every client's progress through your tax return process with a visual kanban board. Move cards, set stages, automate actions.</li>
  <li><strong>Messaging</strong> — Send and receive secure messages with clients directly inside DarkLion. No more email for sensitive client communication.</li>
  <li><strong>Tax Organizer</strong> — Send clients a personalized document checklist. They upload directly. You get a compiled workpaper PDF.</li>
  <li><strong>Proposals</strong> — Create and send engagement proposals. Clients sign electronically.</li>
  <li><strong>Viktor AI</strong> — An AI agent with full access to the firm's data. Ask Viktor anything about your clients, pipelines, or workload.</li>
</ul>

<h2>Who Built It</h2>
<p>DarkLion was built by Chris Ragain (CPA/PFS, Sentinel Wealth & Tax) and Argus (AI assistant). It's API-first — meaning everything a human staff member can do, Viktor (the AI agent) can do via the same endpoints. Nothing is a workaround; the AI capabilities are structural.</p>

<h2>The Core Philosophy</h2>
<div class="callout tip"><span class="callout-icon">💡</span><div>Every competitor bolts AI on top of an existing system. DarkLion is built AI-native from day one. The same API you use in the browser is what Viktor uses. No separate "AI mode" — it's the same system.</div></div>

<p>DarkLion is designed around a single principle: a CPA firm should never have to leave the platform to serve a client. Documents, communication, workflow, signing, and AI assistance all live in one place.</p>

</div>
    `
  },

  {
    slug: 'key-concepts',
    title: 'Key Concepts',
    section: 'Getting Started',
    keywords: ['relationship', 'company', 'person', 'hierarchy', 'structure', 'data model'],
    prev: { slug: 'what-is-darklion', title: 'What Is DarkLion?' },
    next: { slug: 'first-client', title: 'Your First Client' },
    body: 'DarkLion organizes everything around three entities: Relationships, Companies, and People. Understanding this hierarchy is essential.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Getting Started</span><span class="sep">›</span>
  <span>Key Concepts</span>
</div>
<h1 class="article-title">Key Concepts</h1>
<div class="article-meta">Section: Getting Started</div>
<div class="article-body">

<p>DarkLion organizes all client data around three core entities. Understanding how they relate to each other is the foundation for using the platform effectively.</p>

<h2>The Three-Level Hierarchy</h2>

<pre><code>Relationship  →  the household or group (top-level)
├── Companies →  legal entities (S-Corp, LLC, Trust, 1040, etc.)
└── People    →  individuals with portal logins</code></pre>

<h3>Relationship</h3>
<p>A <strong>Relationship</strong> is the top-level container — it represents a household or group. For most clients, this is their family unit (e.g., "The Ragain Family"). For business-only clients, it might be their company group (e.g., "Smith Group").</p>
<ul>
  <li>Billing happens at the Relationship level</li>
  <li>Every Company and every Person belongs to one Relationship</li>
  <li>Notes, service tier, and pipeline history are tracked here</li>
</ul>

<h3>People</h3>
<p><strong>People</strong> are the individuals inside a Relationship — the taxpayer, their spouse, adult children with their own accounts, etc. Each Person:</p>
<ul>
  <li>Can have their own client portal login</li>
  <li>Has their own personal tax records (filing status, SSN, DOB)</li>
  <li>Can be linked to a spouse (for MFJ filers)</li>
  <li>Can have access to one or more Companies</li>
</ul>

<h3>Companies</h3>
<p><strong>Companies</strong> are legal business entities — S-Corps, LLCs, partnerships, trusts, or even a joint 1040 filed as an entity. Each Company:</p>
<ul>
  <li>Belongs to one Relationship</li>
  <li>Can connect to QuickBooks Online for bookkeeping</li>
  <li>Has its own document folder, pipeline cards, and workflow</li>
  <li>Can have multiple People with access (e.g., both spouses see the S-Corp)</li>
</ul>

<div class="callout info"><span class="callout-icon">ℹ️</span><div><strong>Real example:</strong> The Ragain Family is a Relationship. Chris Ragain and Sara Ragain are People. Ragain Holdings LLC is a Company. Both Chris and Sara have access to the Company, but each has their own portal login.</div></div>

<h2>Why This Matters</h2>
<p>Almost everything in DarkLion — documents, messages, pipelines, portals — is attached to one of these three entity types. When you upload a document, you choose whether it belongs to a Person or a Company. When you create a pipeline, you decide if it tracks Companies or People. Understanding this structure makes every other feature click into place.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>When in doubt: <strong>Relationship</strong> = the family/group. <strong>People</strong> = individuals who log in. <strong>Companies</strong> = business entities that file separately or have their own books.</div></div>

</div>
    `
  },

  {
    slug: 'first-client',
    title: 'Your First Client',
    section: 'Getting Started',
    keywords: ['add client', 'new client', 'setup', 'onboard', 'invite', 'create relationship'],
    prev: { slug: 'key-concepts', title: 'Key Concepts' },
    next: { slug: 'crm-overview', title: 'CRM Overview' },
    body: 'Step by step guide to adding your first client in DarkLion: creating a relationship, adding people, adding companies, and inviting them to the portal.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Getting Started</span><span class="sep">›</span>
  <span>Your First Client</span>
</div>
<h1 class="article-title">Your First Client</h1>
<div class="article-meta">Section: Getting Started</div>
<div class="article-body">

<p>Here's how to get a new client fully set up in DarkLion — from creating their record to getting them into the portal.</p>

<h2>Step 1 — Create a Relationship</h2>
<ol class="step-list">
  <li>Go to <strong>CRM</strong> in the left sidebar.</li>
  <li>On the <strong>Relationships</strong> tab, click <strong>+ New Relationship</strong>.</li>
  <li>Enter the household name (e.g., "The Smith Family"), service tier, and billing status.</li>
  <li>Click <strong>Save</strong>.</li>
</ol>

<h2>Step 2 — Add People</h2>
<ol class="step-list">
  <li>Click into the Relationship you just created.</li>
  <li>On the <strong>People</strong> tab, click <strong>+ Add Person</strong>.</li>
  <li>Fill in: first name, last name, email, phone, filing status, date of birth.</li>
  <li>If married filing jointly, set filing status to <strong>MFJ</strong> — you'll be able to link a spouse after adding them.</li>
  <li>Click <strong>Save</strong>.</li>
  <li>Repeat for a spouse if applicable, then link them together on the person's edit modal.</li>
</ol>

<h2>Step 3 — Add Companies (if applicable)</h2>
<ol class="step-list">
  <li>On the <strong>Companies</strong> tab of the CRM, click <strong>+ New Company</strong>.</li>
  <li>Enter the company name, entity type (S-Corp, LLC, etc.), and assign to the correct Relationship.</li>
  <li>Set bookkeeping service type: <strong>Firm Manages</strong> (you do their books) or <strong>Client Prepared</strong> (they do their own books).</li>
  <li>Click <strong>Save</strong>. Portal access is auto-granted to People in the same Relationship.</li>
</ol>

<h2>Step 4 — Invite the Client to Their Portal</h2>
<ol class="step-list">
  <li>Open the Person record in the CRM.</li>
  <li>On the <strong>Overview</strong> tab, click <strong>Send Portal Invite</strong>.</li>
  <li>An email goes to the client with a link to set their password and access their portal.</li>
  <li>Once they accept, their portal is live — they'll see their documents, companies, and messaging.</li>
</ol>

<div class="callout tip"><span class="callout-icon">💡</span><div>You don't have to invite clients to the portal right away. You can use DarkLion for internal tracking first and invite them when you're ready to share documents.</div></div>

<h2>What's Next</h2>
<p>With your first client set up, you can:</p>
<ul>
  <li><a href="/help/article/uploading-documents">Upload documents</a> to their record</li>
  <li><a href="/help/article/creating-pipelines">Add them to a pipeline</a> to track their return</li>
  <li><a href="/help/article/sending-organizer">Send them a tax organizer</a> for document collection</li>
  <li><a href="/help/article/sending-messages">Send them a message</a> through the portal</li>
</ul>

</div>
    `
  },

  // ─── CRM ───────────────────────────────────────────────────────────────────

  {
    slug: 'crm-overview',
    title: 'CRM Overview',
    section: 'CRM',
    keywords: ['crm', 'clients', 'contacts', 'manage', 'search', 'filter'],
    prev: { slug: 'first-client', title: 'Your First Client' },
    next: { slug: 'relationships', title: 'Relationships' },
    body: 'The CRM is the central hub for all client records. Three tabs: Relationships, People, Companies. Click any row to open the full detail page.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>CRM</span><span class="sep">›</span>
  <span>CRM Overview</span>
</div>
<h1 class="article-title">CRM Overview</h1>
<div class="article-meta">Section: CRM</div>
<div class="article-body">

<p>The CRM (Client Relationship Manager) is the central hub for all client data in DarkLion. Navigate to it using the <strong>🗂️ CRM</strong> link in the left sidebar.</p>

<h2>The Three Tabs</h2>
<ul>
  <li><strong>Relationships</strong> — All client households and groups. This is the primary view for most staff work.</li>
  <li><strong>People</strong> — All individuals across all relationships. Useful when you need to look someone up by name or email.</li>
  <li><strong>Companies</strong> — All business entities. Filter by entity type or bookkeeping service.</li>
</ul>

<h2>Searching and Filtering</h2>
<p>Each tab has a <strong>Filter…</strong> search box that filters the list in real time. You can also use the global search bar at the top of any DarkLion page (the magnifying glass) to search across all three entity types at once.</p>

<h2>Detail Pages</h2>
<p>Click any row in the CRM to open the full detail page for that entity. Each detail page has tabs specific to that entity type:</p>
<ul>
  <li><strong>Person detail:</strong> Overview · Docs · Tax · Communication · Organizers · Workflow · Notes</li>
  <li><strong>Company detail:</strong> Overview · Docs · Tax · Bookkeeping · Communication · Organizers · Workflow · Notes</li>
  <li><strong>Relationship detail:</strong> Overview · Notes · Billing</li>
</ul>

<h2>Adding New Records</h2>
<ul>
  <li><strong>+ New Relationship</strong> — on the Relationships tab</li>
  <li><strong>+ New Person</strong> — on the People tab</li>
  <li><strong>+ New Company</strong> — on the Companies tab</li>
</ul>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>When you add a Company, portal access is automatically granted to all People in the same Relationship. You don't need to manually link them.</div></div>

</div>
    `
  },

  // ─── PIPELINES ──────────────────────────────────────────────────────────────

  {
    slug: 'pipelines-overview',
    title: 'Pipelines Overview',
    section: 'Pipelines',
    keywords: ['pipeline', 'kanban', 'workflow', 'stages', 'cards', 'track', 'progress', 'tax return'],
    prev: null,
    next: { slug: 'creating-pipelines', title: 'Creating a Pipeline' },
    body: 'Pipelines let you track every client through a repeatable process using a visual kanban board. Each pipeline has stages; each client gets a card that moves through those stages.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Pipelines</span><span class="sep">›</span>
  <span>Pipelines Overview</span>
</div>
<h1 class="article-title">Pipelines Overview</h1>
<div class="article-meta">Section: Pipelines</div>
<div class="article-body">

<p>Pipelines are the workflow engine of DarkLion. They let you track every client through a repeatable process — like a tax return preparation workflow — using a visual kanban board.</p>

<h2>Core Concepts</h2>

<h3>Pipeline Template</h3>
<p>A <strong>Pipeline Template</strong> defines the process — its name, what type of entity it tracks (Companies, People, or Relationships), and its stages. You create a template once and reuse it every year.</p>

<h3>Pipeline Instance</h3>
<p>An <strong>Instance</strong> is a specific run of a template — e.g., "2025 Business Tax Returns." Instances are year-specific. When a new tax year starts, you create a new instance from the same template rather than rebuilding from scratch.</p>

<h3>Stages</h3>
<p><strong>Stages</strong> are the columns in the kanban board — e.g., "Awaiting Documents", "In Preparation", "Client Review", "E-Sign Requested", "Delivered." You can create as many stages as you need and reorder them anytime.</p>

<h3>Cards (Jobs)</h3>
<p>Each <strong>Card</strong> represents one client entity moving through the pipeline. Cards are created manually (or automatically via Smart Triggers). A card shows the client's name, current stage, priority, and any notes.</p>

<h2>The Kanban Board</h2>
<p>Go to <strong>Pipelines</strong> in the left sidebar to see all your pipeline templates. Click a pipeline name to open the kanban board for its current year. You can:</p>
<ul>
  <li><strong>Drag cards</strong> between stages to move clients forward</li>
  <li><strong>Click a card</strong> to open the detail panel (notes, assignee, due date, history)</li>
  <li>Use the <strong>← →</strong> buttons on a card to move it one stage at a time</li>
  <li>Switch between years using the year selector in the board header</li>
</ul>

<h2>Automation</h2>
<p>Pipelines connect to two automation systems:</p>
<ul>
  <li><strong>Smart Triggers</strong> — Events in DarkLion (like a client submitting financials) automatically move cards to the right stage.</li>
  <li><strong>Stage Actions</strong> — When a card enters a stage, DarkLion can automatically send a portal message or create a staff task.</li>
</ul>

<div class="callout tip"><span class="callout-icon">💡</span><div>You only need one pipeline per process type. Use the year selector to manage multiple years from the same template — no need to rebuild stages every year.</div></div>

</div>
    `
  },

  {
    slug: 'smart-triggers',
    title: 'Smart Triggers',
    section: 'Pipelines',
    keywords: ['triggers', 'automation', 'auto-move', 'pipeline', 'event', 'organizer submitted', 'financials'],
    prev: { slug: 'pipeline-cards', title: 'Stages & Cards' },
    next: { slug: 'stage-actions', title: 'Stage Actions' },
    body: 'Smart Triggers automatically move pipeline cards when specific events happen in DarkLion — like a client submitting their organizer or signing a return.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Pipelines</span><span class="sep">›</span>
  <span>Smart Triggers</span>
</div>
<h1 class="article-title">Smart Triggers</h1>
<div class="article-meta">Section: Pipelines</div>
<div class="article-body">

<p>Smart Triggers connect real events in DarkLion to your pipeline. When something happens — a client submits their organizer, signs a return, or uploads financials — DarkLion can automatically move their card to the right stage.</p>

<h2>Available Triggers</h2>

<h3>Tax</h3>
<ul>
  <li><strong>organizer_submitted</strong> — Client completes and submits their tax organizer</li>
  <li><strong>return_delivered</strong> — Staff delivers the completed tax return to the client</li>
  <li><strong>return_signed</strong> — Client signs their return (8879 or similar)</li>
  <li><strong>tax_financials_generated</strong> — Advisor generates a tax financials PDF from QuickBooks</li>
  <li><strong>client_financials_submitted</strong> — Client uploads or submits their financials from the portal</li>
</ul>

<h3>Engagement</h3>
<ul>
  <li><strong>engagement_letter_uploaded</strong> — Staff uploads a signed engagement letter</li>
  <li><strong>engagement_letter_signed</strong> — Client signs the engagement letter</li>
</ul>

<h3>Portal</h3>
<ul>
  <li><strong>portal_activated</strong> — Client accepts their portal invite and logs in for the first time</li>
  <li><strong>portal_message_received</strong> — Client sends a message through the portal</li>
</ul>

<h3>Proposals</h3>
<ul>
  <li><strong>proposal_sent</strong> — Staff sends a proposal to a client</li>
  <li><strong>proposal_signed</strong> — Client signs the proposal</li>
</ul>

<h2>Setting Up a Trigger</h2>
<ol class="step-list">
  <li>Go to <strong>Pipelines</strong> and open a pipeline.</li>
  <li>Click <strong>⚙️ Settings</strong> in the board header.</li>
  <li>Find the stage you want the trigger to move cards <em>to</em>.</li>
  <li>Click <strong>+ Add Trigger</strong> on that stage's card.</li>
  <li>Select the trigger type from the dropdown.</li>
  <li>Save. The trigger is now active for this pipeline.</li>
</ol>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Triggers are entity-type aware. A trigger on a Company pipeline will only fire for company events, not person events. This prevents cross-contamination between pipelines.</div></div>

<h2>Manual Trigger (Fire Trigger Button)</h2>
<p>You can also fire a trigger manually from the client's CRM page. On the Person or Company detail page → <strong>Workflow tab</strong> → click <strong>⚡ Fire Trigger</strong> → select the trigger type. Useful for testing or handling edge cases.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>Each stage can have up to 2 triggers. If a card doesn't exist yet when a trigger fires, DarkLion will automatically create one in the target stage — you don't have to add clients to a pipeline before triggering.</div></div>

</div>
    `
  },

  // ─── CLIENT PORTAL ──────────────────────────────────────────────────────────

  {
    slug: 'portal-overview',
    title: 'Client Portal Overview',
    section: 'Client Portal',
    keywords: ['portal', 'client login', 'client access', 'what clients see', 'secure'],
    prev: null,
    next: { slug: 'inviting-clients', title: 'Inviting Clients' },
    body: 'The client portal gives each client a secure login to view documents, communicate with your firm, upload financials, and sign returns.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Client Portal</span><span class="sep">›</span>
  <span>Portal Overview</span>
</div>
<h1 class="article-title">Client Portal Overview</h1>
<div class="article-meta">Section: Client Portal</div>
<div class="article-body">

<p>Every client in DarkLion gets their own secure portal — a private web app where they can interact with your firm without email. The portal is the client-facing side of DarkLion.</p>

<h2>What Clients Can Do</h2>
<ul>
  <li><strong>View & Download Documents</strong> — See all documents your firm has delivered to them, organized by year and category. New documents are highlighted with a ✦ NEW badge.</li>
  <li><strong>Send & Receive Messages</strong> — Secure messaging with your firm. No email required for sensitive communication.</li>
  <li><strong>Upload Documents</strong> — Clients can upload files directly to their own record (tax returns, W-2s, statements, etc.).</li>
  <li><strong>Submit Financials</strong> — For business clients, they can connect QuickBooks or upload P&L and Balance Sheet PDFs directly to their advisor.</li>
  <li><strong>Tax Organizer</strong> — Complete a personalized checklist of documents to upload for tax prep.</li>
  <li><strong>Sign Returns</strong> — E-sign tax returns and engagement letters from within the portal.</li>
</ul>

<h2>Portal Structure</h2>
<p>The portal is organized around tabs:</p>
<ul>
  <li><strong>Overview</strong> — Summary of their account, recent activity, any items requiring attention</li>
  <li><strong>Personal Documents</strong> — Documents attached to them as an individual</li>
  <li><strong>Organizers</strong> — Their tax organizer checklists</li>
  <li><strong>Messages</strong> — Secure chat with your firm</li>
  <li><strong>Business Tabs</strong> — One tab per Company they have access to (documents, bookkeeping, financials)</li>
</ul>

<h2>Portal URL</h2>
<p>The portal lives at <strong>darklion.ai/client-login</strong> (or your custom domain if configured). Each client logs in with the email address you have on file for them.</p>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Staff and client logins are completely separate. A client cannot access any staff screens, and staff tokens don't work on the client portal. There is no overlap.</div></div>

</div>
    `
  },

  {
    slug: 'inviting-clients',
    title: 'Inviting Clients to the Portal',
    section: 'Client Portal',
    keywords: ['invite', 'portal invite', 'send invite', 'client login', 'activate portal', 'email invite'],
    prev: { slug: 'portal-overview', title: 'Portal Overview' },
    next: { slug: 'what-clients-see', title: 'What Clients See' },
    body: 'How to send a portal invitation to a client so they can set their password and log in.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Client Portal</span><span class="sep">›</span>
  <span>Inviting Clients</span>
</div>
<h1 class="article-title">Inviting Clients to the Portal</h1>
<div class="article-meta">Section: Client Portal</div>
<div class="article-body">

<p>Before a client can log into their portal, you need to send them an invitation. The invite email contains a link for them to set their password and activate their account.</p>

<h2>How to Send an Invite</h2>
<ol class="step-list">
  <li>Go to <strong>CRM → People</strong> and click the client's name.</li>
  <li>On the <strong>Overview</strong> tab, find the <strong>Portal Access</strong> section.</li>
  <li>Click <strong>Send Portal Invite</strong>.</li>
  <li>The client receives an email with a link to set their password. The link expires after 7 days.</li>
</ol>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Make sure the client's email address is correct before sending the invite. The invite goes to whatever email is on their Person record.</div></div>

<h2>What the Client Receives</h2>
<p>The invitation email contains:</p>
<ul>
  <li>Your firm's name and branding</li>
  <li>A link to set their password (valid for 7 days)</li>
  <li>The URL to log in going forward</li>
</ul>
<p>No sensitive data is included in the email — the content simply directs them to log in securely.</p>

<h2>Re-Sending an Invite</h2>
<p>If a client didn't receive the invite or the link expired, just click <strong>Send Portal Invite</strong> again. A new link is generated and the old one is invalidated.</p>

<h2>Resetting a Client's Password</h2>
<p>If a client is locked out, they can use the <strong>Forgot Password</strong> link on the portal login page to reset their own password. Or you can send them a fresh invite from their Person record.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>You don't have to invite every client right away. Many firms use DarkLion internally for a while before rolling out the portal to clients. Invite them when you're ready to start sharing documents.</div></div>

</div>
    `
  },

  // ─── DOCUMENTS ──────────────────────────────────────────────────────────────

  {
    slug: 'documents-overview',
    title: 'Documents Overview',
    section: 'Documents',
    keywords: ['documents', 'files', 'upload', 'download', 'S3', 'storage', 'folders', 'organize'],
    prev: null,
    next: { slug: 'uploading-documents', title: 'Uploading Documents' },
    body: 'DarkLion stores all client documents securely in AWS S3. Documents are organized by owner, year, and category. Clients see only what you choose to deliver to them.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Documents</span><span class="sep">›</span>
  <span>Documents Overview</span>
</div>
<h1 class="article-title">Documents Overview</h1>
<div class="article-meta">Section: Documents</div>
<div class="article-body">

<p>DarkLion stores all client documents securely in AWS S3. Every document is organized by who owns it, what year it belongs to, and what category it falls under. Clients only see documents that have been delivered to them — everything else is private to your firm.</p>

<h2>Document Ownership</h2>
<p>Every document in DarkLion belongs to either a <strong>Person</strong> or a <strong>Company</strong>. This determines which tab it appears on in the CRM and in the client portal.</p>
<ul>
  <li><strong>Person documents</strong> — Personal tax returns, W-2s, 1099s, individual documents</li>
  <li><strong>Company documents</strong> — Business tax returns, financial statements, bookkeeping docs</li>
</ul>

<h2>Folder Structure</h2>
<p>Within each owner, documents are organized by:</p>
<ul>
  <li><strong>Section:</strong> <code>Delivered by Advisor</code> (firm uploaded) or <code>Uploaded by Client</code> (client uploaded)</li>
  <li><strong>Year:</strong> Tax year the document belongs to (e.g., 2025, 2024)</li>
  <li><strong>Category:</strong> Tax, Bookkeeping, or Other</li>
</ul>

<h2>Security</h2>
<p>Documents are never served directly from S3. Every download generates a short-lived signed URL that expires after 15 minutes. This means:</p>
<ul>
  <li>You cannot share a document link with someone and have it work indefinitely</li>
  <li>Documents are fully protected even if someone guesses the URL</li>
  <li>All downloads are logged in the audit trail</li>
</ul>

<div class="callout tip"><span class="callout-icon">💡</span><div>There is also a firm-level <strong>Documents</strong> page (in the sidebar) that shows all documents across all clients in one view — useful for bulk management or finding something quickly.</div></div>

</div>
    `
  },

  // ─── MESSAGING ──────────────────────────────────────────────────────────────

  {
    slug: 'messaging-overview',
    title: 'Messaging Overview',
    section: 'Messaging',
    keywords: ['messages', 'inbox', 'threads', 'communication', 'portal chat', 'secure messaging'],
    prev: null,
    next: { slug: 'staff-inbox', title: 'Staff Inbox' },
    body: 'DarkLion messaging replaces email for client communication. Clients message you through the portal; staff reply from the shared team inbox. All conversations are tracked per client.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Messaging</span><span class="sep">›</span>
  <span>Messaging Overview</span>
</div>
<h1 class="article-title">Messaging Overview</h1>
<div class="article-meta">Section: Messaging</div>
<div class="article-body">

<p>DarkLion has a built-in secure messaging system that replaces email for day-to-day client communication. Messages are sent and received inside the platform — nothing sensitive touches an external inbox.</p>

<h2>How It Works</h2>
<ul>
  <li><strong>Clients</strong> send messages from their portal. They see a chat-style interface.</li>
  <li><strong>Staff</strong> see all client messages in the shared <strong>Messages</strong> inbox. Threads from all clients come in here.</li>
  <li>When a client sends a message, the thread flips to <strong>Open</strong> status and appears at the top of the staff inbox.</li>
  <li>When staff reply, the thread flips to <strong>Waiting</strong> (waiting for client response).</li>
  <li>When the conversation is done, staff mark it <strong>Resolved</strong> and it moves off the active inbox.</li>
</ul>

<h2>Thread Statuses</h2>
<ul>
  <li><strong>Open</strong> — Client sent a message; needs staff attention</li>
  <li><strong>Waiting</strong> — Staff replied; waiting for client</li>
  <li><strong>Resolved</strong> — Conversation complete; archived from inbox</li>
</ul>

<h2>Internal Notes</h2>
<p>Staff can add <strong>internal notes</strong> to any thread — visible only to staff, never to the client. Useful for leaving context for teammates.</p>

<h2>Client Notifications</h2>
<p>When staff send a message, the client gets an email notification: <em>"You have a new message from Sentinel Wealth & Tax — log in to view it."</em> The message content is never in the email itself.</p>

<div class="callout info"><span class="callout-icon">ℹ️</span><div>Every message thread is also visible on the Person's or Company's <strong>Communication tab</strong> in the CRM. Staff don't have to go to the Messages inbox to reply — they can reply directly from the client's record.</div></div>

</div>
    `
  },

  // ─── VIKTOR AI ──────────────────────────────────────────────────────────────

  {
    slug: 'viktor-ai',
    title: 'Viktor AI',
    section: 'Viktor AI',
    keywords: ['viktor', 'AI', 'agent', 'assistant', 'ask', 'intelligence', 'briefing'],
    prev: null,
    next: null,
    body: 'Viktor is DarkLion\'s built-in AI agent. Ask Viktor about clients, pipelines, open tasks, revenue, or anything else about the firm. Viktor has full read and write access to all firm data.',
    html: `
<div class="article-breadcrumb">
  <a href="/help">Help</a><span class="sep">›</span>
  <span>Viktor AI</span>
</div>
<h1 class="article-title">Viktor AI</h1>
<div class="article-meta">Section: Viktor AI</div>
<div class="article-body">

<p>Viktor is DarkLion's built-in AI agent — an intelligent assistant that has full access to your firm's data. Viktor lives in the right panel of the Dashboard and can answer questions, take actions, and surface insights you might otherwise miss.</p>

<h2>What Viktor Can Do</h2>
<ul>
  <li><strong>Answer questions about clients</strong> — "What's the status of the Ragain family's return?" or "Which clients haven't signed their 8879 yet?"</li>
  <li><strong>Pipeline intelligence</strong> — "How many cards are stuck in the same stage for more than 2 weeks?" or "What's our completion rate this year vs. last?"</li>
  <li><strong>Firm overview</strong> — Viktor generates a morning briefing every day at 4 AM with a summary of open items, pipeline health, and anything that needs attention.</li>
  <li><strong>CRM actions</strong> — Viktor can create and update client records, move pipeline cards, and send portal messages — all through natural language.</li>
  <li><strong>Communication drafting</strong> — Ask Viktor to draft a client message and you can review it before sending.</li>
</ul>

<h2>How Viktor Fits In</h2>
<p>Viktor uses the exact same API that you use when you click buttons in DarkLion. There's no separate "AI mode" — Viktor is just another user of the system with an <code>agent</code> role. Every action Viktor takes is logged in the audit trail with <code>role=agent</code> so you can always see what it did.</p>

<h2>Morning Briefings</h2>
<p>Every morning at 4 AM, Viktor pre-generates a briefing for each staff member. When you open the Dashboard, you'll see Viktor's summary waiting for you — covering open threads, pipeline stalls, upcoming deadlines, and anything unusual. This is generated fresh each day from live firm data.</p>

<div class="callout tip"><span class="callout-icon">💡</span><div>The best way to use Viktor is to ask it questions you'd otherwise have to manually compile — like "give me a list of every client whose return has been in the same stage for more than 3 weeks." Viktor can do that in seconds.</div></div>

<h2>What Viktor Cannot Do</h2>
<ul>
  <li>Viktor cannot make decisions on your behalf without you seeing them first — it always shows you what it's about to do and waits for confirmation on sensitive actions.</li>
  <li>Viktor cannot access anything outside DarkLion — it only knows what's in your firm's data.</li>
</ul>

</div>
    `
  },

];

/**
 * Build the search index — lightweight version of each article for client-side search.
 */
const searchIndex = articles.map(a => ({
  slug: a.slug,
  title: a.title,
  section: a.section,
  keywords: a.keywords || [],
  body: a.body || '',
}));

/**
 * Home page module cards
 */
const homeModules = [
  { icon: '🚀', title: 'Getting Started', desc: 'New to DarkLion? Start here.', href: '/help/article/what-is-darklion' },
  { icon: '🗂️', title: 'CRM', desc: 'Manage relationships, people, and companies.', href: '/help/article/crm-overview' },
  { icon: '📁', title: 'Documents', desc: 'Upload, organize, and deliver files to clients.', href: '/help/article/documents-overview' },
  { icon: '🔐', title: 'Client Portal', desc: 'Invite clients and manage their experience.', href: '/help/article/portal-overview' },
  { icon: '📋', title: 'Pipelines', desc: 'Track client workflows with kanban boards.', href: '/help/article/pipelines-overview' },
  { icon: '💬', title: 'Messaging', desc: 'Secure client communication inside DarkLion.', href: '/help/article/messaging-overview' },
  { icon: '🧾', title: 'Tax Organizer', desc: 'Collect client documents with smart checklists.', href: '/help/article/organizer-overview' },
  { icon: '🤖', title: 'Viktor AI', desc: 'Your AI agent with full firm intelligence.', href: '/help/article/viktor-ai' },
];

module.exports = { articles, searchIndex, homeModules };
