'use strict';
const twilio = require('twilio');

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  return twilio(sid, token);
}

/**
 * Send an SMS message via Twilio.
 * @param {string} to - recipient phone number (E.164 format, e.g. +12395551234)
 * @param {string} body - message text
 * @returns {Promise<{ sid: string, status: string }>}
 */
async function sendSMS(to, body) {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) throw new Error('TWILIO_FROM_NUMBER not configured');
  const client = getClient();
  const msg = await client.messages.create({ from, to, body });
  return { sid: msg.sid, status: msg.status };
}

module.exports = { sendSMS };
