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

// ─── Tray icon (programmatic gold circle on dark background) ──────────────────
function createTrayIcon(connected) {
  const { createCanvas } = (() => {
    try { return require('canvas'); } catch { return null; }
  })() || {};

  // Fallback: build a simple PNG programmatically using raw pixel data
  // 16x16 PNG with dark background and gold circle
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);

  const bgR = 0x1a, bgG = 0x1a, bgB = 0x2e; // dark navy
  const fgR = connected ? 0xf0 : 0x88;
  const fgG = connected ? 0xb9 : 0x88;
  const fgB = connected ? 0x00 : 0x88;
  const cx = 7.5, cy = 7.5, radius = 5.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= radius) {
        pixels[idx] = fgR;
        pixels[idx + 1] = fgG;
        pixels[idx + 2] = fgB;
        pixels[idx + 3] = 255;
      } else {
        pixels[idx] = bgR;
        pixels[idx + 1] = bgG;
        pixels[idx + 2] = bgB;
        pixels[idx + 3] = 255;
      }
    }
  }

  // Build a raw PNG using pure JS (no external deps)
  const png = buildPNG(size, size, pixels);
  return nativeImage.createFromBuffer(png);
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
    let crc = 0xffffffff;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([typeBytes, data]);
    const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, typeBytes, data, crcVal]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
