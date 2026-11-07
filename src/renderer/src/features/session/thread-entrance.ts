import { prefersReducedMotion } from '@renderer/stores/settings'

// The streamed words' reveal, played by block: each rises out of the same soft blur.
const RISE: Keyframe[] = [
  { opacity: 0, filter: 'blur(4px)', transform: 'translateY(4px)' },
  { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
]
const DURATION_MS = 320
/** --ease-out-quint */
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Blocks start at most this far apart, and the last within SPREAD_MS, however many show. */
const STEP_MS = 20
const SPREAD_MS = 160
/** Frames the scroller may take to settle on the latest items before the entrance starts. */
const MAX_FRAMES = 6

// A reply's text rises paragraph by paragraph and item by item; anything else as a whole.
const PROSE = ':scope .markdown-chunk > :not(ul, ol), :scope .markdown-chunk > :is(ul, ol) > li'

function within(el: Element, top: number, bottom: number): boolean {
  const box = el.getBoundingClientRect()
  return box.bottom > top && box.top < bottom && box.height > 0
}

function rise(viewport: HTMLElement, content: HTMLElement): void {
  const { top, bottom } = viewport.getBoundingClientRect()
  const blocks: HTMLElement[] = []
  for (const item of content.querySelectorAll<HTMLElement>(':scope > [data-message-id]')) {
    if (!within(item, top, bottom)) continue
    const prose = [...item.querySelectorAll<HTMLElement>(PROSE)]
    if (prose.length === 0) blocks.push(item)
    else blocks.push(...prose.filter((el) => within(el, top, bottom)))
  }
  const step = blocks.length > 1 ? Math.min(STEP_MS, SPREAD_MS / (blocks.length - 1)) : 0
  // The platform's animations, not Motion's: Motion leaves the end values on each block, and a
  // filter or transform there would make every paragraph a stacking context and containing block.
  blocks.forEach((el, i) =>
    el.animate(RISE, {
      duration: DURATION_MS,
      delay: i * step,
      easing: EASE_OUT,
      fill: 'backwards',
    }),
  )
}

/**
 * Entering a session: what its viewport shows rises in block by block, top to bottom, and the
 * screen settles within half a second. The thread stays hidden until the scroller has settled on
 * its latest items, since items off screen lay out at an estimated height first. Returns a cancel.
 */
export function playEntrance(viewport: HTMLElement, content: HTMLElement): () => void {
  if (prefersReducedMotion()) return () => {}
  content.style.opacity = '0'
  let frame = 0
  let frames = 0
  let last = ''
  const tick = () => {
    const now = `${viewport.scrollTop} ${viewport.scrollHeight}`
    if (now !== last && ++frames < MAX_FRAMES) {
      last = now
      frame = requestAnimationFrame(tick)
      return
    }
    content.style.removeProperty('opacity')
    rise(viewport, content)
  }
  frame = requestAnimationFrame(tick)
  return () => {
    cancelAnimationFrame(frame)
    content.style.removeProperty('opacity')
  }
}
