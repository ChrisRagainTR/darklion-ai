'use strict';

/**
 * Generate a PDF from a URL.
 * Uses @sparticuz/chromium on Railway (Linux), falls back to local puppeteer on macOS.
 */
async function generatePDF(htmlContent, pageUrl) {
  let browser;

  try {
    // Try @sparticuz/chromium first (Railway / Linux)
    const puppeteer = require('puppeteer-core');
    const chromium = require('@sparticuz/chromium');
    const executablePath = await chromium.executablePath();

    if (!executablePath) throw new Error('No sparticuz chromium executable');

    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 900 },
      executablePath,
      headless: true,
    });
  } catch (e) {
    // Fallback: use full puppeteer (downloads its own Chromium — works locally)
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  const page = await browser.newPage();
  try {
    if (pageUrl) {
      await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#loe-document', { timeout: 15000 }).catch(() => {});
      // Extra wait for fonts and images
      await new Promise(r => setTimeout(r, 1500));
    } else if (htmlContent) {
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
