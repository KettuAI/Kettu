import { useEffect } from 'react'
import { stepZoom, type ZoomStep } from '@shared/settings'
import { errorMessage } from '@renderer/lib/host'
import { isMac, isMod } from '@renderer/lib/platform'
import { useProjectsStore } from '@renderer/stores/projects'
import { flattenTree, sessionTree, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  settingsBack,
  NO_PROJECT_GROUP,
  openSession,
  openSettings,
  toggleSidebar,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'
import { newSession, openProjectDialog } from './actions'
import { emitAppEvent } from './events'

/**
 * App-wide shortcuts. On macOS, Cmd+O, Cmd+N, Cmd+, and Cmd+B are menu accelerators that arrive as
 * app commands, and the zoom keys are menu items, so they are not handled here. While a terminal
 * has focus on Windows and Linux, only the terminal and zoom shortcuts reach the app, since
 * Ctrl+B, Ctrl+L and Ctrl+N mean something to the shell.
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const view = useViewStore.getState()
      const inTerminal = !!(document.activeElement as HTMLElement | null)?.closest(
        '[data-terminal]',
      )

      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Backquote') {
        event.preventDefault()
        if (!view.projectPath || view.settings.open) return
        if (event.shiftKey) emitAppEvent({ kind: 'new-terminal' })
        else toggleTerminal(view.projectPath)
        return
      }

      if (event.key === 'Escape' && view.settings.open && !isEditable(event.target)) {
        event.preventDefault()
        settingsBack()
        return
      }

      if (!isMod(event) || event.altKey) return
      const zoom = isMac ? null : zoomStep(event.key)
      if (zoom !== null) return run(event, () => zoomBy(zoom))
      if (inTerminal && !isMac) {
        const selection = window.getSelection()?.toString() ?? ''
        if (!(event.key.toLowerCase() === 'l' && !event.shiftKey && selection)) return
      }

      const key = event.key.toLowerCase()
      if (!isMac && !event.shiftKey) {
        if (key === 'o') return run(event, () => void openProjectDialog())
        if (key === 'n') return run(event, newSession)
        if (key === ',') return run(event, () => openSettings())
        if (key === 'b') return run(event, toggleSidebar)
      }
      if (key === 'u' && !event.shiftKey && view.main.kind === 'session' && !view.settings.open) {
        return run(event, () => emitAppEvent({ kind: 'add-attachments' }))
      }
      if (key === 'l' && !event.shiftKey) {
        return run(event, () =>
          emitAppEvent({ kind: inTerminal ? 'ask-selection' : 'focus-composer' }),
        )
      }
      if (event.shiftKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
        return run(event, () => stepSession(event.code === 'BracketLeft' ? -1 : 1))
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

function run(event: KeyboardEvent, action: () => void): void {
  event.preventDefault()
  event.stopPropagation()
  action()
}

/** = or + zooms in, - or _ out and 0 resets, with Shift or without, as in Chrome. */
function zoomStep(key: string): ZoomStep | null {
  if (key === '=' || key === '+') return 1
  if (key === '-' || key === '_') return -1
  return key === '0' ? 0 : null
}

function zoomBy(step: ZoomStep): void {
  const { settings, update } = useSettingsStore.getState()
  update({ appearance: { zoom: stepZoom(settings.appearance.zoom, step) } }).catch(
    (error: unknown) => console.warn(`Could not change the zoom: ${errorMessage(error)}`),
  )
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  )
}

/** Previous or next session in sidebar order, across projects and No project. */
function stepSession(delta: -1 | 1): void {
  const view = useViewStore.getState()
  const { byId } = useSessionsStore.getState()
  const groups: (string | null)[] = [
    ...useProjectsStore.getState().projects.map((p) => p.path),
    null,
  ]
  const order = groups
    .filter((p) => !view.collapsedProjects[p ?? NO_PROJECT_GROUP])
    .flatMap((p) => flattenTree(sessionTree(byId, p), (id) => view.expandedParents[id] ?? false))
  if (!order.length) return
  const currentId = view.main.kind === 'session' ? view.main.sessionId : null
  const at = currentId ? order.indexOf(currentId) : -1
  const next = order[(at + delta + order.length) % order.length]!
  openSession(next, byId[next]!.projectPath)
}
