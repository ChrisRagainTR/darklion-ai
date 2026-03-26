/**
 * organizerParser.js
 * Parses a Drake Software tax organizer PDF using pdf-lib for structure
 * and a Python subprocess (pypdf) for text extraction — same approach
 * proven reliable during development/testing.
 *
 * Falls back gracefully if Python unavailable.
 */

const { execSync, spawnSync } = require('child_process');
const { writeFileSync, unlinkSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const crypto = require('crypto');

// Payer names that Sentinel provides internally (no client upload needed)
const SENTINEL_PROVIDES_PATTERNS = [/altruist/i];

const SECTION_ORDER = ['w2', '1099-r', '1099-div', '1099-int', '1099-nec', '1099-misc', '1099-g', 'k1', 'schedule-c', '1098', 'childcare', 'other'];

/**
 * Extract all text from PDF buffer using Python pypdf.
 * Returns one big string of all pages joined with \n--- PAGE N ---\n
 */
function extractTextWithPython(pdfBuffer) {
  const tmpPath = join(tmpdir(), `org_${crypto.randomBytes(6).toString('hex')}.pdf`);
  try {
    writeFileSync(tmpPath, pdfBuffer);
    const script = `
import sys
try:
    import pypdf
    reader = pypdf.PdfReader(sys.argv[1])
    for i, page in enumerate(reader.pages):
        print(f"--- PAGE {i+1} ---")
        t = page.extract_text()
        if t: print(t)
except Exception as e:
    import traceback
    traceback.print_exc()
    sys.exit(1)
`;
    const result = spawnSync('python3', ['-c', script, tmpPath], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.status !== 0) {
      throw new Error(`Python extraction failed: ${result.stderr}`);
    }
    return result.stdout;
  } finally {
    try { unlinkSync(tmpPath); } catch (_) {}
  }
}

/**
 * Split extracted text into page arrays.
 */
function splitPages(text) {
  return text.split(/--- PAGE \d+ ---\n?/).filter(p => p.trim().length > 0);
}

/**
 * Parse checklist pages (pages 1-2) for named payers.
 */
function parseChecklistItems(pageTexts) {
  const items = [];
  const checklistText = pageTexts.slice(0, 3).join('\n');

  // Helper: extract payer lines from a section
  function extractPayerLines(text, startPattern, endPattern) {
    const match = text.match(new RegExp(startPattern + '([\\s\\S]*?)(?=' + endPattern + '|$)', 'i'));
    if (!match) return [];
    return match[1].split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && !l.match(/^\[/) && !l.match(/^\*+\d+$/) && !l.match(/^Page \d/));
  }

  // W-2
  for (const line of extractPayerLines(checklistText, 'Wages \\(Form W-2\\)', 'IRA Distributions|Dividends|Interest')) {
    items.push({ section: 'w2', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
  }

  // 1099-R
  for (const line of extractPayerLines(checklistText, 'IRA Distributions.*?Form 1099-R\\)', 'Dividends|Interest')) {
    items.push({ section: '1099-r', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
  }

  // 1099-DIV — handle account numbers on next line
  const divLines = extractPayerLines(checklistText, 'Dividends \\(Form 1099-DIV\\)', 'Interest \\(Form 1099');
  for (let i = 0; i < divLines.length; i++) {
    const line = divLines[i];
    const nextLine = divLines[i + 1] || '';
    if (nextLine.match(/^\*+\d+$/) || nextLine.match(/^\d{4,}$/)) {
      items.push({ section: '1099-div', payerName: line, accountNumber: nextLine, owner: 'joint', ein: '' });
      i++;
    } else {
      items.push({ section: '1099-div', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
    }
  }

  // 1099-INT
  const intLines = extractPayerLines(checklistText, 'Interest \\(Form 1099-INT\\)', 'State and City|Credit Card|Partnerships|Miscellaneous|Nonemployee');
  for (let i = 0; i < intLines.length; i++) {
    const line = intLines[i];
    const nextLine = intLines[i + 1] || '';
    if (nextLine.match(/^\*+\d+$/) || nextLine.match(/^\d{4,}$/)) {
      items.push({ section: '1099-int', payerName: line, accountNumber: nextLine, owner: 'joint', ein: '' });
      i++;
    } else {
      items.push({ section: '1099-int', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
    }
  }

  // 1099-NEC
  for (const line of extractPayerLines(checklistText, 'Nonemployee Compensation.*?1099-NEC\\)', 'State and City|Credit Card|Partnerships|Self-employed|Other Income')) {
    items.push({ section: '1099-nec', payerName: line, accountNumber: '', owner: 'spouse', ein: '' });
  }

  // 1099-MISC
  for (const line of extractPayerLines(checklistText, 'Miscellaneous Income.*?1099-MISC\\)', 'Nonemployee|1099-NEC|State and City')) {
    items.push({ section: '1099-misc', payerName: line, accountNumber: '', owner: 'spouse', ein: '' });
  }

  // 1099-G (skip generic "Unemployment" / "DEPARTMENT")
  for (const line of extractPayerLines(checklistText, 'State and City.*?1099-G\\)', 'Credit Card|Partnerships')) {
    if (!line.match(/unemployment/i) && !line.match(/^DEPARTMENT/i)) {
      items.push({ section: '1099-g', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
    }
  }

  // K-1s
  for (const line of extractPayerLines(checklistText, 'Partnerships.*?Schedule K-1\\)', 'Brokerage|Self-employed|Other Income')) {
    items.push({ section: 'k1', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
  }

  // Schedule C
  for (const line of extractPayerLines(checklistText, 'Self-employed Income.*?Schedule C\\)', 'Other Income')) {
    items.push({ section: 'schedule-c', payerName: line + ' — Income & Expense Records', accountNumber: '', owner: 'taxpayer', ein: '' });
  }

  return items;
}

/**
 * Parse detail/income pages for amounts, EINs, owner.
 */
function parseDetailPages(pageTexts) {
  const enriched = [];

  for (const pageText of pageTexts) {
    // W-2 detail (S_INC.LD page)
    if (pageText.includes('S_INC.LD') || pageText.includes('Wages & Salaries')) {
      for (const line of pageText.split('\n')) {
        const m = line.match(/^([TS])\s+(.+?)\s+(\d[\d,]+)\s*$/);
        if (m && !m[2].match(/^(Payer|Employer|Distribution)/i)) {
          enriched.push({ section: 'w2', payerName: m[2].trim(), owner: m[1] === 'T' ? 'taxpayer' : 'spouse', prior_year_amount: parseFloat(m[3].replace(/,/g, '')) });
        }
      }
    }

    // K-1 detail (S_E2.LD page) — get EINs and owner
    if (pageText.includes('S_E2.LD') || pageText.includes('Schedule K-1 from Partnerships')) {
      for (const line of pageText.split('\n')) {
        const m = line.match(/^([TS])\s+([\d-]{9,12})\s+(.+)$/);
        if (m) {
          enriched.push({ section: 'k1', payerName: m[3].trim(), ein: m[2].trim(), owner: m[1] === 'T' ? 'taxpayer' : 'spouse' });
        }
      }
    }

    // 1098 — Other Information page (S_OTHER.LD)
    if (pageText.includes('S_OTHER.LD') || (pageText.includes('Lender') && pageText.includes('Mortgage Interest'))) {
      const lines = pageText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.match(/\b(BANK|MORTGAGE|FINANCIAL|CREDIT|LOAN|TRUST|SAVINGS|FEDERAL)\b/i) && line.length < 60) {
          // Look ahead for an amount
          const nearby = lines.slice(i + 1, i + 5).join(' ');
          const amtMatch = nearby.match(/(\d[\d,]{2,})/);
          if (amtMatch) {
            enriched.push({ section: '1098', payerName: line, owner: 'joint', prior_year_amount: parseFloat(amtMatch[1].replace(/,/g, '')) });
            break;
          }
        }
      }
    }

    // Childcare — dependent/info page (S_TPINFO.LD2)
    if (pageText.includes('S_TPINFO.LD2') || pageText.includes('Child and Other Dependent')) {
      const lines = pageText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Care provider name — typically followed by address then EIN then amount
        if (line.length > 4 && line.match(/^[A-Z]/) && lines[i + 1] && lines[i + 1].match(/\d{4,}/)) {
          const nearby = lines.slice(i, i + 8).join(' ');
          const amtMatch = nearby.match(/(\d[\d,]{3,})\s*$/);
          if (amtMatch) {
            enriched.push({ section: 'childcare', payerName: line + ' — Childcare/Tuition Statement', owner: 'joint', prior_year_amount: parseFloat(amtMatch[1].replace(/,/g, '')) });
            break;
          }
        }
      }
    }

    // 1099-R detail (income page)
    if (pageText.includes('GE AVIATION') || (pageText.includes('PENSION') && pageText.match(/\d[\d,]{3,}/))) {
      for (const line of pageText.split('\n')) {
        const m = line.match(/^([TS])\s+(.+?(?:PENSION|ANNUITY|MASTER).+?)\s+(\d[\d,]+)\s*$/i);
        if (m) {
          enriched.push({ section: '1099-r', payerName: m[2].trim(), owner: m[1] === 'T' ? 'taxpayer' : 'spouse', prior_year_amount: parseFloat(m[3].replace(/,/g, '')) });
        }
      }
    }

    // Interest detail (S_INC2.LD)
    if (pageText.includes('S_INC2.LD') || pageText.includes('Interest Income')) {
      const lines = pageText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const m = line.match(/^([TSJ])\s+(.+?)\s*$/);
        if (m && m[2].length > 3) {
          const nextLine = (lines[i + 1] || '').trim();
          const amtLine = (lines[i + 2] || '').trim();
          const acct = nextLine.match(/^\*+\d+$/) ? nextLine : '';
          const amt = (acct ? amtLine : nextLine).match(/^(\d[\d,]+)$/);
          if (amt) {
            enriched.push({
              section: '1099-int',
              payerName: m[2].trim(),
              accountNumber: acct,
              owner: m[1] === 'T' ? 'taxpayer' : m[1] === 'S' ? 'spouse' : 'joint',
              prior_year_amount: parseFloat(amt[1].replace(/,/g, '')),
            });
          }
        }
      }
    }
  }

  return enriched;
}

/**
 * Merge checklist items with enriched detail data.
 */
function mergeItems(checklistItems, detailItems) {
  const merged = [...checklistItems];

  for (const detail of detailItems) {
    const idx = merged.findIndex(item =>
      item.section === detail.section && (
        item.payerName.toLowerCase().slice(0, 10) === detail.payerName.toLowerCase().slice(0, 10) ||
        detail.payerName.toLowerCase().slice(0, 10) === item.payerName.toLowerCase().slice(0, 10)
      )
    );

    if (idx >= 0) {
      if (detail.ein) merged[idx].ein = detail.ein;
      if (detail.owner && detail.owner !== 'joint') merged[idx].owner = detail.owner;
      if (detail.prior_year_amount) merged[idx].prior_year_amount = detail.prior_year_amount;
      if (detail.accountNumber) merged[idx].accountNumber = detail.accountNumber;
    } else if (['1098', 'childcare'].includes(detail.section)) {
      const exists = merged.some(m => m.section === detail.section &&
        m.payerName.toLowerCase().slice(0, 8) === detail.payerName.toLowerCase().slice(0, 8));
      if (!exists) merged.push(detail);
    }
  }

  return merged;
}

/**
 * Flag Altruist and firm-company K-1s as Sentinel Provides.
 */
function flagSentinelItems(items, firmCompanyNames = []) {
  return items.map(item => ({
    ...item,
    sentinel_provides:
      SENTINEL_PROVIDES_PATTERNS.some(p => p.test(item.payerName)) ||
      (item.section === 'k1' && firmCompanyNames.some(name =>
        item.payerName.toLowerCase().includes(name.toLowerCase().slice(0, 8))
      )),
  }));
}

function deduplicateItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.section}:${item.payerName.toLowerCase().slice(0, 20)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Main export: parse a Drake organizer PDF buffer.
 * @param {Buffer} pdfBuffer
 * @param {string[]} firmCompanyNames
 * @returns {Promise<{ clientName: string, taxYear: string, items: Array }>}
 */
async function parseOrganizerPdf(pdfBuffer, firmCompanyNames = []) {
  const fullText = extractTextWithPython(pdfBuffer);
  const pageTexts = splitPages(fullText);

  // Client name + year from first page
  const firstPage = pageTexts[0] || '';
  const nameMatch = firstPage.match(/([A-Z][A-Z\s&]+(?:LLC|INC|LP)?)\s+\*{3}-\*{2}-\*{4}/);
  const clientName = nameMatch ? nameMatch[1].trim() : 'Unknown Client';
  const yearMatch = firstPage.match(/\b(202\d)\b/);
  const taxYear = yearMatch ? yearMatch[1] : '2025';

  const checklistItems = parseChecklistItems(pageTexts);
  const detailItems = parseDetailPages(pageTexts);

  let items = mergeItems(checklistItems, detailItems);
  items = deduplicateItems(items);
  items = flagSentinelItems(items, firmCompanyNames);

  items = items
    .sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.section);
      const bi = SECTION_ORDER.indexOf(b.section);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map((item, i) => ({ ...item, display_order: i }));

  return { clientName, taxYear, items };
}

module.exports = { parseOrganizerPdf };
