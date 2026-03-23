'use strict';
const pdfParse = require('pdf-parse');

// Strategy: extract the first 20 pages (core 1040 + schedules) PLUS the last 8 pages
// (comparison table + estimated payment vouchers are always near the end).
// This skips the middle worksheet pages (depreciation detail, AMT worksheets, etc.)
// that Claude doesn't need and only add noise.
const CORE_PAGES = 20;     // first N pages — main form + key schedules
const TAIL_PAGES = 8;      // last N pages — comparison + estimated payments
const MAX_CHARS = 80000;   // ~20k tokens — fast for Haiku

async function extractPdfText(buffer) {
  // Get total page count
  let totalPages = 0;
  try {
    const meta = await pdfParse(buffer, { max: 1 });
    totalPages = meta.numpages || 0;
  } catch(e) { /* ignore */ }

  // Extract core pages (first 20)
  const coreData = await pdfParse(buffer, { max: CORE_PAGES });
  let text = coreData.text || '';

  // Extract tail pages (last 8) if the return is long enough
  if (totalPages > CORE_PAGES + 2) {
    const tailStart = Math.max(totalPages - TAIL_PAGES + 1, CORE_PAGES + 1);
    // pdf-parse doesn't support page ranges natively, so we extract full and slice
    // Only do this if the total is manageable
    if (totalPages <= 60) {
      try {
        const fullData = await pdfParse(buffer);
        const fullText = fullData.text || '';
        // Estimate char position of tail pages (proportional approximation)
        const tailStartChar = Math.floor((fullText.length / totalPages) * (tailStart - 1));
        const tailText = fullText.substring(tailStartChar);
        text += '\n\n--- TAIL PAGES (comparison, estimated payments) ---\n\n' + tailText;
      } catch(e) { /* use core only */ }
    }
  }

  // Trim to char limit
  const trimmed = text.length > MAX_CHARS
    ? text.substring(0, MAX_CHARS) + '\n\n[TEXT TRUNCATED]'
    : text;

  return trimmed;
}

module.exports = { extractPdfText };
