import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { PLUGIN_BEFORE_SEND_DEADLINE_MS } from '@shared/plugin-host'
import { pluginClient, type TestPluginHost } from '../testing/plugin-host'
import { ATTACH_ITEMS, PluginHooks, requestFacts, type RequestFacts } from './hooks'
import { PluginRefs } from './refs'

const session = {
  id: 's1',
  agentId: 'fake-agent',
  projectPath: '/repo',
  title: 'Fix the clock',
  status: 'running',
  origin: 'user',
  parentId: null,
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
} as SessionSummary

const request: RequestFacts = {
  tool: 'Run rm -rf build',
  kind: 'execute',
  command: 'rm -rf build',
  paths: [],
}

let stop: (() => void) | null = null
afterEach(() => stop?.())

function setup() {
  const logs: string[] = []
  const { client, host } = pluginClient({ functions: {} })
  stop = () => {
    client.stop()
    host.stop()
  }
  const log = (level: 'info' | 'warn', message: string) => logs.push(`${level} ${message}`)
  const hooks = new PluginHooks({
    client,
    refs: new PluginRefs({ client, source: () => null, locale: () => 'en', log }),
    title: (id) => `Plugin ${id}`,
    log,
  })
  const add = (
    id: string,
    source: string,
    events: string[],
    permissions: string[],
  ): TestPluginHost => {
    host.scripts.set(`/${id}.js`, source)
    client.register({ id, scriptPath: `/${id}.js`, activation: events }, permissions)
    return host
  }
  return { hooks, host, logs, add }
}

const told = (host: TestPluginHost, id: string): string[] =>
  host.logs
    .filter((line) => line.startsWith(`${id} info EVENT `))
    .map((line) => line.slice(id.length + 12))

describe('what a plugin is sent', () => {
  it('loads a script only when an event it names happens', async () => {
    const { hooks, host, add } = setup()
    add('quiet', `console.log('LOADED')`, [], ['sessions.summary'])
    add(
      'waiting',
      `console.log('LOADED'); kettu.on('session.turnEnded', () => {})`,
      ['session.turnEnded'],
      ['sessions.summary'],
    )
    hooks.emit('session.started', session)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.logs).toEqual([])
    hooks.emit('session.turnEnded', session, { outcome: 'end_turn', durationMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(host.logs).toEqual(['waiting info LOADED', 'waiting info Loaded'])
  })

  it('sends an event only to a plugin that has its permission, and content only with the high one', async () => {
    const { hooks, host, add } = setup()
    const script = `kettu.on('session.toolFinished', (p) => console.log('EVENT ' + JSON.stringify(p)))`
    add('summary', script, ['session.toolFinished'], ['sessions.summary'])
    add('content', script, ['session.toolFinished'], ['sessions.summary', 'sessions.content'])
    add('none', script, ['session.toolFinished'], ['prompt.attach'])
    hooks.emit(
      'session.toolFinished',
      session,
      { kind: 'execute', status: 'completed' },
      {
        title: 'Run pnpm test',
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    const [only] = told(host, 'summary')
    expect(JSON.parse(only!)).toMatchObject({
      session: { id: 's1', title: 'Fix the clock' },
      kind: 'execute',
      status: 'completed',
    })
    expect(JSON.parse(only!)).not.toHaveProperty('title')
    expect(JSON.parse(told(host, 'content')[0]!)).toHaveProperty('title', 'Run pnpm test')
    expect(told(host, 'none')).toEqual([])
  })

  it('tells a session that is not one the user works in to no plugin', async () => {
    const { hooks, host, add } = setup()
    add(
      'p',
      `kettu.on('session.turnEnded', () => console.log('EVENT x'))`,
      ['session.turnEnded'],
      ['sessions.summary'],
    )
    hooks.emit('session.turnEnded', { ...session, origin: 'task' }, {})
    hooks.emit('session.turnEnded', { ...session, origin: 'subagent' }, {})
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(host.logs).toEqual([])
  })

  it('tells a plugin of events in the order they happened', async () => {
    const { hooks, host, add } = setup()
    add(
      'order',
      `kettu.on('session.toolFinished', (p) => console.log('EVENT ' + p.kind))`,
      ['session.toolFinished'],
      ['sessions.summary'],
    )
    for (const kind of ['read', 'edit', 'execute', 'fetch']) {
      hooks.emit('session.toolFinished', session, { kind, status: 'completed' })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(told(host, 'order')).toEqual(['read', 'edit', 'execute', 'fetch'])
  })
})

describe('before a message is sent', () => {
  it('collects what plugins attach, within their limits, and shows the plugin that did', async () => {
    const { hooks, add } = setup()
    const many = Array.from({ length: ATTACH_ITEMS + 3 }, (_, i) => `{ text: 'item ${i}' }`)
    add(
      'a',
      `kettu.on('session.beforeSend', () => ({ attach: [{ title: 'Ticket', text: 'ABC-1' }] }))`,
      ['session.beforeSend'],
      ['prompt.attach'],
    )
    add(
      'b',
      `kettu.on('session.beforeSend', async () => ({ attach: [${many.join(',')}] }))`,
      ['session.beforeSend'],
      ['prompt.attach'],
    )
    const given = await hooks.attachments(session, 'Fix it')
    expect(given.filter((item) => item.pluginId === 'a')).toEqual([
      { pluginId: 'a', plugin: 'Plugin a', title: 'Ticket', text: 'ABC-1' },
    ])
    expect(given.filter((item) => item.pluginId === 'b')).toHaveLength(ATTACH_ITEMS)
  })

  it('leaves out an answer that is no attachment, and a listener that throws', async () => {
    const { hooks, add } = setup()
    add(
      'odd',
      `kettu.on('session.beforeSend', () => { throw new Error('boom') })
       kettu.on('session.beforeSend', () => ({ attach: [{ text: '   ' }, { text: 7 }, 'x', null] }))
       kettu.on('session.beforeSend', () => 'not an object')
       kettu.on('session.beforeSend', () => ({ attach: [{ text: 'kept' }] }))`,
      ['session.beforeSend'],
      ['prompt.attach'],
    )
    expect(await hooks.attachments(session, 'x')).toEqual([
      { pluginId: 'odd', plugin: 'Plugin odd', text: 'kept' },
    ])
  })

  it('gives a plugin the message and the session only with the permissions for them', async () => {
    const { hooks, host, add } = setup()
    const script = `kettu.on('session.beforeSend', (p) => { console.log('EVENT ' + JSON.stringify(p)) })`
    add('bare', script, ['session.beforeSend'], ['prompt.attach'])
    add(
      'full',
      script,
      ['session.beforeSend'],
      ['prompt.attach', 'sessions.summary', 'sessions.content'],
    )
    await hooks.attachments(session, 'My secret plan')
    expect(JSON.parse(told(host, 'bare')[0]!)).toEqual({ sessionId: 's1' })
    expect(JSON.parse(told(host, 'full')[0]!)).toMatchObject({
      sessionId: 's1',
      session: { id: 's1' },
      text: 'My secret plan',
    })
  })

  it('does not wait past the deadline for a plugin, and keeps the answers of the others', async () => {
    const { hooks, logs, add } = setup()
    add(
      'slow',
      `kettu.on('session.beforeSend', () => new Promise(() => {}))`,
      ['session.beforeSend'],
      ['prompt.attach'],
    )
    add(
      'fast',
      `kettu.on('session.beforeSend', () => ({ attach: [{ text: 'on time' }] }))`,
      ['session.beforeSend'],
      ['prompt.attach'],
    )
    const started = Date.now()
    const given = await hooks.attachments(session, 'x')
    expect(Date.now() - started).toBeLessThan(PLUGIN_BEFORE_SEND_DEADLINE_MS + 400)
    expect(given.map((item) => item.pluginId)).toEqual(['fast'])
    expect(logs.some((line) => line.includes('slow'))).toBe(true)
  })
})

describe('a check of a permission request', () => {
  const answers: [string, string][] = [
    ['an allow', `({ allow: true })`],
    ['a boolean', `true`],
    ['the word allow', `'allow'`],
    ['an empty denial', `({ deny: '  ' })`],
    ['a denial that is no text', `({ deny: true })`],
    ['nothing', `undefined`],
    ['a thrown error', `(() => { throw new Error('boom') })()`],
  ]

  it.each(answers)('cannot allow: %s passes the request to the user', async (_name, answer) => {
    const { hooks, add } = setup()
    add(
      'p',
      `kettu.on('session.permissionRequested', () => ${answer})`,
      ['session.permissionRequested'],
      ['requests.check'],
    )
    expect(await hooks.check(session, request)).toBeNull()
  })

  it('denies with the plugin and its reason, the first plugin that does', async () => {
    const { hooks, add } = setup()
    add(
      'allows',
      `kettu.on('session.permissionRequested', () => ({ allow: true }))`,
      ['session.permissionRequested'],
      ['requests.check'],
    )
    add(
      'denies',
      `kettu.on('session.permissionRequested', ({ request }) => ({ deny: 'No ' + request.command }))`,
      ['session.permissionRequested'],
      ['requests.check'],
    )
    expect(await hooks.check(session, request)).toEqual({
      pluginId: 'denies',
      plugin: 'Plugin denies',
      reason: 'No rm -rf build',
    })
  })

  it('asks no plugin that lacks the permission, and passes a request one is too slow for', async () => {
    const { hooks, add } = setup()
    const deny = `kettu.on('session.permissionRequested', () => ({ deny: 'No' }))`
    add('no-permission', deny, ['session.permissionRequested'], ['sessions.summary'])
    add('not-declared', deny, [], ['requests.check'])
    expect(await hooks.check(session, request)).toBeNull()
    add(
      'slow',
      `kettu.on('session.permissionRequested', () => new Promise((resolve) => setTimeout(() => resolve({ deny: 'late' }), 5000)))`,
      ['session.permissionRequested'],
      ['requests.check'],
    )
    const started = Date.now()
    expect(await hooks.check(session, request)).toBeNull()
    expect(Date.now() - started).toBeLessThan(PLUGIN_BEFORE_SEND_DEADLINE_MS + 400)
  })

  it('reads the facts of a request from its tool entry, the command only for a command', () => {
    const base = {
      kind: 'tool' as const,
      id: 't',
      status: 'pending' as const,
      content: [],
      permission: null,
    }
    expect(
      requestFacts({
        ...base,
        title: 'Run ls',
        toolKind: 'execute',
        rawInput: 'ls -la',
        locations: [],
        permissionResult: null,
      }),
    ).toEqual({ tool: 'Run ls', kind: 'execute', command: 'ls -la', paths: [] })
    expect(
      requestFacts({
        ...base,
        title: 'Edit a.ts',
        toolKind: 'edit',
        rawInput: '{"file_path":"/a.ts"}',
        locations: [{ path: '/a.ts' }],
        permissionResult: null,
      }),
    ).toEqual({ tool: 'Edit a.ts', kind: 'edit', command: null, paths: ['/a.ts'] })
  })
})
