import { useEffect } from 'react'
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

/** Commands from main: the app menu and notification clicks. */
export function useAppCommands(): void {
  useEffect(
    () =>
      window.kettu.app.onCommand((command) => {
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
        }
      }),
    [],
  )
}
