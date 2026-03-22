const puppeteer = require('./node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const signHtml = fs.readFileSync(path.join(__dirname, 'public/proposal-sign.html'), 'utf8');

// Extract LOE CSS from the on-screen styles (the #loe-styles block)
const loeStylesMatch = signHtml.match(/<style id="loe-styles">([\s\S]*?)<\/style>/);
const loeStyles = loeStylesMatch ? loeStylesMatch[1] : '';

// Extract the JS functions we need (everything between <script> tags in body)
// We need: escHtml, fmtDate, formatOrdinalDate, buildTaxFeeTableRows, generateTaxLOE, generateWealthLOE, loeCoverHeader, generateSignatureAuditHtml
const scriptMatch = signHtml.match(/<script>\s*([\s\S]*?)\s*init\(\);\s*<\/script>/);
const jsContent = scriptMatch ? scriptMatch[1] : '';

const sampleEng = {
  engagement_type: 'tax',
  company_name: 'Ragain Financial Inc',
  client_name: 'Chris Ragain',
  contact_name: 'Christopher G. Ragain',
  contact_email: 'chris@ragainfinancial.com',
  address_line1: '3301 Bonita Beach Rd, Suite 312',
  address_line2: 'Bonita Springs, FL 34134',
  entity_type: 'S-Corporation',
  owners: 'Christopher G. Ragain — CEO, 100%',
  tiers: [{
    name: 'Tax + Bookkeeping',
    subtitle: 'Complete tax & financial record management',
    monthlyPrice: 500,
    price: 500,
    bullets: ['Monthly Bookkeeping & Reconciliation', 'Financial Statement Preparation'],
    isRecommended: true,
    recommended: true,
  }],
  selected_tier_index: 0,
  selected_tier_indices: [],
  add_ons: [{ description: 'Schedule C', monthlyPrice: 25 }],
  backwork: [{ description: 'Prior Year Bookkeeping Catchup', flatFee: 1500 }],
  aum_fee_percent: 0.69,
  require_dual_signature: false,
  signed_by_name: 'Christopher G. Ragain',
  signed_at: new Date().toISOString(),
  signer_ip: '98.42.111.200',
  // Base64 signature placeholder - simple line
  signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAABCAYAAABkWT5QAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QA/wD/AP+gvaeTAAAAB3RJTUUH6AMWFRcwmJ6V7QAAADNJREFUKBVjYBgFgx0QBQR/GP6TAiQjqMOiAAAAAElFTkSuQmCC',
};

const printCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    font-size: 10.5pt;
    color: #1a1a2e;
    line-height: 1.65;
    background: white;
    padding: 0.75in 0.9in;
  }
  p { margin: 0 0 9pt 0; font-size: 10pt; text-align: left; }
  h1 { font-size: 14pt; font-weight: 700; text-align: left; color: #462161; margin: 18pt 0 12pt; }
  h2 { font-size: 10.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #1a1a2e; border-bottom: 1pt solid #e5e2eb; padding-bottom: 3pt; margin: 16pt 0 7pt; }
  h3 { font-size: 10pt; font-weight: 700; color: #1a1a2e; margin: 10pt 0 5pt; }
  ul, ol { margin: 5pt 0 9pt 18pt; }
  li { margin-bottom: 3pt; font-size: 10pt; }
  .loe-elections-title { font-size: 12pt !important; font-weight: 700 !important; color: #462161 !important; border-bottom: 1.5pt solid #462161 !important; padding-bottom: 4pt !important; margin: 16pt 0 10pt !important; text-transform: none !important; letter-spacing: 0 !important; }
  .loe-cover-heading { font-size: 10.5pt !important; font-weight: 700 !important; color: #462161 !important; margin: 12pt 0 5pt !important; text-transform: none !important; border-bottom: none !important; letter-spacing: 0 !important; }
  .loe-fee-line { font-size: 10pt; font-weight: 600; color: #462161; margin: 4pt 0 8pt; }
  .loe-section-heading { font-size: 10.5pt; font-weight: 700; color: #462161; border-bottom: 1.5pt solid #462161; padding-bottom: 3pt; margin: 16pt 0 7pt; }
  .loe-services-table, .loe-monthly-table, .loe-backwork-table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 9.5pt; }
  .loe-services-table th, .loe-monthly-table th, .loe-backwork-table th { background: #462161; color: white; padding: 5pt 8pt; text-align: left; font-weight: 600; font-size: 9pt; }
  .loe-monthly-table th:last-child, .loe-backwork-table th:last-child { text-align: right; }
  .loe-services-table td, .loe-monthly-table td, .loe-backwork-table td { padding: 4.5pt 8pt; border-bottom: 0.5pt solid #e5e2eb; vertical-align: top; text-align: left; }
  .loe-svc-name { font-weight: 500; text-align: left; }
  .loe-svc-price { text-align: right; font-weight: 600; white-space: nowrap; }
  .loe-svc-status { text-align: right; }
  .loe-status-included { color: #059669; font-weight: 600; font-size: 9pt; }
  .loe-total-row td { font-weight: 700; color: #462161; border-top: 1.5pt solid #462161; padding: 5pt 8pt; background: #faf8ff; }
  .loe-total-row td:last-child { text-align: right; }
  .loe-monthly-table tbody tr:nth-child(even):not(.loe-total-row) { background: #faf8ff; }
  .loe-services-table tbody tr:nth-child(even) { background: #faf8ff; }
  .loe-svc-name-hdr { text-align: left; }
  .loe-svc-price-hdr { text-align: right; }
  .loe-backwork-section { margin: 10pt 0 14pt; }
  .loe-backwork-title { font-size: 10pt; font-weight: 700; text-decoration: underline; color: #1a1a2e; margin-bottom: 5pt; }
  .loe-backwork-table th { background: #462161; }
  .loe-backwork-table th:last-child { text-align: right; }
  .loe-bw-total-row td { font-weight: 700; color: #462161; border-top: 1pt solid #462161; background: #faf8ff; }
  .loe-election-box { border: 1pt solid #462161; border-radius: 4pt; padding: 8pt 12pt; margin: 10pt 0; background: #faf8ff; }
  .loe-election-summary { width: 100%; font-size: 10pt; }
  .loe-election-summary td { padding: 2pt 0; }
  .loe-agreement-title { text-align: left; font-size: 13pt !important; font-weight: 700 !important; color: #462161 !important; margin: 18pt 0 12pt !important; border: none !important; }
  .loe-checkbox-line { font-size: 10pt; margin: 4pt 0; }
  .loe-service-list, .loe-doc-list { margin: 5pt 0 9pt 18pt; list-style-type: disc; }
  .loe-bk-list, .loe-planning-list { margin: 5pt 0 9pt 18pt; list-style-type: decimal; }
  .loe-service-list li, .loe-bk-list li, .loe-doc-list li, .loe-planning-list li { margin-bottom: 3pt; }
  .loe-acceptance-block { margin-top: 28pt; padding-top: 16pt; border-top: 1.5pt solid #462161; }
  .loe-acceptance-title { text-align: left; font-size: 12pt !important; font-weight: 700 !important; color: #462161 !important; border: none !important; margin-bottom: 10pt !important; }
  .loe-sig-label { margin-top: 16pt; font-size: 10pt; }
  .loe-sig-block { margin: 8pt 0 16pt; }
  .loe-sig-name-italic { font-style: italic; font-size: 14pt; font-family: Georgia, serif; color: #1a1a2e; }
  .loe-sig-line { width: 180pt; border-bottom: 0.75pt solid #1a1a2e; margin: 3pt 0; }
  .loe-sig-detail { font-size: 9pt; color: #6b7280; margin: 1pt 0; }
  .loe-sig-closing { font-style: italic; margin-bottom: 14pt; font-size: 10pt; }
  .loe-accepted-agreed { font-weight: 700; font-size: 10pt; margin-top: 20pt; margin-bottom: 10pt; text-decoration: underline; }
  .loe-sig-lines { display: flex; gap: 30pt; align-items: flex-end; margin-top: 6pt; }
  .loe-sig-line-group { display: flex; flex-direction: column; }
  .loe-sig-line-long { width: 220pt; border-bottom: 0.75pt solid #1a1a2e; margin-bottom: 3pt; height: 22pt; }
  .loe-sig-line-short { width: 120pt; border-bottom: 0.75pt solid #1a1a2e; margin-bottom: 3pt; height: 22pt; }
  .loe-sig-line-label { font-size: 8.5pt; color: #6b7280; }
  .loe-confidential { font-size: 9pt; font-weight: 700; letter-spacing: 0; color: #462161; margin-bottom: 16pt; text-align: left; }
  .loe-client-info { margin-bottom: 16pt; }
  .loe-client-info p { margin: 1pt 0; font-size: 10pt; }
  .loe-client-name { font-size: 12pt; font-weight: 700; }
  .loe-tax-confidential { font-size: 9pt; font-weight: 700; text-decoration: underline; margin-bottom: 14pt; color: #1a1a2e; letter-spacing: 0; }
  .loe-consent-block { margin-top: 28pt; padding-top: 14pt; border-top: 0.75pt solid #e5e2eb; }
  .loe-consent-heading { font-size: 11pt; font-weight: 700; color: #1a1a2e; border-bottom: 0.75pt solid #e5e2eb; padding-bottom: 4pt; margin-bottom: 10pt; margin-top: 20pt; }
  .loe-consent-options { margin: 10pt 0; }
  .loe-consent-option { margin: 5pt 0; font-size: 10pt; }
  .loe-consent-x { display: inline-block; border: 0.75pt solid #1a1a2e; font-weight: 700; font-size: 9pt; margin-right: 6pt; text-align: center; min-width: 18pt; padding: 0 2pt; }
  .loe-consent-blank { display: inline-block; border: 0.75pt solid #1a1a2e; font-size: 9pt; margin-right: 6pt; min-width: 18pt; color: transparent; }
  .loe-consent-signatures { display: flex; gap: 30pt; margin: 16pt 0; padding: 10pt 0; border-top: 0.75pt solid #e5e2eb; }
  .loe-consent-sig-col { flex: 1; }
  .loe-consent-sig-field { margin: 8pt 0; font-size: 9.5pt; }
  .loe-tigta-notice { font-size: 8.5pt; color: #6b7280; margin-top: 16pt; padding-top: 8pt; border-top: 0.75pt solid #e5e2eb; font-style: italic; }
  .loe-cover-header-block { margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 2px solid #462161; }
`;

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  const page = await browser.newPage();

  // Inject the LOE functions and render
  await page.setContent(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>${printCSS}</style>
  </head><body><div id="root"></div>
  <script>
    ${jsContent}
    // Remove init() call and replace with direct render
    const eng = ${JSON.stringify(sampleEng)};
    const logoUrl = 'https://darklion.ai/sentinel-logo.png';
    const loeHtml = generateTaxLOE(eng);
    const auditHtml = generateSignatureAuditHtml(eng);
    document.getElementById('root').innerHTML = loeHtml + auditHtml;
  </script>
  </body></html>`, {waitUntil: 'networkidle0'});

  await page.waitForTimeout(2000); // wait for fonts

  const pdf = await page.pdf({
    format: 'Letter',
    margin: { top: '0.75in', bottom: '0.75in', left: '0.9in', right: '0.9in' },
    printBackground: true,
    displayHeaderFooter: false,
  });

  fs.writeFileSync('/tmp/test_loe.pdf', pdf);
  console.log('PDF written to /tmp/test_loe.pdf, size:', pdf.length, 'bytes');
  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
