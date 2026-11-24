import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { useBrowserStore } from '@renderer/stores/browser'
import { devicesOf, selectDevice, useDevicesStore } from '@renderer/stores/devices'
import { isSurfaceKind, kindOfKey, type SurfaceKind } from '@renderer/stores/surface-tabs'
import { showTerminal, terminalsOf, useTerminalsStore } from '@renderer/stores/terminals'
import { panelSession, toggleSidePane, useViewStore, type SidePane } from '@renderer/stores/view'

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
  const held = (pane: SidePane | undefined): pane is SidePane =>
    !!pane && (isSurfaceKind(pane) ? has[pane] : tabs.some((tab) => tab === pane))
  const last = view.sideLast[panel]
  const pane = held(last) ? last : (order.find(held) ?? tabs[0] ?? 'surfaces')
  toggleSidePane(panel, pane, true)
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
