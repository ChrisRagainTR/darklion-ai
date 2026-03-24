'use strict';

/**
 * drive.js — Windows drive mount/unmount helpers using net use.
 * Uses HTTP WebDAV on 127.0.0.1:7890 — no registry changes needed.
 */

const { exec } = require('child_process');

const DRIVE_LETTER = 'L:';
const WEBDAV_HOST = '\\\\127.0.0.1@7890\\DavWWWRoot';
const WEBDAV_USER = 'darklion';

/**
 * Mount L: drive via net use.
 * @param {string} token - JWT token used as password for WebDAV basic auth
 * @returns {Promise<void>}
 */
function mountDrive(token) {
  return new Promise((resolve, reject) => {
    // First, try to delete any existing mount to avoid "already in use" errors
    exec(`net use ${DRIVE_LETTER} /delete /y`, () => {
      // Ignore errors from the delete (may not exist)
      const cmd = `net use ${DRIVE_LETTER} ${WEBDAV_HOST} /user:${WEBDAV_USER} "${token}" /persistent:yes`;
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error('[Drive] Mount failed:', stderr || err.message);
          return reject(new Error(stderr || err.message));
        }
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
