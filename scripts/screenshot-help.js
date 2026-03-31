/**
 * DarkLion Help Center Screenshot Generator
 *
 * Captures annotated screenshots for all help articles.
 * Saves to public/images/help/<slug>.png
 *
 * Usage: node scripts/screenshot-help.js
 */

'use strict';

const { chromium } = require('playwright');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const BASE_URL = process.env.BASE_URL || 'https://darklion-ai-development.up.railway.app';
const JWT_SECRET = process.env.JWT_SECRET || 'k9Xm2vQpL7nR4wYtBsEuJcFhGdAzN8oWiKqT3eMjP6yDlCbOxVHrUfSgZ5I1Ma';
const OUTPUT_DIR = path.join(__dirname, '../public/images/help');
const VIEWPORT = { width: 1440, height: 900 };

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── ANNOTATION HELPERS ──────────────────────────────────────────────────────

function arrowSvg(x, y, direction = 'down', label = '', imgW = 1440, imgH = 900) {
  const len = 55;
  let x1, y1, x2, y2, lx, ly;
  switch (direction) {
    case 'right': x1 = x - len; y1 = y; x2 = x - 8; y2 = y; lx = x1 - 4; ly = y - 16; break;
    case 'left':  x1 = x + len; y1 = y; x2 = x + 8; y2 = y; lx = x1 + 4; ly = y - 16; break;
    case 'down':  x1 = x; y1 = y - len; x2 = x; y2 = y - 8; lx = x - 70; ly = y1 - 6; break;
    case 'up':    x1 = x; y1 = y + len; x2 = x; y2 = y + 8; lx = x - 70; ly = y1 + 20; break;
  }
  const bg = label ? `<text x="${lx}" y="${ly}" font-family="Segoe UI,sans-serif" font-size="13" font-weight="bold" fill="white" stroke="#b91c1c" stroke-width="4" paint-order="stroke">${label}</text>` : '';
  const fg = label ? `<text x="${lx}" y="${ly}" font-family="Segoe UI,sans-serif" font-size="13" font-weight="bold" fill="white">${label}</text>` : '';
  return `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="ah" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ef4444"/></marker></defs>
  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ef4444" stroke-width="3" marker-end="url(#ah)"/>
  ${bg}${fg}
</svg>`;
}

function highlightSvg(x, y, w, h, imgW = 1440, imgH = 900) {
  return `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" fill="none" stroke="#ef4444" stroke-width="3" rx="5"/>
</svg>`;
}

async function annotate(inputPath, overlays) {
  if (!overlays.length) return;
  const composites = overlays.map(svg => ({ input: Buffer.from(svg), top: 0, left: 0 }));
  const tmp = inputPath + '.tmp.png';
  await sharp(inputPath).composite(composites).toFile(tmp);
  fs.renameSync(tmp, inputPath);
}

// ─── SCREENSHOT SPECS ────────────────────────────────────────────────────────
// annotations: array of { selector, type: 'arrow'|'highlight', direction?, label? }

const SCREENSHOTS = [
  // ── GETTING STARTED ──
  {
    slug: 'key-concepts',
    url: '/crm',
    waitFor: '.crm-tabs, .tab-btn, [data-tab]',
    annotations: [],
  },
  {
    slug: 'first-client',
    url: '/crm',
    waitFor: '.crm-tabs, .entity-list, tbody',
    annotations: [
      { selector: 'button:has-text("New"), .btn-new, button[onclick*="new"]', type: 'arrow', direction: 'down', label: 'Click to add client' },
    ],
  },
  // ── CRM ──
  {
    slug: 'search',
    url: '/crm',
    waitFor: '.top-header',
    cropSelector: '.top-header',
    annotations: [
      { selector: '#search-input, input[type="search"], .search-input, input[placeholder*="search" i]', type: 'arrow', direction: 'down', label: 'Search any client' },
    ],
  },
  // ── DOCUMENTS ──
  {
    slug: 'uploading-documents',
    url: '/documents',
    waitFor: '.main, .doc-list, table',
    annotations: [
      { selector: 'button:has-text("Upload"), .upload-btn, label[for*="upload"]', type: 'arrow', direction: 'down', label: 'Upload files here' },
    ],
  },
  {
    slug: 'delivering-to-clients',
    url: '/documents',
    waitFor: '.main, table',
    annotations: [
      { selector: 'select[name*="owner"], button:has-text("Deliver"), .deliver-select, select', type: 'highlight', label: '' },
    ],
  },
  {
    slug: 'document-folders',
    url: '/documents',
    waitFor: '.main, .doc-list',
    annotations: [],
  },
  // ── CLIENT PORTAL ──
  {
    slug: 'portal-overview',
    url: '/crm?tab=people',
    waitFor: '.main',
    annotations: [],
  },
  {
    slug: 'inviting-clients',
    url: '/crm?tab=people',
    waitFor: '.main, .entity-list, tbody tr',
    navigate: async (page) => {
      // Click first person row to open detail
      const row = page.locator('tbody tr').first();
      if (await row.count() > 0) {
        await row.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    },
    annotations: [
      { selector: 'button:has-text("Invite"), .portal-invite-btn, button:has-text("Send Invite")', type: 'arrow', direction: 'right', label: 'Invite to portal' },
    ],
  },
  {
    slug: 'what-clients-see',
    url: '/crm?tab=people',
    waitFor: '.main, tbody tr',
    navigate: async (page) => {
      const row = page.locator('tbody tr').first();
      if (await row.count() > 0) {
        await row.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    },
    annotations: [
      { selector: 'button:has-text("View Portal"), .view-portal-btn', type: 'arrow', direction: 'right', label: 'Preview as client' },
    ],
  },
  {
    slug: 'client-financials',
    url: '/crm?tab=companies',
    waitFor: '.main, tbody tr',
    navigate: async (page) => {
      const row = page.locator('tbody tr').first();
      if (await row.count() > 0) {
        await row.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
        // Click Docs tab
        const docsTab = page.locator('[data-tab="documents"], button:has-text("Documents"), button:has-text("Docs")').first();
        if (await docsTab.count() > 0) await docsTab.click();
        await page.waitForTimeout(600);
      }
    },
    annotations: [
      { selector: 'button:has-text("Send to Tax Prep"), .tax-prep-btn', type: 'arrow', direction: 'down', label: 'Send financials to tax prep' },
    ],
  },
  // ── PIPELINES ──
  {
    slug: 'creating-pipelines',
    url: '/pipelines',
    waitFor: '.main, table, .pipeline-list',
    annotations: [
      { selector: 'button:has-text("New Pipeline"), button:has-text("+ New"), .new-pipeline', type: 'arrow', direction: 'down', label: 'Create a pipeline' },
    ],
  },
  {
    slug: 'pipeline-cards',
    url: '/pipelines',
    waitFor: '.main, table',
    navigate: async (page) => {
      // Open first pipeline (kanban board)
      const link = page.locator('.pipe-link, a[href*="/pipelines/"], table tbody tr td a').first();
      if (await link.count() > 0) {
        await link.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
    },
    annotations: [],
  },
  {
    slug: 'smart-triggers',
    url: '/pipelines',
    waitFor: '.main, table',
    navigate: async (page) => {
      // Find settings gear link
      const gear = page.locator('a[href*="/settings"], .settings-link, button:has-text("Settings")').first();
      if (await gear.count() > 0) {
        await gear.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    },
    annotations: [
      { selector: '.trigger-list, [data-section="triggers"], .triggers-section, h2:has-text("Trigger"), h3:has-text("Trigger")', type: 'highlight', label: '' },
    ],
  },
  {
    slug: 'stage-actions',
    url: '/pipelines',
    waitFor: '.main, table',
    navigate: async (page) => {
      const gear = page.locator('a[href*="/settings"], .settings-link, button:has-text("Settings")').first();
      if (await gear.count() > 0) {
        await gear.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    },
    annotations: [
      { selector: '.actions-list, [data-section="actions"], .stage-actions, h2:has-text("Action"), h3:has-text("Action")', type: 'highlight', label: '' },
    ],
  },
  // ── MESSAGING ──
  {
    slug: 'staff-inbox',
    url: '/messages',
    waitFor: '.main, .thread-list, .inbox',
    annotations: [],
  },
  {
    slug: 'sending-messages',
    url: '/messages',
    waitFor: '.main',
    annotations: [
      { selector: 'button:has-text("Compose"), button:has-text("New"), button:has-text("New Message"), .compose-btn', type: 'arrow', direction: 'down', label: 'Start a new message' },
    ],
  },
  {
    slug: 'internal-notes',
    url: '/messages',
    waitFor: '.main, .thread-list, tbody tr',
    navigate: async (page) => {
      const row = page.locator('tbody tr, .thread-item').first();
      if (await row.count() > 0) {
        await row.click();
        await page.waitForTimeout(1200);
      }
    },
    annotations: [
      { selector: '[data-type="internal"], input[type="checkbox"]:near(:text("Internal")), label:has-text("Internal"), .internal-toggle', type: 'arrow', direction: 'right', label: 'Internal note toggle' },
    ],
  },
  // ── TAX ORGANIZER ──
  {
    slug: 'organizer-overview',
    url: '/crm?tab=people',
    waitFor: '.main, tbody tr',
    navigate: async (page) => {
      const row = page.locator('tbody tr').first();
      if (await row.count() > 0) {
        await row.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
        // Click organizer/workflow tab
        const tab = page.locator('[data-tab="organizers"], [data-tab="workflow"], button:has-text("Organizer")').first();
        if (await tab.count() > 0) {
          await tab.click();
          await page.waitForTimeout(600);
        }
      }
    },
    annotations: [],
  },
  {
    slug: 'sending-organizer',
    url: '/crm?tab=people',
    waitFor: '.main, tbody tr',
    navigate: async (page) => {
      const row = page.locator('tbody tr').first();
      if (await row.count() > 0) {
        await row.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const tab = page.locator('[data-tab="organizers"], [data-tab="workflow"], button:has-text("Organizer")').first();
        if (await tab.count() > 0) {
          await tab.click();
          await page.waitForTimeout(600);
        }
      }
    },
    annotations: [
      { selector: 'button:has-text("Send Organizer"), button:has-text("New Organizer"), .send-organizer-btn', type: 'arrow', direction: 'down', label: 'Send organizer' },
    ],
  },
  {
    slug: 'reviewing-submissions',
    url: '/crm?tab=people',
    waitFor: '.main, tbody tr',
    navigate: async (page) => {
      const row = page.locator('tbody tr').first();
      if (await row.count() > 0) {
        await row.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const tab = page.locator('[data-tab="organizers"], button:has-text("Organizer")').first();
        if (await tab.count() > 0) {
          await tab.click();
          await page.waitForTimeout(600);
        }
      }
    },
    annotations: [],
  },
  // ── VIKTOR AI ──
  {
    slug: 'viktor-ai',
    url: '/dashboard',
    waitFor: '.main, .dashboard',
    annotations: [
      { selector: '.viktor-panel, .viktor-chat, .viktor-section, #viktor, [class*="viktor"]', type: 'arrow', direction: 'left', label: 'Viktor AI' },
    ],
  },
];

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`📸 DarkLion Help Screenshot Generator`);
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   Output:   ${OUTPUT_DIR}`);
  console.log(`   Articles: ${SCREENSHOTS.length}\n`);

  // Generate JWT matching DarkLion's expected payload (dl_token key)
  const token = jwt.sign(
    { firmId: 1, userId: 1402, role: 'owner', email: 'test@darklion.ai', name: 'Test User', firmName: 'Sentinel Wealth & Tax' },
    JWT_SECRET,
    { expiresIn: '2h' }
  );

  const storageState = {
    cookies: [],
    origins: [{
      origin: BASE_URL,
      localStorage: [
        { name: 'dl_token', value: token },
        { name: 'dl_firm', value: JSON.stringify({ name: 'Sentinel Wealth & Tax' }) },
      ],
    }],
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1.5,
    storageState,
  });

  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});

  // Verify auth works
  console.log('  🔑 Verifying auth...');
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 20000 });
  const title = await page.title();
  const url = page.url();
  if (url.includes('login')) {
    console.error(`  ❌ Auth failed — still on login page. Check JWT_SECRET.`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  ✅ Auth OK (${title})\n`);

  let passed = 0, failed = 0;

  for (const spec of SCREENSHOTS) {
    const outPath = path.join(OUTPUT_DIR, `${spec.slug}.png`);
    process.stdout.write(`  📷 ${spec.slug}... `);

    try {
      await page.goto(`${BASE_URL}${spec.url}`, { waitUntil: 'networkidle', timeout: 20000 });

      if (spec.waitFor) {
        await page.waitForSelector(spec.waitFor, { timeout: 6000 }).catch(() => {});
      }

      if (spec.navigate) {
        await spec.navigate(page).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      }

      await page.waitForTimeout(700);

      // Screenshot
      if (spec.cropSelector) {
        await page.locator(spec.cropSelector).first().screenshot({ path: outPath, type: 'png' }).catch(async () => {
          await page.screenshot({ path: outPath, fullPage: false, type: 'png' });
        });
      } else {
        await page.screenshot({ path: outPath, fullPage: false, type: 'png' });
      }

      // Annotations
      if (spec.annotations?.length > 0) {
        const imgMeta = await sharp(outPath).metadata();
        const W = imgMeta.width, H = imgMeta.height;
        const overlays = [];

        for (const ann of spec.annotations) {
          let box = null;
          // Try each selector variant (comma-separated)
          for (const sel of ann.selector.split(',').map(s => s.trim())) {
            try {
              const el = page.locator(sel).first();
              box = await el.boundingBox();
              if (box) break;
            } catch {}
          }
          if (!box) continue;

          const cx = Math.round(box.x + box.width / 2);
          const cy = Math.round(box.y + box.height / 2);

          if (ann.type === 'arrow') {
            // Arrow points to top-center of element
            overlays.push(arrowSvg(cx, Math.round(box.y), ann.direction || 'down', ann.label || '', W, H));
          } else if (ann.type === 'highlight') {
            overlays.push(highlightSvg(Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height), W, H));
          }
        }

        if (overlays.length) await annotate(outPath, overlays);
      }

      console.log(`✅`);
      passed++;
    } catch (err) {
      console.log(`❌ ${err.message.split('\n')[0]}`);
      failed++;
    }
  }

  await browser.close();

  console.log(`\n📊 ${passed} captured, ${failed} failed`);
  console.log(`   Files: ${OUTPUT_DIR}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
