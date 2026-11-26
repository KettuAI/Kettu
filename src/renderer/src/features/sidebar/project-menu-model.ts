import { newSession } from '@renderer/app/actions'
import { focusedPane } from '@renderer/features/split/layout'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  createTerminal,
  loadTerminals,
  terminalsOf,
  useTerminalsStore,
} from '@renderer/stores/terminals'
import {
  newSessionPanel,
  paneProjectPath,
  panelOf,
  sessionsShown,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'

/**
 * Opens the terminal pane in the project's folder: in the side panel in view when its session or
 * New session works in the project, else in the project's New session, which opens first.
 */
export async function openProjectTerminal(projectPath: string): Promise<void> {
  const s = useViewStore.getState()
  const projects = useProjectsStore.getState().projects
  const focused = focusedPane(s.layout).view
  const panel = panelOf(focused, s.projectPath, projects)
  const focusedPath = paneProjectPath(focused, s.projectPath, projects)
  if (!s.settings.open && sessionsShown(s.main) && focusedPath === projectPath && panel) {
    // The pane starts a terminal itself when it opens in a panel that has none.
    toggleTerminal(panel, true)
    return
  }
  newSession(projectPath)
  const draft = newSessionPanel(projectPath)
  toggleTerminal(draft, true)
  // Shown together with its New session, the pane leaves starting one to whoever switched.
  await loadTerminals(projectPath, draft)
  if (terminalsOf(useTerminalsStore.getState().byId, draft).length === 0) {
    await createTerminal(projectPath, draft)
  }
}
