// tests/global-setup.cjs
// Playwright global setup: runs once before the entire test suite.
// Generates a JWT directly using JWT_SECRET — no login endpoint call,
// no rate-limit exposure, always produces a valid token.

'use strict';

const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const BASE_URL = process.env.BASE_URL || 'https://darklion-ai-development.up.railway.app';
const TEST_EMAIL = process.env.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || 'k9Xm2vQpL7nR4wYtBsEuJcFhGdAzN8oWiKqT3eMjP6yDlCbOxVHrUfSgZ5I1Ma';
const AUTH_STATE_PATH = 'tests/.auth/user.json';

// Known payload for the test@darklion.ai account (firm_id=1, id=1402)
const TEST_TOKEN_PAYLOAD = {
  firmId: 1,
  userId: 1402,
  role: 'staff',
  email: 'test@darklion.ai',
  name: '',
  firmName: 'Sentinel Wealth & Tax',
};

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

  // Check if an existing valid token can be reused (saves a tiny bit of time)
  const authStatePath = path.resolve(AUTH_STATE_PATH);
  if (fs.existsSync(authStatePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
      const existingToken = saved.origins?.[0]?.localStorage?.find(e => e.name === 'dl_token')?.value;
      if (existingToken) {
        const payload = JSON.parse(Buffer.from(existingToken.split('.')[1], 'base64').toString());
        const expiresIn = payload.exp - Math.floor(Date.now() / 1000);
        if (expiresIn > 300) {
          console.log(`\n✅ [global-setup] Valid token found (expires in ${Math.round(expiresIn / 3600)}h) — skipping re-gen\n`);
          return;
        }
        console.log(`\n⏳ [global-setup] Token expired or expiring soon — generating fresh token\n`);
      }
    } catch {
      // Malformed auth file — fall through to fresh token gen
    }
  }

  console.log(`\n🔑 [global-setup] Generating JWT directly for ${TEST_EMAIL} (no login endpoint) …`);

  try {
    // Sign directly — bypasses the rate-limited /firms/login endpoint entirely
    const token = jwt.sign(TEST_TOKEN_PAYLOAD, JWT_SECRET, { expiresIn: '24h' });

    const storageState = {
      cookies: [],
      origins: [
        {
          origin: BASE_URL,
          localStorage: [
            { name: 'dl_token', value: token },
            { name: 'dl_firm', value: JSON.stringify({ name: 'Sentinel Wealth & Tax' }) },
          ],
        },
      ],
    };

    fs.writeFileSync(authStatePath, JSON.stringify(storageState, null, 2));
    console.log(`✅ [global-setup] Token generated and saved to ${AUTH_STATE_PATH}\n`);
  } catch (err) {
    console.error('[global-setup] Token generation failed:', err.message);
    fs.writeFileSync(authStatePath, JSON.stringify({ cookies: [], origins: [] }));
  }
};
