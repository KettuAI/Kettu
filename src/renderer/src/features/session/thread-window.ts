/**
 * Idle-settling virtualization policy for long session threads.
 *
 * Active wheel/trackpad scrolling never unmounts mounted items (preventing mid-scroll React +
 * Markdown/Shiki unmount/remount storms). Instead:
 * - While scrolling, if the viewport approaches previously virtualized placeholders, the mounted
 *   range only expands (with a generous lookahead buffer) unless total mounted items exceed a high
 *   safety cap.
 * - After scrolling settles (idle debounce), items far outside the viewport are measured once and
 *   evicted to exact-height placeholders to keep DOM and heap bounded.
 */

export interface ThreadWindowConfig {
  /** Minimum rendered item count before virtualization activates. */
  windowThreshold: number
  /** Mounted items kept on each side of the visible range when evicting while idle. */
  overscanItems: number
  /** Lookahead items mounted ahead of the visible range during active scrolling. */
  expandBufferItems: number
  /** Hard ceiling on simultaneously mounted items during fast full-thread scrubs. */
  hardCapMounted: number
  /** Tail items pinned permanently mounted for smooth live streaming and bottom anchoring. */
  pinTail: number
  /** Minimum boundary delta before replacing an existing window during idle eviction. */
  hysteresis: number
  /** Quiet period after the last scroll event before evicting off-screen items. */
  idleEvictMs: number
}

export const DESKTOP_WINDOW_CONFIG: ThreadWindowConfig = {
  windowThreshold: 320,
  overscanItems: 90,
  expandBufferItems: 30,
  hardCapMounted: 420,
  pinTail: 10,
  hysteresis: 8,
  idleEvictMs: 350,
}

export const WEB_WINDOW_CONFIG: ThreadWindowConfig = {
  windowThreshold: 64,
  overscanItems: 28,
  expandBufferItems: 14,
  hardCapMounted: 140,
  pinTail: 10,
  hysteresis: 4,
  idleEvictMs: 300,
}

export interface IndexRange {
  start: number
  end: number
}

/**
 * Computes the next mounted window during active scrolling. Returns `null` when no state change is
 * needed (either below threshold, not yet virtualized, or the visible band plus lookahead already
 * lies inside the current mounted window).
 */
export function expandWindowForScroll(
  current: IndexRange | null,
  visible: IndexRange,
  shownFrom: number,
  totalItems: number,
  config: ThreadWindowConfig,
): IndexRange | null {
  const renderedCount = totalItems - shownFrom
  if (renderedCount <= config.windowThreshold) return null
  // Never start evicting while the user is actively scrolling; wait for idle eviction.
  if (current === null) return null

  const lastIndex = totalItems - 1
  const needStart = Math.max(shownFrom, visible.start - config.expandBufferItems)
  const needEnd = Math.min(lastIndex, visible.end + config.expandBufferItems)

  if (needStart >= current.start && needEnd <= current.end) return null

  let nextStart = Math.min(current.start, needStart)
  let nextEnd = Math.max(current.end, needEnd)

  // Safety valve for scrubbing across thousands of entries in a single continuous gesture: trim
  // only the far side opposite the visible band so heap stays bounded without touching near items.
  if (nextEnd - nextStart + 1 > config.hardCapMounted) {
    const center = Math.floor((visible.start + visible.end) / 2)
    const half = Math.floor(config.hardCapMounted / 2)
    nextStart = Math.max(shownFrom, Math.min(needStart, center - half))
    nextEnd = Math.min(lastIndex, Math.max(needEnd, nextStart + config.hardCapMounted - 1))
    if (nextEnd - nextStart + 1 > config.hardCapMounted) {
      nextStart = Math.max(shownFrom, nextEnd - config.hardCapMounted + 1)
    }
  }

  if (nextStart === current.start && nextEnd === current.end) return null
  return { start: nextStart, end: nextEnd }
}

/**
 * Computes the target mounted window once scrolling has settled. Returns `null` when the current
 * window is already close enough (within `hysteresis`) or virtualization is not needed.
 */
export function computeIdleWindow(
  current: IndexRange | null,
  visible: IndexRange,
  shownFrom: number,
  totalItems: number,
  config: ThreadWindowConfig,
): IndexRange | null {
  const renderedCount = totalItems - shownFrom
  if (renderedCount <= config.windowThreshold) return null

  const lastIndex = totalItems - 1
  const start = Math.max(shownFrom, visible.start - config.overscanItems)
  const end = Math.min(lastIndex, visible.end + config.overscanItems)

  // If the retained overscan covers everything rendered, no eviction is necessary.
  if (start <= shownFrom && end >= lastIndex - config.pinTail) {
    return current === null ? null : { start: shownFrom, end: lastIndex }
  }

  if (
    current !== null &&
    Math.abs(current.start - start) < config.hysteresis &&
    Math.abs(current.end - end) < config.hysteresis
  ) {
    return null
  }

  return { start, end }
}

/**
 * Finds the visible item index range inside `viewport` without walking off-screen
 * `content-visibility: auto` children. During active scrolling (`allowHitTest: false`), uses pure
 * scroll-ratio estimation with zero HitTest or layout reads; during idle eviction
 * (`allowHitTest: true`), uses O(1) hit-testing at three points in the viewport and falls back to
 * proportional estimation when hit-testing is unavailable (e.g. jsdom).
 */
export function findVisibleIndexRange(
  viewport: HTMLElement,
  content: HTMLElement,
  keyToIndex: ReadonlyMap<string, number>,
  shownFrom: number,
  totalItems: number,
  { allowHitTest = false }: { allowHitTest?: boolean } = {},
): IndexRange | null {
  const renderedCount = totalItems - shownFrom
  if (renderedCount <= 0) return null

  if (
    allowHitTest &&
    typeof document !== 'undefined' &&
    typeof document.elementsFromPoint === 'function'
  ) {
    const box = viewport.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) {
      const x = box.left + box.width / 2
      const samples = [
        box.top + Math.min(24, box.height * 0.15),
        box.top + box.height * 0.5,
        box.bottom - Math.min(24, box.height * 0.15),
      ]
      let minIdx = Infinity
      let maxIdx = -1
      for (const y of samples) {
        for (const hit of document.elementsFromPoint(x, y)) {
          if (!(hit instanceof HTMLElement)) continue
          const item = hit.closest<HTMLElement>('[data-message-id]')
          if (!item || item.parentElement !== content) continue
          const key = item.dataset.messageId
          const idx = key ? keyToIndex.get(key) : undefined
          if (idx !== undefined) {
            if (idx < minIdx) minIdx = idx
            if (idx > maxIdx) maxIdx = idx
            break
          }
        }
      }
      if (maxIdx >= 0 && minIdx <= maxIdx) {
        return { start: minIdx, end: maxIdx }
      }
    }
  }

  // Zero-HitTest proportional scroll estimation (safe during active scrolling and in jsdom).
  const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, viewport.scrollTop / maxScroll)) : 1
  const center = shownFrom + Math.round(ratio * (renderedCount - 1))
  return {
    start: Math.max(shownFrom, center - 4),
    end: Math.min(totalItems - 1, center + 4),
  }
}
