'use strict';

/**
 * main.js — Electron main process.
 * Manages: login window, tray icon, WebDAV server, drive mount/unmount, auto-start.
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');

// ─── Single instance lock ─────────────────────────────────────────────────────
// MUST be called before app.whenReady()
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── Lazy imports (avoids issues before app ready) ────────────────────────────
let auth, apiModule, webdavServer, drive;

function loadModules() {
  auth = require('./auth');
  apiModule = require('./api');
  webdavServer = require('./webdav-server');
  drive = require('./drive');
}

// ─── State ────────────────────────────────────────────────────────────────────
let tray = null;
let loginWindow = null;
let isConnected = false;
let currentToken = null;

// ─── Tray icon (hardcoded base64 PNG — 16x16 gold circle on dark background) ──
function createTrayIcon(connected) {
  // Minimal 16x16 PNG — gold circle on dark navy background
  // Generated offline; no external dependencies or buffer math
  const GOLD_ICON_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAX0lEQVQ4y2NgGAWkAkYGBob/DAwM/6mggZGBgeE/FTQwMjAw/KeCBkYGBob/VNDAyMDA8J8KGhgZGBj+U0EDIwMDw38qaGBkYGD4TwUNjAwMDP+poIGRgYHhPxU0AAArcBPd3kHETwAAAABJRU5ErkJggg==';
  const GREY_ICON_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAVUlEQVQ4y2NgGAWkAkYGBob/DAwM/6mggZGBgeE/FTQwMjAw/KeCBkYGBob/VNDAyMDA8J8KGhgZGBj+U0EDIwMDw38qaGBkYGD4TwUNjAwMDP+poIHRAAArcBPd3p4r0gAAAABJRU5ErkJggg==';

  try {
    const b64 = connected ? GOLD_ICON_B64 : GREY_ICON_B64;
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (!img.isEmpty()) return img;
  } catch (e) { /* fall through */ }

  // Ultimate fallback: empty image
  return nativeImage.createEmpty();
}

/**
 * Build a minimal PNG from raw RGBA pixels (no external deps).
 * Uses zlib (built into Node) for DEFLATE compression.
 */
function buildPNG(width, height, pixels) {
  const zlib = require('zlib');

  // Build raw image data (filter byte 0x00 before each row)
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      row.copy(row, 1 + x * 4, src, src); // noop copy placeholder
      row[1 + x * 4 + 0] = pixels[src + 0];
      row[1 + x * 4 + 1] = pixels[src + 1];
      row[1 + x * 4 + 2] = pixels[src + 2];
      row[1 + x * 4 + 3] = pixels[src + 3];
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);

  function crc32(buf) {
// ─── Tray menu ────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const statusLabel = isConnected
    ? 'DarkLion Drive (L:) ✓ Connected'
    : 'DarkLion Drive — Not Connected';

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Drive',
      enabled: isConnected,
      click: () => { if (drive) drive.openDrive(); },
    },
    { type: 'separator' },
    {
      label: 'Log Out',
      click: async () => {
        await disconnectDrive();
        if (auth) auth.clearAuth();
        showLoginWindow();
      },
    },
    {
      label: 'Quit',
      click: async () => {
        await disconnectDrive();
        app.quit();
      },
    },
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setImage(createTrayIcon(isConnected));
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(isConnected ? 'DarkLion Drive — Connected' : 'DarkLion Drive — Disconnected');
}

// ─── Login window ─────────────────────────────────────────────────────────────
function showLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  const appPath = app.getAppPath();
  loginWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    frame: true,
    title: 'DarkLion Drive — Login',
    backgroundColor: '#0f1724',
    webPreferences: {
      preload: path.join(appPath, 'app', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.loadFile(path.join(appPath, 'app', 'renderer', 'login.html'));
  loginWindow.setMenuBarVisibility(false);

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// ─── Connect / disconnect ─────────────────────────────────────────────────────
async function connectDrive(token) {
  try {
    console.log('[Main] Starting WebDAV server...');
    await webdavServer.startServer(() => {
      // Called when token is rejected — show login
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

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('login', async (event, { email, password }) => {
  try {
    const result = await apiModule.login(email, password);
    const { token, firm } = result;

    auth.saveAuth(token, email, firm?.name || '');

    // Close login window
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

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  loadModules();

  // Auto-start on Windows login
  app.setLoginItemSettings({ openAtLogin: true });

  // Create tray
  tray = new Tray(createTrayIcon(false));
  tray.setToolTip('DarkLion Drive');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => {
    if (isConnected) {
      drive.openDrive();
    } else {
      showLoginWindow();
    }
  });

  // Try auto-login with stored credentials
  const stored = auth.loadAuth();
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

app.on('second-instance', () => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
  }
});

app.on('window-all-closed', (e) => {
  // Prevent quit when all windows close — keep tray alive
  e.preventDefault();
});

app.on('before-quit', async () => {
  console.log('[Main] App quitting, cleaning up...');
  await disconnectDrive();
});

app.on('will-quit', async (e) => {
  // Extra safety net — ensure drive is unmounted
  if (isConnected) {
    e.preventDefault();
    await disconnectDrive();
    app.quit();
  }
});
