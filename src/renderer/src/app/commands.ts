import { useEffect } from 'react'
import { askRemoveDevice } from '@renderer/features/settings/device-remove'
import { recordAction, watchNavigation } from '@renderer/lib/action-log'
import { confirmDebugRestart } from '@renderer/stores/debug'
import { showQuitHint } from '@renderer/stores/quit-hint'
import { openReport } from '@renderer/stores/report'
import { useSessionsStore } from '@renderer/stores/sessions'
import { askUpdateList, checkForUpdates } from '@renderer/stores/updates'
import { useTasksStore } from '@renderer/stores/tasks'
import {
  openRoutines,
  openSession,
  openSettings,
  openTask,
  openUsage,
  toggleSidebar,
  type SettingsSection,
} from '@renderer/stores/view'
import { newSession, openProjectDialog } from './actions'
import { setWindowHidden } from './bootstrap'
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
          case 'remove-device':
            askRemoveDevice(null, command.deviceId)
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
          case 'open-usage':
            openUsage()
            break
          case 'open-updates':
            askUpdateList()
            break
          case 'open-task':
            if (useTasksStore.getState().summaries[command.taskId]) openTask(command.taskId)
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
          case 'quit-hint':
            showQuitHint(command.countdown)
            break
          case 'confirm-debug-restart':
            confirmDebugRestart()
            break
          case 'window-hidden':
            setWindowHidden(true)
            break
          case 'window-shown':
            setWindowHidden(false)
            break
          case 'report-problem':
            void openReport(
              command.span
                ? {
                    origin: 'recording',
                    range: { kind: 'span', ...command.span },
                    extras: ['verbose'],
                  }
                : {},
            )
            break
        }
      }),
    [],
  )
}
