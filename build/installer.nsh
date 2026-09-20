!include "StrFunc.nsh"
!ifndef BUILD_UNINSTALLER
  ${StrRep}
!endif

!macro customInstall
  CreateDirectory "$PROFILE\.codex-progress-hud"
  ${StrRep} $1 "$INSTDIR" "\" "\\"
  FileOpen $0 "$PROFILE\.codex-progress-hud\install.json" w
  FileWrite $0 "{$\"executablePath$\":$\"$1\\Codex Progress HUD.exe$\",$\"installDirectory$\":$\"$1$\",$\"version$\":$\"${VERSION}$\"}$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\stop-companion.ps1"'
  ; electron-builder also invokes this macro from the old uninstaller during
  ; upgrades. Never offer or perform user-data removal on that path.
  ${ifNot} ${isUpdated}
    Delete "$PROFILE\.codex-progress-hud\install.json"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Remove Codex Progress HUD local settings, token, logs, and diagnostics?" /SD IDNO IDNO keepUserData
      RMDir /r "$PROFILE\.codex-progress-hud"
    keepUserData:
  ${endif}
!macroend
