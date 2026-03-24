; installer.nsh — Custom NSIS macros for DarkLion Print Agent
; electron-builder automatically includes this file when it exists in build/
; Docs: https://www.electron.build/nsis#custom-nsis-script

!macro customInstall
  ; ── Step 1: Install Ghostscript if not already present ────────────────────
  DetailPrint "Checking for Ghostscript..."
  IfFileExists "C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe" gs_done gs_needed

  gs_needed:
    DetailPrint "Downloading Ghostscript (required for PDF conversion)..."
    inetc::get \
      "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10031/gs10031w64.exe" \
      "$PLUGINSDIR\gs_setup.exe" \
      /END
    Pop $0
    StrCmp $0 "OK" gs_run gs_fail

    gs_fail:
      MessageBox MB_OK|MB_ICONEXCLAMATION "Could not download Ghostscript. Please check your internet connection and try again."
      Abort

    gs_run:
      DetailPrint "Installing Ghostscript..."
      ExecWait '"$PLUGINSDIR\gs_setup.exe" /S' $0
      DetailPrint "Ghostscript installer returned: $0"

  gs_done:
    DetailPrint "Ghostscript ready."

  ; ── Step 2: Copy Redmon DLL and setup scripts to temp location ─────────────
  SetOutPath "$PLUGINSDIR\darklion-setup"
  File "${BUILD_RESOURCES_DIR}\redmon64.dll"
  File "${BUILD_RESOURCES_DIR}\printer-setup.ps1"

  ; ── Step 3: Install DarkLion Printer via PowerShell ───────────────────────
  DetailPrint "Installing DarkLion Printer..."
  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -NonInteractive -File \
    "$PLUGINSDIR\darklion-setup\printer-setup.ps1" \
    -RedmonDll "$PLUGINSDIR\darklion-setup\redmon64.dll"'
  Pop $0
  DetailPrint "Printer setup returned: $0"

  ; ── Step 4: Register app to auto-start for current user ───────────────────
  WriteRegStr HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" \
    "DarkLionPrintAgent" "$INSTDIR\DarkLion Print Agent.exe"

!macroend

!macro customUnInstall
  ; ── Remove the printer ─────────────────────────────────────────────────────
  SetOutPath "$PLUGINSDIR\darklion-setup"
  File "${BUILD_RESOURCES_DIR}\printer-remove.ps1"

  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -NonInteractive -File \
    "$PLUGINSDIR\darklion-setup\printer-remove.ps1"'

  ; ── Remove auto-start entry ────────────────────────────────────────────────
  DeleteRegValue HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "DarkLionPrintAgent"

!macroend
