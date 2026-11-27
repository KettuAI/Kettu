import { compareVersions, VERSION } from '@shared/market-publish'
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

/** First host version that implements `projects.worktreeSettings` and `projects.setWorktreeSettings`. */
export const WORKTREE_SETTINGS_SINCE = '0.0.38'

/**
 * Whether a host reporting `version` implements worktree settings RPCs. Local desktop hosts (null),
 * dev/test builds (`0.0.0` / non-semver), and hosts at or above `WORKTREE_SETTINGS_SINCE` do; older
 * remote hosts hide the item instead of sending an unsupported RPC.
 */
export function hostSupportsWorktreeSettings(version: string | null | undefined): boolean {
  if (!version) return true
  if (version === '0.0.0' || version.startsWith('0.0.0-')) return true
  if (!VERSION.test(version)) return true
  return compareVersions(version, WORKTREE_SETTINGS_SINCE) >= 0
}

export type ProjectMenuItem =
  | 'newSession'
  | 'edit'
  | 'pin'
  | 'importSessions'
  | 'openInTerminal'
  | 'showInFileManager'
  | 'worktreeSettings'
  | 'showArchived'
  | 'archive'
  | 'remove'

export interface ProjectMenuContext {
  /** Whether the file manager on this computer can reveal the project folder (desktop + local). */
  revealable: boolean
  /** Whether opening a terminal in this project's folder is allowed. */
  terminal: boolean
  /** Whether the project is not known to be outside a Git repository. */
  git: boolean
  /** Whether the project's host supports worktree settings RPCs. */
  worktreeSettings: boolean
  /** Whether the project's host supports pinning projects. */
  canPin: boolean
  /** Whether the project's host supports archiving projects. */
  canArchive: boolean
  /** Whether the project's folder is missing on disk. */
  gone: boolean
  /** Whether the project's remote host is offline / unreachable. */
  away: boolean
}

/**
 * The groups a project's menu shows, filtered by capabilities and permissions rather than host
 * locality, with no empty groups.
 */
export function projectMenuGroups(ctx: ProjectMenuContext): ProjectMenuItem[][] {
  const groups: ProjectMenuItem[][] = [
    ['newSession', 'edit', ...(ctx.canPin ? (['pin'] as const) : [])],
    [
      'importSessions',
      ...(ctx.terminal ? (['openInTerminal'] as const) : []),
      ...(ctx.revealable ? (['showInFileManager'] as const) : []),
    ],
    ctx.git && ctx.worktreeSettings ? ['worktreeSettings'] : [],
    ['showArchived'],
    [...(ctx.canArchive ? (['archive'] as const) : []), 'remove'],
  ]
  return groups.filter((group) => group.length > 0)
}

/**
 * Whether a project menu item is disabled. Actions that require the project folder on disk wait
 * while it is missing (`gone`) or its host is offline (`away`); host-level metadata and Settings
 * navigation only wait while the host is `away`.
 */
export function isProjectMenuItemDisabled(
  item: ProjectMenuItem,
  ctx: Pick<ProjectMenuContext, 'gone' | 'away'>,
): boolean {
  switch (item) {
    case 'newSession':
    case 'importSessions':
    case 'openInTerminal':
    case 'showInFileManager':
    case 'worktreeSettings':
      return ctx.gone || ctx.away
    case 'edit':
    case 'pin':
    case 'showArchived':
    case 'archive':
    case 'remove':
      return ctx.away
  }
}

export type NoProjectMenuItem = 'newSession' | 'pin' | 'showArchived'

export interface NoProjectMenuContext {
  /** Scratch sessions start on this computer only. */
  local: boolean
  /** Whether the host supports pinning the No project group. */
  canPin: boolean
  /** Whether the remote host is offline / unreachable. */
  away: boolean
}

/** The groups a No project row's menu shows, with no empty groups. */
export function noProjectMenuGroups(ctx: NoProjectMenuContext): NoProjectMenuItem[][] {
  const groups: NoProjectMenuItem[][] = [
    [...(ctx.local ? (['newSession'] as const) : []), ...(ctx.canPin ? (['pin'] as const) : [])],
    ['showArchived'],
  ]
  return groups.filter((group) => group.length > 0)
}

/** Whether a No project menu item is disabled. */
export function isNoProjectMenuItemDisabled(
  item: NoProjectMenuItem,
  ctx: Pick<NoProjectMenuContext, 'away'>,
): boolean {
  switch (item) {
    case 'newSession':
      return false
    case 'pin':
    case 'showArchived':
      return ctx.away
  }
}

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
