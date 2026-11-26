import { prefersReducedMotion } from '@renderer/stores/settings'

// Subtle compositor-only settle on session entry: starts already legible (never opacity: 0, no
// blur filter, no multi-frame hidden wait) so switching to a cached or actively running session
// paints messages on the first frame alongside the outline rail.
const SETTLE: Keyframe[] = [
  { opacity: 0.85, transform: 'translateY(3px)' },
  { opacity: 1, transform: 'translateY(0px)' },
]
const DURATION_MS = 160
/** --ease-out-quint */
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

function visibleItems(
  viewport: HTMLElement,
  content: HTMLElement,
  top: number,
  bottom: number,
): HTMLElement[] {
  const items: HTMLElement[] = []
  const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const fromEnd = maxScroll > 0 && viewport.scrollTop > maxScroll * 0.5
  let seen = false
  for (
    let node = fromEnd ? content.lastElementChild : content.firstElementChild;
    node;
    node = fromEnd ? node.previousElementSibling : node.nextElementSibling
  ) {
    if (!(node instanceof HTMLElement) || !node.dataset.messageId) continue
    const box = node.getBoundingClientRect()
    if (box.bottom > top && box.top < bottom && box.height > 0) {
      seen = true
      items.push(node)
    } else if (seen) {
      // Stop as soon as we exit the visible band so off-screen content-visibility items are untouched.
      break
    }
  }
  return fromEnd ? items.reverse() : items
}

/**
 * Entering a session: runs a light compositor-only settle on the items currently in view without
 * hiding the thread or waiting across animation frames for scrollHeight quiescence. Initial scroll
 * placement is already applied synchronously by MessageScroller before this runs. Returns a cancel.
 */
export function playEntrance(viewport: HTMLElement, content: HTMLElement): () => void {
  if (prefersReducedMotion()) return () => {}
  const { top, bottom } = viewport.getBoundingClientRect()
  if (bottom <= top) return () => {}
  // Platform Web Animations rather than Motion: finished animations release automatically instead
  // of leaving transforms that turn message items into stacking contexts / containing blocks.
  const animations: Animation[] = []
  for (const item of visibleItems(viewport, content, top, bottom)) {
    if (typeof item.animate !== 'function') continue
    const animation = item.animate(SETTLE, {
      duration: DURATION_MS,
      easing: EASE_OUT,
    })
    if (animation) animations.push(animation)
  }
  return () => {
    for (const animation of animations) animation.cancel()
  }
}
