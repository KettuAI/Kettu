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
 * The item at the top of the viewport and its offset, or null when the thread shows its end or
 * follows it, which MessageScroller marks by leaving `end` out of `data-scrollable`.
 */
export function itemAtTop(
  viewport: HTMLElement,
  content: HTMLElement,
): { item: string; offset: number } | null {
  if (!viewport.getAttribute('data-scrollable')?.split(' ').includes('end')) return null
  const top = viewport.getBoundingClientRect().top
  for (const child of content.children) {
    if (!(child instanceof HTMLElement) || !child.dataset.messageId) continue
    const box = child.getBoundingClientRect()
    if (box.bottom > top) return { item: child.dataset.messageId, offset: box.top - top }
  }
  return null
}
