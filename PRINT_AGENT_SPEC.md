# DarkLion Print Agent — Full Spec

## What It Does
A Windows application that installs a virtual printer called "DarkLion Printer". When staff prints any document from any application, a small routing popup appears immediately. Staff selects client, year, and folder, then the PDF uploads directly to the correct docs tab in DarkLion.

## User Flow
1. Staff opens any document (PDF, Word, tax return from Drake, etc.)
2. File → Print → Select "DarkLion Printer"
3. A popup window appears immediately with:
   - **Document name** (auto-filled from print job title, editable)
   - **Client search** (type to search — same as CRM unified search)
   - **Year** (dropdown, defaults to current tax year)
   - **Folder** (Tax / Bookkeeping / Other — defaults to Tax)
   - **Section** (Delivered by Advisor / Private Staff Only)
   - **Upload** button + **Cancel** button
4. Click Upload → PDF goes to the correct person or company docs tab
5. Toast notification: "Uploaded to Smith Family · 2025 · Tax"

## Architecture

### Components
1. **Virtual PDF Printer Driver** — installs "DarkLion Printer" as a Windows printer using the built-in Windows PDF port monitor (XPS → PDF conversion, same tech as Microsoft Print to PDF). No third-party driver.
2. **Print Monitor Service** — Node.js Windows service (via `node-windows`) that watches the spool output folder for new PDFs.
3. **Routing UI** — Electron app (minimal, tray-based). On startup it's invisible. When a new PDF is detected, it opens a small window (400×500px) for routing.
4. **DarkLion API Client** — calls the existing `/api/documents/upload` endpoint with JWT auth.

### Auth
- First run: browser-based login to darklion.ai → JWT stored in Windows Credential Manager
- Subsequent runs: silent auth using stored token, refreshes automatically
- Per-user on RDS (each RDS session has its own credential store)

### RDS Server Support
- Install once on the RDS server as an administrator
- Virtual printer appears for ALL users on the server automatically
- Each user's routing popup is isolated (Electron runs per-user session)
- Service runs as SYSTEM, Electron runs in user context

## File & Folder Structure (repo: `darklion-print-agent`)
```
darklion-print-agent/
  installer/
    setup.iss          # Inno Setup installer script
    printer-setup.ps1  # PowerShell: registers XPS port monitor + printer
    printer-remove.ps1 # PowerShell: uninstalls printer on uninstall
  service/
    index.js           # Node.js Windows service — watches spool folder
    watcher.js         # Chokidar file watcher for new PDFs
    ipc.js             # Named pipe / IPC to notify Electron
    package.json
  app/
    main.js            # Electron main process
    preload.js         # Context bridge
    renderer/
      index.html       # Routing UI
      app.js           # Search, form, upload logic
      style.css
    auth.js            # JWT storage via Windows Credential Manager
    api.js             # DarkLion API calls (search, upload)
    package.json
  shared/
    config.js          # API base URL, spool path, etc.
```

## Key Technical Details

### Virtual Printer Setup (PowerShell)
```powershell
# Add XPS port (built into Windows)
Add-PrinterPort -Name "DarkLionPort:" -PrinterHostAddress "localhost"

# Add printer using built-in XPS driver  
Add-Printer -Name "DarkLion Printer" `
  -DriverName "Microsoft XPS Document Writer v4" `
  -PortName "DarkLionPort:"

# Configure output path (PDFs land here)
$spoolPath = "$env:PROGRAMDATA\DarkLion\Spool"
# ... registry entries to redirect XPS output to $spoolPath as PDF
```

### Service (node-windows)
```js
const Service = require('node-windows').Service;
const chokidar = require('chokidar');
const { createServer } = require('net'); // named pipe IPC

// Watch spool folder
chokidar.watch(SPOOL_PATH, { awaitWriteFinish: true })
  .on('add', filePath => {
    if (filePath.endsWith('.pdf') || filePath.endsWith('.xps')) {
      notifyElectron(filePath); // via named pipe
    }
  });
```

### Electron Routing UI
```js
// On IPC message from service: new file at filePath
ipcMain.on('new-print', (event, filePath) => {
  const win = new BrowserWindow({ width: 420, height: 520, ... });
  win.loadFile('renderer/index.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('file-ready', { path: filePath, name: basename(filePath) });
  });
});
```

### API Calls
```js
// Search clients (existing endpoint)
GET /api/search?q=smith
→ { relationships: [...], companies: [...], people: [...] }

// Upload document (existing endpoint)
POST /api/documents/upload
FormData: { file, owner_type, owner_id, year, folder_section, folder_category, display_name }
Headers: { Authorization: Bearer <jwt> }
```

## Installer
- Single `.exe` built with Inno Setup
- Runs `printer-setup.ps1` as admin during install
- Installs Node.js service and Electron app
- Adds Electron to Windows startup (per user)
- Uninstaller removes printer, service, and app cleanly

## RDS-Specific Notes
- Printer install runs once as admin → visible to all users
- Each user session runs their own Electron tray instance
- Service runs as SYSTEM (single instance for all users)
- Named pipe per-user: `\\.\pipe\darklion-print-{username}`
- Tested pattern: how Drake Tax and SmartVault do their RDS printing

## Build Dependencies
- Node.js 18+ (bundled in installer)
- Electron 28+
- `node-windows` (Windows service management)
- `chokidar` (file watcher)
- `electron-builder` (package + NSIS installer)
- `keytar` (Windows Credential Manager for JWT storage)
- Inno Setup (installer script compiler)

## DarkLion API Changes Needed
None. Uses existing endpoints:
- `GET /api/search?q=` — unified search
- `POST /api/documents/upload` — file upload
- `POST /auth/login` or token refresh endpoint (confirm which)

## Build Order
1. Virtual printer setup script (PowerShell) — test on Windows VM
2. Service: file watcher + named pipe IPC
3. Electron: routing UI (search + form + upload)  
4. Auth flow: login webview + token storage
5. Installer: Inno Setup script
6. RDS testing

## Estimated Timeline
- Sprint 1 (2 days): Printer driver + service + basic IPC working
- Sprint 2 (2 days): Electron routing UI + DarkLion API integration  
- Sprint 3 (1 day): Auth, installer, RDS testing
- Total: ~1 week to solid v1
