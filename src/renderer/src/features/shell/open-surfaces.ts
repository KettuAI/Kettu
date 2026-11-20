import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { useBrowserStore } from '@renderer/stores/browser'
import { devicesOf, selectDevice, useDevicesStore } from '@renderer/stores/devices'
import type { SurfaceKind } from '@renderer/stores/surface-tabs'
import { showTerminal, terminalsOf, useTerminalsStore } from '@renderer/stores/terminals'
import { panelSession, toggleSidePane } from '@renderer/stores/view'

/**
 * Opens the row on the kind shown last when it still has a tab, else on any kind that has one,
 * else on the row's empty pane, which offers a terminal, a page or a device.
 */
export function openSurfaces(panel: string, projectPath: string, last?: SurfaceKind): void {
  const sessionId = panelSession(panel)
  const has: Record<SurfaceKind, boolean> = {
    terminal: terminalsOf(useTerminalsStore.getState().byId, panel).length > 0,
    browser:
      !isWeb && !!sessionId && !!useBrowserStore.getState().bySession[sessionId]?.tabs.length,
    devices:
      hostOfPath(projectPath) === null &&
      devicesOf(useDevicesStore.getState().devices, sessionId).length > 0,
  }
  const kind =
    last && has[last] ? last : (['terminal', 'browser', 'devices'] as const).find((k) => has[k])
  toggleSidePane(panel, kind ?? 'surfaces', true)
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
