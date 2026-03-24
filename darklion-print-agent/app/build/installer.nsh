; installer.nsh — Custom NSIS macros for DarkLion Print Agent
; Uses TCP/IP port approach — no Redmon DLL needed.
; electron-builder automatically includes this file when it exists in build/

!macro customInstall
  ; ── Step 1: Install Ghostscript if not already present ────────────────────
  DetailPrint "Checking for Ghostscript..."
  IfFileExists "C:\Program Files\gs\*.*" gs_done gs_needed

  gs_needed:
    DetailPrint "Downloading Ghostscript (required for PDF conversion)..."
    inetc::get \
      "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10031/gs10031w64.exe" \
      "$PLUGINSDIR\gs_setup.exe" \
      /END
    Pop $0
    StrCmp $0 "OK" gs_run gs_fail

    gs_fail:
      MessageBox MB_OK|MB_ICONEXCLAMATION "Could not download Ghostscript. Please check your internet connection and try again.$\nAfter connecting, re-run this installer."
      Abort

    gs_run:
      DetailPrint "Installing Ghostscript silently..."
      ExecWait '"$PLUGINSDIR\gs_setup.exe" /S' $0
      DetailPrint "Ghostscript installer exited: $0"

  gs_done:
    DetailPrint "Ghostscript is ready."

  ; ── Step 2: Run printer setup PowerShell script ────────────────────────────
  DetailPrint "Installing DarkLion Printer..."
  SetOutPath "$PLUGINSDIR\darklion-setup"
  File "${BUILD_RESOURCES_DIR}\printer-setup.ps1"

  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "$PLUGINSDIR\darklion-setup\printer-setup.ps1"'
  Pop $0
  DetailPrint "Printer setup exited: $0"

  ; ── Step 3: Register app to auto-start for current user ───────────────────
  WriteRegStr HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "DarkLionPrintAgent" "$INSTDIR\DarkLion Print Agent.exe"

!macroend

!macro customUnInstall
  ; ── Remove printer and port ────────────────────────────────────────────────
  SetOutPath "$PLUGINSDIR\darklion-setup"
  File "${BUILD_RESOURCES_DIR}\printer-remove.ps1"
  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "$PLUGINSDIR\darklion-setup\printer-remove.ps1"'

  ; ── Remove auto-start ─────────────────────────────────────────────────────
  DeleteRegValue HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "DarkLionPrintAgent"

!macroend
