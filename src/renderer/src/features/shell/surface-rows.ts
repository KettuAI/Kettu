import type { IconSvgElement } from '@hugeicons/react'
import {
  BrowserIcon,
  BubbleChatQuestionIcon,
  ComputerIcon,
  ComputerPhoneSyncIcon,
  ComputerTerminal01Icon,
  DashboardSquare02Icon,
  Folder01Icon,
  GitBranchIcon,
  ShapesIcon,
} from '@hugeicons/core-free-icons'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { KIND_ICON } from '@renderer/features/artifacts/kinds'
import { languageText, surfaceTitle } from '@renderer/features/plugin-views/plugin-text'
import { artifactKind } from '@renderer/features/artifacts/model'
import { threadArtifacts, type BoardArtifact } from '@renderer/features/board/board-model'
import { REQUESTS_ICON } from '@renderer/features/requests/icon'
import { readsModelRequests } from '@renderer/features/requests/support'
import { useSessionView } from '@renderer/features/session/use-thread'
import { learnArtifactHost, sessionHost } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { formatShortcut, isWeb } from '@renderer/lib/platform'
import { artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { useDevicesStore } from '@renderer/stores/devices'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { usePluginSurfaces, type PluginSurface } from '@renderer/stores/plugin-surfaces'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { openSideChat } from '@renderer/stores/side-chat'
import { createTerminal } from '@renderer/stores/terminals'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  panelSession,
  openArtifactTab,
  openPluginPane,
  pluginPaneId,
  toggleSidePane,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'

export type SurfaceRowId =
  | 'terminal'
  | 'browser'
  | 'devices'
  | 'files'
  | 'git'
  | 'board'
  | 'sideChat'
  | 'requests'
  | 'computer'

/** The icon of each kind, on its tab, in the list and on the bar. */
export const SURFACE_ICON: Record<SurfaceRowId, IconSvgElement> = {
  terminal: ComputerTerminal01Icon,
  browser: BrowserIcon,
  devices: ComputerPhoneSyncIcon,
  files: Folder01Icon,
  git: GitBranchIcon,
  board: DashboardSquare02Icon,
  sideChat: BubbleChatQuestionIcon,
  requests: REQUESTS_ICON,
  computer: ComputerIcon,
}

/**
 * The rows in the order the list shows them: the kinds a session opens several of, then the ones
 * it has one of. The side chat has a shortcut of its own instead of a letter.
 */
const ROWS: { id: SurfaceRowId; key: string | null; group: 0 | 1 }[] = [
  { id: 'terminal', key: 'T', group: 0 },
  { id: 'browser', key: 'P', group: 0 },
  { id: 'devices', key: 'D', group: 0 },
  { id: 'files', key: 'F', group: 1 },
  { id: 'git', key: 'G', group: 1 },
  { id: 'board', key: 'B', group: 1 },
  { id: 'sideChat', key: null, group: 1 },
  { id: 'requests', key: 'R', group: 1 },
  { id: 'computer', key: 'C', group: 1 },
]

/** How many of the session's artifacts the list offers; the board lists them all. */
const LISTED_ARTIFACTS = 6
const NO_ARTIFACTS: BoardArtifact[] = []

const OFF_TEXT = {
  terminal: 'surfaces.list.off.terminal',
  firstMessage: 'surfaces.list.off.firstMessage',
  webBrowser: 'surfaces.list.off.webBrowser',
  webComputer: 'surfaces.list.off.webComputer',
  noDevices: 'surfaces.list.off.noDevices',
  otherHost: 'surfaces.list.off.otherHost',
  noRequests: 'surfaces.list.off.noRequests',
  computer: 'surfaces.list.off.computer',
} as const
type OffReason = keyof typeof OFF_TEXT

export interface SurfaceRow {
  id: SurfaceRowId
  icon: IconSvgElement
  label: string
  /** The letter that picks the row while the list has focus; none for the side chat. */
  key: string | null
  /** What the row's end shows in the letter's place: the side chat's own shortcut. */
  shortcut: string | null
  group: 0 | 1
  /** A one-per-session tab the row already holds, which picking the row selects. */
  open: boolean
  /** Why the row does not apply now; it is dimmed and cannot be picked. */
  off: string | null
  /** An agent uses it at this moment. */
  live: boolean
}

/** What the side panel can show here, and what it cannot yet and why. */
export function useSurfaceRows(panel: string, projectPath: string): SurfaceRow[] {
  const { t } = useTranslation('shell')
  const sessionId = panelSession(panel)
  const terminal = useTerminalAllowed(projectPath)
  const remote = hostOfPath(projectPath) !== null
  const summary = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  const session = useSessionView(sessionId ?? '')
  const held = useDevicesStore(
    (s) => !!sessionId && s.devices.some((device) => device.sessionId === sessionId),
  )
  // Unknown until the host has looked for Xcode and the Android SDK.
  const noDevices = useDevicesStore((s) =>
    s.environment ? !s.environment.ios && !s.environment.android : false,
  )
  const computer = !isWeb && !!session?.computer && !!summary && hostOfSession(summary) === null
  const tabs = useViewStore((s) => s.sideTabs[panel])
  // A sub-agent's page shows its parent's work: it has no board and no side chat of its own.
  const subagent = summary?.origin === 'subagent'

  const reasons: Record<SurfaceRowId, OffReason | null> = {
    terminal: terminal ? null : 'terminal',
    browser: isWeb ? 'webBrowser' : sessionId ? null : 'firstMessage',
    devices: !sessionId
      ? 'firstMessage'
      : remote
        ? 'otherHost'
        : noDevices && !held
          ? 'noDevices'
          : null,
    files: null,
    git: null,
    board: sessionId ? null : 'firstMessage',
    sideChat: sessionId ? null : 'firstMessage',
    requests: !sessionId
      ? 'firstMessage'
      : readsModelRequests(summary?.agentId)
        ? null
        : 'noRequests',
    computer: computer ? null : isWeb ? 'webComputer' : 'computer',
  }
  return ROWS.filter((row) => !subagent || (row.id !== 'board' && row.id !== 'sideChat')).map(
    (row) => ({
      ...row,
      icon: SURFACE_ICON[row.id],
      label: t(`surfaces.list.${row.id}`),
      shortcut: row.id === 'sideChat' ? formatShortcut('Mod+J') : null,
      off: reasons[row.id] ? t(OFF_TEXT[reasons[row.id]!]) : null,
      live: row.id === 'computer' && computer,
      open: !!tabs?.some((tab) => tab === row.id),
    }),
  )
}

/** An artifact the session wrote, as the list offers it. */
export interface ArtifactChoice {
  id: string
  title: string
  icon: IconSvgElement
}

/** The session's artifacts for the list: the newest first, the first few. */
export function useArtifactChoices(panel: string): ArtifactChoice[] {
  const sessionId = panelSession(panel)
  const written = useThreadsStore((s) => {
    const state = sessionId ? s.replicas[sessionId]?.state : undefined
    return state ? threadArtifacts(state) : NO_ARTIFACTS
  })
  const titles = useThreadsStore(
    useShallow((s) => {
      const byId = sessionId ? s.replicas[sessionId]?.state?.byId : undefined
      return written.map(({ entryId }) => {
        const entry = byId?.[entryId]
        return entry?.kind === 'artifact' ? entry.title : ''
      })
    }),
  )
  const live = useArtifactsStore(
    useShallow((s) =>
      written.flatMap((artifact, index) => {
        if (artifactStanding(s, artifact.artifactId) !== 'live') return []
        const summary = s.list?.find((other) => other.id === artifact.artifactId)
        const kind = summary ? artifactKind(summary) : null
        return [`${index}\n${summary?.title ?? ''}\n${kind ?? ''}`]
      }),
    ),
  )
  return live.slice(0, LISTED_ARTIFACTS).map((line) => {
    const [index, title, kind] = line.split('\n')
    const artifact = written[Number(index)]!
    // A session's artifacts are kept where it runs, which every request for one goes by.
    if (sessionId) learnArtifactHost(artifact.artifactId, sessionHost(sessionId))
    return {
      id: artifact.artifactId,
      title: title || titles[Number(index)] || '',
      icon: kind ? KIND_ICON[kind as keyof typeof KIND_ICON] : ShapesIcon,
    }
  })
}

/** A pane a plugin on the panel's host gives the side panel. */
export interface PluginPaneChoice {
  plugin: PluginSurface
  viewId: string
  label: string
  /** The plugin's name, which tells panes of one name apart. */
  pluginTitle: string
  /** A tab of the panel already shows it, which picking the row selects. */
  open: boolean
}

/** The panes of the plugins that are on, on the host the panel's session runs on. */
export function usePluginPaneChoices(panel: string, projectPath: string): PluginPaneChoice[] {
  const { i18n } = useTranslation()
  const { plugins } = usePluginSurfaces(hostOfPath(projectPath))
  const docs = useViewStore((s) => s.sideDocs[panel])
  return useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.panes.map((pane) => ({
          plugin,
          viewId: pane.id,
          label: languageText(pane.title, i18n.language) || pane.id,
          pluginTitle: surfaceTitle(plugin, i18n.language),
          open: !!docs?.some((tab) => tab.id === pluginPaneId(plugin.pluginId, pane.id)),
        })),
      ),
    [plugins, docs, i18n.language],
  )
}

/** Shows a plugin's pane in a tab of the panel. */
export function startPluginPane(panel: string, choice: PluginPaneChoice): void {
  openPluginPane(panel, { pluginId: choice.plugin.pluginId, viewId: choice.viewId })
}

/** Shows one of the session's artifacts in the panel's preview tab. */
export function startArtifact(panel: string, id: string): void {
  openArtifactTab(panel, id, { preview: true })
}

/** Opens the row: a new terminal or page, the devices tab's list, or the kind's one tab. */
export function startSurface(panel: string, projectPath: string, id: SurfaceRowId): void {
  const sessionId = panelSession(panel)
  if (id === 'terminal') {
    toggleTerminal(panel, true)
    void createTerminal(projectPath, panel)
  } else if (id === 'browser') {
    if (!sessionId) return
    toggleSidePane(panel, 'browser', true)
    void window.kettu.browser
      .newTab(sessionId)
      .catch((error: unknown) => console.error('Could not open a tab', error))
  } else if (id === 'sideChat') {
    if (sessionId) openSideChat(sessionId)
  } else toggleSidePane(panel, id, true)
}

/** The list's rows that can be picked. */
export const MENU_ITEM = '[role="menuitem"]:not([aria-disabled="true"])'

/** Puts the keyboard's focus on the list's first row that can be picked. */
export function focusSurfaceList(panel: string): boolean {
  const list = document.querySelector<HTMLElement>(`[data-surface-list="${CSS.escape(panel)}"]`)
  const row = list?.querySelector<HTMLElement>(MENU_ITEM)
  row?.focus()
  return !!row
}

// The bar opens the panel before the list is drawn, so its request waits here for a moment.
let pendingFocus: { panel: string; at: number } | null = null
const PENDING_MS = 1000

/** Asks the list of this panel to take the keyboard's focus as soon as it shows. */
export function requestSurfaceListFocus(panel: string): void {
  if (!focusSurfaceList(panel)) pendingFocus = { panel, at: Date.now() }
}

/** Takes a waiting request to focus this panel's list, if it is still fresh. */
export function takePendingSurfaceListFocus(panel: string): void {
  if (pendingFocus?.panel !== panel || Date.now() - pendingFocus.at > PENDING_MS) return
  pendingFocus = null
  focusSurfaceList(panel)
}
