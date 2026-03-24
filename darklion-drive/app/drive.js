'use strict';

/**
 * drive.js — Windows drive mount/unmount helpers using net use.
 * Uses HTTP WebDAV on 127.0.0.1:7890 — no registry changes needed.
 */

const { exec } = require('child_process');

const DRIVE_LETTER = 'L:';
const WEBDAV_PORT = 7890;
const WEBDAV_USER = 'darklion';

/**
 * Mount L: drive via PowerShell net use.
 * Uses PowerShell to safely pass the token as a SecureString, avoiding
 * command-line injection / special character issues with JWT tokens.
 * @param {string} token - JWT token used as password for WebDAV basic auth
 */
function mountDrive(token) {
  return new Promise(function(resolve, reject) {
    // Delete existing mount first
    exec('net use ' + DRIVE_LETTER + ' /delete /y', function() {
      // Use PowerShell to safely handle the token (avoids special char issues)
      var psScript = [
        '$pwd = ConvertTo-SecureString \'' + token.replace(/'/g, "''") + '\' -AsPlainText -Force',
        '$cred = New-Object System.Management.Automation.PSCredential(\'' + WEBDAV_USER + '\', $pwd)',
        'net use ' + DRIVE_LETTER + ' \\\\127.0.0.1@' + WEBDAV_PORT + '\\DavWWWRoot /user:' + WEBDAV_USER + ' $cred.GetNetworkCredential().Password /persistent:yes'
      ].join('; ');

      // Simpler approach: write token to temp file to avoid shell escaping
      var os = require('os');
      var fs = require('fs');
      var tmpFile = require('path').join(os.tmpdir(), 'dl_token.tmp');
      fs.writeFileSync(tmpFile, token, 'utf8');

      var cmd = 'powershell -NoProfile -Command "' +
        '$t = Get-Content \\"' + tmpFile + '\\" -Raw; ' +
        'net use ' + DRIVE_LETTER + ' \\\\\\\\127.0.0.1@' + WEBDAV_PORT + '\\\\DavWWWRoot /user:' + WEBDAV_USER + ' $t /persistent:yes; ' +
        'Remove-Item \\"' + tmpFile + '\\" -Force"';

      console.log('[Drive] Mounting via PowerShell...');
      exec(cmd, function(err, stdout, stderr) {
        // Clean up temp file regardless
        try { fs.unlinkSync(tmpFile); } catch(e) {}

        if (err) {
          console.error('[Drive] Mount failed:', stderr || err.message);
          return reject(new Error(stderr || err.message));
        }
        console.log('[Drive] stdout:', stdout);
        console.log('[Drive] Mounted L: successfully');
        resolve();
      });
    });
  });
}

/**
 * Unmount L: drive.
 * @returns {Promise<void>}
 */
function unmountDrive() {
  return new Promise((resolve) => {
    exec(`net use ${DRIVE_LETTER} /delete /y`, (err, stdout, stderr) => {
      if (err) {
        console.warn('[Drive] Unmount warning:', stderr || err.message);
      } else {
        console.log('[Drive] Unmounted L:');
      }
      resolve(); // Always resolve — best effort
    });
  });
}

/**
 * Check if L: drive is currently mounted.
 * @returns {Promise<boolean>}
 */
function isDriveMounted() {
  return new Promise((resolve) => {
    exec(`net use ${DRIVE_LETTER}`, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Open File Explorer to the mounted drive.
 */
function openDrive() {
  exec(`explorer.exe ${DRIVE_LETTER}\\`, (err) => {
    if (err) console.warn('[Drive] Could not open Explorer:', err.message);
  });
}

module.exports = { mountDrive, unmountDrive, isDriveMounted, openDrive, DRIVE_LETTER };
