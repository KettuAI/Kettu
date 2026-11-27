import { useEffect, type RefObject } from 'react'
import type { Project, SessionSummary } from '@shared/agent-host'
import type { TaskSummary } from '@shared/workflow'
import { focusedPane, type Layout } from '@renderer/features/split/layout'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { sessionFolder } from '@renderer/lib/session-folder'
import { allowsTerminal } from '@renderer/stores/hosts'
import { useOverlayStore } from '@renderer/stores/overlays'
import { activeProjects, useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import {
  closeSidePanel,
  paneProjectPath,
  panelOf,
  sessionsShown,
  taskPanel,
  useViewStore,
  type MainView,
  type SidePane,
} from '@renderer/stores/view'
import {
  attachMobileSwipeListeners,
  createMobileSwipeTracker,
  hasBlockingOverlay,
  type SwipeElementLike,
} from './mobile-swipe'
import { NARROW_WINDOW, useNarrowWindow } from './narrow'
import { reopenSidePanel } from './open-surfaces'

export interface ActiveSidePanelInput {
  main: MainView
  layout: Layout
  projectPath: string | null
  projects: readonly Project[]
  sessions: Readonly<Record<string, Pick<SessionSummary, 'projectPath' | 'worktree' | 'scratch'>>>
  tasks: Readonly<Record<string, Pick<TaskSummary, 'projectPath' | 'worktreePath'>>>
  sidePane: Readonly<Record<string, SidePane>>
  terminalAllowed: (projectPath: string) => boolean
}

export interface ActiveSidePanel {
  panel: string
  projectPath: string
  open: boolean
}

/**
 * Resolves whether the current view supports a right side panel, its panel key and
 * working project path, and whether that panel is currently visible (mirroring
 * `MainArea` and `SidePanelArea`).
 */
export function resolveActiveSidePanel(input: ActiveSidePanelInput): ActiveSidePanel | null {
  let panel: string | null = null
  let resolvedPath: string | null = null

  if (input.main.kind === 'task') {
    const task = input.tasks[input.main.taskId]
    resolvedPath = task ? (task.worktreePath ?? task.projectPath) : null
    if (resolvedPath) panel = taskPanel(input.main.taskId)
  } else if (sessionsShown(input.main)) {
    const focused = focusedPane(input.layout).view
    panel = panelOf(focused, input.projectPath, input.projects)
    const summary = focused.kind === 'session' ? input.sessions[focused.sessionId] : undefined
    const focusedFolder = summary ? sessionFolder(summary) : null
    resolvedPath =
      focusedFolder ||
      paneProjectPath(focused, input.projectPath, input.projects) ||
      input.projectPath ||
      activeProjects(input.projects)[0]?.path ||
      null
  }

  if (!panel || !resolvedPath) return null

  const shown = input.sidePane[panel]
  const remote = hostOfPath(resolvedPath) !== null
  const visiblePane = !shown
    ? undefined
    : !remote
      ? shown
      : shown === 'devices' || shown === 'computer'
        ? undefined
        : shown === 'terminal' && !input.terminalAllowed(resolvedPath)
          ? undefined
          : shown

  return {
    panel,
    projectPath: resolvedPath,
    open: Boolean(visiblePane),
  }
}

function readActiveSidePanel(): ActiveSidePanel | null {
  const view = useViewStore.getState()
  return resolveActiveSidePanel({
    main: view.main,
    layout: view.layout,
    projectPath: view.projectPath,
    projects: useProjectsStore.getState().projects,
    sessions: useSessionsStore.getState().byId,
    tasks: useTasksStore.getState().summaries,
    sidePane: view.sidePane,
    terminalAllowed: (path) => allowsTerminal(hostOfPath(path)),
  })
}

function hasWorkbenchBlocker(): boolean {
  const view = useViewStore.getState()
  if (view.settings.open || view.searchOpen || view.shortcutsOpen || view.renamingIn !== null) {
    return true
  }
  if (Object.keys(useOverlayStore.getState().dismissible).length > 0) {
    return true
  }
  return hasBlockingOverlay()
}

/**
 * Creates a swipe tracker wired directly to the live workbench stores and narrow web viewport.
 */
export function createWorkbenchSwipeTracker(
  stopAt: () => SwipeElementLike | null,
  options: {
    now?: () => number
    getSelection?: () => import('./mobile-swipe').SelectionLike | null
    getComputedStyle?: (node: SwipeElementLike) => import('./mobile-swipe').ComputedStyleLike | null
  } = {},
) {
  return createMobileSwipeTracker({
    isEnabled: () => isWeb && window.matchMedia(NARROW_WINDOW).matches,
    getViewportWidth: () => window.innerWidth,
    stopAt,
    hasBlockingOverlay: hasWorkbenchBlocker,
    now: options.now,
    getSelection: options.getSelection,
    getComputedStyle: options.getComputedStyle,
    getPanelState: () => {
      const view = useViewStore.getState()
      const side = readActiveSidePanel()
      return {
        sidebarDrawer: view.sidebarDrawer,
        sidePanelOpen: side?.open ?? false,
        canOpenSidePanel: side !== null,
      }
    },
    onAction: (action) => {
      if (action === 'open-sidebar') {
        useViewStore.setState({ sidebarDrawer: true })
      } else if (action === 'close-sidebar') {
        useViewStore.setState({ sidebarDrawer: false })
      } else if (action === 'open-side-panel') {
        const side = readActiveSidePanel()
        if (side) reopenSidePanel(side.panel, side.projectPath)
      } else if (action === 'close-side-panel') {
        const side = readActiveSidePanel()
        if (side) closeSidePanel(side.panel)
      }
    },
  })
}

/**
 * Enables single-step horizontal swipe switching between the sidebar drawer, main area,
 * and right side panel on narrow web viewports. Desktop builds and wide layouts are untouched.
 */
export function useMobilePanelSwipe(frame: RefObject<HTMLElement | null>): void {
  const narrow = useNarrowWindow()

  useEffect(() => {
    if (!isWeb || !narrow) return
    const root = frame.current
    if (!root) return

    const tracker = createWorkbenchSwipeTracker(() => root as unknown as SwipeElementLike)
    return attachMobileSwipeListeners(root, tracker)
  }, [frame, narrow])
}
