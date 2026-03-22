'use strict';

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

/**
 * Generate a PDF from a URL or raw HTML string.
 *
 * @param {string|null} htmlContent - Raw HTML to render (used if pageUrl is null)
 * @param {string|null} pageUrl     - URL to navigate to (takes priority over htmlContent)
 * @returns {Promise<Buffer>} PDF bytes
 */
async function generatePDF(htmlContent, pageUrl) {
  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
    executablePath,
    headless: true,
  });

  const page = await browser.newPage();

  try {
    if (pageUrl) {
      await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      // Wait for the LOE document node to appear (best-effort)
      await page.waitForSelector('#loe-document', { timeout: 15000 }).catch(() => {});
    } else {
      await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    }

    const pdf = await page.pdf({
      format: 'Letter',
      margin: { top: '0.75in', bottom: '0.75in', left: '0.85in', right: '0.85in' },
      printBackground: true,
      displayHeaderFooter: false,
    });

    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { generatePDF };
