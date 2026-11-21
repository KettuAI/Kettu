import type { IconSvgElement } from '@hugeicons/react'
import {
  BrowserIcon,
  ComputerIcon,
  ComputerPhoneSyncIcon,
  ComputerTerminal01Icon,
  File01Icon,
  GitCompareIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { REQUESTS_ICON } from '@renderer/features/requests/icon'
import { readsModelRequests } from '@renderer/features/requests/support'
import { useSessionView } from '@renderer/features/session/use-thread'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { useDevicesStore } from '@renderer/stores/devices'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { createTerminal } from '@renderer/stores/terminals'
import { panelSession, toggleSidePane, toggleTerminal } from '@renderer/stores/view'

export type SurfaceRowId =
  'terminal' | 'browser' | 'devices' | 'files' | 'git' | 'requests' | 'computer'

/** The rows in the order the list shows them: the tabs a row can open, then the panes. */
const ROWS: { id: SurfaceRowId; icon: IconSvgElement; key: string; group: 0 | 1 }[] = [
  { id: 'terminal', icon: ComputerTerminal01Icon, key: 'T', group: 0 },
  { id: 'browser', icon: BrowserIcon, key: 'P', group: 0 },
  { id: 'devices', icon: ComputerPhoneSyncIcon, key: 'D', group: 0 },
  { id: 'files', icon: File01Icon, key: 'F', group: 1 },
  { id: 'git', icon: GitCompareIcon, key: 'G', group: 1 },
  { id: 'requests', icon: REQUESTS_ICON, key: 'R', group: 1 },
  { id: 'computer', icon: ComputerIcon, key: 'C', group: 1 },
]

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
  /** The letter that picks the row while the list has focus. */
  key: string
  group: 0 | 1
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
    requests: !sessionId
      ? 'firstMessage'
      : readsModelRequests(summary?.agentId)
        ? null
        : 'noRequests',
    computer: computer ? null : isWeb ? 'webComputer' : 'computer',
  }
  return ROWS.map((row) => ({
    ...row,
    label: t(`surfaces.list.${row.id}`),
    off: reasons[row.id] ? t(OFF_TEXT[reasons[row.id]!]) : null,
    live: row.id === 'computer' && computer,
  }))
}

/** Opens the row: a new terminal or page, the devices pane, or the pane itself. */
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
