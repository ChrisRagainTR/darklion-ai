'use strict';

/**
 * Generate a PDF by navigating to a URL with Puppeteer.
 * Uses full puppeteer package (includes bundled Chromium).
 */
async function generatePDF(htmlContent, pageUrl) {
  const puppeteer = require('puppeteer');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });

  const page = await browser.newPage();
  try {
    if (pageUrl) {
      await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      // Wait for LOE content to render
      await page.waitForSelector('#loe-document', { timeout: 15000 }).catch(() => {});
      // Extra wait for fonts and images
      await new Promise(r => setTimeout(r, 2000));
    } else if (htmlContent) {
      await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
      await new Promise(r => setTimeout(r, 1000));
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
