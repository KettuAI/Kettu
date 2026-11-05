/** A side pane the user used last, which Mod+W closes a tab of rather than the window. */
export type UsedPane =
  { kind: 'files'; projectPath: string } | { kind: 'terminal' } | { kind: 'browser' }

// A tab pressed by the pointer does not take the focus, so the focused element alone cannot tell.
let used: UsedPane | null = null

function paneOf(target: Element | null): UsedPane | null {
  const files = target?.closest<HTMLElement>('[data-files-panel]')
  if (files) return { kind: 'files', projectPath: files.dataset.filesPanel ?? '' }
  if (target?.closest('[data-terminal-panel]')) return { kind: 'terminal' }
  if (target?.closest('[data-browser-panel]')) return { kind: 'browser' }
  return null
}

function track(event: Event): void {
  used = paneOf(event.target instanceof Element ? event.target : null)
}

document.addEventListener('pointerdown', track, true)
document.addEventListener('focusin', track, true)

function onScreen(pane: UsedPane): boolean {
  if (pane.kind === 'terminal') return !!document.querySelector('[data-terminal-panel]')
  if (pane.kind === 'browser') return !!document.querySelector('[data-browser-panel]')
  const panes = document.querySelectorAll<HTMLElement>('[data-files-panel]')
  return [...panes].some((el) => el.dataset.filesPanel === pane.projectPath)
}

/**
 * The side pane the user used last, while it is on screen; else null. A page in the browser pane
 * takes the keyboard focus from the app's own page, so main says when it has it.
 */
export function usedPane(browserFocused = false): UsedPane | null {
  const pane = browserFocused ? ({ kind: 'browser' } as const) : used
  return pane && onScreen(pane) ? pane : null
}
