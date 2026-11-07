import { useEffect } from 'react'
import { recordAction, watchNavigation } from '@renderer/lib/action-log'
import { confirmDebugRestart } from '@renderer/stores/debug'
import { useSessionsStore } from '@renderer/stores/sessions'
import { checkForUpdates } from '@renderer/stores/updates'
import {
  openRoutines,
  openSession,
  openSettings,
  toggleSidebar,
  type SettingsSection,
} from '@renderer/stores/view'
import { newSession, openProjectDialog } from './actions'
import { closeCurrent } from './close'
import { back, forward, toggleHistory } from './history'
import { layerOpen } from './shortcuts'

/** Records where the window goes, for the log. */
export function useActionLog(): void {
  useEffect(() => watchNavigation(), [])
}

/** Commands from main: the app menu and notification clicks. */
export function useAppCommands(): void {
  useEffect(
    () =>
      window.kettu.app.onCommand((command) => {
        recordAction(`command.${command.kind}`)
        switch (command.kind) {
          case 'open-project':
            void openProjectDialog()
            break
          case 'new-session':
            newSession()
            break
          case 'open-settings':
            openSettings((command.section as SettingsSection | undefined) ?? null)
            if (command.section === 'about') void checkForUpdates()
            break
          case 'toggle-sidebar':
            toggleSidebar()
            break
          case 'open-session': {
            const summary = useSessionsStore.getState().byId[command.sessionId]
            if (summary) openSession(summary.id, summary.projectPath)
            break
          }
          case 'open-routines':
            openRoutines()
            break
          // The menu has these keys when the page leaves them, as it does under a dialog or menu.
          case 'go-back':
            if (!layerOpen()) back()
            break
          case 'go-forward':
            if (!layerOpen()) forward()
            break
          case 'show-history':
            toggleHistory(layerOpen())
            break
          case 'close':
            if (!closeCurrent(command.browser)) window.kettu.app.closeWindow()
            break
          case 'confirm-debug-restart':
            confirmDebugRestart()
            break
        }
      }),
    [],
  )
}
