'use strict';

var childProcess = require('child_process');
var spawn = childProcess.spawn;
var exec = childProcess.exec;
var path = require('path');
var fs = require('fs');
var os = require('os');

// Find rclone.exe - check multiple locations
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
    try {
      fs.accessSync(c);
      return c;
    } catch (e) {}
  }
  return 'rclone';
}

var rcloneProc = null;
var retries = 0;
var MAX_RETRIES = 3;
var onDisconnectCallback = null;
var currentToken = null;
var retryTimeout = null;

function mountDrive(token, onDisconnect) {
  unmountDrive();
  onDisconnectCallback = onDisconnect;
  currentToken = token;
  retries = 0;
  return doMount(token);
}

function doMount(token) {
  return new Promise(function(resolve, reject) {
    var rcloneBin = findRclone();
    var driveLetter = 'L:';

    // Write a temp rclone config file — avoids inline spec parsing issues with URLs/tokens
    var configPath = path.join(os.tmpdir(), 'darklion-rclone.conf');
    var configContent = '[darklion]\ntype = webdav\nurl = http://127.0.0.1:7891\nbearer_token = ' + token + '\n';
    fs.writeFileSync(configPath, configContent, 'utf8');

    var args = [
      'mount',
      'darklion:',
      driveLetter,
      '--config', configPath,
      '--volname', 'DarkLion Drive',
      '--vfs-cache-mode', 'writes',
      '--no-modtime',
      '--dir-cache-time', '30s',
      '--poll-interval', '30s',
      '--attr-timeout', '1s',
      '--log-level', 'ERROR',
      '--network-mode'
    ];

    console.log('[Rclone] Starting rclone mount with binary:', rcloneBin);

    rcloneProc = spawn(rcloneBin, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    var mounted = false;

    var mountTimeout = setTimeout(function() {
      if (!mounted) {
        reject(new Error('Rclone mount timed out after 15 seconds'));
      }
    }, 15000);

    rcloneProc.stderr.on('data', function(data) {
      var msg = data.toString();
      console.log('[Rclone] stderr:', msg);
      if (msg.indexOf('Fatal error') !== -1 || msg.indexOf('mount failed') !== -1 || msg.indexOf('failed to mount') !== -1) {
        clearTimeout(mountTimeout);
        if (!mounted) {
          reject(new Error(msg.trim()));
        }
      }
    });

    rcloneProc.stdout.on('data', function(data) {
      console.log('[Rclone] stdout:', data.toString());
    });

    // rclone mount does not print a "ready" line on success
    // Assume mounted after 3s if no fatal error was reported
    setTimeout(function() {
      if (!mounted && rcloneProc && !rcloneProc.killed) {
        mounted = true;
        clearTimeout(mountTimeout);
        console.log('[Rclone] Assuming mounted after 3s (no fatal error seen)');
        resolve();
      }
    }, 3000);

    rcloneProc.on('exit', function(code) {
      console.log('[Rclone] Process exited with code:', code);
      rcloneProc = null;

      if (mounted) {
        // Drive was connected and now dropped — attempt retry or notify disconnect
        if (retries < MAX_RETRIES && currentToken) {
          retries++;
          console.log('[Rclone] Attempting reconnect, try ' + retries + ' of ' + MAX_RETRIES);
          retryTimeout = setTimeout(function() {
            doMount(currentToken).then(function() {
              console.log('[Rclone] Reconnected successfully');
            }).catch(function(err) {
              console.error('[Rclone] Reconnect failed:', err.message);
              if (onDisconnectCallback) {
                onDisconnectCallback();
              }
            });
          }, 2000);
        } else {
          if (onDisconnectCallback) {
            onDisconnectCallback();
          }
        }
      }
    });

    rcloneProc.on('error', function(err) {
      clearTimeout(mountTimeout);
      console.error('[Rclone] Process error:', err.message);
      if (!mounted) {
        reject(err);
      }
    });
  });
}

function unmountDrive() {
  return new Promise(function(resolve) {
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    currentToken = null;
    retries = 0;

    if (rcloneProc && !rcloneProc.killed) {
      rcloneProc.kill('SIGTERM');
      var proc = rcloneProc;
      setTimeout(function() {
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
        rcloneProc = null;
        resolve();
      }, 2000);
    } else {
      rcloneProc = null;
      resolve();
    }
  });
}

function openDrive() {
  // Use shell: true to open drive letter correctly
  var shell = require('electron').shell;
  if (shell) {
    shell.openPath('L:\\').catch(function(e) {
      console.warn('[Rclone] shell.openPath failed:', e);
    });
  } else {
    exec('start explorer.exe L:', { shell: true }, function(err) {
      if (err) console.warn('[Rclone] Could not open Explorer:', err.message);
    });
  }
}

function isRunning() {
  return rcloneProc !== null && !rcloneProc.killed;
}

module.exports = { mountDrive, unmountDrive, openDrive, isRunning };
