; installer.nsh - Custom NSIS script for DarkLion Drive
; Injected into the electron-builder generated installer via nsis.include

!macro customInstall
  ; ── Check/Install WinFsp ────────────────────────────────────────────────────
  ; WinFsp is required for rclone mounting. Skip if already installed.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WinFsp" "DisplayName"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WinFsp" "DisplayName"
  ${EndIf}

  ${If} $0 == ""
    ; WinFsp not found — download and install it
    DetailPrint "WinFsp not found. Downloading installer..."
    NSISdl::download "https://github.com/winfsp/winfsp/releases/download/v2.0/winfsp-2.0.23075.msi" "$TEMP\winfsp.msi"
    Pop $0
    ${If} $0 == "success"
      DetailPrint "Installing WinFsp..."
      ExecWait '"msiexec" /i "$TEMP\winfsp.msi" /quiet /norestart' $0
      ${If} $0 != 0
        ${If} $0 != 3010
          MessageBox MB_ICONEXCLAMATION|MB_OK "WinFsp installation returned code $0. DarkLion Drive may not work correctly. Please install WinFsp manually from https://winfsp.dev/rel/"
        ${EndIf}
      ${EndIf}
      DetailPrint "WinFsp installation complete."
    ${Else}
      MessageBox MB_ICONEXCLAMATION|MB_OK "Could not download WinFsp. Please install it manually from https://winfsp.dev/rel/ before using DarkLion Drive."
    ${EndIf}
  ${Else}
    DetailPrint "WinFsp already installed: $0 — skipping."
  ${EndIf}
!macroend

!macro customUnInstall
  ; Intentionally leave WinFsp installed (other apps may depend on it)
!macroend
