'use strict';

/**
 * DarkLion Print Agent - Electron Main Process
 *
 * Simplified architecture: Electron handles everything.
 * - Tray icon (invisible on startup)
 * - Chokidar watches the spool folder directly (no separate Windows service)
 * - When a new PDF lands, opens the routing window
 * - JWT auth via Windows Credential Manager (keytar)
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { storeToken, getToken, clearToken, isTokenExpired } = require('./auth');
const { startPrintServer, stopPrintServer } = require('./print-server');

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'DarkLion'
);

// ── State ────────────────────────────────────────────────────────────────────
let tray = null;
let loginWindow = null;
let routingWindows = new Map(); // filePath → BrowserWindow
let pendingJobs = []; // jobs queued while login window is open

// ── Single instance lock (must be before whenReady per Electron docs) ─────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Ensure spool directory exists
  if (!fs.existsSync(SPOOL_DIR)) {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
  }

  setupTray();
  startPrintServer(handleNewPrintJob);
  await checkAuth();
});

// Second instance launched — just focus existing
app.on('second-instance', () => {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.focus();
});

// Don't quit when all windows are closed — stay in tray
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  stopPrintServer();
});

// ── Tray ─────────────────────────────────────────────────────────────────────
function setupTray() {
  try {
    // Create a simple 16x16 colored icon programmatically — no .ico file needed
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFZSURBVDiNpdMxSBtxFAbw3+UuuTReQkZBLEoGwcHBRQcHwUVwEJcOgpuDm4ODg4iDg4ODi4ODg4ODg4ODg4ODg4OD4ODg4ODg4ODg4ODg4OD4ODg4Lg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4AA=='
    );
    tray = new Tray(icon);
    tray.setToolTip('DarkLion Print Agent');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'DarkLion Print Agent', enabled: false },
      { type: 'separator' },
      { label: 'Sign Out', click: async () => { await clearToken(); showLoginWindow(); } },
      { label: 'Quit', click: () => app.quit() },
    ]));
  } catch (err) {
    console.error('[tray] Failed to create tray:', err.message);
    // Continue without tray — app still works via login window
  }
}


// ── Handle new print job ──────────────────────────────────────────────────────
async function handleNewPrintJob(filePath) {
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    pendingJobs.push(filePath);
    showLoginWindow();
    return;
  }
  showRoutingWindow(filePath);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    showLoginWindow();
  }
}

// ── Login window ──────────────────────────────────────────────────────────────
function showLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 400,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'DarkLion — Sign In',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loginWindow.setMenu(null);
  loginWindow.loadFile('login.html');
  loginWindow.on('closed', () => { loginWindow = null; });
}

// ── Routing window ────────────────────────────────────────────────────────────
function showRoutingWindow(filePath) {
  if (routingWindows.has(filePath)) {
    const existing = routingWindows.get(filePath);
    if (!existing.isDestroyed()) { existing.focus(); return; }
  }

  const jobName = cleanJobName(path.basename(filePath, '.pdf'));

  const win = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Route to DarkLion',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenu(null);
  win.loadFile('index.html');
  routingWindows.set(filePath, win);

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('job-ready', { filePath, jobName });
  });

  win.on('closed', () => {
    routingWindows.delete(filePath);
    // Clean up spool file if user closed without uploading
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
  });
}

function cleanJobName(raw) {
  if (!raw) return 'Document';
  return raw.replace(/^\d{8}_\d{6}_/, '') || 'Document';
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('search', async (event, query) => {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');
  return require('./api').search(query, token);
});

ipcMain.handle('upload', async (event, params) => {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');
  return require('./api').uploadDocument({ ...params, token });
});

ipcMain.on('upload-complete', (event, { filePath }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.destroy();
  routingWindows.delete(filePath);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
});

ipcMain.on('cancel', (event, { filePath }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.destroy();
});

ipcMain.handle('login', async (event, { email, password }) => {
  const result = await require('./api').login(email, password);
  await storeToken(result.token);
  return result;
});

ipcMain.on('login-success', async () => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.destroy();
    loginWindow = null;
  }
  const jobs = [...pendingJobs];
  pendingJobs = [];
  for (const fp of jobs) showRoutingWindow(fp);
});

ipcMain.on('logout', async () => {
  await clearToken();
  showLoginWindow();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
