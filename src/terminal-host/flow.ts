import { TERMINAL_FLOW } from '@shared/terminal-host'

export type FlowChange = 'pause' | 'resume' | null

/**
 * Counts characters a port has received but not yet acknowledged, per port, as VS Code's pty
 * host does (MIT). The pty pauses when any port falls more than the high watermark behind and
 * resumes once every port is back under the low one, so output never outruns what the slowest
 * screen draws. A port that goes away no longer holds the pty back.
 */
export class FlowControl {
  private readonly unacked = new Map<string, number>()
  private paused = false

  constructor(
    private readonly high: number = TERMINAL_FLOW.highWatermark,
    private readonly low: number = TERMINAL_FLOW.lowWatermark,
  ) {}

  get isPaused(): boolean {
    return this.paused
  }

  sent(ports: Iterable<string>, chars: number): FlowChange {
    for (const port of ports) this.unacked.set(port, (this.unacked.get(port) ?? 0) + chars)
    if (!this.paused && this.behind() > this.high) {
      this.paused = true
      return 'pause'
    }
    return null
  }

  ack(port: string, chars: number): FlowChange {
    const current = this.unacked.get(port)
    if (current === undefined) return null
    this.unacked.set(port, Math.max(0, current - chars))
    return this.maybeResume()
  }

  removePort(port: string): FlowChange {
    if (!this.unacked.delete(port)) return null
    return this.maybeResume()
  }

  private behind(): number {
    let max = 0
    for (const value of this.unacked.values()) max = Math.max(max, value)
    return max
  }

  private maybeResume(): FlowChange {
    if (this.paused && this.behind() < this.low) {
      this.paused = false
      return 'resume'
    }
    return null
  }
}
