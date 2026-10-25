// The rail's geometry and the reading position, apart from React so they can be tested.

const DASH_HEIGHT = 2
const DASH_GAP = 4

/** How many dashes the rail draws: one per message while they fit in half the viewport's height. */
export function dashCount(messages: number, viewportHeight: number): number {
  const fit = Math.floor((viewportHeight / 2 + DASH_GAP) / (DASH_HEIGHT + DASH_GAP))
  return Math.max(0, Math.min(messages, Math.max(1, fit)))
}

/** The dash a message falls under when `dashes` dashes stand for `messages` messages evenly. */
export function dashOf(index: number, messages: number, dashes: number): number {
  return messages <= dashes ? index : Math.floor((index * dashes) / messages)
}

/**
 * The message the reader is at: the last whose top has passed the line, else the first. A message
 * with no element lies above the rendered part of the thread, so it has passed too.
 */
export function readingAt(
  ids: readonly string[],
  placed: { has(id: string): boolean },
  passed: { has(id: string): boolean },
): string | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!
    if (!placed.has(id) || passed.has(id)) return id
  }
  return ids[0] ?? null
}

// The observed box reaches far above the viewport and down to a third of it, so a message
// intersects it exactly while its top is above that line, however far it scrolled past.
const ABOVE_PX = 10_000_000
const READING_MARGIN = `${ABOVE_PX}px 0px -66.667% 0px`

/**
 * Follows the reading position with an IntersectionObserver on the user messages of the thread's
 * content, so scrolling notifies only those who subscribe, never the thread itself.
 */
export class ReadingTracker {
  private ids: readonly string[] = []
  private wanted = new Set<string>()
  private readonly placed = new Map<string, Element>()
  private readonly passed = new Set<string>()
  private current: string | null = null
  private readonly listeners = new Set<() => void>()
  private readonly intersections: IntersectionObserver
  private readonly mutations: MutationObserver

  constructor(
    viewport: Element,
    private readonly content: Element,
  ) {
    this.intersections = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const id = (record.target as HTMLElement).dataset.messageId
          if (!id) continue
          if (record.isIntersecting) this.passed.add(id)
          else this.passed.delete(id)
        }
        this.update()
      },
      { root: viewport, rootMargin: READING_MARGIN },
    )
    this.mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((node) => this.unplace(node))
        record.addedNodes.forEach((node) => this.place(node))
      }
      this.update()
    })
    this.mutations.observe(content, { childList: true })
  }

  /** The user messages, oldest first, by the ids their items carry. */
  setMessages(ids: readonly string[]): void {
    this.ids = ids
    this.wanted = new Set(ids)
    for (const [id, element] of this.placed) {
      if (!this.wanted.has(id)) this.unplace(element)
    }
    for (const child of this.content.children) this.place(child)
    this.update()
  }

  private place(node: Node): void {
    const id = node instanceof HTMLElement ? node.dataset.messageId : undefined
    if (!id || !this.wanted.has(id) || this.placed.get(id) === node) return
    this.placed.set(id, node as Element)
    this.intersections.observe(node as Element)
  }

  private unplace(node: Node): void {
    const id = node instanceof HTMLElement ? node.dataset.messageId : undefined
    if (!id || this.placed.get(id) !== node) return
    this.placed.delete(id)
    this.passed.delete(id)
    this.intersections.unobserve(node as Element)
  }

  private update(): void {
    const next = readingAt(this.ids, this.placed, this.passed)
    if (next === this.current) return
    this.current = next
    for (const listener of this.listeners) listener()
  }

  readonly get = (): string | null => this.current

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  disconnect(): void {
    this.intersections.disconnect()
    this.mutations.disconnect()
    this.listeners.clear()
  }
}
