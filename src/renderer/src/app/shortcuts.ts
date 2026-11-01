import { useEffect } from 'react'
import { stepZoom, type ZoomStep } from '@shared/settings'
import { errorMessage } from '@renderer/lib/host'
import { isMac, isMod, platform } from '@renderer/lib/platform'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore, visibleOrder } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  focusPaneAt,
  settingsBack,
  openSession,
  openSettings,
  toggleShortcuts,
  toggleSidebar,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'
import { paneOrder } from '@renderer/features/split/layout'
import { newSession, openProjectDialog } from './actions'
import { emitAppEvent } from './events'
import { back, forward } from './history'

const client = window.kettu.client

/**
 * Whether the page handles Mod+O, Mod+N, Mod+, and Mod+B: the desktop app's menu has them on
 * macOS, and a browser has no such menu.
 */
export function pageHandlesMenuKeys(platform: string, client: 'desktop' | 'web'): boolean {
  return client === 'web' || platform !== 'darwin'
}

/** Whether the page zooms on Mod and +, - or 0: not under macOS's menu, nor in a browser's zoom. */
export function pageHandlesZoomKeys(platform: string, client: 'desktop' | 'web'): boolean {
  return client === 'desktop' && platform !== 'darwin'
}

/**
 * App-wide shortcuts. On macOS, Cmd+O, Cmd+N, Cmd+, and Cmd+B are menu accelerators that arrive as
 * app commands, and the zoom keys are menu items, so they are not handled here; a browser has no
 * menu, so the web client handles the first four and leaves zoom to the browser. While a terminal
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

      if (
        event.key === 'Escape' &&
        view.settings.open &&
        !isEditable(event.target) &&
        !layerOpen()
      ) {
        event.preventDefault()
        settingsBack()
        return
      }

      const step = historyStep(event, platform)
      if (step) {
        if (layerOpen()) return
        return run(event, step === 'back' ? back : forward)
      }

      if (!isMod(event) || event.altKey) return
      const zoom = pageHandlesZoomKeys(platform, client) ? zoomStep(event.key) : null
      if (zoom !== null) return run(event, () => zoomBy(zoom))
      if (inTerminal && !isMac) {
        const selection = window.getSelection()?.toString() ?? ''
        if (!(event.key.toLowerCase() === 'l' && !event.shiftKey && selection)) return
      }

      // The Files pane's editor keeps this key, which comments the selected lines there.
      if (event.key === '/' && !inCodeEditor(event.target)) {
        return run(event, () => toggleShortcuts(layerOpen()))
      }

      // Mod+1 to Mod+9 focus a pane of the split, unless Settings covers it or no pane is there.
      const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : null
      if (digit !== null && !view.settings.open && !event.shiftKey) {
        if (!paneAt(digit)) return
        return run(event, () => {
          focusPaneAt(digit)
          focusComposerOfPane()
        })
      }

      const key = event.key.toLowerCase()
      if (pageHandlesMenuKeys(platform, client) && !event.shiftKey) {
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
    // The mouse's back and forward buttons.
    const onMouseUp = (event: MouseEvent) => {
      if ((event.button !== 3 && event.button !== 4) || layerOpen()) return
      event.preventDefault()
      if (event.button === 3) back()
      else forward()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mouseup', onMouseUp)
    // An artifact's page keeps the keys typed in it; main passes on the app's own shortcuts.
    const offForwarded = window.kettu.app.onShortcut((key) =>
      onKeyDown(new KeyboardEvent('keydown', { ...key, cancelable: true })),
    )
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mouseup', onMouseUp)
      offForwarded()
    }
  }, [])
}

const BRACKETS: Record<string, 'back' | 'forward'> = {
  BracketLeft: 'back',
  BracketRight: 'forward',
}
const ARROWS: Record<string, 'back' | 'forward'> = { ArrowLeft: 'back', ArrowRight: 'forward' }

/**
 * Back or forward from a key: Cmd+[ and Cmd+] on macOS, Alt+Left and Alt+Right elsewhere. The
 * Files pane's editor keeps them, where they indent or move by syntax, and outside macOS so does
 * a terminal, where they move by a word.
 */
export function historyStep(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'>,
  platform: string,
): 'back' | 'forward' | null {
  const mac = platform === 'darwin'
  const held = mac ? event.metaKey && !event.altKey : event.altKey && !event.metaKey
  if (!held || event.ctrlKey || event.shiftKey) return null
  const step = (mac ? BRACKETS : ARROWS)[event.code]
  if (!step || inCodeEditor(event.target)) return null
  if (!mac && (event.target as HTMLElement | null)?.closest('[data-terminal]')) return null
  return step
}

function run(event: KeyboardEvent, action: () => void): void {
  event.preventDefault()
  event.stopPropagation()
  action()
}

/** Whether the split has a pane at that place; a key for one past it is left to the app. */
function paneAt(index: number): boolean {
  return !!paneOrder(useViewStore.getState().layout)[index]
}

/** Puts the keyboard focus in the focused pane's composer, or in the pane itself for a subagent. */
function focusComposerOfPane(): void {
  const { layout } = useViewStore.getState()
  requestAnimationFrame(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-split-pane="${CSS.escape(layout.focus)}"]`,
    )
    const composer = pane?.querySelector<HTMLElement>('.cm-content, [contenteditable=true]')
    ;(composer ?? pane)?.focus()
  })
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

function inCodeEditor(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest('[data-code-editor]')
}

/**
 * Whether a dialog or menu is open, closing included: Esc is its own, and Base UI leaves the event
 * unprevented. Focus can be on the body by then, after the button it went back to was disabled.
 */
function layerOpen(): boolean {
  return !!document.querySelector('[role=dialog], [role=alertdialog], [role=menu]')
}

/** Previous or next session in sidebar order, across Pinned, the projects and No project. */
function stepSession(delta: -1 | 1): void {
  const view = useViewStore.getState()
  const { byId } = useSessionsStore.getState()
  const order = visibleOrder(view, byId, useProjectsStore.getState().projects)
  if (!order.length) return
  const currentId = view.main.kind === 'session' ? view.main.sessionId : null
  const at = currentId ? order.indexOf(currentId) : -1
  const next = order[(at + delta + order.length) % order.length]!
  openSession(next, byId[next]!.projectPath)
}
