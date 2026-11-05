import { useEffect } from 'react'
import { usedFilesPane } from '@renderer/features/files/pane-focus'
import { closeActiveFile } from '@renderer/stores/files'
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
import { back, forward, toggleHistory } from './history'
import { layerOpen } from './shortcuts'

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
          case 'close': {
            const project = usedFilesPane()
            if (!project || !closeActiveFile(project)) window.kettu.app.closeWindow()
            break
          }
        }
      }),
    [],
  )
}
