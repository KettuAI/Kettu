// Notices a plugin host that stopped answering: a ping at an interval, and a call when one stays
// unanswered. The process that runs the plugin host, main or the daemon, kills it then.

import { PLUGIN_HOST_PING_INTERVAL_MS, PLUGIN_HOST_PING_TIMEOUT_MS } from './plugin-host'

export class PluginHostWatch {
  private interval: ReturnType<typeof setInterval> | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private waitingFor: number | null = null

  constructor(
    private readonly ping: (id: number) => void,
    private readonly silent: () => void,
  ) {}

  /** Starts pinging, for a process that just reported ready. */
  start(): void {
    this.stop()
    this.interval = setInterval(() => {
      if (this.waitingFor !== null) return
      const id = this.nextId++
      this.waitingFor = id
      this.timeout = setTimeout(() => {
        this.stop()
        this.silent()
      }, PLUGIN_HOST_PING_TIMEOUT_MS)
      this.ping(id)
    }, PLUGIN_HOST_PING_INTERVAL_MS)
  }

  pong(id: number): void {
    if (id !== this.waitingFor) return
    this.waitingFor = null
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.timeout) clearTimeout(this.timeout)
    this.interval = null
    this.timeout = null
    this.waitingFor = null
  }
}
