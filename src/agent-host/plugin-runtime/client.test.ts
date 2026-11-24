import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  PluginRequestError,
  type AgentToPluginHost,
  type PluginHostToAgent,
} from '@shared/plugin-host'
import type { PortChannel } from '@shared/port-channel'
import { loadEngine, type Engine } from '../../plugin-host/engine'
import { createPluginService, type PluginService } from '../../plugin-host/start'
import { PluginHostClient, type PluginFunction } from './client'

let engine: Engine

beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm')
  engine = await loadEngine(new Uint8Array(await readFile(wasm)))
})

interface End<Out> extends PortChannel<Out> {
  raw(message: unknown): void
}

/** Two ends of a port that carries only what JSON can, as the real ones do. */
function pair(): [End<AgentToPluginHost>, End<PluginHostToAgent>] {
  const end = <Out>(): End<Out> & { peer: End<unknown> | null; deliver(data: unknown): void } => {
    let listener: ((data: unknown) => void) | null = null
    const queued: unknown[] = []
    const closers: (() => void)[] = []
    let open = true
    const self = {
      peer: null as End<unknown> | null,
      deliver: (data: unknown) => (listener ? listener(data) : queued.push(data)),
      raw: (message: unknown) => {
        if (!open) return
        const copy: unknown = JSON.parse(JSON.stringify(message))
        const peer = self.peer as unknown as { deliver(data: unknown): void }
        queueMicrotask(() => peer.deliver(copy))
      },
      send: (message: Out) => self.raw(message),
      onMessage: (next: (data: unknown) => void) => {
        listener = next
        for (const data of queued.splice(0)) next(data)
      },
      onClose: (next: () => void) => closers.push(next),
      close: () => {
        if (!open) return
        open = false
        const peer = self.peer as unknown as { closed(): void }
        queueMicrotask(() => peer.closed())
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

interface Setup {
  client: PluginHostClient
  wants: boolean[]
  logs: string[]
  /** What the agent host's end of the current port receives is also served; this is its end. */
  agentEnd(): End<AgentToPluginHost>
  /** Ends the plugin host's process, as a crash does. */
  crashHost(): void
  add(id: string, source: string, activation?: string[]): void
}

function setup(functions: Record<string, PluginFunction> = {}): Setup {
  const scripts = new Map<string, string>()
  const wants: boolean[] = []
  const logs: string[] = []
  let service: PluginService | null = null
  let agent: End<AgentToPluginHost> | null = null
  const startHost = (): void => {
    service = createPluginService({
      engine,
      readScript: async (path) => scripts.get(path)!,
      log: (pluginId, level, text) => logs.push(`${pluginId} ${level} ${text}`),
      limits: { callMs: 100, answerMs: 1000 },
    })
    const [agentEnd, hostEnd] = pair()
    agent = agentEnd
    service.connect(hostEnd)
    client.attach(agentEnd)
  }
  const client: PluginHostClient = new PluginHostClient({
    want: (run) => {
      wants.push(run)
      if (run) queueMicrotask(startHost)
      else service?.stop()
    },
    functions,
    log: () => {},
    timings: { startMs: 1000, idleStopMs: 50, crashWindowMs: 200 },
  })
  return {
    client,
    wants,
    logs,
    agentEnd: () => agent!,
    crashHost: () => {
      service?.stop()
      queueMicrotask(startHost)
    },
    add: (id, source, activation = ['command:run']) => {
      scripts.set(`/${id}.js`, source)
      client.register({ id, scriptPath: `/${id}.js`, activation })
    },
  }
}

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    if (error instanceof PluginRequestError) return error.code
    throw error
  }
  return 'ok'
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('the plugin host over its port', () => {
  it('starts the process only for a declared trigger and lets it go when idle', async () => {
    const { client, wants, add } = setup()
    add('hello', `exports.greet = (name) => 'Hello, ' + name`)
    expect(await code(client.activate('hello', 'command:other'))).toBe('not_declared')
    expect(await code(client.activate('stranger', 'command:run'))).toBe('invalid')
    expect(await code(client.call('hello', 'greet', ['you']))).toBe('not_active')
    expect(wants).toEqual([])
    await client.activate('hello', 'command:run')
    expect(wants).toEqual([true])
    expect(await client.call('hello', 'greet', ['you'])).toBe('Hello, you')
    expect(client.status()).toEqual([{ id: 'hello', state: 'active', crashes: 0, reason: null }])
    await client.unregister('hello')
    await wait(120)
    expect(wants).toEqual([true, false])
    expect(client.status()).toEqual([])
  })

  it('round-trips calls and events and answers host functions from its own list only', async () => {
    const seen: unknown[] = []
    const { client, add } = setup({
      'sessions.count': (pluginId, args) => {
        seen.push([pluginId, args])
        return 3
      },
    })
    add(
      'counter',
      `let events = 0
       kettu.on('tick', (payload) => { events += payload.by })
       exports.events = () => events
       exports.count = () => kettu.call('sessions.count', 'open')
       exports.reach = (name) => kettu.call(name).then(() => 'answered', (error) => error.message)`,
    )
    await client.activate('counter', 'command:run')
    await client.deliverEvent('counter', 'tick', { by: 2 })
    await client.deliverEvent('counter', 'tick', { by: 3 })
    expect(await client.call('counter', 'events', [])).toBe(5)
    expect(await client.call('counter', 'count', [])).toBe(3)
    expect(seen).toEqual([['counter', ['open']]])
    for (const name of [
      'sessions.delete',
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(await client.call('counter', 'reach', [name])).toBe(`No host function "${name}"`)
    }
  })

  it('refuses malformed requests', async () => {
    const { client, add, agentEnd } = setup()
    add('ok', `exports.ping = () => 1`)
    await client.activate('ok', 'command:run')
    const answers: PluginHostToAgent[] = []
    const end = agentEnd()
    end.onMessage((data) => answers.push(data as PluginHostToAgent))
    const bad = [
      {
        type: 'activate',
        requestId: 9001,
        plugin: { id: '../x', scriptPath: '/x.js', activation: ['a'] },
        trigger: 'a',
      },
      {
        type: 'activate',
        requestId: 9002,
        plugin: { id: 'x', scriptPath: 7, activation: ['a'] },
        trigger: 'a',
      },
      {
        type: 'activate',
        requestId: 9003,
        plugin: { id: 'x', scriptPath: '/x.js', activation: 'a' },
        trigger: 'a',
      },
      { type: 'call', requestId: 9004, pluginId: 'ok', name: 'ping', args: 'no' },
      { type: 'call', requestId: 9005, pluginId: {}, name: 'ping', args: [] },
      { type: 'event', requestId: 9006, pluginId: 'ok', name: 5 },
      { type: 'launch', requestId: 9007 },
    ]
    for (const message of bad) end.raw(message)
    end.raw({ type: 'call', requestId: 'x', pluginId: 'ok', name: 'ping', args: [] })
    end.raw('call')
    await wait(20)
    expect(
      answers
        .filter((answer) => answer.type === 'answer')
        .map((answer) => 'error' in answer && answer.error.code),
    ).toEqual(bad.map(() => 'invalid'))
  })

  it('keeps a crashing plugin away from the others and disabled across a host restart', async () => {
    const { client, add, crashHost, logs } = setup()
    add('steady', `let calls = 0; exports.next = () => ++calls`)
    add('wild', `exports.spin = () => { for (;;) {} }`)
    await client.activate('steady', 'command:run')
    expect(await client.call('steady', 'next', [])).toBe(1)
    for (let crash = 0; crash < 3; crash++) {
      await client.activate('wild', 'command:run')
      expect(await code(client.call('wild', 'spin', []))).toBe('crashed')
    }
    expect(await client.call('steady', 'next', [])).toBe(2)
    expect(client.status()).toContainEqual({
      id: 'wild',
      state: 'disabled',
      crashes: 3,
      reason: 'deadline',
    })
    expect(await code(client.activate('wild', 'command:run'))).toBe('disabled')
    expect(logs.some((line) => line.startsWith('wild error') && line.includes('disabled'))).toBe(
      true,
    )

    crashHost()
    await wait(20)
    // The new process holds no script, and still refuses the disabled plugin.
    expect(await code(client.call('steady', 'next', []))).toBe('not_active')
    expect(client.status().map((plugin) => [plugin.id, plugin.state])).toEqual([
      ['wild', 'disabled'],
    ])
    client.register({ id: 'wild', scriptPath: '/wild.js', activation: ['command:run'] })
    expect(await code(client.activate('wild', 'command:run'))).toBe('disabled')
    await client.activate('steady', 'command:run')
    expect(await client.call('steady', 'next', [])).toBe(1)

    await client.enable('wild')
    await client.activate('wild', 'command:run')
    expect(client.status().find((plugin) => plugin.id === 'wild')?.state).toBe('active')
  })

  it('fails what waits when it stops', async () => {
    const { client, add, wants } = setup()
    add('slow', `exports.never = () => new Promise(() => {})`)
    await client.activate('slow', 'command:run')
    const waiting = code(client.call('slow', 'never', []))
    client.stop()
    expect(await waiting).toBe('unavailable')
    expect(wants).toEqual([true, false])
    expect(await code(client.start())).toBe('unavailable')
  })
})
