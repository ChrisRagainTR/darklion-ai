/**
 * organizerParser.js
 * Parses a Drake Software tax organizer PDF and returns structured checklist items.
 * Works by extracting text from every page and matching known section patterns.
 */

const { PdfReader } = require('pdfreader');

// Payer names that Sentinel provides internally (no client upload needed)
const SENTINEL_PROVIDES_PATTERNS = [
  /altruist/i,
];

// EIN → entity name mapping from K-1 basis worksheets (populated during parse)
const SECTION_MAP = {
  w2: { label: 'W-2 · Wages', section: 'w2' },
  '1099-r': { label: '1099-R · Retirement', section: '1099-r' },
  '1099-div': { label: '1099-DIV · Dividends', section: '1099-div' },
  '1099-int': { label: '1099-INT · Interest', section: '1099-int' },
  '1099-nec': { label: '1099-NEC · Non-Employee Compensation', section: '1099-nec' },
  '1099-misc': { label: '1099-MISC · Miscellaneous', section: '1099-misc' },
  '1099-g': { label: '1099-G · State Refund', section: '1099-g' },
  'k1': { label: 'Schedule K-1 · Partnerships & S-Corps', section: 'k1' },
  'schedule-c': { label: 'Schedule C · Business Income', section: 'schedule-c' },
  '1098': { label: 'Form 1098 · Mortgage Interest', section: '1098' },
  'childcare': { label: 'Childcare & Dependent Expenses', section: 'childcare' },
};

/**
 * Extract all text from a PDF buffer, page by page.
 * Returns array of page text strings.
 */
function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const pages = [];
    let currentPage = [];
    let currentPageNum = 0;

    new PdfReader().parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (!item) {
        // EOF
        if (currentPage.length) pages.push(currentPage.join(' '));
        return resolve(pages);
      }
      if (item.page) {
        if (currentPage.length) pages.push(currentPage.join(' '));
        currentPage = [];
        currentPageNum = item.page;
      } else if (item.text) {
        currentPage.push(item.text.trim());
      }
    });
  });
}

/**
 * Parse the checklist pages (pages 1-2 typically) for named payers.
 * Returns array of { section, payerName, accountNumber, owner }
 */
function parseChecklistItems(pageTexts) {
  const items = [];
  const checklistText = pageTexts.slice(0, 3).join('\n');

  // W-2 section
  const w2Section = checklistText.match(/Wages \(Form W-2\)([\s\S]*?)(?=IRA Distributions|Dividends|Interest|$)/i);
  if (w2Section) {
    const lines = w2Section[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[')) {
        // Detect owner hints: lines sometimes have T/S prefix in detail pages
        items.push({ section: 'w2', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
      }
    }
  }

  // 1099-R
  const r1099Section = checklistText.match(/IRA Distributions.*?Form 1099-R\)([\s\S]*?)(?=Dividends|Interest|$)/i);
  if (r1099Section) {
    const lines = r1099Section[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[')) {
        items.push({ section: '1099-r', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
      }
    }
  }

  // 1099-DIV
  const divSection = checklistText.match(/Dividends \(Form 1099-DIV\)([\s\S]*?)(?=Interest|State and City|$)/i);
  if (divSection) {
    const lines = divSection[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    let pendingPayer = null;
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[') && !line.match(/^\*+\d+$/)) {
        if (pendingPayer) {
          // Previous line was payer, this might be account number
          if (line.match(/^\*+\d+$/) || line.match(/^\d{4,}$/)) {
            items[items.length - 1].accountNumber = line;
          } else {
            pendingPayer = line;
            items.push({ section: '1099-div', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
          }
        } else {
          pendingPayer = line;
          items.push({ section: '1099-div', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
        }
      } else if (line.match(/^\*+\d+$/) && items.length) {
        items[items.length - 1].accountNumber = line;
      }
    }
  }

  // 1099-INT
  const intSection = checklistText.match(/Interest \(Form 1099-INT\)([\s\S]*?)(?=State and City|Credit Card|Partnerships|$)/i);
  if (intSection) {
    const lines = intSection[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[') && !line.match(/^\*+\d+$/)) {
        items.push({ section: '1099-int', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
      } else if (line.match(/^\*+\d+$/) && items.length) {
        items[items.length - 1].accountNumber = line;
      }
    }
  }

  // 1099-NEC
  const necSection = checklistText.match(/Nonemployee Compensation.*?1099-NEC\)([\s\S]*?)(?=State and City|Credit Card|Partnerships|Self-employed|Other Income|$)/i);
  if (necSection) {
    const lines = necSection[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[')) {
        items.push({ section: '1099-nec', payerName: line, accountNumber: '', owner: 'spouse', ein: '' });
      }
    }
  }

  // 1099-MISC
  const miscSection = checklistText.match(/Miscellaneous Income.*?1099-MISC\)([\s\S]*?)(?=Nonemployee|1099-NEC|State and City|$)/i);
  if (miscSection) {
    const lines = miscSection[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[')) {
        items.push({ section: '1099-misc', payerName: line, accountNumber: '', owner: 'spouse', ein: '' });
      }
    }
  }

  // 1099-G (named only — skip generic "Unemployment compensation" / "DEPARTMENT OF...")
  const gSection = checklistText.match(/State and City.*?1099-G\)([\s\S]*?)(?=Credit Card|Partnerships|$)/i);
  if (gSection) {
    const lines = gSection[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[') &&
          !line.match(/unemployment/i) && !line.match(/^DEPARTMENT/i)) {
        items.push({ section: '1099-g', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
      }
    }
  }

  // K-1s (checklist)
  const k1Section = checklistText.match(/Partnerships.*?Schedule K-1\)([\s\S]*?)(?=Brokerage|Self-employed|Other Income|$)/i);
  if (k1Section) {
    const lines = k1Section[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[')) {
        items.push({ section: 'k1', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
      }
    }
  }

  // Schedule C (checklist page 2)
  const schedCSection = checklistText.match(/Self-employed Income.*?Schedule C\)([\s\S]*?)(?=Other Income|$)/i);
  if (schedCSection) {
    const lines = schedCSection[1].split('\n').map(l => l.trim()).filter(l => l && l !== '[  ]');
    for (const line of lines) {
      if (line.length > 2 && !line.startsWith('[')) {
        items.push({ section: 'schedule-c', payerName: line + ' — Income & Expense Records', accountNumber: '', owner: 'taxpayer', ein: '' });
      }
    }
  }

  return items;
}

/**
 * Parse income detail pages (pages 9-16) for amounts, EINs, owner (T/S/J).
 * Returns enriched items with prior_year_amount, ein, owner overrides.
 */
function parseDetailPages(pageTexts) {
  const enriched = [];

  for (const pageText of pageTexts) {
    // W-2 detail page
    if (pageText.includes('Wages & Salaries') || pageText.includes('S_INC.LD')) {
      const lines = pageText.split('\n');
      for (const line of lines) {
        const m = line.match(/^([TS])\s+(.+?)\s+(\d[\d,]+)\s*$/);
        if (m) {
          enriched.push({
            section: 'w2',
            payerName: m[2].trim(),
            owner: m[1] === 'T' ? 'taxpayer' : 'spouse',
            prior_year_amount: parseFloat(m[3].replace(/,/g, '')),
          });
        }
      }
    }

    // 1099-R detail
    if (pageText.includes('GE AVIATION') || pageText.includes('S_INC.LD')) {
      const lines = pageText.split('\n');
      for (const line of lines) {
        const m = line.match(/^([TS])\s+(.+?)\s+(\d[\d,]+)\s*$/);
        if (m && (line.includes('PENSION') || line.includes('ANNUITY') || line.includes('IRA'))) {
          enriched.push({
            section: '1099-r',
            payerName: m[2].trim(),
            owner: m[1] === 'T' ? 'taxpayer' : 'spouse',
            prior_year_amount: parseFloat(m[3].replace(/,/g, '')),
          });
        }
      }
    }

    // K-1 detail page — get EINs
    if (pageText.includes('S_E2.LD') || pageText.includes('Schedule K-1 from Partnerships')) {
      const lines = pageText.split('\n');
      for (const line of lines) {
        const m = line.match(/^([TS])\s+([\d-]{9,11})\s+(.+)$/);
        if (m) {
          enriched.push({
            section: 'k1',
            payerName: m[3].trim(),
            ein: m[2].trim(),
            owner: m[1] === 'T' ? 'taxpayer' : 'spouse',
          });
        }
      }
    }

    // 1098 mortgage — Other Information page
    if (pageText.includes('S_OTHER.LD') || pageText.includes('Lender') || pageText.includes('Mortgage Interest')) {
      const lines = pageText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Look for lender name followed by an amount
        if (line.match(/BANK|MORTGAGE|FINANCIAL|CREDIT|LOAN|TRUST|SAVINGS/i)) {
          const nextNums = lines.slice(i + 1, i + 4).map(l => l.trim()).join(' ');
          const amtMatch = nextNums.match(/(\d[\d,]+)/);
          if (amtMatch) {
            enriched.push({
              section: '1098',
              payerName: line,
              owner: 'joint',
              prior_year_amount: parseFloat(amtMatch[1].replace(/,/g, '')),
            });
          }
        }
      }
    }

    // Childcare — dependent page
    if (pageText.includes('S_TPINFO.LD2') || pageText.includes('Child and Other Dependent')) {
      const lines = pageText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Care provider lines: name followed by address and amount
        if (line.length > 3 && lines[i + 1] && lines[i + 1].match(/\d{3,}/)) {
          const amtMatch = pageText.match(/(\d[\d,]+)\s*$/m);
          if (amtMatch) {
            enriched.push({
              section: 'childcare',
              payerName: line + ' — Childcare/Tuition Statement',
              owner: 'joint',
              prior_year_amount: parseFloat(amtMatch[1].replace(/,/g, '')),
            });
            break; // one childcare entry per page
          }
        }
      }
    }
  }

  return enriched;
}

/**
 * Merge checklist items with enriched detail data.
 * Detail data wins for EIN, amount, owner.
 */
function mergeItems(checklistItems, detailItems) {
  const merged = [...checklistItems];

  for (const detail of detailItems) {
    // Try to find matching checklist item by payer name similarity
    const idx = merged.findIndex(item =>
      item.section === detail.section &&
      (item.payerName.toLowerCase().includes(detail.payerName.toLowerCase().slice(0, 8)) ||
       detail.payerName.toLowerCase().includes(item.payerName.toLowerCase().slice(0, 8)))
    );

    if (idx >= 0) {
      if (detail.ein) merged[idx].ein = detail.ein;
      if (detail.owner) merged[idx].owner = detail.owner;
      if (detail.prior_year_amount) merged[idx].prior_year_amount = detail.prior_year_amount;
    } else if (detail.section === '1098' || detail.section === 'childcare') {
      // These often don't appear in checklist — add directly from detail
      const exists = merged.some(m => m.section === detail.section &&
        m.payerName.toLowerCase().includes(detail.payerName.toLowerCase().slice(0, 6)));
      if (!exists) merged.push(detail);
    }
  }

  return merged;
}

/**
 * Flag items that Sentinel provides internally.
 */
function flagSentinelItems(items, firmCompanyNames = []) {
  return items.map(item => {
    const isSentinel =
      SENTINEL_PROVIDES_PATTERNS.some(p => p.test(item.payerName)) ||
      (item.section === 'k1' && firmCompanyNames.some(name =>
        item.payerName.toLowerCase().includes(name.toLowerCase().slice(0, 6))
      ));
    return { ...item, sentinel_provides: isSentinel };
  });
}

/**
 * Deduplicate items — remove exact payer+section duplicates, keep first.
 */
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
 * @param {string[]} firmCompanyNames - company names in the relationship (for Sentinel Provides)
 * @returns {Promise<{ clientName: string, taxYear: string, items: Array }>}
 */
async function parseOrganizerPdf(pdfBuffer, firmCompanyNames = []) {
  const pageTexts = await extractPdfText(pdfBuffer);

  // Extract client name and tax year from first page
  const firstPage = pageTexts[0] || '';
  const nameMatch = firstPage.match(/([A-Z][A-Z\s&]+(?:LLC|INC|LP)?)\s+\*{3}-\*{2}-\*{4}/);
  const clientName = nameMatch ? nameMatch[1].trim() : 'Unknown Client';
  const yearMatch = firstPage.match(/\b(202\d)\b/);
  const taxYear = yearMatch ? yearMatch[1] : '2025';

  // Parse checklist pages
  const checklistItems = parseChecklistItems(pageTexts);

  // Parse detail pages for enrichment
  const detailItems = parseDetailPages(pageTexts);

  // Merge and clean up
  let items = mergeItems(checklistItems, detailItems);
  items = deduplicateItems(items);
  items = flagSentinelItems(items, firmCompanyNames);

  // Add display order
  const sectionOrder = ['w2', '1099-r', '1099-div', '1099-int', '1099-nec', '1099-misc', '1099-g', 'k1', 'schedule-c', '1098', 'childcare', 'other'];
  items = items.sort((a, b) => {
    const ai = sectionOrder.indexOf(a.section);
    const bi = sectionOrder.indexOf(b.section);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  }).map((item, i) => ({ ...item, display_order: i }));

  return { clientName, taxYear, items };
}

module.exports = { parseOrganizerPdf };
