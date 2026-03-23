'use strict';
const pdfParse = require('pdf-parse');

async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return data.text || '';
}

module.exports = { extractPdfText };
