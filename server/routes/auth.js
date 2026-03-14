const { Router } = require('express');
const db = require('../db');

const router = Router();

// Exchange authorization code for tokens
router.get('/callback', async (req, res) => {
  const { code, realmId } = req.query;

  if (!code || !realmId) {
    return res.status(400).json({ error: 'Missing code or realmId' });
  }

  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri = process.env.QB_REDIRECT_URI;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Token exchange failed:', errBody);
      return res.status(502).json({ error: 'Token exchange failed' });
    }

    const tokens = await tokenRes.json();
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    // Fetch company info
    let companyName = '';
    try {
      const companyRes = await fetch(
        `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`,
        { headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' } }
      );
      if (companyRes.ok) {
        const companyData = await companyRes.json();
        companyName = companyData.CompanyInfo?.CompanyName || '';
      }
    } catch (e) {
      // Non-fatal — we just won't have the name
    }

    // Upsert company
    db.prepare(`
      INSERT INTO companies (realm_id, company_name, access_token, refresh_token, token_expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(realm_id) DO UPDATE SET
        company_name = excluded.company_name,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expires_at = excluded.token_expires_at,
        connected_at = datetime('now')
    `).run(realmId, companyName, tokens.access_token, tokens.refresh_token, expiresAt);

    res.json({ ok: true, company: companyName || realmId });
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Refresh tokens for a company
async function refreshTokens(realmId) {
  const company = db.prepare('SELECT * FROM companies WHERE realm_id = ?').get(realmId);
  if (!company) throw new Error(`Company ${realmId} not found`);

  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;

  const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: company.refresh_token,
    }),
  });

  if (!tokenRes.ok) throw new Error('Token refresh failed');

  const tokens = await tokenRes.json();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  db.prepare(`
    UPDATE companies SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE realm_id = ?
  `).run(tokens.access_token, tokens.refresh_token, expiresAt, realmId);

  return tokens.access_token;
}

// Get a valid access token, refreshing if needed
async function getAccessToken(realmId) {
  const company = db.prepare('SELECT * FROM companies WHERE realm_id = ?').get(realmId);
  if (!company) throw new Error(`Company ${realmId} not found`);

  // Refresh if token expires within 5 minutes
  if (Date.now() > company.token_expires_at - 300000) {
    return refreshTokens(realmId);
  }

  return company.access_token;
}

router.refreshTokens = refreshTokens;
router.getAccessToken = getAccessToken;

module.exports = router;
