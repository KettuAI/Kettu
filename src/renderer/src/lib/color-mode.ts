export type ColorMode = 'light' | 'dark'

let shown: ColorMode | undefined
let switches = 0

/**
 * Shows `mode` on <html>, every color in the same frame: while it switches, elements' own
 * transitions wait (globals.css), so none lands after the rest. With `fade`, the window
 * cross-fades from the old colors as a view transition.
 */
export function showColorMode(mode: ColorMode, fade: boolean): void {
  if (mode === shown) return
  shown = mode
  const root = document.documentElement
  const current = ++switches
  const flip = (): void => {
    root.dataset.switchingTheme = ''
    root.dataset.theme = mode
  }
  // Only after a frame has drawn the new colors, or releasing them would start the transitions.
  const release = (): void =>
    void requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (current === switches) delete root.dataset.switchingTheme
      }),
    )
  if (fade && typeof document.startViewTransition === 'function') {
    const transition = document.startViewTransition(flip)
    // Skipped while the window is hidden or when the next switch starts; it still flips.
    transition.ready.catch(() => {})
    void transition.finished.then(release)
  } else {
    flip()
    release()
  }
}
