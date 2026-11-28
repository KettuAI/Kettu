// Tracks `document.hidden` so infinite CSS animations and ticking UI timers pause while a window
// is hidden or minimized and immediately catch up when it becomes visible again.

const listeners = new Set<(hidden: boolean) => void>()
let listening = false

export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true
}

function handleVisibilityChange(): void {
  const hidden = isPageHidden()
  for (const listener of listeners) listener(hidden)
}

function ensureListener(): void {
  if (
    listening ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function'
  ) {
    return
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)
  listening = true
}

function maybeRemoveListener(): void {
  if (!listening || listeners.size > 0) return
  if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
  listening = false
}

/** Subscribes to page visibility transitions (`document.hidden`). */
export function subscribePageVisibility(listener: (hidden: boolean) => void): () => void {
  listeners.add(listener)
  ensureListener()
  return () => {
    listeners.delete(listener)
    maybeRemoveListener()
  }
}

/**
 * Mirrors `document.hidden` onto `<html data-page-hidden="">` so global CSS can pause infinite
 * decorative animations while the window is offscreen.
 */
export function followPageVisibility(): () => void {
  const sync = (hidden: boolean): void => {
    if (typeof document === 'undefined' || !document.documentElement) return
    if (hidden) document.documentElement.dataset.pageHidden = ''
    else delete document.documentElement.dataset.pageHidden
  }
  sync(isPageHidden())
  return subscribePageVisibility(sync)
}
