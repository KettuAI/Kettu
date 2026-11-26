import { focusedPane } from '@renderer/features/split/layout'
import { setGitPaneTab, type GitPaneTab } from '@renderer/stores/git'
import { useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { paneProjectPath, panelOf, toggleSidePane, useViewStore } from '@renderer/stores/view'

export interface OpenGitPane {
  tab: GitPaneTab
  /**
   * Opens the commit box too: its focus, the files it is for, or all of them with null, and
   * whether Mod+Enter commits and pushes.
   */
  commit?: { only: string[] | null; andPush: boolean }
  /** The side panel to open it in; the one in focus when it works in the project, by default. */
  panel?: string
}

/** Shows the Git pane on a page, in the session's side panel or, without one, the focused pane's. */
export function openGitPane(projectPath: string, request: OpenGitPane): void {
  const state = useViewStore.getState()
  const projects = useProjectsStore.getState().projects
  const view = focusedPane(state.layout).view
  const panel =
    request.panel ??
    (paneProjectPath(view, state.projectPath, projects) === projectPath
      ? panelOf(view, state.projectPath, projects)
      : null)
  if (!panel) return
  if (request.commit) {
    useGitStore.setState((s) => ({ commitAsk: { ...s.commitAsk, [projectPath]: request.commit! } }))
  }
  setGitPaneTab(panel, request.tab)
  toggleSidePane(panel, 'git', true)
}
