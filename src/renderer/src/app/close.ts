import { isSplit } from '@renderer/features/split/layout'
import { closeActiveFile } from '@renderer/stores/files'
import { useSessionsStore } from '@renderer/stores/sessions'
import { closeSettings, closeSplitPane, useViewStore } from '@renderer/stores/view'
import { leaveSession } from './actions'
import { emitAppEvent } from './events'
import { dialogOpen, popupOpen } from './shortcuts'
import { usedPane } from './used-pane'

/**
 * Mod+W: closes the part the user used last, a file, terminal or browser tab, else leaves the shown
 * session without archiving it. Returns false when nothing is left to close, which the window's own
 * close takes. A dialog keeps the key, so a second press cannot close the window under it.
 */
export function closeCurrent(browserFocused = false): boolean {
  if (dialogOpen()) return true
  const { settings, main, layout } = useViewStore.getState()
  if (settings.open) {
    closeSettings()
    return true
  }
  const used = usedPane(browserFocused)
  if (used?.kind === 'files' && closeActiveFile(used.projectPath)) return true
  if (used?.kind === 'terminal' || used?.kind === 'browser') {
    emitAppEvent({ kind: used.kind === 'terminal' ? 'close-terminal' : 'close-browser' })
    return true
  }
  if (popupOpen()) return false
  if (main.kind !== 'session' && main.kind !== 'new') return false
  if (isSplit(layout)) {
    closeSplitPane(layout.focus, true)
    return true
  }
  if (main.kind !== 'session') return false
  leaveSession(useSessionsStore.getState().byId[main.sessionId])
  return true
}
