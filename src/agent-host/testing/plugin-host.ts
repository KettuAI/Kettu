// Test helpers: the plugin host in the test's own process, behind the port the agent host takes.

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { AgentToPluginHost, PluginHostToAgent } from '@shared/plugin-host'
import type { PortChannel } from '@shared/port-channel'
import { loadEngine, type Engine } from '../../plugin-host/engine'
import type { EnvironmentLimits } from '../../plugin-host/environment'
import { createPluginService, type PluginService } from '../../plugin-host/start'
import { PluginHostClient, type PluginHostClientOptions } from '../plugin-runtime/client'

let engine: Promise<Engine> | null = null

/** The script engine, compiled once for all the tests of a file. */
export function pluginEngine(): Promise<Engine> {
  engine ??= (async () => {
    const wasm = createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm')
    return loadEngine(new Uint8Array(await readFile(wasm)))
  })()
  return engine
}

interface End<Out> extends PortChannel<Out> {
  peer: End<unknown> | null
  deliver(data: unknown): void
  closed(): void
}

/** Two ends of a port that carries only what JSON can, as the real ones do. */
function portPair(): [End<AgentToPluginHost>, End<PluginHostToAgent>] {
  const end = <Out>(): End<Out> => {
    let listener: ((data: unknown) => void) | null = null
    const queued: unknown[] = []
    const closers: (() => void)[] = []
    let open = true
    const self: End<Out> = {
      peer: null,
      deliver: (data) => (listener ? listener(data) : queued.push(data)),
      send: (message) => {
        if (!open) return
        const copy: unknown = JSON.parse(JSON.stringify(message))
        queueMicrotask(() => self.peer?.deliver(copy))
      },
      onMessage: (next) => {
        listener = next
        for (const data of queued.splice(0)) next(data)
      },
      onClose: (next) => closers.push(next),
      close: () => {
        if (!open) return
        open = false
        queueMicrotask(() => self.peer?.closed())
      },
      closed: () => {
        open = false
        for (const closer of closers) closer()
      },
    }
    return self
  }
  const a = end<AgentToPluginHost>()
  const b = end<PluginHostToAgent>()
  a.peer = b
  b.peer = a
  return [a, b]
}

/**
 * A plugin host that starts when the agent host asks for it, reads each script from `scripts` by
 * its path, and hands the agent host its port through `attach`.
 */
export class TestPluginHost {
  readonly scripts = new Map<string, string>()
  readonly logs: string[] = []
  /** The limits the plugins run under; set before one is woken. */
  limits: Partial<EnvironmentLimits> = {}
  private service: PluginService | null = null

  constructor(private readonly attach: (port: PortChannel<AgentToPluginHost>) => void) {}

  /** What the agent host's `want` calls. */
  want = (run: boolean): void => {
    if (!run) {
      this.service?.stop()
      this.service = null
      return
    }
    queueMicrotask(() => void this.start())
  }

  private async start(): Promise<void> {
    const service = createPluginService({
      engine: await pluginEngine(),
      readScript: async (path) => {
        const source = this.scripts.get(path) ?? (await readFile(path, 'utf8'))
        return source
      },
      log: (pluginId, level, text) => this.logs.push(`${pluginId} ${level} ${text}`),
      limits: this.limits,
    })
    this.service = service
    const [agentEnd, hostEnd] = portPair()
    service.connect(hostEnd)
    this.attach(agentEnd)
  }

  stop(): void {
    this.service?.stop()
    this.service = null
  }
}

/** A client of the plugin host with a plugin host of its own behind it. */
export function pluginClient(
  options: Pick<PluginHostClientOptions, 'functions'> & Partial<PluginHostClientOptions>,
): { client: PluginHostClient; host: TestPluginHost } {
  const host: TestPluginHost = new TestPluginHost((port) => client.attach(port))
  const client: PluginHostClient = new PluginHostClient({
    want: host.want,
    log: () => {},
    ...options,
  })
  return { client, host }
}
