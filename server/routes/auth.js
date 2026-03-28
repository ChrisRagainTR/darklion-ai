const { Router } = require('express');
const { pool } = require('../db');
const { requireFirm } = require('../middleware/requireFirm');

const router = Router();

// Exchange authorization code for tokens
router.get('/callback', async (req, res) => {
  const { code, realmId, state } = req.query;

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

    // Extract firm_id, company_id, and return origin from state
    // Format: "firmId:companyId:nonce:returnOrigin" (returnOrigin is URL-encoded)
    let firmId = null;
    let darklionCompanyId = null;
    let returnOrigin = null;
    if (state) {
      const decoded = decodeURIComponent(state);
      const parts = decoded.split(':');
      const parsed = parseInt(parts[0], 10);
      if (!isNaN(parsed) && parsed > 0) firmId = parsed;
      if (parts.length >= 3) {
        const cid = parseInt(parts[1], 10);
        if (!isNaN(cid) && cid > 0) darklionCompanyId = cid;
      }
      if (parts.length >= 4) {
        // returnOrigin may contain colons (https://...) — rejoin from index 3
        const rawOrigin = parts.slice(3).join(':');
        // Validate it's a real https origin we control
        if (/^https?:\/\/[a-zA-Z0-9._-]+/.test(rawOrigin)) {
          returnOrigin = rawOrigin;
        }
      }
    }

    // If we have a specific DarkLion company_id, update that record with the realm/tokens
    if (darklionCompanyId) {
      // Get current realm_id so we can clean up FK-referencing rows if it's changing
      const { rows: curRows } = await pool.query('SELECT realm_id FROM companies WHERE id = $1', [darklionCompanyId]);
      const oldRealmId = curRows[0]?.realm_id;

      if (oldRealmId && oldRealmId !== realmId) {
        // Old realm_id is changing — delete orphaned child rows that FK-reference it
        // These are all fake/empty if the old realm was a placeholder
        await pool.query('DELETE FROM scan_results WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM close_packages WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM category_rules WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM jobs WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM statement_schedules WHERE realm_id = $1', [oldRealmId]).catch(() => {});
        await pool.query('DELETE FROM employee_metadata WHERE realm_id = $1', [oldRealmId]).catch(() => {});
      }

      await pool.query(`
        UPDATE companies SET
          realm_id = $1, company_name = COALESCE(NULLIF($2,''), company_name),
          access_token = $3, refresh_token = $4, token_expires_at = $5,
          connected_at = NOW(), firm_id = COALESCE($6, firm_id)
        WHERE id = $7
      `, [realmId, companyName, tokens.access_token, tokens.refresh_token, expiresAt, firmId, darklionCompanyId]);
    } else {
      // No specific company — upsert by realm_id (new connection)
      await pool.query(`
        INSERT INTO companies (realm_id, company_name, access_token, refresh_token, token_expires_at, firm_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(realm_id) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          token_expires_at = EXCLUDED.token_expires_at,
          connected_at = NOW(),
          firm_id = COALESCE(EXCLUDED.firm_id, companies.firm_id)
      `, [realmId, companyName, tokens.access_token, tokens.refresh_token, expiresAt, firmId]);
    }

    // Audit log
    try {
      const { auditLog } = require('./firms');
      await auditLog(firmId, 'company_connect', `Connected: ${companyName || realmId} (realm: ${realmId})`, req.ip);
    } catch (e) { /* non-fatal */ }

    const appBase = returnOrigin || (process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : '');
    const isXHR = req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers['accept'] || '').includes('application/json') || req.headers['authorization'];

    if (isXHR) {
      // Called via fetch from callback.html — return JSON so it can show success UI
      return res.json({ ok: true, company: companyName || realmId, company_id: darklionCompanyId });
    }

    // Run initial scans in background (non-blocking)
    runInitialScans(realmId).catch(e => console.error('Initial scan error:', e));

    // Direct browser redirect from Intuit — redirect back to the origin they started from
    if (darklionCompanyId) {
      return res.redirect(`${appBase}/crm/company/${darklionCompanyId}?connected=1`);
    }
    return res.redirect(`${appBase}/crm?qbo=connected`);
  } catch (err) {
    console.error('OAuth callback error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// Refresh tokens for a company
async function refreshTokens(realmId) {
  const { rows } = await pool.query('SELECT * FROM companies WHERE realm_id = $1', [realmId]);
  const company = rows[0];
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

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => '');
    // Clear tokens so the company shows as disconnected and prompts reconnect
    await pool.query(
      "UPDATE companies SET access_token = '', refresh_token = '', token_expires_at = 0 WHERE realm_id = $1",
      [realmId]
    );
    throw new Error(`QBO token refresh failed (${tokenRes.status}): ${errBody}`);
  }

  const tokens = await tokenRes.json();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  await pool.query(
    'UPDATE companies SET access_token = $1, refresh_token = $2, token_expires_at = $3 WHERE realm_id = $4',
    [tokens.access_token, tokens.refresh_token, expiresAt, realmId]
  );

  return tokens.access_token;
}

// Refresh all QBO tokens for all connected companies — call nightly to keep tokens alive
async function refreshAllTokens() {
  const { rows } = await pool.query(
    "SELECT realm_id, company_name FROM companies WHERE refresh_token IS NOT NULL AND refresh_token != '' AND access_token != ''"
  );
  const results = { refreshed: 0, failed: 0, errors: [] };
  for (const c of rows) {
    try {
      await refreshTokens(c.realm_id);
      results.refreshed++;
      console.log(`[qbo-refresh] Refreshed: ${c.company_name || c.realm_id}`);
    } catch (e) {
      results.failed++;
      results.errors.push({ realm_id: c.realm_id, company: c.company_name, error: e.message });
      console.error(`[qbo-refresh] Failed: ${c.company_name || c.realm_id} — ${e.message}`);
    }
  }
  return results;
}

// Get a valid access token, refreshing if needed
async function getAccessToken(realmId) {
  const { rows } = await pool.query('SELECT * FROM companies WHERE realm_id = $1', [realmId]);
  const company = rows[0];
  if (!company) throw new Error(`Company ${realmId} not found`);

  // Refresh if token expires within 5 minutes
  if (Date.now() > Number(company.token_expires_at) - 300000) {
    return refreshTokens(realmId);
  }

  return company.access_token;
}

// Run scans immediately after a company connects
async function runInitialScans(realmId) {
  const { scanUncategorized } = require('../services/scanner');
  const { generateClosePackage } = require('../services/reports');
  const { scanVariance } = require('../services/variance');
  const { scanLiabilities } = require('../services/liability');

  console.log(`Running initial scans for ${realmId}...`);

  try {
    await scanUncategorized(realmId);
    console.log(`Uncategorized scan complete for ${realmId}`);
  } catch (e) {
    console.error(`Initial uncategorized scan failed for ${realmId}:`, e.message);
  }

  try {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await generateClosePackage(realmId, period);
    console.log(`Close package generated for ${realmId} (${period})`);
  } catch (e) {
    console.error(`Initial close package failed for ${realmId}:`, e.message);
  }

  try {
    await scanVariance(realmId);
    console.log(`Variance analysis complete for ${realmId}`);
  } catch (e) {
    console.error(`Initial variance scan failed for ${realmId}:`, e.message);
  }

  try {
    await scanLiabilities(realmId);
    console.log(`Liability check complete for ${realmId}`);
  } catch (e) {
    console.error(`Initial liability check failed for ${realmId}:`, e.message);
  }
}

// --- Gusto OAuth ---

// Exchange Gusto authorization code for tokens
router.get('/gusto/callback', async (req, res) => {
  const { code, realmId } = req.query;

  if (!code || !realmId) {
    return res.status(400).json({ error: 'Missing code or realmId' });
  }

  const clientId = process.env.GUSTO_CLIENT_ID;
  const clientSecret = process.env.GUSTO_CLIENT_SECRET;
  const redirectUri = process.env.GUSTO_REDIRECT_URI;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(`${process.env.GUSTO_API_URL || 'https://api.gusto-demo.com'}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Gusto token exchange failed:', errBody);
      return res.status(502).json({ error: 'Gusto token exchange failed' });
    }

    const tokens = await tokenRes.json();
    const expiresAt = Date.now() + (tokens.expires_in || 7200) * 1000;

    // Fetch Gusto company ID from /v1/companies
    let gustoCompanyId = '';
    try {
      const compRes = await fetch(`${process.env.GUSTO_API_URL || 'https://api.gusto-demo.com'}/v1/companies`, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
      });
      if (compRes.ok) {
        const compData = await compRes.json();
        const comps = Array.isArray(compData) ? compData : [];
        if (comps.length > 0) {
          gustoCompanyId = comps[0].uuid || '';
        }
      } else {
        console.error('Gusto /v1/companies failed:', compRes.status, await compRes.text());
      }
    } catch (e) {
      console.error('Failed to fetch Gusto company ID:', e.message);
    }

    // Update the company record with Gusto tokens
    await pool.query(`
      UPDATE companies SET
        gusto_access_token = $1,
        gusto_refresh_token = $2,
        gusto_token_expires_at = $3,
        gusto_company_id = $4
      WHERE realm_id = $5
    `, [tokens.access_token, tokens.refresh_token, expiresAt, gustoCompanyId, realmId]);

    res.json({ ok: true, gusto_company_id: gustoCompanyId });
  } catch (err) {
    console.error('Gusto OAuth callback error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Refresh Gusto tokens
async function refreshGustoTokens(realmId) {
  const { rows } = await pool.query(
    'SELECT gusto_refresh_token FROM companies WHERE realm_id = $1', [realmId]
  );
  const company = rows[0];
  if (!company?.gusto_refresh_token) throw new Error(`Gusto not connected for ${realmId}`);

  const tokenRes = await fetch(`${process.env.GUSTO_API_URL || 'https://api.gusto-demo.com'}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GUSTO_CLIENT_ID,
      client_secret: process.env.GUSTO_CLIENT_SECRET,
      refresh_token: company.gusto_refresh_token,
    }),
  });

  if (!tokenRes.ok) throw new Error('Gusto token refresh failed');

  const tokens = await tokenRes.json();
  const expiresAt = Date.now() + (tokens.expires_in || 7200) * 1000;

  await pool.query(
    'UPDATE companies SET gusto_access_token = $1, gusto_refresh_token = $2, gusto_token_expires_at = $3 WHERE realm_id = $4',
    [tokens.access_token, tokens.refresh_token, expiresAt, realmId]
  );

  return tokens.access_token;
}

// Get valid Gusto access token, refreshing if needed
async function getGustoAccessToken(realmId) {
  const { rows } = await pool.query(
    'SELECT gusto_access_token, gusto_token_expires_at, gusto_company_id FROM companies WHERE realm_id = $1',
    [realmId]
  );
  const company = rows[0];
  if (!company?.gusto_access_token) throw new Error(`Gusto not connected for ${realmId}`);

  if (Date.now() > Number(company.gusto_token_expires_at) - 300000) {
    return refreshGustoTokens(realmId);
  }

  return company.gusto_access_token;
}

router.refreshTokens = refreshTokens;
router.getAccessToken = getAccessToken;
router.refreshGustoTokens = refreshGustoTokens;
router.getGustoAccessToken = getGustoAccessToken;
router.refreshAllTokens = refreshAllTokens;

module.exports = router;
