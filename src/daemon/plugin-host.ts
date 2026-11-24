// The daemon's side of the plugin host, as main's PluginHost is the app's: the process runs only
// while the agent host says a plugin's script needs it, and the agent host connects to its socket.

import type { MainToPluginHost, PluginHostToMain } from '@shared/plugin-host'
import { PluginHostWatch } from '@shared/plugin-host-watch'
import { createLogger } from '../main/log'
import { ForkedHost, type HostTimings } from './forked-host'

type Host = ForkedHost<MainToPluginHost, PluginHostToMain>

export interface PluginHostOptions {
  modulePath: string
  /** The engine's WebAssembly file, which the build puts beside the bundles. */
  wasmPath: string
  env: NodeJS.ProcessEnv
  /** Tells the agent host the socket of a plugin host that is ready. */
  ready(socketPath: string): void
  inspector?(url: string | null): void
  timings?: HostTimings
}

export class PluginHost {
  private host: Host | null = null
  private readonly log = createLogger('plugin-host')
  private readonly watch = new PluginHostWatch(
    (id) => this.host?.post({ type: 'plugin-host:ping', id }),
    () => this.host?.kill(),
  )

  constructor(private readonly options: PluginHostOptions) {}

  /** Starts the process when the agent host needs it and stops it when it no longer does. */
  setWanted(run: boolean): void {
    if (!run) {
      void this.stop()
      return
    }
    if (this.host) {
      // The agent host asks again after it restarted, or after it lost its port.
      if (this.host.state === 'ready') this.announce(this.host)
      else this.host.restart()
      return
    }
    const { options } = this
    const host: Host = new ForkedHost<MainToPluginHost, PluginHostToMain>({
      log: this.log,
      modulePath: options.modulePath,
      socketName: 'plugin-host',
      env: options.env,
      inspector: options.inspector,
      timings: options.timings,
      initMessage: (socketPath) => ({
        type: 'plugin-host:init',
        wasmPath: options.wasmPath,
        socketPath: socketPath ?? undefined,
      }),
      shutdownMessage: { type: 'plugin-host:shutdown' },
      readyType: 'plugin-host:ready',
      stoppedType: 'plugin-host:stopped',
      onMessage: (message) => {
        if (message.type === 'plugin-host:pong') this.watch.pong(message.id)
      },
      onReady: () => {
        if (this.host !== host) return
        this.watch.start()
        this.announce(host)
      },
      onExit: () => {
        if (this.host === host) this.watch.stop()
      },
    })
    this.host = host
    host.start()
  }

  /** Stops the process; a later need starts a new one. */
  async stop(): Promise<void> {
    const host = this.host
    this.host = null
    this.watch.stop()
    await host?.stop()
  }

  private announce(host: Host): void {
    if (host.socketPath) this.options.ready(host.socketPath)
  }
}
