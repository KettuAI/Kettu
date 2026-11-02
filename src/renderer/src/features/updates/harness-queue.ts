import type { AgentId } from '@shared/thread'

export interface HarnessQueueState {
  /** Asked for, waiting for the harness's running sessions to end. */
  waiting: AgentId[]
  /** Asked for, waiting their turn behind the update installing. */
  queued: AgentId[]
}

export interface HarnessQueueDeps {
  /** Runs one update; resolves once it is done, has failed or was stopped. */
  run(agentId: AgentId): Promise<void>
  /** How many of the harness's sessions run now. */
  busy(agentId: AgentId): number
  changed(state: HarnessQueueState): void
}

/**
 * Harness updates the user asked for. They install one after another, and never while one of the
 * harness's sessions runs: those wait until its sessions end, unless the user stopped them for it.
 */
export class HarnessQueue {
  private waiting: AgentId[] = []
  private queued: AgentId[] = []
  private installing: AgentId | null = null
  /** Asked for with Now, after its sessions were stopped, so a late status cannot hold it. */
  private readonly forced = new Set<AgentId>()

  constructor(private readonly deps: HarnessQueueDeps) {}

  /** Installs each now, after the one installing, or once its running sessions end. */
  request(agentIds: readonly AgentId[], { now = false }: { now?: boolean } = {}): void {
    for (const id of agentIds) {
      if (id === this.installing) continue
      this.waiting = this.waiting.filter((w) => w !== id)
      if (now) this.forced.add(id)
      if (!now && this.deps.busy(id) > 0) this.waiting.push(id)
      else if (!this.queued.includes(id)) this.queued.push(id)
    }
    this.emit()
    void this.drain()
  }

  /** Queues the waiting ones whose sessions ended; called as sessions change. */
  check(): void {
    if (this.waiting.length === 0) return
    const free = this.waiting.filter((id) => this.deps.busy(id) === 0)
    if (free.length === 0) return
    this.waiting = this.waiting.filter((id) => !free.includes(id))
    this.queued.push(...free.filter((id) => !this.queued.includes(id)))
    this.emit()
    void this.drain()
  }

  /** Stops waiting for one, which is on offer again. */
  forget(agentId: AgentId): void {
    this.waiting = this.waiting.filter((id) => id !== agentId)
    this.queued = this.queued.filter((id) => id !== agentId)
    this.forced.delete(agentId)
    this.emit()
  }

  /** Drops what is queued, as stopping the update installing does. */
  clear(): void {
    this.queued = []
    this.forced.clear()
    this.emit()
  }

  hasWaiting(): boolean {
    return this.waiting.length > 0
  }

  private emit(): void {
    this.deps.changed({ waiting: [...this.waiting], queued: [...this.queued] })
  }

  private async drain(): Promise<void> {
    if (this.installing) return
    for (let next = this.queued.shift(); next; next = this.queued.shift()) {
      // A session that started while it queued holds it again.
      if (!this.forced.has(next) && this.deps.busy(next) > 0) {
        this.waiting.push(next)
        this.emit()
        continue
      }
      this.forced.delete(next)
      this.installing = next
      this.emit()
      try {
        await this.deps.run(next)
      } catch (error) {
        console.warn(`Could not update ${next}`, error)
      } finally {
        this.installing = null
      }
    }
    this.emit()
  }
}
