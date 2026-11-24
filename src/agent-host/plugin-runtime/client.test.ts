import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  PluginRequestError,
  type AgentToPluginHost,
  type PluginHostToAgent,
} from '@shared/plugin-host'
import { PLUGIN_HOOK_EVENTS, PLUGIN_PERMISSIONS } from '@shared/plugins'
import { PLUGIN_REF_EVENTS } from '@shared/plugin-refs'
import { PLUGIN_CHANNEL_EVENT } from '@shared/plugin-channels'
import { PLUGIN_VIEW_EVENTS } from '@shared/plugin-views'
import type { PortChannel } from '@shared/port-channel'
import { loadEngine, type Engine } from '../../plugin-host/engine'
import { readPackage, readPackageFolder } from '../plugins/package'
import { createPluginService, type PluginService } from '../../plugin-host/start'
import type { PluginApiCall } from './call'
import { PluginHostClient } from './client'
import { PLUGIN_EVENTS, RANDOM_BYTES_MAX, createPluginApi, type PluginApiDeps } from './functions'
import type { HttpTransport } from './network'
import { PluginStorage } from './storage'
import { tempFolder } from '../testing/temp'

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
  add(id: string, source: string, activation?: string[], permissions?: string[]): void
}

function setup(functions: Record<string, PluginApiCall> = {}): Setup {
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
    add: (id, source, activation = ['command:run'], permissions = []) => {
      scripts.set(`/${id}.js`, source)
      client.register({ id, scriptPath: `/${id}.js`, activation }, permissions)
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
      'sessions.count': {
        permission: null,
        run: ({ pluginId }, args) => {
          seen.push([pluginId, args])
          return 3
        },
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

/** A script that passes a call on and reports what became of it. */
const RELAY = `exports.call = (name, ...args) =>
  kettu.call(name, ...args).then((value) => ({ ok: value }), (error) => ({ error: error.message }))`

function apiDeps() {
  const sessions = {
    list: vi.fn(() => []),
    turns: vi.fn(async () => []),
    info: vi.fn(() => null),
    summary: vi.fn(),
    startedBy: vi.fn(() => []),
    agents: vi.fn(() => []),
    defaultAgent: vi.fn(() => null),
    project: vi.fn(),
    start: vi.fn(async () => 'new'),
    send: vi.fn(async () => ({ delivered: 'sent' as const })),
    now: () => 0,
  }
  const transport = vi.fn<HttpTransport>(async () => ({
    status: 200,
    headers: {},
    body: 'fine',
  }))
  const deps: PluginApiDeps = {
    locale: () => 'zh-CN',
    colorMode: () => null,
    sessions: sessions as unknown as PluginApiDeps['sessions'],
    own: {
      setting: vi.fn(() => 'on'),
      secret: vi.fn(() => null),
      storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
    },
    channels: { answer: vi.fn() },
    transport,
  }
  return { deps, sessions, transport }
}

describe('the plugin API', () => {
  it('answers a call only to a plugin that has its permission, naming the one it lacks', async () => {
    const { deps, sessions, transport } = apiDeps()
    const api = createPluginApi(deps)
    const { client, add } = setup(api)
    add('bare', RELAY)
    await client.activate('bare', 'command:run')
    let gated = 0
    for (const [name, call] of Object.entries(api)) {
      if (call.permission === null) continue
      gated++
      const needs = call.permission === 'network' ? 'network:<domain>' : call.permission
      expect(
        await client.call('bare', 'call', [name, 'https://api.example.com/', {}]),
        name,
      ).toEqual({ error: expect.stringContaining(`"${needs}"`) })
    }
    expect(gated).toBeGreaterThan(0)
    expect(transport).not.toHaveBeenCalled()
    for (const fn of Object.values(sessions)) {
      if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled()
    }
  })

  it('opens each permission to its own calls and no others', async () => {
    const { deps } = apiDeps()
    const api = createPluginApi(deps)
    const { client, add } = setup(api)
    for (const permission of PLUGIN_PERMISSIONS) {
      add(`only-${permission}`, RELAY, ['command:run'], [permission])
      await client.activate(`only-${permission}`, 'command:run')
      for (const [name, call] of Object.entries(api)) {
        if (call.permission === null || call.permission === permission) continue
        const answer = (await client.call(`only-${permission}`, 'call', [name, {}])) as {
          error?: string
        }
        expect(answer.error, `${permission} for ${name}`).toContain('needs the permission')
      }
    }
    // Every call asks for a permission a plugin can declare.
    for (const call of Object.values(api)) {
      if (call.permission === null || call.permission === 'network') continue
      expect(PLUGIN_PERMISSIONS as readonly string[]).toContain(call.permission)
    }
  })

  it('answers the calls that need no permission', async () => {
    const { client, add } = setup(createPluginApi(apiDeps().deps))
    add('bare', RELAY)
    await client.activate('bare', 'command:run')
    expect(await client.call('bare', 'call', ['api.version'])).toEqual({ ok: 1 })
    expect(await client.call('bare', 'call', ['app.locale'])).toEqual({ ok: 'zh-CN' })
    expect(await client.call('bare', 'call', ['app.colorMode'])).toEqual({ ok: null })
  })

  it('gives each plugin its own settings, secrets and storage, with no permission, and no other plugin’s', async () => {
    const dir = await tempFolder('kettu-plugin-own-')
    await mkdir(path.join(dir, 'one'))
    await mkdir(path.join(dir, 'two'))
    const { deps } = apiDeps()
    deps.own = {
      setting: (pluginId, key) => {
        if (key !== 'mode') throw new Error(`${pluginId} declares no setting ${key}`)
        return pluginId === 'one' ? 'deep' : 'fast'
      },
      secret: (pluginId, key) => (pluginId === 'one' && key === 'token' ? 'tok-1' : null),
      storage: new PluginStorage(
        (id) => path.join(dir, id),
        () => {},
      ),
    }
    const { client, add } = setup(createPluginApi(deps))
    add('one', RELAY)
    add('two', RELAY)
    await client.activate('one', 'command:run')
    await client.activate('two', 'command:run')
    const call = (id: string, ...args: unknown[]) => client.call(id, 'call', args)
    expect(await call('one', 'settings.get', 'mode')).toEqual({ ok: 'deep' })
    expect(await call('two', 'settings.get', 'mode')).toEqual({ ok: 'fast' })
    expect(await call('one', 'settings.get', 'other')).toEqual({
      error: 'one declares no setting other',
    })
    expect(await call('one', 'settings.secret', 'token')).toEqual({ ok: 'tok-1' })
    expect(await call('two', 'settings.secret', 'token')).toEqual({ ok: null })
    expect(await call('one', 'storage.set', 'seen', { n: 3 })).toEqual({ ok: null })
    expect(await call('one', 'storage.get', 'seen')).toEqual({ ok: { n: 3 } })
    expect(await call('two', 'storage.get', 'seen')).toEqual({ ok: null })
    expect(await call('one', 'storage.keys')).toEqual({ ok: ['seen'] })
    expect(await call('one', 'storage.delete', 'seen')).toEqual({ ok: null })
    expect(await call('one', 'storage.keys')).toEqual({ ok: [] })
    expect(await call('one', 'storage.get', 7)).toEqual({
      error: expect.stringContaining('storage key'),
    })
  })

  it('gives random bytes as hex without a permission, up to its cap, and refuses any other length', async () => {
    const { client, add } = setup(createPluginApi(apiDeps().deps))
    add('bare', RELAY)
    await client.activate('bare', 'command:run')
    const bytes = (length: unknown) => client.call('bare', 'call', ['random.bytes', length])
    const first = (await bytes(16)) as { ok: string }
    const second = (await bytes(16)) as { ok: string }
    expect(first.ok).toMatch(/^[0-9a-f]{32}$/)
    expect(second.ok).not.toBe(first.ok)
    expect(((await bytes(RANDOM_BYTES_MAX)) as { ok: string }).ok).toHaveLength(
      RANDOM_BYTES_MAX * 2,
    )
    for (const bad of [0, RANDOM_BYTES_MAX + 1, 1.5, -1, '8', null]) {
      expect(await bytes(bad), String(bad)).toEqual({
        error: expect.stringContaining('whole number of 1 to'),
      })
    }
  })

  it('has no call that runs commands, reads files or reaches credentials, whatever is granted', async () => {
    const { deps } = apiDeps()
    const api = createPluginApi(deps)
    const { client, add } = setup(api)
    add('all', RELAY, ['command:run'], [...PLUGIN_PERMISSIONS, 'network:example.com'])
    await client.activate('all', 'command:run')
    for (const name of [
      'shell.run',
      'process.exec',
      'child_process.spawn',
      'fs.readFile',
      'fs.writeFile',
      'projects.readFile',
      'files.read',
      'system.permissions',
      'camera.capture',
      'credentials.get',
      'agent.credentials',
      'github.token',
      'plugins.data',
      'plugins.list',
      'window.eval',
      'sessions.delete',
      'constructor',
      '__proto__',
    ]) {
      expect(await client.call('all', 'call', [name]), name).toEqual({
        error: `No host function "${name}"`,
      })
    }
  })

  it('only adds calls within a version', () => {
    // The calls version 1 shipped with; one that goes missing or changes its permission breaks plugins.
    const shipped: Record<string, string | null> = {
      'api.version': null,
      'app.locale': null,
      'app.colorMode': null,
      'settings.get': null,
      'settings.secret': null,
      'storage.get': null,
      'storage.set': null,
      'storage.delete': null,
      'storage.keys': null,
      'random.bytes': null,
      'network.fetch': 'network',
      'sessions.list': 'sessions.summary',
      'sessions.read': 'sessions.content',
      'sessions.start': 'sessions.start',
      'sessions.send': 'sessions.start',
    }
    const api = createPluginApi(apiDeps().deps)
    for (const [name, permission] of Object.entries(shipped)) {
      expect(api[name]?.permission, name).toBe(permission)
    }
  })
})

describe('the sample plugin and the published types', () => {
  const folder = path.resolve('packages/plugin-api')

  it('is a package Kettu installs, asking for what its script uses', async () => {
    const pkg = readPackage(await readPackageFolder(path.join(folder, 'sample')), '0.0.0')
    expect(pkg.contents.permissions).toEqual([
      'sessions.summary',
      'prompt.attach',
      'requests.check',
      'network:hooks.example.com',
    ])
    expect(pkg.contents.events).toEqual(['session.beforeSend', 'session.permissionRequested'])
    expect(pkg.contents.mentions).toMatchObject([{ id: 'states' }])
    expect(pkg.contents.links).toMatchObject([
      { id: 'state', patterns: ['https://hooks.example.com/digest/{state}'] },
    ])
    expect(pkg.manifest.kettu).toMatchObject({ api: 1, script: 'sh.kettu/main.js' })
  })

  it('runs through the engine and reaches only what its manifest names', async () => {
    const source = await readFile(path.join(folder, 'sample/sh.kettu/main.js'), 'utf8')
    const { deps, sessions, transport } = apiDeps()
    sessions.list.mockReturnValue([
      { id: 'a', status: 'running', origin: 'user', archivedAt: null },
      { id: 'b', status: 'running', origin: 'user', archivedAt: null },
      { id: 'c', status: 'ready', origin: 'user', archivedAt: null },
    ] as never)
    const { client, add } = setup(createPluginApi(deps))
    add('sample', source, ['command:run'], ['sessions.summary', 'network:hooks.example.com'])
    await client.activate('sample', 'command:run')
    expect(await client.call('sample', 'digest', [])).toEqual({ running: 2, ready: 1 })
    expect(await client.call('sample', 'post', [])).toBe(200)
    expect(transport).toHaveBeenCalledTimes(1)
    const sent = transport.mock.calls[0]![0]
    expect(sent.url.href).toBe('https://hooks.example.com/digest')
    expect(sent).toMatchObject({ method: 'POST', body: '{"running":2,"ready":1}' })

    add('narrow', source, ['command:run'], ['sessions.summary'])
    await client.activate('narrow', 'command:run')
    await expect(client.call('narrow', 'post', [])).rejects.toMatchObject({
      message: expect.stringContaining('needs the permission "network:<domain>"'),
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('attaches its digest to a message and denies a recursive delete, through the hooks', async () => {
    const source = await readFile(path.join(folder, 'sample/sh.kettu/main.js'), 'utf8')
    const { deps, sessions } = apiDeps()
    sessions.list.mockReturnValue([
      { id: 'a', status: 'running', origin: 'user', archivedAt: null },
    ] as never)
    const { client, add } = setup(createPluginApi(deps))
    add(
      'sample',
      source,
      ['session.beforeSend', 'session.permissionRequested'],
      ['sessions.summary'],
    )
    await client.activate('sample', 'session.beforeSend')
    expect(await client.hook('sample', 'session.beforeSend', { sessionId: 'a' })).toEqual([
      { attach: [{ title: 'Working sessions', text: '{"running":1}' }] },
    ])
    const request = (command: string) => ({ sessionId: 'a', request: { command } })
    expect(
      await client.hook('sample', 'session.permissionRequested', request('rm -rf build')),
    ).toEqual([{ deny: 'A recursive delete is not allowed here.' }])
    expect(await client.hook('sample', 'session.permissionRequested', request('ls'))).toEqual([
      null,
    ])
  })

  it('lists its sessions’ states for an @, and what one adds and shows as a link, through the hooks', async () => {
    const source = await readFile(path.join(folder, 'sample/sh.kettu/main.js'), 'utf8')
    const { deps, sessions } = apiDeps()
    sessions.list.mockReturnValue([
      { id: 'a', status: 'running', origin: 'user', archivedAt: null },
      { id: 'b', status: 'ready', origin: 'user', archivedAt: null },
    ] as never)
    const { client, add } = setup(createPluginApi(deps))
    add('sample', source, ['mention:states', 'link:state'], ['sessions.summary'])
    await client.activate('sample', 'mention:states')
    expect(
      await client.hook('sample', 'mention.search', {
        source: 'states',
        query: 'ru',
        locale: 'en',
      }),
    ).toEqual([{ items: [{ id: 'running', title: 'running', subtitle: 'sessions', end: '1' }] }])
    expect(
      await client.hook('sample', 'mention.content', {
        source: 'states',
        item: 'ready',
        locale: 'en',
      }),
    ).toEqual([{ title: 'Sessions that are ready', text: '1 sessions are ready now.' }])
    await client.activate('sample', 'link:state')
    expect(
      await client.hook('sample', 'link.card', {
        link: 'state',
        url: 'https://hooks.example.com/digest/running',
        match: { state: 'running' },
        locale: 'en',
      }),
    ).toEqual([
      {
        label: 'running',
        title: 'Sessions that are running',
        badges: [{ text: '1', tone: 'info' }],
      },
    ])
  })

  it('lists the calls and events the host answers, no more and no fewer', async () => {
    const types = await readFile(path.join(folder, 'index.d.ts'), 'utf8')
    const names = (block: string): string[] => {
      const body = types.split(`export interface ${block} {`)[1]!.split('\n}\n')[0]!
      return [...body.matchAll(/^ {2}'([A-Za-z.]+)': /gm)].map((match) => match[1]!)
    }
    expect(names('KettuCalls').sort()).toEqual(Object.keys(createPluginApi(apiDeps().deps)).sort())
    expect(names('KettuEvents').sort()).toEqual(
      [
        ...PLUGIN_EVENTS,
        ...PLUGIN_VIEW_EVENTS,
        ...PLUGIN_REF_EVENTS,
        PLUGIN_CHANNEL_EVENT,
        ...Object.keys(PLUGIN_HOOK_EVENTS),
      ].sort(),
    )
  })
})
