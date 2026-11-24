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
  toggleSidePane,
  useViewStore,
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
    terminal: terminalsOf(useTerminalsStore.getState().byId, panel).length > 0,
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
  const last = view.sideLast[panel]
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
    toggleSidePane(panel, 'terminal', true)
    showTerminal(panel, id)
  } else if (kind === 'page') {
    if (!sessionId || isWeb) return
    toggleSidePane(panel, 'browser', true)
    void window.kettu.browser.selectTab(sessionId, id)
  } else if (sessionId) {
    toggleSidePane(panel, 'devices', true)
    selectDevice(sessionId, id)
  }
}
