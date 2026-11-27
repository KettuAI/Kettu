/**
 * Where a thread was read when it was left: the item at the top of its viewport, the entry that item
 * starts with, how far the item's top lay below the viewport's, the entry its rendered items started
 * at, and the cursor of the older pages then loaded, null when the whole thread was. A thread left
 * at its end keeps none.
 */
export interface ReadingPosition {
  item: string
  entry: string | null
  offset: number
  from: string | null
  older: number | null
}

/** How many sessions keep where they were read; the most recently used win. */
export const MAX_REMEMBERED_POSITIONS = 200

/** Distance from the bottom (px) within which the thread counts as sticking to the bottom. */
export const STICK_TO_BOTTOM_THRESHOLD = 40

/** Keys that express user scroll intent on the thread viewport. */
export const SCROLL_INTENT_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
])

const DEFAULT_QUIET_MS = 400
const DEFAULT_MAX_SETTLE_MS = 1500
const ALIGN_EPSILON_PX = 0.5

const positions = new Map<string, ReadingPosition>()

export function readingPosition(sessionId: string): ReadingPosition | null {
  const saved = positions.get(sessionId)
  if (!saved) return null
  // Refresh LRU order when a session is revisited.
  positions.delete(sessionId)
  positions.set(sessionId, saved)
  return saved
}

export function leaveThread(sessionId: string, position: ReadingPosition | null): void {
  positions.delete(sessionId)
  if (!position) return
  positions.set(sessionId, position)
  if (positions.size > MAX_REMEMBERED_POSITIONS) {
    positions.delete(positions.keys().next().value!)
  }
}

export function forgetReadingPosition(sessionId: string): void {
  positions.delete(sessionId)
}

export function clearReadingPositions(): void {
  positions.clear()
}

/**
 * Distance in pixels from the viewport bottom to the end of real message content (excluding any
 * visible MessageScroller spacer). Returns null when viewport geometry is unavailable.
 */
export function distanceFromEnd(viewport: HTMLElement, content: HTMLElement): number | null {
  if (!(viewport.clientHeight > 0) || !(viewport.scrollHeight > 0)) return null
  const spacer = content.lastElementChild
  const spacerHeight =
    spacer instanceof HTMLElement &&
    spacer.hasAttribute('data-message-scroller-spacer') &&
    !spacer.hidden
      ? spacer.offsetHeight
      : 0
  const contentHeight = Math.max(0, viewport.scrollHeight - spacerHeight)
  return contentHeight - viewport.scrollTop - viewport.clientHeight
}

/**
 * Finds the top-most message item crossing the viewport's top edge via hit testing so leaving a
 * long thread never walks off-screen `content-visibility: auto` items with getBoundingClientRect.
 */
function hitTopItem(content: HTMLElement, box: DOMRect): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') {
    return null
  }
  const x = box.left + box.width / 2
  const maxY = box.bottom - 1
  for (const dy of [8, 28, 64, 120]) {
    const y = box.top + dy
    if (y >= maxY) break
    for (const hit of document.elementsFromPoint(x, y)) {
      if (!(hit instanceof HTMLElement)) continue
      const item = hit.closest<HTMLElement>('[data-message-id]')
      if (item && item.parentElement === content) {
        // Walk up a couple siblings in case the sample landed past a small item at the very top edge.
        let current = item
        for (let step = 0; step < 4; step++) {
          const prev = current.previousElementSibling
          if (!(prev instanceof HTMLElement) || !prev.dataset.messageId) break
          if (prev.getBoundingClientRect().bottom <= box.top) break
          current = prev
        }
        return current
      }
    }
  }
  return null
}

export interface ItemAtTopOptions {
  /** Distance from the bottom (px) within which the viewport counts as sticking to the end. */
  edgeThreshold?: number
  /**
   * True when the thread is detached from bottom-following (either restored mid-thread or scrolled
   * away by the user), allowing synchronous capture even before MessageScroller flushes its next
   * animation frame to update `data-scrollable`.
   */
  detached?: boolean
}

/**
 * The item at the top of the viewport and its offset, or null when the thread shows its end or
 * follows it.
 */
export function itemAtTop(
  viewport: HTMLElement,
  content: HTMLElement,
  options: ItemAtTopOptions = {},
): { item: string; offset: number } | null {
  const edgeThreshold = options.edgeThreshold ?? STICK_TO_BOTTOM_THRESHOLD
  const distance = distanceFromEnd(viewport, content)
  if (distance !== null && distance <= edgeThreshold) return null
  const scrollableEnd =
    viewport.getAttribute('data-scrollable')?.split(' ').includes('end') ?? false
  if (!scrollableEnd && !(options.detached && distance !== null && distance > edgeThreshold)) {
    return null
  }
  const box = viewport.getBoundingClientRect()
  const hit = hitTopItem(content, box)
  if (hit && hit.dataset.messageId) {
    const itemBox = hit.getBoundingClientRect()
    if (itemBox.bottom > box.top) {
      return { item: hit.dataset.messageId, offset: itemBox.top - box.top }
    }
  }
  const top = box.top
  for (const child of content.children) {
    if (!(child instanceof HTMLElement) || !child.dataset.messageId) continue
    const itemBox = child.getBoundingClientRect()
    if (itemBox.bottom > top) return { item: child.dataset.messageId, offset: itemBox.top - top }
  }
  return null
}

function findMessageItem(content: HTMLElement, itemKey: string): HTMLElement | null {
  if (
    typeof content.querySelector === 'function' &&
    typeof CSS !== 'undefined' &&
    typeof CSS.escape === 'function'
  ) {
    return content.querySelector<HTMLElement>(`:scope > [data-message-id="${CSS.escape(itemKey)}"]`)
  }
  for (const child of content.children) {
    if (child instanceof HTMLElement && child.dataset.messageId === itemKey) return child
  }
  return null
}

function jumpViewportTop(viewport: HTMLElement, top: number): void {
  if (typeof viewport.scrollTo === 'function') {
    viewport.scrollTo({ top, behavior: 'instant' })
  } else {
    viewport.scrollTop = top
  }
}

export interface ReturnAnchorOptions {
  viewport: HTMLElement
  content: HTMLElement
  itemKey: string | null
  offset: number
  /** Returns true while below-viewport placeholder gaps are still expanding. */
  isSettling?: () => boolean
  /** Called immediately after the first synchronous placement so the viewport can paint. */
  onPositioned: () => void
  /** Called when the saved item no longer exists and the thread must fall back to its end. */
  onFallbackEnd: () => void
  /** Called once the anchor guard finishes settling or yields to user scroll input. */
  onDone: () => void
  /** Quiet period without layout drift before releasing the anchor guard. */
  quietMs?: number
  /** Upper bound on how long the anchor guard stays active. */
  maxSettleMs?: number
}

/**
 * Restores a thread's saved reading position synchronously before paint, then guards the anchored
 * item against asynchronous layout shifts (code highlighting, images, snapshot refreshes, gap
 * expansion) until layout quiets down or the user scrolls.
 */
export function attachReturnAnchor({
  viewport,
  content,
  itemKey,
  offset,
  isSettling,
  onPositioned,
  onFallbackEnd,
  onDone,
  quietMs = DEFAULT_QUIET_MS,
  maxSettleMs = DEFAULT_MAX_SETTLE_MS,
}: ReturnAnchorOptions): () => void {
  if (itemKey === null) {
    onFallbackEnd()
    onPositioned()
    onDone()
    return () => {}
  }

  let done = false
  let pinned: HTMLElement | null = null
  let frame = 0
  let quietTimer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  let resizeObserver: ResizeObserver | null = null
  let mutationObserver: MutationObserver | null = null

  const pin = (target: HTMLElement | null): void => {
    if (target === pinned) return
    pinned?.style.removeProperty('content-visibility')
    pinned = target
    // Skipped while off-screen, a tall item would keep its estimated height until laid out.
    pinned?.style.setProperty('content-visibility', 'visible')
  }

  const align = (): boolean => {
    const target = findMessageItem(content, itemKey)
    if (!target) return false
    pin(target)
    const off = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset
    if (Math.abs(off) <= ALIGN_EPSILON_PX) return false
    const nextTop = Math.max(0, viewport.scrollTop + off)
    if (Math.abs(nextTop - viewport.scrollTop) <= ALIGN_EPSILON_PX) return false
    jumpViewportTop(viewport, nextTop)
    return true
  }

  const teardown = (): void => {
    if (frame !== 0 && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame)
      frame = 0
    }
    if (quietTimer !== null) {
      clearTimeout(quietTimer)
      quietTimer = null
    }
    if (maxTimer !== null) {
      clearTimeout(maxTimer)
      maxTimer = null
    }
    resizeObserver?.disconnect()
    resizeObserver = null
    mutationObserver?.disconnect()
    mutationObserver = null
    viewport.removeEventListener('wheel', onUserIntent)
    viewport.removeEventListener('touchstart', onUserIntent)
    viewport.removeEventListener('touchmove', onUserIntent)
    viewport.removeEventListener('pointerdown', onPointerDown)
    viewport.removeEventListener('keydown', onKeyDown)
    pin(null)
  }

  const finish = (): void => {
    if (done) return
    done = true
    teardown()
    onDone()
  }

  const scheduleQuietCheck = (): void => {
    if (done) return
    if (quietTimer !== null) clearTimeout(quietTimer)
    quietTimer = setTimeout(() => {
      quietTimer = null
      if (done) return
      if (align() || isSettling?.()) {
        scheduleQuietCheck()
        return
      }
      finish()
    }, quietMs)
  }

  const scheduleAlign = (): void => {
    if (done || frame !== 0) return
    if (typeof requestAnimationFrame !== 'function') {
      if (align()) scheduleQuietCheck()
      return
    }
    frame = requestAnimationFrame(() => {
      frame = 0
      if (done) return
      align()
      scheduleQuietCheck()
    })
  }

  const onUserIntent = (): void => {
    finish()
  }

  const onPointerDown = (event: PointerEvent): void => {
    // Only dragging the scrollbar itself (pressed on the viewport) counts as scroll intent.
    if (event.target === viewport) finish()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (SCROLL_INTENT_KEYS.has(event.key)) finish()
  }

  // Place synchronously before the first paint so the viewport never flashes the start or end.
  align()
  onPositioned()

  viewport.addEventListener('wheel', onUserIntent, { passive: true })
  viewport.addEventListener('touchstart', onUserIntent, { passive: true })
  viewport.addEventListener('touchmove', onUserIntent, { passive: true })
  viewport.addEventListener('pointerdown', onPointerDown, { passive: true })
  viewport.addEventListener('keydown', onKeyDown, { passive: true })

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleAlign())
    resizeObserver.observe(content)
    resizeObserver.observe(viewport)
  }

  if (typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(() => scheduleAlign())
    mutationObserver.observe(content, { childList: true })
  }

  scheduleAlign()
  scheduleQuietCheck()
  maxTimer = setTimeout(() => finish(), maxSettleMs)

  return () => {
    if (done) return
    done = true
    teardown()
  }
}
