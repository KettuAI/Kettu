import { newSession } from '@renderer/app/actions'
import { focusedPane } from '@renderer/features/split/layout'
import {
  createTerminal,
  loadTerminals,
  terminalsOf,
  useTerminalsStore,
} from '@renderer/stores/terminals'
import { sessionsShown, toggleTerminal, useViewStore } from '@renderer/stores/view'

/**
 * Opens the terminal pane in the project's folder. The pane belongs to the project the main area
 * shows, so another project's opens its New session first.
 */
export async function openProjectTerminal(projectPath: string): Promise<void> {
  const s = useViewStore.getState()
  if (
    !s.settings.open &&
    sessionsShown(s.main) &&
    focusedPane(s.layout).view.projectPath === projectPath
  ) {
    // The pane starts a terminal itself when it opens in a project that has none.
    toggleTerminal(projectPath, true)
    return
  }
  newSession(projectPath)
  toggleTerminal(projectPath, true)
  // Shown together with its project, the pane leaves starting one to whoever switched.
  await loadTerminals(projectPath)
  if (terminalsOf(useTerminalsStore.getState().byId, projectPath).length === 0) {
    await createTerminal(projectPath)
  }
}
