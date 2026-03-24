'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

// Must be before app.whenReady()
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Lazy imports
let auth, apiModule, webdavServer, drive;

function loadModules() {
  auth = require('./auth');
  apiModule = require('./api');
  webdavServer = require('./webdav-server');
  drive = require('./drive');
}

// State
let tray = null;
let loginWindow = null;
let isConnected = false;
let currentToken = null;

// Valid 16x16 PNGs generated with Node zlib
const GOLD_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGPgF1f5TwlmGJwGnFzhgxUTZQAuzbgMYSBFMzZDRg2gtgEURyNVEtLgyAukYACSBsiYUYvh7QAAAABJRU5ErkJggg==';
const GREY_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGPgF1f5TwlmGJwGpKSkYMVEGYBLMy5DGEjRjM2QUQOobQDF0UiVhDQ48gIpGAAJd5bAmYtGRwAAAABJRU5ErkJggg==';

function createTrayIcon(connected) {
  try {
    const b64 = connected ? GOLD_ICON_B64 : GREY_ICON_B64;
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (!img.isEmpty()) return img;
  } catch (e) {
    // ignore
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const statusLabel = isConnected
    ? 'DarkLion Drive (L:)  Connected'
    : 'DarkLion Drive -- Not Connected';

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Drive',
      enabled: isConnected,
      click: function() { if (drive) drive.openDrive(); }
    },
    { type: 'separator' },
    {
      label: 'Log Out',
      click: async function() {
        await disconnectDrive();
        if (auth) auth.clearAuth();
        showLoginWindow();
      }
    },
    {
      label: 'Quit',
      click: async function() {
        await disconnectDrive();
        app.quit();
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

async function connectDrive(token) {
  try {
    console.log('[Main] Starting WebDAV server...');
    await webdavServer.startServer(function() {
      console.log('[Main] Token expired, showing login');
      isConnected = false;
      currentToken = null;
      if (auth) auth.clearAuth();
      updateTray();
      showLoginWindow();
    });

    console.log('[Main] Mounting drive...');
    await drive.mountDrive(token);

    isConnected = true;
    currentToken = token;
    updateTray();
    console.log('[Main] Drive connected successfully');
    return true;
  } catch (err) {
    console.error('[Main] connectDrive failed:', err.message);
    isConnected = false;
    currentToken = null;
    updateTray();
    throw err;
  }
}

async function disconnectDrive() {
  try {
    if (drive) await drive.unmountDrive();
  } catch (e) {
    console.warn('[Main] Unmount error:', e.message);
  }
  try {
    if (webdavServer) await webdavServer.stopServer();
  } catch (e) {
    console.warn('[Main] Stop server error:', e.message);
  }
  isConnected = false;
  currentToken = null;
  updateTray();
}

ipcMain.handle('login', async function(event, creds) {
  try {
    var result = await apiModule.login(creds.email, creds.password);
    var token = result.token;
    var firm = result.firm;

    auth.saveAuth(token, creds.email, (firm && firm.name) || '');

    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.close();
    }

    await connectDrive(token);
    return { success: true };
  } catch (err) {
    console.error('[IPC] Login error:', err.message);
    return { success: false, error: err.message || 'Login failed' };
  }
});

ipcMain.handle('get-version', function() {
  return app.getVersion();
});

app.whenReady().then(async function() {
  loadModules();

  app.setLoginItemSettings({ openAtLogin: true });

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

  var stored = auth.loadAuth();
  if (stored && stored.token) {
    console.log('[Main] Found stored token, attempting auto-connect...');
    try {
      await connectDrive(stored.token);
      console.log('[Main] Auto-connect successful');
    } catch (err) {
      console.warn('[Main] Auto-connect failed, showing login:', err.message);
      auth.clearAuth();
      showLoginWindow();
    }
  } else {
    showLoginWindow();
  }
});

app.on('second-instance', function() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
  }
});

app.on('window-all-closed', function(e) {
  e.preventDefault();
});

app.on('before-quit', async function() {
  console.log('[Main] App quitting, cleaning up...');
  await disconnectDrive();
});

app.on('will-quit', async function(e) {
  if (isConnected) {
    e.preventDefault();
    await disconnectDrive();
    app.quit();
  }
});
