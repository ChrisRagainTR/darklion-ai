// tests/global-setup.cjs
// Playwright global setup: runs once before the entire test suite.
// Gets a JWT via the API (faster, no rate-limit issues) and saves
// the storageState to disk so all tests can reuse it.

'use strict';

const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'https://darklion-ai-development.up.railway.app';
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const AUTH_STATE_PATH = 'tests/.auth/user.json';

module.exports = async function globalSetup() {
  const authDir = path.dirname(path.resolve(AUTH_STATE_PATH));
  fs.mkdirSync(authDir, { recursive: true });

  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.warn(
      '\n⚠️  [global-setup] TEST_EMAIL or TEST_PASSWORD is not set.\n' +
      '   Tests that require authentication will fail.\n' +
      '   Set them as environment variables before running:\n' +
      '     TEST_EMAIL=... TEST_PASSWORD=... npx playwright test\n'
    );
    if (!fs.existsSync(path.resolve(AUTH_STATE_PATH))) {
      fs.writeFileSync(path.resolve(AUTH_STATE_PATH), JSON.stringify({ cookies: [], origins: [] }));
    }
    return;
  }

  // If existing auth state has a token, reuse it (avoid hammering login endpoint)
  const existingState = fs.existsSync(path.resolve(AUTH_STATE_PATH))
    ? JSON.parse(fs.readFileSync(path.resolve(AUTH_STATE_PATH), 'utf8'))
    : null;
  const existingToken = existingState?.origins?.[0]?.localStorage?.find(e => e.name === 'dl_token')?.value;
  if (existingToken) {
    console.log('✅ [global-setup] Reusing existing auth token');
    return;
  }

  console.log(`\n🔐 [global-setup] Logging in as ${TEST_EMAIL} …`);

  // Use the API directly — avoids browser rate-limit issues and is faster
  try {
    const res = await fetch(`${BASE_URL}/firms/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });

    const data = await res.json();

    if (!res.ok || !data.token) {
      console.error('[global-setup] API login failed:', data.error || JSON.stringify(data));
      // Don't overwrite existing state if login fails
      if (!fs.existsSync(path.resolve(AUTH_STATE_PATH))) {
        fs.writeFileSync(path.resolve(AUTH_STATE_PATH), JSON.stringify({ cookies: [], origins: [] }));
      }
      return;
    }

    console.log('✅ [global-setup] Login successful — token acquired');

    // Build storageState with the token in localStorage
    const storageState = {
      cookies: [],
      origins: [
        {
          origin: BASE_URL,
          localStorage: [
            { name: 'dl_token', value: data.token },
            { name: 'dl_firm', value: JSON.stringify(data.firm || {}) },
          ],
        },
      ],
    };

    fs.writeFileSync(path.resolve(AUTH_STATE_PATH), JSON.stringify(storageState, null, 2));
    console.log(`📁 [global-setup] Auth state saved to ${AUTH_STATE_PATH}\n`);
  } catch (err) {
    console.error('[global-setup] Login failed:', err.message);
    fs.writeFileSync(path.resolve(AUTH_STATE_PATH), JSON.stringify({ cookies: [], origins: [] }));
  }
};
