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

/** How many sessions keep where they were read; the most recently left win. */
const REMEMBERED = 200

const positions = new Map<string, ReadingPosition>()

export function readingPosition(sessionId: string): ReadingPosition | null {
  return positions.get(sessionId) ?? null
}

export function leaveThread(sessionId: string, position: ReadingPosition | null): void {
  positions.delete(sessionId)
  if (!position) return
  positions.set(sessionId, position)
  if (positions.size > REMEMBERED) positions.delete(positions.keys().next().value!)
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

/**
 * The item at the top of the viewport and its offset, or null when the thread shows its end or
 * follows it, which MessageScroller marks by leaving `end` out of `data-scrollable`.
 */
export function itemAtTop(
  viewport: HTMLElement,
  content: HTMLElement,
): { item: string; offset: number } | null {
  if (!viewport.getAttribute('data-scrollable')?.split(' ').includes('end')) return null
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
