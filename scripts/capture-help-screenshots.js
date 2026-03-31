'use strict';

/**
 * capture-help-screenshots.js
 * 
 * Logs in to DarkLion dev as the test user and captures screenshots
 * for each help article section. Saves to public/images/help/.
 * 
 * Usage: node scripts/capture-help-screenshots.js
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://darklion-ai-development.up.railway.app';
const EMAIL = 'test@darklion.ai';
const PASSWORD = 'DarkLion2026!';
const OUT_DIR = path.join(__dirname, '../public/images/help');

// Ensure output directory exists
fs.mkdirSync(OUT_DIR, { recursive: true });

const pages = [
  // Dashboard / Getting Started
  { file: 'dashboard.png',            url: '/dashboard',              waitFor: '.shell-content, main, #main-content' },
  
  // CRM
  { file: 'crm-overview.png',         url: '/crm',                    waitFor: '.crm-container, table, .client-list' },
  { file: 'crm-relationships.png',    url: '/relationships',          waitFor: 'table, .relationships-list, h1' },
  { file: 'crm-people.png',           url: '/people',                 waitFor: 'table, .people-list, h1' },
  { file: 'crm-companies.png',        url: '/companies',              waitFor: 'table, .companies-list, h1' },

  // Documents
  { file: 'documents.png',            url: '/documents',              waitFor: 'table, .documents-list, h1' },

  // Pipelines
  { file: 'pipelines.png',            url: '/pipelines',              waitFor: '.pipeline-board, .kanban, h1' },
  { file: 'pipeline-settings.png',    url: '/pipeline-settings',      waitFor: 'h1, form, .settings-container' },

  // Messaging
  { file: 'messages.png',             url: '/messages',               waitFor: '.inbox, .messages-list, h1' },

  // Proposals
  { file: 'proposals.png',            url: '/proposals',              waitFor: 'table, .proposals-list, h1' },

  // Bulk Send
  { file: 'bulk-send.png',            url: '/bulk-send',              waitFor: 'h1, form, .bulk-send-container' },

  // Settings
  { file: 'settings.png',             url: '/settings',               waitFor: 'h1, form, .settings-container' },
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  console.log('→ Logging in...');
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('networkidle');

  // Fill login form
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await page.click('button[type="submit"], input[type="submit"], .login-btn, button:has-text("Sign In"), button:has-text("Log In")');
  
  // Wait for redirect after login
  await page.waitForURL(/(?!.*\/login)/, { timeout: 15000 });
  console.log('✓ Logged in. Current URL:', page.url());

  // Small pause to let JS settle
  await page.waitForTimeout(1500);

  for (const { file, url, waitFor } of pages) {
    try {
      console.log(`→ Capturing ${file} (${url})...`);
      await page.goto(`${BASE_URL}${url}`, { waitUntil: 'networkidle', timeout: 20000 });
      
      // Wait for the main content to appear
      try {
        await page.waitForSelector(waitFor, { timeout: 8000 });
      } catch (_) {
        // If selector doesn't match, just wait a bit
        await page.waitForTimeout(2000);
      }

      // Extra settle time
      await page.waitForTimeout(800);

      const outPath = path.join(OUT_DIR, file);
      await page.screenshot({ path: outPath, fullPage: false });
      console.log(`  ✓ Saved: ${outPath}`);
    } catch (err) {
      console.error(`  ✗ Failed ${file}: ${err.message}`);
    }
  }

  await browser.close();
  console.log('\n✅ All done. Screenshots saved to public/images/help/');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
