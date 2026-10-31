import { TERMINAL_FLOW } from '@shared/terminal-host'

export type FlowChange = 'pause' | 'resume' | null

/**
 * Counts characters a window's port has received but not yet acknowledged, per port, as VS Code's
 * pty host does (MIT). The pty pauses when any port falls more than the high watermark behind and
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

/**
 * Counts what each paired device's port has not acknowledged, per port. A device never pauses the
 * pty, so a slow phone slows only itself: once a port is more than the high watermark behind it
 * gets no more data, and once it acknowledges back under the low one it catches up with the
 * terminal's replay instead of the output it missed.
 */
export class DeviceFlow {
  private readonly unacked = new Map<string, number>()
  private readonly behind = new Set<string>()

  constructor(
    private readonly high: number = TERMINAL_FLOW.highWatermark,
    private readonly low: number = TERMINAL_FLOW.lowWatermark,
  ) {}

  /** The ports among `ports` that get the next `chars`; one this puts behind still gets them. */
  sent(ports: Iterable<string>, chars: number): string[] {
    const receiving: string[] = []
    for (const port of ports) {
      if (this.behind.has(port)) continue
      const unacked = (this.unacked.get(port) ?? 0) + chars
      this.unacked.set(port, unacked)
      if (unacked > this.high) this.behind.add(port)
      receiving.push(port)
    }
    return receiving
  }

  /** Whether the port caught up with this: it was behind and is now under the low watermark. */
  ack(port: string, chars: number): boolean {
    const current = this.unacked.get(port)
    if (current === undefined) return false
    const unacked = Math.max(0, current - chars)
    this.unacked.set(port, unacked)
    if (!this.behind.has(port) || unacked >= this.low) return false
    this.behind.delete(port)
    return true
  }

  /** The port starts over, as after an attach's replay. */
  reset(port: string): void {
    this.unacked.set(port, 0)
    this.behind.delete(port)
  }

  removePort(port: string): void {
    this.unacked.delete(port)
    this.behind.delete(port)
  }
}
