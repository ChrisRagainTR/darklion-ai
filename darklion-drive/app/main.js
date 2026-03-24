'use strict';

var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var ipcMain = electron.ipcMain;
var Tray = electron.Tray;
var Menu = electron.Menu;
var nativeImage = electron.nativeImage;
var path = require('path');

// Single instance lock - MUST be before app.whenReady()
var gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Lazy-loaded modules
var auth = null;
var apiModule = null;
var webdavServer = null;
var drive = null;

function loadModules() {
  auth = require('./auth');
  apiModule = require('./api');
  webdavServer = require('./webdav-server');
  drive = require('./drive');
}

// App state
var tray = null;
var loginWindow = null;
var isConnected = false;
var currentToken = null;

// Tray icons as base64 PNGs (16x16)
// GOLD = connected state, GREY = disconnected state
var GOLD_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGPgF1f5TwlmGJwGnFzhgxUTZQAuzbgMYSBFMzZDRg2gtgEURyNVEtLgyAukYACSBsiYUYvh7QAAAABJRU5ErkJggg==';
var GREY_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGPgF1f5TwlmGJwGpKSkYMVEGYBLMy5DGEjRjM2QUQOobQDF0UiVhDQ48gIpGAAJd5bAmYtGRwAAAABJRU5ErkJggg==';

function createTrayIcon(connected) {
  try {
    var b64 = connected ? GOLD_ICON_B64 : GREY_ICON_B64;
    var img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (!img.isEmpty()) return img;
  } catch (e) {
    // fall through to empty
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  var statusLabel = isConnected
    ? 'DarkLion Drive (L:)  Connected'
    : 'DarkLion Drive -- Not Connected';

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Drive',
      enabled: isConnected,
      click: function() {
        if (drive) drive.openDrive();
      }
    },
    { type: 'separator' },
    {
      label: 'Log Out',
      click: function() {
        disconnectDrive().then(function() {
          if (auth) auth.clearAuth();
          showLoginWindow();
        });
      }
    },
    {
      label: 'Quit',
      click: function() {
        disconnectDrive().then(function() {
          app.quit();
        });
      }
    }
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setImage(createTrayIcon(isConnected));
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(isConnected ? 'DarkLion Drive -- Connected' : 'DarkLion Drive -- Disconnected');
}

function showLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  var appPath = app.getAppPath();

  loginWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    frame: true,
    title: 'DarkLion Drive -- Login',
    backgroundColor: '#0f1724',
    webPreferences: {
      preload: path.join(appPath, 'app', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loginWindow.loadFile(path.join(appPath, 'app', 'renderer', 'login.html'));
  loginWindow.setMenuBarVisibility(false);

  loginWindow.on('closed', function() {
    loginWindow = null;
  });
}

// Called when rclone unexpectedly disconnects (crash, auth error, etc.)
function onDriveDisconnected() {
  console.log('[Main] Drive disconnected unexpectedly');
  isConnected = false;
  currentToken = null;
  updateTray();
  if (auth) auth.clearAuth();
  showLoginWindow();
}

function connectDrive(token) {
  console.log('[Main] Starting WebDAV server on port 7891...');
  return webdavServer.startServer(function() {
    // Called when WebDAV server gets a 401 from the API (token expired)
    console.log('[Main] Token expired, showing login');
    isConnected = false;
    currentToken = null;
    if (drive) drive.unmountDrive();
    if (auth) auth.clearAuth();
    updateTray();
    showLoginWindow();
  }).then(function() {
    console.log('[Main] Mounting drive via rclone...');
    return drive.mountDrive(token, onDriveDisconnected);
  }).then(function() {
    isConnected = true;
    currentToken = token;
    updateTray();
    console.log('[Main] Drive connected successfully on L:');
    return true;
  }).catch(function(err) {
    console.error('[Main] connectDrive failed:', err.message);
    isConnected = false;
    currentToken = null;
    updateTray();
    throw err;
  });
}

function disconnectDrive() {
  var p = Promise.resolve();
  if (drive) {
    p = p.then(function() {
      return drive.unmountDrive();
    }).catch(function(e) {
      console.warn('[Main] Unmount error:', e.message);
    });
  }
  if (webdavServer) {
    p = p.then(function() {
      return webdavServer.stopServer();
    }).catch(function(e) {
      console.warn('[Main] Stop server error:', e.message);
    });
  }
  return p.then(function() {
    isConnected = false;
    currentToken = null;
    updateTray();
  });
}

// IPC: login handler
ipcMain.handle('login', function(event, creds) {
  return apiModule.login(creds.email, creds.password).then(function(result) {
    var token = result.token;
    var firm = result.firm;

    auth.saveAuth(token, creds.email, (firm && firm.name) || '');

    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.close();
    }

    return connectDrive(token).then(function() {
      return { success: true };
    });
  }).catch(function(err) {
    console.error('[IPC] Login error:', err.message);
    return { success: false, error: err.message || 'Login failed' };
  });
});

ipcMain.handle('get-version', function() {
  return app.getVersion();
});

// App ready
app.whenReady().then(function() {
  loadModules();

  // Auto-start on Windows login
  app.setLoginItemSettings({ openAtLogin: true });

  // Create system tray icon (disconnected state initially)
  tray = new Tray(createTrayIcon(false));
  tray.setToolTip('DarkLion Drive');
  tray.setContextMenu(buildTrayMenu());

  tray.on('double-click', function() {
    if (isConnected) {
      drive.openDrive();
    } else {
      showLoginWindow();
    }
  });

  // Try auto-connect if we have a stored token
  var stored = auth.loadAuth();
  if (stored && stored.token) {
    console.log('[Main] Found stored token, attempting auto-connect...');
    connectDrive(stored.token).then(function() {
      console.log('[Main] Auto-connect successful');
    }).catch(function(err) {
      console.warn('[Main] Auto-connect failed, showing login:', err.message);
      auth.clearAuth();
      showLoginWindow();
    });
  } else {
    showLoginWindow();
  }
});

// Focus existing window if second instance launched
app.on('second-instance', function() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
  }
});

// Keep app alive even with no windows open (lives in tray)
app.on('window-all-closed', function(e) {
  e.preventDefault();
});

// Clean up before quit
app.on('before-quit', function() {
  console.log('[Main] App quitting, cleaning up...');
  disconnectDrive();
});
