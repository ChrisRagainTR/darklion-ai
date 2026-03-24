; installer.nsh - Custom NSIS script for DarkLion Drive
; Injected into the electron-builder generated installer via nsis.include
;
; Responsibilities:
;   1. Silently install WinFsp (required for rclone --network-mode mounting)
;   2. rclone.exe is bundled into app resources by electron-builder extraResources

!macro customInstall
  ; ── Install WinFsp ──────────────────────────────────────────────────────────
  ; winfsp.msi is included via extraResources and lands in $INSTDIR\resources\winfsp.msi
  DetailPrint "Installing WinFsp filesystem driver..."
  ExecWait '"msiexec" /i "$INSTDIR\resources\winfsp.msi" /quiet /norestart' $0
  ${If} $0 != 0
    ${If} $0 != 3010
      ; 3010 = success but reboot required - acceptable
      MessageBox MB_ICONEXCLAMATION|MB_OK "WinFsp installation returned code $0. DarkLion Drive may not work correctly. Please install WinFsp manually from https://winfsp.dev/rel/"
    ${EndIf}
  ${EndIf}
  DetailPrint "WinFsp installation complete (code: $0)"
!macroend

!macro customUnInstall
  ; Nothing extra needed on uninstall
  ; We intentionally leave WinFsp installed (other apps may use it)
!macroend
