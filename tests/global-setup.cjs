// tests/global-setup.cjs
// Playwright global setup: runs once before the entire test suite.
// Performs a real browser login and saves the storageState to disk so
// all individual test files can reuse it without logging in again.

'use strict';

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'https://darklion-ai-development.up.railway.app';
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const AUTH_STATE_PATH = 'tests/.auth/user.json';

module.exports = async function globalSetup() {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.warn(
      '\n⚠️  [global-setup] TEST_EMAIL or TEST_PASSWORD is not set.\n' +
      '   Tests that require authentication will fail.\n' +
      '   Set them as environment variables before running:\n' +
      '     TEST_EMAIL=... TEST_PASSWORD=... npx playwright test\n'
    );
    // Write an empty auth state so tests can at least import it
    const authDir = path.dirname(path.resolve(AUTH_STATE_PATH));
    fs.mkdirSync(authDir, { recursive: true });
    if (!fs.existsSync(path.resolve(AUTH_STATE_PATH))) {
      fs.writeFileSync(
        path.resolve(AUTH_STATE_PATH),
        JSON.stringify({ cookies: [], origins: [] })
      );
    }
    return;
  }

  console.log(`\n🔐 [global-setup] Logging in as ${TEST_EMAIL} …`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Fill credentials — the login form can use various selectors
    await page.fill(
      'input[type="email"], input[name="email"], #email',
      TEST_EMAIL
    );
    await page.fill(
      'input[type="password"], input[name="password"], #password',
      TEST_PASSWORD
    );

    // Submit and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
      page.click('button[type="submit"], .btn-gold, button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")'),
    ]);

    // DarkLion stores the JWT as dl_token in localStorage
    await page.waitForFunction(
      () => !!localStorage.getItem('dl_token'),
      { timeout: 20_000 }
    ).catch(() => {
      console.warn('[global-setup] dl_token not found after login — auth may have failed');
    });

    const token = await page.evaluate(() => localStorage.getItem('dl_token'));
    if (token) {
      console.log('✅ [global-setup] Login successful — token acquired');
    } else {
      console.warn('⚠️  [global-setup] No token found after login — check credentials');
    }

    // Persist cookies + localStorage to disk
    const authDir = path.dirname(path.resolve(AUTH_STATE_PATH));
    fs.mkdirSync(authDir, { recursive: true });
    await context.storageState({ path: AUTH_STATE_PATH });

    console.log(`📁 [global-setup] Auth state saved to ${AUTH_STATE_PATH}\n`);
  } catch (err) {
    console.error('[global-setup] Login failed:', err.message);
    // Write empty state so tests can still run (auth-required tests will fail gracefully)
    const authDir = path.dirname(path.resolve(AUTH_STATE_PATH));
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.resolve(AUTH_STATE_PATH),
      JSON.stringify({ cookies: [], origins: [] })
    );
  } finally {
    await browser.close();
  }
};
