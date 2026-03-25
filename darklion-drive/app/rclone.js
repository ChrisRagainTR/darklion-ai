'use strict';

var childProcess = require('child_process');
var spawn = childProcess.spawn;
var exec = childProcess.exec;
var path = require('path');
var fs = require('fs');
var os = require('os');

function findRclone() {
  var resourcesPath = process.resourcesPath || '';
  var appPath = '';
  try {
    appPath = require('electron').app.getAppPath();
  } catch (e) {
    appPath = __dirname;
  }

  var candidates = [
    path.join(resourcesPath, 'rclone.exe'),
    path.join(appPath, '..', '..', 'vendor', 'rclone.exe'),
    path.join(appPath, 'vendor', 'rclone.exe'),
    path.join(__dirname, '..', 'vendor', 'rclone.exe'),
    'rclone'
  ];

  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c === 'rclone') return c;
    try { fs.accessSync(c); return c; } catch (e) {}
  }
  return 'rclone';
}

var rcloneProc = null;
var retries = 0;
var MAX_RETRIES = 3;
var onDisconnectCallback = null;
var currentToken = null;
var retryTimeout = null;
var DRIVE_LETTER = 'O:';
var MOUNT_DIR = DRIVE_LETTER; // Mount directly to drive letter in fixed-disk mode (no --network-mode)

// Kill any running rclone.exe processes that might hold a stale mount
function killStaleRclone() {
  return new Promise(function(resolve) {
    // Kill our tracked process first
    if (rcloneProc && !rcloneProc.killed) {
      rcloneProc.kill('SIGKILL');
    }
    rcloneProc = null;
    
    // Also kill any orphaned rclone.exe processes (from previous app crashes)
    exec('taskkill /F /IM rclone.exe /T', function() {
      // Wait a moment for WinFsp to release the drive letter
      setTimeout(resolve, 1500);
    });
  });
}

function mountDrive(token, onDisconnect) {
  onDisconnectCallback = onDisconnect;
  currentToken = token;
  retries = 0;

  // Always kill stale rclone first, then mount fresh
  return killStaleRclone().then(function() {
    return doMount(token);
  });
}

function doMount(token) {
  return new Promise(function(resolve, reject) {
    var rcloneBin = findRclone();

    // Write rclone config to temp file
    var configPath = path.join(os.tmpdir(), 'darklion-rclone.conf');
    try {
      fs.writeFileSync(configPath, '[darklion]\ntype = webdav\nurl = http://127.0.0.1:7891\nbearer_token = ' + token + '\n', 'utf8');
    } catch(e) {
      return reject(new Error('Cannot write rclone config: ' + e.message));
    }

    var args = [
      'mount',
      'darklion:',
      MOUNT_DIR,
      '--config', configPath,
      '--volname', 'DarkLion Drive',
      '--vfs-cache-mode', 'writes',
      '--no-modtime',
      '--dir-cache-time', '30s',
      '--attr-timeout', '1s',
      '--log-level', 'ERROR'
    ];

    console.log('[Rclone] Starting rclone mount:', rcloneBin, 'at', MOUNT_DIR);

    rcloneProc = spawn(rcloneBin, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    var mounted = false;
    var rejected = false;

    var mountTimeout = setTimeout(function() {
      if (!mounted && !rejected) {
        rejected = true;
        reject(new Error('Rclone mount timed out after 15 seconds'));
      }
    }, 15000);

    rcloneProc.stderr.on('data', function(data) {
      var msg = data.toString().trim();
      console.log('[Rclone] stderr:', msg);
      if (!mounted && !rejected) {
        if (msg.indexOf('CRITICAL') !== -1 || msg.indexOf('failed to mount') !== -1) {
          clearTimeout(mountTimeout);
          rejected = true;
          reject(new Error(msg));
        }
      }
    });

    rcloneProc.stdout.on('data', function(data) {
      console.log('[Rclone] stdout:', data.toString().trim());
    });

    // Assume mounted after 4s with no fatal error, then assign drive letter via subst
    setTimeout(function() {
      if (!mounted && !rejected && rcloneProc && !rcloneProc.killed) {
        mounted = true;
        clearTimeout(mountTimeout);
        console.log('[Rclone] Mounted successfully at:', MOUNT_DIR);
        console.log('[Rclone] Mounted successfully at:', DRIVE_LETTER);
        resolve();
      }
    }, 4000);

    rcloneProc.on('exit', function(code) {
      console.log('[Rclone] Process exited, code:', code);
      rcloneProc = null;

      if (mounted) {
        if (retries < MAX_RETRIES && currentToken) {
          retries++;
          console.log('[Rclone] Reconnecting, attempt', retries, 'of', MAX_RETRIES);
          retryTimeout = setTimeout(function() {
            killStaleRclone().then(function() { return doMount(currentToken); }).then(function() {
              console.log('[Rclone] Reconnected');
            }).catch(function(err) {
              console.error('[Rclone] Reconnect failed:', err.message);
              if (onDisconnectCallback) onDisconnectCallback();
            });
          }, 2000);
        } else {
          if (onDisconnectCallback) onDisconnectCallback();
        }
      }
    });

    rcloneProc.on('error', function(err) {
      clearTimeout(mountTimeout);
      console.error('[Rclone] Spawn error:', err.message);
      if (!mounted && !rejected) {
        rejected = true;
        reject(err);
      }
    });
  });
}

function unmountDrive() {
  return new Promise(function(resolve) {
    if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
    currentToken = null;
    retries = 0;
    killStaleRclone().then(resolve);
  });
}

function openDrive() {
  exec('explorer.exe ' + DRIVE_LETTER + '\\', function() {});
}

function isRunning() {
  return rcloneProc !== null && !rcloneProc.killed;
}

module.exports = { mountDrive, unmountDrive, openDrive, isRunning, MOUNT_DIR };
