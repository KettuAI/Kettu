// A card's page growing into the area the viewer takes, and shrinking back into the card when the
// viewer closes. A copy of the page flies over the window, so whatever draws the viewer, it never
// needs to know.

import { prefersReducedMotion } from '@renderer/stores/settings'

const DURATION = 300
const FADE = 160
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

function ghostOf(page: HTMLElement): HTMLElement {
  const ghost = document.createElement('div')
  ghost.className = 'k-glide'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.appendChild(page.cloneNode(true))
  // Inside the shell, whose variables the page's styles read.
  ;(page.closest('.ui-as') ?? document.body).appendChild(ghost)
  return ghost
}

function frame(box: DOMRect, radius: number): Keyframe {
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: `${radius}px`,
  }
}

/**
 * Grows the card's page into `area`, then runs `open`, and fades the copy out over what opened.
 * Opens at once when motion is reduced.
 */
export function growInto(page: HTMLElement | null, area: DOMRect | null, open: () => void): void {
  if (!page || !area || prefersReducedMotion()) return open()
  const ghost = ghostOf(page)
  const grow = ghost.animate([frame(page.getBoundingClientRect(), 6), frame(area, 12)], {
    duration: DURATION,
    easing: EASE,
    fill: 'forwards',
  })
  let opened = false
  const finish = () => {
    if (opened) return
    opened = true
    open()
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: FADE,
      delay: 40,
      fill: 'forwards',
    })
    fade.onfinish = () => ghost.remove()
    fade.oncancel = () => ghost.remove()
  }
  grow.onfinish = finish
  grow.oncancel = finish
}

/** Shrinks a copy of the card's page from `area` back into it, the card's own page hidden meanwhile. */
export function shrinkFrom(page: HTMLElement | null, area: DOMRect | null): void {
  if (!page || !area || prefersReducedMotion()) return
  const card = page.getBoundingClientRect()
  if (card.width === 0 || card.height === 0) return
  const ghost = ghostOf(page)
  page.style.visibility = 'hidden'
  const shrink = ghost.animate([frame(area, 12), frame(card, 6)], {
    duration: DURATION,
    easing: EASE,
    fill: 'forwards',
  })
  const done = () => {
    page.style.visibility = ''
    ghost.remove()
  }
  shrink.onfinish = done
  shrink.oncancel = done
}
