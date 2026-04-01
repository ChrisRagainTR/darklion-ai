'use strict';

const BASE_URL = 'https://secure.blueleaf.com';

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function extractAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

function parseNumber(str) {
  const n = parseFloat((str || '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────

async function blueleafGet(token, path) {
  const url = `${BASE_URL}${path}`;
  const auth = Buffer.from(`${token}:x`).toString('base64');
  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/xml',
    },
  });
  if (!res.ok) {
    throw new Error(`Blueleaf API error: ${res.status} ${res.statusText} — ${path}`);
  }
  return res.text();
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchHouseholds(token) {
  const xml = await blueleafGet(token, '/api/v1/households.xml');
  const householdBlocks = extractAllTags(xml, 'household');
  return householdBlocks.map(block => ({
    id: extractTag(block, 'id'),
    email: extractTag(block, 'email'),
    fullName: extractTag(block, 'full-name'),
  }));
}

async function fetchHouseholdDetail(token, householdId) {
  const xml = await blueleafGet(token, `/api/v1/households/${householdId}.xml`);
  const householdBlock = extractTag(xml, 'household') || xml;

  const accountBlocks = extractAllTags(householdBlock, 'account');
  const accounts = accountBlocks.map(ab => {
    const holdingBlocks = extractAllTags(ab, 'holding');
    // account-type is a nested block — display-name may be self-closing (<display-name nil="true"/>)
    const accountTypeBlock = extractTag(ab, 'account-type');
    // Try display-name first (non-self-closing), fall back to name
    const rawDisplayName = extractTag(accountTypeBlock, 'display-name');
    const rawName = extractTag(accountTypeBlock, 'name');
    // Self-closing tags return empty string from extractTag — use name as fallback
    const accountTypeDisplay = (rawDisplayName && !rawDisplayName.includes('<') ? rawDisplayName : rawName) || '';
    // balance is a nested block: <balance><value>123.00</value><period>2025-01-01</period></balance>
    const balanceBlock = extractTag(ab, 'balance');
    const balanceValue = parseNumber(extractTag(balanceBlock, 'value')) || parseNumber(extractTag(ab, 'current-net-value'));
    return {
      id: extractTag(ab, 'id'),
      name: extractTag(ab, 'name'),
      institutionName: extractTag(ab, 'institution-name'),
      accountNumber: extractTag(ab, 'account-number'),
      accountType: accountTypeDisplay,
      currentNetValue: parseNumber(extractTag(ab, 'current-net-value')),
      balance: balanceValue,
      holdings: holdingBlocks.map(hb => ({
        id: extractTag(hb, 'id') || extractTag(hb, 'holding-id'),
        description: extractTag(hb, 'description'),
        ticker: extractTag(hb, 'ticker-name') || extractTag(hb, 'ticker'),
        companyName: extractTag(hb, 'company-name'),
        price: parseNumber(extractTag(hb, 'price')),
        value: parseNumber(extractTag(hb, 'value')),
        quantity: parseNumber(extractTag(hb, 'quantity')),
      })),
    };
  });

  return {
    id: extractTag(householdBlock, 'id') || householdId,
    fullName: extractTag(householdBlock, 'full-name'),
    email: extractTag(householdBlock, 'email'),
    accounts,
  };
}

async function fetchHouseholdBalance(token, householdId, date) {
  const path = `/api/v1/households/${householdId}.xml?date=${date}`;
  const xml = await blueleafGet(token, path);
  // Sum all account balances at the given date
  const householdBlock = extractTag(xml, 'household') || xml;
  const accountBlocks = extractAllTags(householdBlock, 'account');
  let total = 0;
  for (const ab of accountBlocks) {
    // balance is nested: <balance><value>...</value></balance>
    const balanceBlock = extractTag(ab, 'balance');
    const val = parseNumber(extractTag(balanceBlock, 'value')) || parseNumber(extractTag(ab, 'current-net-value'));
    total += val;
  }
  return total;
}

function startOfQuarter(date) {
  const m = date.getMonth(); // 0-indexed
  const q = Math.floor(m / 3) * 3;
  return new Date(date.getFullYear(), q, 1);
}

function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

async function calculatePerformance(token, householdId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const startOfQtr = startOfQuarter(now);

  // Last month: first day of previous month → first day of current month
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = startOfMonth;

  // Last quarter: start of previous quarter → start of current quarter
  const startOfLastQtr = new Date(startOfQtr);
  startOfLastQtr.setMonth(startOfLastQtr.getMonth() - 3);
  const endOfLastQtr = startOfQtr;

  // 3-year: same date 3 years ago
  const threeYearAgo = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate());

  const [currentBalance, mtdStart, qtdStart, ytdStart, lastMonthStart, lastMonthEnd, lastQtrStart, lastQtrEnd, threeYrStart] = await Promise.all([
    fetchHouseholdBalance(token, householdId, toDateStr(now)),
    fetchHouseholdBalance(token, householdId, toDateStr(startOfMonth)),
    fetchHouseholdBalance(token, householdId, toDateStr(startOfQtr)),
    fetchHouseholdBalance(token, householdId, toDateStr(startOfYear)),
    fetchHouseholdBalance(token, householdId, toDateStr(startOfLastMonth)),
    fetchHouseholdBalance(token, householdId, toDateStr(endOfLastMonth)),
    fetchHouseholdBalance(token, householdId, toDateStr(startOfLastQtr)),
    fetchHouseholdBalance(token, householdId, toDateStr(endOfLastQtr)),
    fetchHouseholdBalance(token, householdId, toDateStr(threeYearAgo)),
  ]);

  function pct(start, end) {
    const e = end !== undefined ? end : currentBalance;
    if (!start || start === 0) return null;
    return (e - start) / start;
  }

  return {
    mtd: pct(mtdStart),
    qtd: pct(qtdStart),
    ytd: pct(ytdStart),
    lastMonth: pct(lastMonthStart, lastMonthEnd),
    lastQuarter: pct(lastQtrStart, lastQtrEnd),
    threeYear: pct(threeYrStart),
  };
}

async function syncPerson(token, personId, householdId, firmId, pool) {
  const [detail, performance] = await Promise.all([
    fetchHouseholdDetail(token, householdId),
    calculatePerformance(token, householdId),
  ]);

  const rawBalance = detail.accounts.reduce((sum, a) => sum + (a.balance || a.currentNetValue || 0), 0);
  const today = toDateStr(new Date());

  const { rows } = await pool.query(
    `INSERT INTO blueleaf_snapshots
       (firm_id, person_id, blueleaf_household_id, snapshot_date, performance, accounts, raw_balance, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (person_id, snapshot_date)
     DO UPDATE SET
       performance = EXCLUDED.performance,
       accounts = EXCLUDED.accounts,
       raw_balance = EXCLUDED.raw_balance,
       synced_at = NOW()
     RETURNING *`,
    [firmId, personId, householdId, today, JSON.stringify(performance), JSON.stringify(detail.accounts), rawBalance]
  );

  return { ...rows[0], detail, performance };
}

module.exports = { fetchHouseholds, fetchHouseholdDetail, fetchHouseholdBalance, calculatePerformance, syncPerson };
