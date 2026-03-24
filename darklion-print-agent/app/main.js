'use strict';

/**
 * DarkLion Print Agent - Electron Main Process
 *
 * - Runs as a tray icon (invisible on startup)
 * - Connects to the named pipe server exposed by the Windows service
 * - When a new print job arrives, opens the routing window
 * - Registers this session in active-sessions.json so the service knows to notify us
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const { storeToken, getToken, clearToken, isTokenExpired } = require('./auth');

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'DarkLion'
);
const SESSIONS_FILE = path.join(BASE_DIR, 'active-sessions.json');
const username = (process.env.USERNAME || os.userInfo().username || 'user').replace(/[^a-z0-9_-]/gi, '_');
const PIPE_NAME = `\\\\.\\pipe\\darklion-print-${username}`;

// ── State ────────────────────────────────────────────────────────────────────
let tray = null;
let loginWindow = null;
let routingWindows = new Map(); // filePath → BrowserWindow
let pipeServer = null;
let pendingJobs = []; // jobs queued while login is open

// ── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Single instance lock — only one Electron per user session
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // Register this user session so the service knows to notify us
  registerSession();

  // Set up tray icon
  setupTray();

  // Start listening on named pipe for messages from the service
  startPipeServer();

  // Check auth state on startup
  await checkAuth();
});

app.on('window-all-closed', () => {
  // Don't quit when all windows are closed — stay in tray
});

app.on('before-quit', () => {
  unregisterSession();
});

// ── Session registration ─────────────────────────────────────────────────────
function registerSession() {
  try {
    if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
    let data = { usernames: [] };
    if (fs.existsSync(SESSIONS_FILE)) {
      try { data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (_) {}
    }
    if (!data.usernames) data.usernames = [];
    if (!data.usernames.includes(username)) {
      data.usernames.push(username);
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.error('[main] Failed to register session:', err.message);
  }
}

function unregisterSession() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    data.usernames = (data.usernames || []).filter(u => u !== username);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data), 'utf8');
  } catch (_) {}
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function setupTray() {
  // Use a simple 16x16 PNG — the installer places icon.ico in the app dir
  const iconPath = path.join(__dirname, 'renderer', 'icon.ico');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('DarkLion Print Agent');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'DarkLion Print Agent',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Sign Out',
      click: async () => {
        await clearToken();
        showLoginWindow();
      },
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ── Named pipe server ────────────────────────────────────────────────────────
function startPipeServer() {
  pipeServer = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // last partial line stays in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          handleServiceMessage(msg);
        } catch (e) {
          console.error('[main] Bad IPC message:', line);
        }
      }
    });

    socket.on('error', (err) => {
      console.log('[main] Pipe socket error:', err.message);
    });
  });

  pipeServer.on('error', (err) => {
    console.error('[main] Pipe server error:', err.message);
    // Retry after 5s
    setTimeout(startPipeServer, 5000);
  });

  pipeServer.listen(PIPE_NAME, () => {
    console.log('[main] Listening on pipe:', PIPE_NAME);
  });
}

// ── Handle message from service ───────────────────────────────────────────────
async function handleServiceMessage(msg) {
  if (msg.event !== 'new-print') return;

  const { filePath, jobName } = msg;
  console.log('[main] New print job:', filePath);

  // Check auth before showing routing window
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    // Queue the job and show login
    pendingJobs.push({ filePath, jobName });
    showLoginWindow();
    return;
  }

  showRoutingWindow(filePath, jobName);
}

// ── Login window ─────────────────────────────────────────────────────────────
async function checkAuth() {
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    showLoginWindow();
  }
}

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
    title: 'DarkLion - Sign In',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.setMenu(null);
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// ── Routing window ────────────────────────────────────────────────────────────
function showRoutingWindow(filePath, jobName) {
  // Don't open duplicate windows for the same file
  if (routingWindows.has(filePath)) {
    const existing = routingWindows.get(filePath);
    if (!existing.isDestroyed()) {
      existing.focus();
      return;
    }
  }

  const win = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Route to DarkLion',
    alwaysOnTop: true,   // show above Drake, Excel, etc.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  routingWindows.set(filePath, win);

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('job-ready', {
      filePath,
      jobName: cleanJobName(jobName),
    });
  });

  win.on('closed', () => {
    routingWindows.delete(filePath);
    // Clean up the spool file if user closed without uploading
    // (they had a chance to upload — if they cancelled, delete the file)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_) {}
  });
}

/**
 * Clean up a job name derived from the spool filename.
 * e.g. "20250324_091523_job" → "Document" or extract meaningful part
 */
function cleanJobName(raw) {
  if (!raw) return 'Document';
  // Strip timestamp prefix like 20250324_091523_
  const cleaned = raw.replace(/^\d{8}_\d{6}_/, '');
  return cleaned || 'Document';
}

// ── IPC handlers (renderer → main) ───────────────────────────────────────────

// Renderer wants to search clients
ipcMain.handle('search', async (event, query) => {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');
  const { search } = require('./api');
  return search(query, token);
});

// Renderer wants to upload a document
ipcMain.handle('upload', async (event, { filePath, ownerType, ownerId, year, folderSection, folderCategory, displayName }) => {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');
  const { uploadDocument } = require('./api');
  return uploadDocument({ filePath, token, ownerType, ownerId, year, folderSection, folderCategory, displayName });
});

// Renderer confirms upload — close the window and delete spool file
ipcMain.on('upload-complete', (event, { filePath }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  routingWindows.delete(filePath);
  // Delete the spool file after successful upload
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
});

// Renderer cancelled — just close and clean up
ipcMain.on('cancel', (event, { filePath }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
});

// Login form submitted
ipcMain.handle('login', async (event, { email, password }) => {
  const { login } = require('./api');
  const result = await login(email, password);
  await storeToken(result.token);
  return result;
});

// Login succeeded — close login window, open any pending jobs
ipcMain.on('login-success', async (event) => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.destroy();
    loginWindow = null;
  }

  // Open routing windows for any queued jobs
  const jobs = [...pendingJobs];
  pendingJobs = [];
  for (const job of jobs) {
    showRoutingWindow(job.filePath, job.jobName);
  }
});

// Renderer requests logout
ipcMain.on('logout', async () => {
  await clearToken();
  showLoginWindow();
});
