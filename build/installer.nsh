!include "StrFunc.nsh"
!ifndef BUILD_UNINSTALLER
  ${StrRep}
!endif

!macro customInstall
  CreateDirectory "$APPDATA\codex-progress-hud"
  ${StrRep} $1 "$INSTDIR" "\" "\\"
  FileOpen $0 "$APPDATA\codex-progress-hud\install.json" w
  FileWrite $0 "{$\"executablePath$\":$\"$1\\Codex Progress HUD.exe$\",$\"installDirectory$\":$\"$1$\",$\"version$\":$\"${VERSION}$\"}$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\stop-companion.ps1"'
  Delete "$APPDATA\codex-progress-hud\install.json"
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove Codex Progress HUD local settings, token, logs, and diagnostics?" IDNO keepUserData
    RMDir /r "$APPDATA\codex-progress-hud"
  keepUserData:
!macroend
