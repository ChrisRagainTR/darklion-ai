'use strict';
const pdfParse = require('pdf-parse');

// Max pages to extract — covers 1040 main form + schedules + comparison page
// without pulling in every workpaper attachment. 50 pages handles most full returns.
const MAX_PAGES = 50;
const MAX_CHARS = 140000; // ~35k tokens — enough for Claude to extract all data

async function extractPdfText(buffer) {
  // First pass: get total page count
  let totalPages = 0;
  try {
    const meta = await pdfParse(buffer, { max: 1 });
    totalPages = meta.numpages || 0;
  } catch(e) { /* ignore */ }

  // Extract only the pages we need
  const data = await pdfParse(buffer, { max: MAX_PAGES });
  const text = data.text || '';

  // Trim to char limit
  const trimmed = text.length > MAX_CHARS
    ? text.substring(0, MAX_CHARS) + '\n\n[TEXT TRUNCATED — extracted first ' + Math.min(MAX_PAGES, totalPages || MAX_PAGES) + ' of ' + (totalPages || '?') + ' pages]'
    : text;

  return trimmed;
}

module.exports = { extractPdfText };
