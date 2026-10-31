// The session titles a device's connection last carried from the agent host, so its activity names
// a session by the title it had at the time rather than by whatever it is called later.

/** Titles kept for one connection; past this many, the least recently told go first. */
const MAX_TITLES = 10_000
/** `sessions.list` requests waiting for their answer; more are not read. */
const MAX_LISTS = 16

type Summary = { id?: unknown; title?: unknown }

export class SessionTitles {
  private readonly titles = new Map<string, string | null>()
  private readonly lists = new Set<number>()

  /** The session's title as last told, null while it has none, undefined when never told. */
  get(sessionId: unknown): string | null | undefined {
    return typeof sessionId === 'string' ? this.titles.get(sessionId) : undefined
  }

  /** A request from the device: a list's answer is read for its titles. */
  request(id: unknown, method: unknown): void {
    if (method === 'sessions.list' && typeof id === 'number' && this.lists.size < MAX_LISTS) {
      this.lists.add(id)
    }
  }

  /** A message from the agent host to the device. */
  received(data: Record<string, unknown>): void {
    const { type } = data
    if (type === 'event') {
      const event = data.event as { type?: unknown; summary?: Summary; sessionId?: unknown } | null
      if (event?.type === 'session.summary') this.keep(event.summary)
      else if (event?.type === 'session.removed' && typeof event.sessionId === 'string') {
        this.titles.delete(event.sessionId)
      }
    } else if ((type === 'response' || type === 'error') && this.lists.delete(data.id as number)) {
      if (type === 'response' && Array.isArray(data.result)) {
        for (const summary of data.result as Summary[]) this.keep(summary)
      }
    }
  }

  private keep(summary: Summary | undefined): void {
    const { id, title } = summary ?? {}
    if (typeof id !== 'string' || (title !== null && typeof title !== 'string')) return
    this.titles.delete(id)
    this.titles.set(id, title)
    if (this.titles.size > MAX_TITLES) this.titles.delete(this.titles.keys().next().value!)
  }
}
