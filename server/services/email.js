'use strict';

const FROM_NAME = 'DarkLion Portal';
const FROM_ADDR = process.env.RESEND_FROM || 'messages@darklion.ai';
const FROM = `${FROM_NAME} <${FROM_ADDR}>`;

/**
 * Send a transactional email via Resend.
 * @param {{ to: string, subject: string, html: string }}
 * @returns {{ ok: true } | { ok: true, skipped: true }}
 */
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping email send to:', to);
    return { ok: true, skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }

  return { ok: true };
}

// ── Shared template wrapper ─────────────────────────────────────────────────

function baseTemplate(content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; padding: 0; background: #0f1117; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    .card { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 12px; padding: 36px 32px; }
    .logo { font-size: 1.1rem; font-weight: 700; color: #c9a84c; letter-spacing: 0.04em; margin-bottom: 28px; }
    h1 { font-size: 1.3rem; font-weight: 700; color: #e8e8e8; margin: 0 0 12px; }
    p { font-size: 0.93rem; color: #8a8fa8; line-height: 1.65; margin: 0 0 16px; }
    .btn { display: inline-block; background: #c9a84c; color: #0f1117; font-weight: 700; font-size: 0.95rem; text-decoration: none; border-radius: 8px; padding: 12px 28px; margin: 8px 0 20px; }
    .divider { height: 1px; background: #2a2d3a; margin: 24px 0; }
    .footer { font-size: 0.78rem; color: #4a4e62; text-align: center; margin-top: 24px; }
    .url-fallback { font-size: 0.78rem; color: #4a4e62; word-break: break-all; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="logo">DarkLion</div>
      ${content}
    </div>
    <div class="footer">This email was sent by your advisory firm's secure portal. Do not reply to this email.</div>
  </div>
</body>
</html>`;
}

// ── Pre-built templates ──────────────────────────────────────────────────────

/**
 * Send a portal invite email.
 */
async function sendPortalInvite({ to, name, firmName, inviteUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const html = baseTemplate(`
    <h1>You're invited to ${esc(firmName)}'s Client Portal</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>${esc(firmName)} has set up a secure client portal for you. Click the button below to create your password and access your documents, tax organizers, and more.</p>
    <a class="btn" href="${esc(inviteUrl)}">Set Up My Account →</a>
    <div class="divider"></div>
    <p>This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.</p>
    <p class="url-fallback">Or copy this link: ${esc(inviteUrl)}</p>
  `);

  return sendEmail({ to, subject: `You're invited to the ${firmName} Client Portal`, html });
}

/**
 * Send a portal notification email to a client.
 */
async function sendPortalNotification({ to, name, firmName, message, portalUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const html = baseTemplate(`
    <h1>Message from ${esc(firmName)}</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>${esc(message)}</p>
    ${portalUrl ? `<a class="btn" href="${esc(portalUrl)}">View My Portal →</a>` : ''}
    <div class="divider"></div>
    <p>Log in to your secure client portal to view details.</p>
  `);

  return sendEmail({ to, subject: `A message from ${firmName}`, html });
}

/**
 * Send a password reset email.
 */
async function sendPasswordReset({ to, name, firmName, resetUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const html = baseTemplate(`
    <h1>Reset Your Password</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>We received a request to reset your password for the ${esc(firmName)} client portal. Click the button below to choose a new password.</p>
    <a class="btn" href="${esc(resetUrl)}">Reset My Password →</a>
    <div class="divider"></div>
    <p>This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
    <p class="url-fallback">Or copy this link: ${esc(resetUrl)}</p>
  `);

  return sendEmail({ to, subject: `Reset your ${firmName} portal password`, html });
}

// Simple HTML escaping for template values
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendEmail, sendPortalInvite, sendPortalNotification, sendPasswordReset };
