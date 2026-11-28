import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { useBrowserStore } from '@renderer/stores/browser'
import { devicesOf, selectDevice, useDevicesStore } from '@renderer/stores/devices'
import { isSurfaceKind, kindOfKey, type SurfaceKind } from '@renderer/stores/surface-tabs'
import { showTerminal, terminalsOf, useTerminalsStore } from '@renderer/stores/terminals'
import {
  docKey,
  isDocKind,
  panelSession,
  selectDoc,
  setTerminalPlacement,
  toggleSidePane,
  toggleTerminal,
  useViewStore,
  type SidePane,
  type SidePanelFallback,
  type TerminalPlacement,
} from '@renderer/stores/view'

/**
 * Opens a closed side panel on the tab it showed last when the row still has it, else on any tab
 * the row has, else on the side panel's list. True when it opened on the list.
 */
export function reopenSidePanel(panel: string, projectPath: string): boolean {
  const view = useViewStore.getState()
  if (view.sidePane[panel]) return view.sidePane[panel] === 'surfaces'
  const sessionId = panelSession(panel)
  const order = (view.sideOrder[panel] ?? []).map(kindOfKey)
  const has: Record<SurfaceKind, boolean> = {
    terminal:
      view.terminalPlacement === 'side' &&
      terminalsOf(useTerminalsStore.getState().byId, panel).length > 0,
    // The row keeps the place of pages a restart is about to open again.
    browser:
      !isWeb &&
      !!sessionId &&
      (!!useBrowserStore.getState().bySession[sessionId]?.tabs.length || order.includes('browser')),
    devices:
      hostOfPath(projectPath) === null &&
      devicesOf(useDevicesStore.getState().devices, sessionId).length > 0,
  }
  const tabs = view.sideTabs[panel] ?? []
  const docs = (view.sideDocs[panel] ?? []).map(docKey)
  // Whether the row still has the tab; a kind of one has an empty id.
  const held = (key: string): boolean => {
    const kind = kindOfKey(key)
    if (isDocKind(kind)) return docs.includes(key)
    return isSurfaceKind(kind) ? has[kind] : tabs.some((tab) => tab === kind)
  }
  const last =
    view.terminalPlacement === 'bottom' && view.sideLast[panel] === 'terminal'
      ? undefined
      : view.sideLast[panel]
  const lastKey = last && (isDocKind(last) ? view.sideDoc[panel] : `${last}:`)
  const key =
    lastKey && kindOfKey(lastKey) === last && held(lastKey)
      ? lastKey
      : ((view.sideOrder[panel] ?? []).find(held) ?? (tabs[0] ? `${tabs[0]}:` : docs[0]))
  const pane = key ? kindOfKey(key) : 'surfaces'
  // A file, diff or artifact tab is shown by its key, since its kind has several.
  if (key && isDocKind(pane)) selectDoc(panel, key)
  else toggleSidePane(panel, pane, true)
  return pane === 'surfaces'
}

/** Opens the row on one terminal, browser tab or device, such as a message's chip names. */
export function revealSurface(
  panel: string,
  kind: 'terminal' | 'page' | 'device',
  id: string,
): void {
  const sessionId = panelSession(panel)
  if (kind === 'terminal') {
    toggleTerminal(panel, true)
    showTerminal(panel, id)
  } else if (kind === 'page') {
    if (!sessionId || isWeb) return
    const hasLocal = useBrowserStore
      .getState()
      .bySession[sessionId]?.tabs.some((tab) => tab.id === id)
    if (!hasLocal) return
    toggleSidePane(panel, 'browser', true)
    void window.kettu.browser.selectTab(sessionId, id)
  } else if (sessionId) {
    toggleSidePane(panel, 'devices', true)
    selectDevice(sessionId, id)
  }
}

/**
 * Picks the nearest live non-terminal tab in `panel` across single tabs, docs, browser pages and
 * devices so moving the terminal to the bottom keeps other previews open or closes an empty panel.
 */
function liveNonTerminalFallback(panel: string): SidePanelFallback {
  const view = useViewStore.getState()
  const sessionId = panelSession(panel)
  const hasBrowser =
    !isWeb && !!sessionId && (useBrowserStore.getState().bySession[sessionId]?.tabs.length ?? 0) > 0
  const hasDevices =
    !!sessionId && devicesOf(useDevicesStore.getState().devices, sessionId).length > 0
  const singleTabs = new Set<string>(view.sideTabs[panel] ?? [])
  const docKeys = new Set((view.sideDocs[panel] ?? []).map(docKey))
  const order = view.sideOrder[panel] ?? []
  const lastTerminal = order.findLastIndex((key) => kindOfKey(key) === 'terminal')
  const others = order
    .map((key, index) => ({ key, kind: kindOfKey(key), index }))
    .filter((other) => {
      if (other.kind === 'terminal') return false
      if (isDocKind(other.kind)) return docKeys.has(other.key)
      if (other.kind === 'browser') return hasBrowser
      if (other.kind === 'devices') return hasDevices
      return singleTabs.has(other.kind)
    })
  const next = others.find((other) => other.index > lastTerminal) ?? others.at(-1)
  if (next) return isDocKind(next.kind) ? { docKey: next.key } : (next.kind as SidePane)
  if (view.sideDocs[panel]?.[0]) return { docKey: docKey(view.sideDocs[panel][0]) }
  if (view.sideTabs[panel]?.[0]) return view.sideTabs[panel][0]
  if (hasBrowser) return 'browser'
  if (hasDevices) return 'devices'
  return null
}

/**
 * Moves the terminal between the side panel and the bottom dock while preserving every live PTY
 * process, buffer and tab order, and focuses the active terminal in the target dock.
 */
export function moveTerminalPlacement(placement: TerminalPlacement, panel?: string | null): void {
  setTerminalPlacement(placement, {
    panel,
    fallbackPane: liveNonTerminalFallback,
  })
  if (!panel) return
  const terminals = useTerminalsStore.getState()
  const focusedId =
    (terminals.focusedSide[panel] === 'right' ? terminals.split[panel] : terminals.active[panel]) ??
    terminalsOf(terminals.byId, panel, terminals.order[panel]).at(-1)?.id ??
    null
  if (focusedId) useTerminalsStore.setState({ focusing: focusedId })
}
