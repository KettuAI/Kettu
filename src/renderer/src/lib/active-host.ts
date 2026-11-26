import type { PaneView } from '@renderer/features/split/layout'
import { hostOfPath } from '@renderer/lib/host-paths'
import type { MainView } from '@renderer/stores/view'

/**
 * Resolves the host of the currently focused session or project, or undefined when none is
 * selected. While a global page (such as Usage or Overview) is shown, falls back to the focused
 * split pane or the selected project so compact limit surfaces stay anchored to the active
 * computer.
 */
export function resolveActiveHostId(input: {
  main: MainView
  focusedPaneView: PaneView
  projectPath: string | null
  sessionHost: (sessionId: string) => string | null | undefined
}): string | null | undefined {
  const { main, focusedPaneView, projectPath, sessionHost } = input
  if (main.kind === 'session') {
    const host = sessionHost(main.sessionId)
    if (host !== undefined) return host
    return projectPath ? hostOfPath(projectPath) : undefined
  }
  if (main.kind === 'new') {
    if (main.noProject) return main.hostId ?? null
    if (projectPath) return hostOfPath(projectPath)
    return main.hostId
  }
  if (main.kind === 'marketplace' && main.hostId !== undefined) {
    return main.hostId
  }
  if (focusedPaneView.kind === 'session') {
    const host = sessionHost(focusedPaneView.sessionId)
    if (host !== undefined) return host
    if (focusedPaneView.projectPath) return hostOfPath(focusedPaneView.projectPath)
  } else if (focusedPaneView.kind === 'new') {
    if (focusedPaneView.noProject) return focusedPaneView.hostId ?? null
    if (focusedPaneView.projectPath) return hostOfPath(focusedPaneView.projectPath)
    if (focusedPaneView.hostId !== undefined) return focusedPaneView.hostId
  }
  return projectPath ? hostOfPath(projectPath) : undefined
}
