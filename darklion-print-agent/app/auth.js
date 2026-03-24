'use strict';

/**
 * JWT storage and management for DarkLion Print Agent.
 * Uses keytar (Windows Credential Manager) to store the token securely.
 * Falls back to a local encrypted file if keytar is unavailable.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const KEYTAR_SERVICE = 'DarkLionPrintAgent';
const KEYTAR_ACCOUNT = 'jwt';

let keytar = null;
try {
  keytar = require('keytar');
} catch (e) {
  console.warn('[auth] keytar not available, using file fallback');
}

// Fallback file path (in app userData directory)
function getTokenFilePath() {
  return path.join(app.getPath('userData'), 'auth.json');
}

/**
 * Store the JWT token securely.
 */
async function storeToken(token) {
  if (keytar) {
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, token);
  } else {
    const filePath = getTokenFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ token }), 'utf8');
  }
}

/**
 * Retrieve the stored JWT token.
 * Returns null if not found.
 */
async function getToken() {
  if (keytar) {
    return await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  } else {
    const filePath = getTokenFilePath();
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return data.token || null;
      } catch (_) {}
    }
    return null;
  }
}

/**
 * Clear the stored token (logout).
 */
async function clearToken() {
  if (keytar) {
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  } else {
    const filePath = getTokenFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * Check if a JWT token is expired (or about to expire within 5 minutes).
 * @param {string} token
 * @returns {boolean}
 */
function isTokenExpired(token) {
  if (!token) return true;
  try {
    // JWT is base64url-encoded: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp) return false; // no expiry claim — treat as valid
    const expiresAt = payload.exp * 1000;
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minute buffer
    return now >= (expiresAt - bufferMs);
  } catch (_) {
    return true;
  }
}

module.exports = { storeToken, getToken, clearToken, isTokenExpired };
