// The Files pane the user used last, so Mod+W closes its tab rather than the window. A tab pressed
// by the pointer does not take the focus, so the focused element alone cannot tell.
let used: string | null = null

function track(event: Event): void {
  const target = event.target instanceof Element ? event.target : null
  used = target?.closest<HTMLElement>('[data-files-panel]')?.dataset.filesPanel ?? null
}

document.addEventListener('pointerdown', track, true)
document.addEventListener('focusin', track, true)

/** The project whose Files pane the user used last, while that pane is on screen; else null. */
export function usedFilesPane(): string | null {
  if (used === null) return null
  const panes = document.querySelectorAll<HTMLElement>('[data-files-panel]')
  return [...panes].some((pane) => pane.dataset.filesPanel === used) ? used : null
}
