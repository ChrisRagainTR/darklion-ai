/**
 * Quick fix for 9 missing screenshots
 */
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const BASE_URL = 'https://darklion-ai-development.up.railway.app';
const JWT_SECRET = 'k9Xm2vQpL7nR4wYtBsEuJcFhGdAzN8oWiKqT3eMjP6yDlCbOxVHrUfSgZ5I1Ma';
const OUTPUT_DIR = path.join(__dirname, '../public/images/help');

const SPECS = [
  { slug: 'client-financials', url: '/crm?tab=companies', nav: async (p) => { const r = p.locator('tbody tr').nth(1); await r.click().catch(()=>{}); await p.waitForTimeout(1200); } },
  { slug: 'creating-pipelines', url: '/pipelines', nav: null },
  { slug: 'internal-notes', url: '/messages', nav: async (p) => { const r = p.locator('tbody tr').first(); await r.click().catch(()=>{}); await p.waitForTimeout(1200); } },
  { slug: 'organizer-overview', url: '/crm?tab=people', nav: async (p) => { const r = p.locator('tbody tr').first(); await r.click().catch(()=>{}); await p.waitForTimeout(1200); } },
  { slug: 'pipeline-cards', url: '/pipelines', nav: async (p) => { const link = p.locator('.pipe-link, a[href*="/pipelines/"]').nth(1); if (await link.count() > 0) { await link.click().catch(()=>{}); await p.waitForTimeout(1500); } } },
  { slug: 'reviewing-submissions', url: '/crm?tab=people', nav: async (p) => { const r = p.locator('tbody tr').first(); await r.click().catch(()=>{}); await p.waitForTimeout(1200); } },
  { slug: 'sending-messages', url: '/messages', nav: null },
  { slug: 'sending-organizer', url: '/crm?tab=people', nav: async (p) => { const r = p.locator('tbody tr').first(); await r.click().catch(()=>{}); await p.waitForTimeout(1200); } },
  { slug: 'smart-triggers', url: '/pipelines', nav: async (p) => { const gear = p.locator('a[href*="/settings"], button:has-text("Settings")').first(); if (await gear.count() > 0) { await gear.click().catch(()=>{}); await p.waitForTimeout(1500); } } },
  { slug: 'stage-actions', url: '/pipelines', nav: async (p) => { const gear = p.locator('a[href*="/settings"], button:has-text("Settings")').first(); if (await gear.count() > 0) { await gear.click().catch(()=>{}); await p.waitForTimeout(1500); } } },
  { slug: 'staff-inbox', url: '/messages', nav: null },
  { slug: 'viktor-ai', url: '/dashboard', nav: null },
];

async function main() {
  console.log('🔧 Fixing 9 missing screenshots...\n');

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, storageState });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});

  // Verify auth
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle', timeout: 20000 });
  const url = page.url();
  if (url.includes('login')) {
    console.error('❌ Auth failed');
    await browser.close();
    process.exit(1);
  }

  for (const spec of SPECS) {
    process.stdout.write(`  ${spec.slug}... `);
    try {
      await page.goto(`${BASE_URL}${spec.url}`, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
      await page.waitForTimeout(1200);
      if (spec.nav) await spec.nav(page);
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUTPUT_DIR, `${spec.slug}.png`), fullPage: false, type: 'png' });
      console.log('✅');
    } catch (e) {
      console.log(`❌ ${e.message.split('\n')[0]}`);
    }
  }

  await browser.close();
  console.log('\n✅ Done');
}

main().catch(e => { console.error(e); process.exit(1); });
