import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PluginRequestError, type PluginScript, type PluginStatus } from '@shared/plugin-host'
import { loadEngine, type Engine } from './engine'
import type { EnvironmentLimits } from './environment'
import { HOST_FUNCTIONS } from './host-functions'
import { PluginManager } from './plugins'

const LIMITS: Partial<EnvironmentLimits> = {
  callMs: 100,
  beforeSendMs: 50,
  answerMs: 1000,
  memoryBytes: 16 * 1024 * 1024,
}

let engine: Engine

beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm')
  engine = await loadEngine(new Uint8Array(await readFile(wasm)))
})

interface Setup {
  manager: PluginManager
  logs: { pluginId: string; level: string; text: string }[]
  statuses: PluginStatus[][]
  forwarded: { pluginId: string; name: string; args: unknown[] }[]
  clock: { now: number }
  wake(id: string, source: string): Promise<void>
}

function setup(): Setup {
  const scripts = new Map<string, string>()
  const logs: Setup['logs'] = []
  const statuses: PluginStatus[][] = []
  const forwarded: Setup['forwarded'] = []
  const clock = { now: 1_000_000 }
  const manager = new PluginManager({
    engine,
    functions: HOST_FUNCTIONS,
    forward: async (pluginId, name, args) => {
      forwarded.push({ pluginId, name, args })
      if (name !== 'agent.double') throw new Error(`No host function "${name}"`)
      return (args[0] as number) * 2
    },
    readScript: async (path) => scripts.get(path)!,
    log: (pluginId, level, text) => logs.push({ pluginId, level, text }),
    onStatus: (plugins) => statuses.push(plugins),
    now: () => clock.now,
    limits: LIMITS,
  })
  const plugin = (id: string): PluginScript => ({
    id,
    scriptPath: `/${id}.js`,
    activation: ['event:test'],
  })
  return {
    manager,
    logs,
    statuses,
    forwarded,
    clock,
    wake: (id, source) => {
      scripts.set(`/${id}.js`, source)
      return manager.activate(plugin(id), 'event:test')
    },
  }
}

const state = (manager: PluginManager, id: string): PluginStatus | undefined =>
  manager.status().find((plugin) => plugin.id === id)

async function code(run: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof run === 'function' ? run() : run)
  } catch (error) {
    if (error instanceof PluginRequestError) return error.code
    throw error
  }
  return 'ok'
}

const HELPERS = `
  exports.loop = () => { for (;;) {} }
  exports.hog = () => { const kept = []; for (;;) kept.push(new Array(100000).fill(0)) }
  exports.ping = (value) => ({ pong: value })
`

describe('what a plugin can reach', () => {
  it('sees no global of the host', async () => {
    const { manager, wake } = setup()
    await wake(
      'probe',
      `exports.probe = () => ({
        names: Object.getOwnPropertyNames(globalThis).sort(),
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        buffer: typeof Buffer,
        webAssembly: typeof WebAssembly,
        viaFunction: typeof Function('return this')().process,
        viaConstructor: typeof (() => {}).constructor('return typeof process === "undefined" ? undefined : process')(),
        hostGlobal: Function('return this')() === globalThis,
        callSource: String(kettu.call),
      })`,
    )
    const seen = (await manager.call('probe', 'probe', [], 'call')) as Record<string, unknown>
    expect(seen).toMatchObject({
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      buffer: 'undefined',
      webAssembly: 'undefined',
      viaFunction: 'undefined',
      viaConstructor: 'undefined',
      hostGlobal: true,
    })
    const names = seen['names'] as string[]
    for (const provided of [
      'kettu',
      'console',
      'setTimeout',
      'clearTimeout',
      'module',
      'exports',
    ]) {
      expect(names).toContain(provided)
    }
    for (const name of names) expect(name in globalThis || provided(name)).toBe(true)
    function provided(name: string): boolean {
      return ['kettu', 'module', 'exports', 'InternalError'].includes(name)
    }
    // Nothing of the host functions is left on the global object.
    expect(names.some((name) => /native|__/.test(name))).toBe(false)
  })

  it('cannot change the host through what it returns or pollutes', async () => {
    const { manager, wake } = setup()
    await wake(
      'polluter',
      `Object.prototype.polluted = 'yes'
       exports.answer = () => JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted": "yes"}}}')`,
    )
    await manager.call('polluter', 'answer', [], 'call')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('refuses values past the size limit, either way', async () => {
    const { manager, wake } = setup()
    await wake('big', `exports.big = () => 'x'.repeat(2 * 1024 * 1024); exports.take = () => 1`)
    expect(await code(manager.call('big', 'big', [], 'call'))).toBe('too_large')
    expect(await code(manager.call('big', 'take', ['x'.repeat(2 * 1024 * 1024)], 'call'))).toBe(
      'too_large',
    )
    expect(state(manager, 'big')?.state).toBe('active')
  })
})

describe('activation', () => {
  it('loads a plugin only for something its manifest declares', async () => {
    const { manager } = setup()
    const plugin = { id: 'quiet', scriptPath: '/quiet.js', activation: ['command:go'] }
    expect(await code(manager.activate(plugin, 'event:other'))).toBe('not_declared')
    expect(await code(manager.call('quiet', 'ping', [], 'call'))).toBe('not_active')
    expect(await code(() => manager.event('quiet', 'test', null))).toBe('not_active')
  })
})

describe('calls and events', () => {
  it('round-trips calls, events, timers and host functions', async () => {
    const { manager, wake, logs, forwarded } = setup()
    await wake(
      'echo',
      `const seen = []
       kettu.on('changed', (payload) => { seen.push(payload.value) })
       exports.seen = () => seen
       exports.sum = (a, b) => a + b
       exports.viaHost = async (value) => ({ echoed: await kettu.call('echo', value), doubled: await kettu.call('agent.double', 21) })
       exports.later = (ms) => new Promise((resolve) => setTimeout(resolve, ms, 'done'))
       exports.cleared = () => new Promise((resolve) => { const id = setTimeout(() => resolve('fired'), 5); clearTimeout(id); setTimeout(() => resolve('cleared'), 20) })
       exports.unknown = () => kettu.call('nothing.here').catch((error) => error.message)
       exports.fails = () => { throw new TypeError('no') }
       console.warn('loaded', { n: 1 })`,
    )
    expect(await manager.call('echo', 'sum', [2, 3], 'call')).toBe(5)
    expect(await manager.call('echo', 'viaHost', [{ a: [1, 'two'] }], 'call')).toEqual({
      echoed: { a: [1, 'two'] },
      doubled: 42,
    })
    expect(forwarded).toEqual([{ pluginId: 'echo', name: 'agent.double', args: [21] }])
    expect(await manager.call('echo', 'later', [10], 'call')).toBe('done')
    expect(await manager.call('echo', 'cleared', [], 'call')).toBe('cleared')
    expect(await manager.call('echo', 'unknown', [], 'call')).toBe(
      'No host function "nothing.here"',
    )
    manager.event('echo', 'changed', { value: 1 })
    manager.event('echo', 'changed', { value: 2 })
    manager.event('echo', 'unheard', { value: 3 })
    expect(await manager.call('echo', 'seen', [], 'call')).toEqual([1, 2])
    expect(await code(manager.call('echo', 'fails', [], 'call'))).toBe('failed')
    expect(await code(manager.call('echo', 'missing', [], 'call'))).toBe('failed')
    expect(await code(manager.call('echo', 'toString', [], 'call'))).toBe('failed')
    expect(logs).toContainEqual({ pluginId: 'echo', level: 'warn', text: 'loaded {"n":1}' })
    expect(state(manager, 'echo')).toMatchObject({ state: 'active', crashes: 0 })
  })

  it('gives up on an answer that never comes without counting a crash', async () => {
    const { manager, wake } = setup()
    await wake('slow', `exports.never = () => new Promise(() => {})`)
    const started = performance.now()
    expect(await code(manager.call('slow', 'never', [], 'before-send'))).toBe('timeout')
    expect(performance.now() - started).toBeLessThan(500)
    expect(state(manager, 'slow')).toMatchObject({ state: 'active', crashes: 0 })
  })
})

describe('limits', () => {
  it('stops a busy loop at its deadline and counts a crash', async () => {
    const { manager, wake } = setup()
    await wake('busy', HELPERS)
    await wake('calm', HELPERS)
    const started = performance.now()
    expect(await code(manager.call('busy', 'loop', [], 'call'))).toBe('crashed')
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(95)
    expect(took).toBeLessThan(400)
    expect(state(manager, 'busy')).toMatchObject({ state: 'idle', crashes: 1, reason: 'deadline' })
    expect(await code(manager.call('busy', 'ping', [1], 'call'))).toBe('not_active')
    // The other plugin never noticed.
    expect(await manager.call('calm', 'ping', [1], 'call')).toEqual({ pong: 1 })
    expect(state(manager, 'calm')).toMatchObject({ state: 'active', crashes: 0 })
    // What wakes it again loads it afresh.
    await wake('busy', HELPERS)
    expect(await manager.call('busy', 'ping', [2], 'call')).toEqual({ pong: 2 })
  })

  it('stops loops in a listener, a timer, a promise job and at load', async () => {
    const { manager, wake } = setup()
    await wake('listener', `kettu.on('go', () => { for (;;) {} })`)
    expect(await code(() => manager.event('listener', 'go', null))).toBe('crashed')
    await wake(
      'timer',
      `exports.arm = () => { setTimeout(() => { for (;;) {} }, 1); return true }
       exports.job = () => Promise.resolve().then(() => { for (;;) {} })
       exports.regex = () => /^(a+)+$/.test('a'.repeat(40) + '!')`,
    )
    await manager.call('timer', 'arm', [], 'call')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(state(manager, 'timer')).toMatchObject({ state: 'idle', crashes: 1 })
    await wake('timer', `exports.job = () => Promise.resolve().then(() => { for (;;) {} })`)
    expect(await code(manager.call('timer', 'job', [], 'call'))).toBe('crashed')
    expect(await code(wake('load', `for (;;) {}`))).toBe('crashed')
    expect(state(manager, 'load')).toMatchObject({ state: 'idle', crashes: 1 })
  })

  it('stops an allocation loop at the memory limit without touching another plugin', async () => {
    const { manager, wake } = setup()
    await wake('hog', HELPERS)
    await wake(
      'calm',
      HELPERS +
        `exports.fill = () => { globalThis.kept = new Array(100000).fill('y'); return kept.length }`,
    )
    expect(await manager.call('calm', 'fill', [], 'call')).toBe(100000)
    expect(await code(manager.call('hog', 'hog', [], 'call'))).toBe('crashed')
    expect(state(manager, 'hog')).toMatchObject({ state: 'idle', crashes: 1, reason: 'memory' })
    expect(await manager.call('calm', 'ping', ['still here'], 'call')).toEqual({
      pong: 'still here',
    })
    expect(await manager.call('calm', 'fill', [], 'call')).toBe(100000)
  })

  it('treats deep recursion as an error of the plugin, not a crash', async () => {
    const { manager, wake } = setup()
    await wake('deep', `exports.dive = function dive() { return dive() + 1 }; exports.ok = () => 1`)
    expect(await code(manager.call('deep', 'dive', [], 'call'))).toBe('failed')
    expect(await manager.call('deep', 'ok', [], 'call')).toBe(1)
  })
})

describe('crashes', () => {
  it('disables a plugin after three crashes in a minute until it is enabled', async () => {
    const { manager, wake, statuses, clock } = setup()
    await wake('calm', HELPERS)
    for (let crash = 1; crash <= 3; crash++) {
      await wake('flaky', HELPERS)
      expect(await code(manager.call('flaky', 'loop', [], 'call'))).toBe('crashed')
      clock.now += 1000
      expect(state(manager, 'flaky')?.crashes).toBe(crash)
    }
    expect(state(manager, 'flaky')).toMatchObject({ state: 'disabled', reason: 'deadline' })
    expect(statuses.at(-1)).toContainEqual({
      id: 'flaky',
      state: 'disabled',
      crashes: 3,
      reason: 'deadline',
    })
    expect(await code(wake('flaky', HELPERS))).toBe('disabled')
    expect(await code(manager.call('flaky', 'ping', [], 'call'))).toBe('disabled')
    expect(await manager.call('calm', 'ping', [1], 'call')).toEqual({ pong: 1 })
    manager.enable('flaky')
    expect(state(manager, 'flaky')).toMatchObject({ state: 'idle', crashes: 0, reason: null })
    await wake('flaky', HELPERS)
    expect(await manager.call('flaky', 'ping', [3], 'call')).toEqual({ pong: 3 })
  })

  it('does not disable a plugin whose crashes are more than a minute apart', async () => {
    const { manager, wake, clock } = setup()
    for (let crash = 0; crash < 4; crash++) {
      await wake('rare', HELPERS)
      expect(await code(manager.call('rare', 'loop', [], 'call'))).toBe('crashed')
      clock.now += 40_000
    }
    expect(state(manager, 'rare')?.state).toBe('idle')
  })

  it('keeps a restored plugin disabled', async () => {
    const { manager, wake } = setup()
    manager.restore([{ id: 'old', reason: 'memory' }])
    expect(await code(wake('old', HELPERS))).toBe('disabled')
    expect(state(manager, 'old')).toMatchObject({ state: 'disabled', reason: 'memory' })
  })
})
