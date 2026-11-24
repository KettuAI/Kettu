import { MessageChannelMain, type MessagePortMain } from 'electron'
import type { MainToPluginHost, PluginHostToMain } from '@shared/plugin-host'
import { PluginHostWatch } from '@shared/plugin-host-watch'
import wasmPath from '@jitl/quickjs-wasmfile-release-sync/wasm?asset'
import pluginHostPath from '../plugin-host/index?modulePath'
import { UtilityHost } from './utility-host'

type Host = UtilityHost<MainToPluginHost, PluginHostToMain>

export interface PluginHostDeps {
  /** Hands the agent host its port to the plugin host; false when the agent host is not running. */
  handPort(port: MessagePortMain): boolean
}

/**
 * Main's side of the plugin host, which runs only while the agent host says a plugin's script
 * needs it. No page connects to it: its one port goes to the agent host.
 */
export class PluginHost {
  private host: Host | null = null
  private readonly watch = new PluginHostWatch(
    (id) => this.host?.post({ type: 'plugin-host:ping', id }),
    () => this.host?.kill(),
  )

  constructor(private readonly deps: PluginHostDeps) {}

  /** Starts the process when the agent host needs it and stops it when it no longer does. */
  setWanted(run: boolean): void {
    if (!run) {
      void this.stop()
      return
    }
    if (this.host) {
      // The agent host asks again after it restarted, or after it lost its port.
      if (this.host.state === 'ready') this.handPort(this.host)
      else this.host.restart()
      return
    }
    const host: Host = new UtilityHost<MainToPluginHost, PluginHostToMain>({
      label: 'plugin-host',
      modulePath: pluginHostPath,
      serviceName: 'Kettu Plugin Host',
      initMessage: () => ({ type: 'plugin-host:init', wasmPath }),
      shutdownMessage: { type: 'plugin-host:shutdown' },
      readyType: 'plugin-host:ready',
      stoppedType: 'plugin-host:stopped',
      onMessage: (message) => {
        if (message.type === 'plugin-host:pong') this.watch.pong(message.id)
      },
      onReady: () => {
        if (this.host !== host) return
        this.watch.start()
        this.handPort(host)
      },
      onExit: () => {
        if (this.host === host) this.watch.stop()
      },
    })
    this.host = host
    host.start()
  }

  /** Stops the process; a later need starts a new one. */
  stop(): Promise<void> {
    const host = this.host
    this.host = null
    this.watch.stop()
    return host ? host.stop() : Promise.resolve()
  }

  private handPort(host: Host): void {
    const { port1, port2 } = new MessageChannelMain()
    if (host.post({ type: 'plugin-host:connect' }, [port1]) && this.deps.handPort(port2)) return
    port1.close()
    port2.close()
  }
}
