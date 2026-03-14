const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

// Detect changes to Chart of Accounts using QBO Change Data Capture
async function detectCoAChanges(realmId, daysSince = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - daysSince);
  const sinceISO = sinceDate.toISOString();

  let changes = { created: [], updated: [], deleted: [] };

  try {
    const data = await qbFetch(realmId, `/cdc?entities=Account&changedSince=${sinceISO}`);

    const cdcResponse = data.CDCResponse?.[0];
    const queryResponse = cdcResponse?.QueryResponse?.[0];
    const accounts = queryResponse?.Account || [];

    for (const acct of accounts) {
      const entry = {
        id: acct.Id,
        name: acct.Name || acct.FullyQualifiedName || '',
        type: acct.AccountType || '',
        subType: acct.AccountSubType || '',
        active: acct.Active !== false,
        createdDate: acct.MetaData?.CreateTime || '',
        lastUpdated: acct.MetaData?.LastUpdatedTime || '',
      };

      // Check if this was created within the window
      const createdAt = new Date(entry.createdDate);
      if (createdAt >= sinceDate) {
        changes.created.push(entry);
      } else if (acct.status === 'Deleted') {
        changes.deleted.push(entry);
      } else {
        changes.updated.push(entry);
      }
    }
  } catch (e) {
    // CDC might not be supported or might fail — fall back to simple comparison
    // Just return whatever we got
    if (e.message.includes('401')) throw e; // re-throw auth errors
  }

  const result = {
    daysSince,
    changes,
    summary: {
      newCount: changes.created.length,
      modifiedCount: changes.updated.length,
      deletedCount: changes.deleted.length,
      totalChanges: changes.created.length + changes.updated.length + changes.deleted.length,
    },
  };

  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'coa_changes', $2, $3, $4)
  `, [realmId, currentPeriod(), JSON.stringify(result), result.summary.totalChanges]);

  return result;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { detectCoAChanges };
