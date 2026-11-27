; Custom NSIS hooks for Kettu's Windows assisted installer.
; Included by electron-builder via nsis.include in electron-builder.yml.

!macro customInstall
  ; When updating in place with keepShortcuts=true, electron-builder skips recreating shortcuts
  ; whose filename did not change. Refresh the Start Menu shortcut and any existing Desktop
  ; shortcut so their target executable, working directory, icon, and AppUserModelId stay in sync
  ; with the newly installed binary.
  SetOutPath "$INSTDIR"

  ${if} $keepShortcuts == "true"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      ${ifNot} ${isNoDesktopShortcut}
        ${if} ${FileExists} "$newDesktopLink"
          CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
          ClearErrors
          WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
        ${endIf}
      ${endIf}
    !endif
  ${endIf}

  ; In per-machine mode, electron-builder uninstalls any previous per-user copy via
  ; uninstallOldVersion HKEY_CURRENT_USER. Because installUtil.nsh checks FileExists "$appExe"
  ; (the per-machine path), it can pass --keep-shortcuts to the per-user uninstaller, leaving
  ; broken per-user shortcuts pointing at the removed per-user executable. Remove those stale links.
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !ifndef ONE_CLICK
      ${if} $installMode == "all"
      ${andIf} $hasPerUserInstallation == "1"
        SetShellVarContext current
        !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
          ${if} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
            WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
            Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
          ${endIf}
        !endif
        !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
          !ifdef MENU_FILENAME
            ${if} ${FileExists} "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
              WinShell::UninstShortcut "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
              Delete "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
              RMDir "$SMPROGRAMS\${MENU_FILENAME}"
            ${endIf}
          !else
            ${if} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
              WinShell::UninstShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
              Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
            ${endIf}
          !endif
        !endif
        SetShellVarContext all
      ${endIf}
    !endif
  !endif

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

  ; Launch the freshly installed executable directly rather than through the Start Menu .lnk.
  ; Passing --updated to a .lnk via StdUtils.ExecShellAsUser can fail or resolve a stale target
  ; on Windows, leaving the app closed after a silent update.
  StrCpy $launchLink "$appExe"
!macroend
