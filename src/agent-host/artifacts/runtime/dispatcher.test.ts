import { describe, expect, it } from 'vitest'
import { RUNTIME_MESSAGE_BYTES, type RuntimeAnswer } from '@shared/artifact-capabilities'
import type { DeclaredArtifact } from './calls'
import {
  BURST,
  CapabilityError,
  MAX_STREAMS,
  RuntimeDispatcher,
  RuntimeRequests,
  type CapabilityHandler,
  type ConsentOutcome,
  type DispatcherDeps,
} from './dispatcher'

const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

function artifact(capabilities: string[], extra: Partial<DeclaredArtifact> = {}): DeclaredArtifact {
  return {
    id: ID,
    project: '/p',
    title: 'Board',
    head: 4,
    deleted: false,
    capabilities,
    runtime: 1,
    ...extra,
  }
}

interface Setup {
  declared?: DeclaredArtifact | null
  allowed?: string[]
  ask?: ConsentOutcome
  handlers?: CapabilityHandler[]
  now?: () => number
}

function dispatcher(setup: Setup = {}) {
  const asked: { capability: string; client: string }[] = []
  const calls: { op: string; args: unknown; project: string | null; version: number }[] = []
  const echo: CapabilityHandler = {
    name: 'db',
    consent: false,
    ops: ['get', 'watch'],
    async call(ctx, op, args) {
      calls.push({ op, args, project: ctx.project, version: ctx.version })
      if (op === 'get' && (args as { fail?: string }).fail === 'refused') {
        throw new CapabilityError('conflict', 'Read it again.')
      }
      if (op === 'get' && (args as { fail?: string }).fail === 'broken') {
        throw new Error('/secret/path exploded')
      }
      return { echoed: args }
    },
    async stream(ctx, _op, args, emit) {
      emit({ n: 1 })
      emit({ n: 2 })
      if ((args as { wait?: boolean }).wait) {
        if (!ctx.signal.aborted) {
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve()),
          )
        }
        emit({ n: 3 })
      }
    },
  }
  const files: CapabilityHandler = {
    name: 'files',
    consent: true,
    ops: ['read'],
    available: (ctx) => ctx.project !== null,
    call: async () => 'text',
  }
  const handlers = new Map((setup.handlers ?? [echo, files]).map((h) => [h.name, h]))
  const deps: DispatcherDeps = {
    artifact: async () => (setup.declared === undefined ? artifact(['db']) : setup.declared),
    project: (folder) => (folder.startsWith('/scratch') ? null : folder),
    allowed: async (_, capability) => (setup.allowed ?? []).includes(capability),
    ask: async (_, capability, client) => {
      asked.push({ capability, client })
      return setup.ask ?? 'denied'
    },
    log: () => {},
    handlers,
    ...(setup.now ? { now: setup.now } : {}),
  }
  const d = new RuntimeDispatcher(deps)
  const send = (message: unknown, signal = new AbortController().signal) => {
    const events: RuntimeAnswer[] = []
    const answer = d.dispatch({
      artifactId: ID,
      message,
      client: 'desktop',
      signal,
      emit: (event) => events.push(event),
    })
    return { answer, events }
  }
  return { d, send, asked, calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

const use = (cap: string, id = 'u1') => ({ v: 1, id, kind: 'use', cap })
const call = (cap: string, op: string, args: unknown = {}, id = 'c1') => ({
  v: 1,
  id,
  kind: 'call',
  cap,
  op,
  args,
})

describe('the runtime dispatcher', () => {
  it('answers use with the ops of a declared capability', async () => {
    const { send } = dispatcher()
    expect(await send(use('db')).answer).toEqual({
      v: 1,
      id: 'u1',
      ok: true,
      value: { ops: ['get', 'watch'] },
    })
  })

  it('answers use with null alike for every refusal', async () => {
    const none = { v: 1, id: 'u1', ok: true, value: null }
    expect(await dispatcher().send(use('files')).answer).toEqual(none)
    expect(await dispatcher().send(use('content')).answer).toEqual(none)
    expect(await dispatcher({ declared: null }).send(use('db')).answer).toEqual(none)
    const deleted = artifact(['db'], { deleted: true })
    expect(await dispatcher({ declared: deleted }).send(use('db')).answer).toEqual(none)
    expect(await dispatcher().send({ ...use('db'), v: 2 }).answer).toEqual({ ...none, v: 2 })
    const scratch = artifact(['files'], { project: '/scratch/1' })
    expect(
      await dispatcher({ declared: scratch, allowed: ['files'] }).send(use('files')).answer,
    ).toEqual(none)
  })

  it('refuses calls with the code that says why', async () => {
    const code = async (setup: Setup, message: unknown) => {
      const answer = await dispatcher(setup).send(message).answer
      return 'error' in answer ? answer.error.code : null
    }
    expect(await code({}, call('files', 'read'))).toBe('not_declared')
    expect(await code({}, call('sample', 'ask'))).toBe('unsupported')
    expect(await code({}, call('db', 'drop'))).toBe('unsupported')
    expect(await code({}, { ...call('db', 'get'), v: 9 })).toBe('unsupported')
    expect(await code({ declared: null }, call('db', 'get'))).toBe('not_found')
    expect(await code({}, { v: 1, id: 'x', kind: 'call', cap: 'db' })).toBe('invalid')
    expect(await code({}, { v: 1, id: 'bad id!', kind: 'use', cap: 'db' })).toBe('invalid')
    expect(await code({}, call('db', 'get', 'x'.repeat(RUNTIME_MESSAGE_BYTES)))).toBe('too_large')
    expect(await code({}, call('db', 'get', { fail: 'refused' }))).toBe('conflict')
  })

  it('keeps what a handler throws to itself unless it is a refusal', async () => {
    const answer = await dispatcher().send(call('db', 'get', { fail: 'broken' })).answer
    expect(answer).toEqual({
      v: 1,
      id: 'c1',
      ok: false,
      error: { code: 'failed', message: 'db.get failed.' },
    })
  })

  it('passes the call with the artifact the client named and its latest version', async () => {
    const { send, calls } = dispatcher()
    expect(await send(call('db', 'get', { id: 'a' })).answer).toEqual({
      v: 1,
      id: 'c1',
      ok: true,
      value: { echoed: { id: 'a' } },
    })
    expect(calls).toEqual([{ op: 'get', args: { id: 'a' }, project: '/p', version: 4 }])
  })

  it('asks the user for a capability that needs consent only on use', async () => {
    const declared = artifact(['files'])
    const allowed = dispatcher({ declared, ask: 'allowed' })
    expect(await allowed.send(use('files')).answer).toMatchObject({ value: { ops: ['read'] } })
    expect(allowed.asked).toEqual([{ capability: 'files', client: 'desktop' }])
    const denied = dispatcher({ declared, ask: 'denied' })
    expect(await denied.send(use('files')).answer).toMatchObject({ value: null })
    const waiting = dispatcher({ declared, ask: 'waiting' })
    expect(await waiting.send(use('files')).answer).toMatchObject({ value: null })
    const asked = dispatcher({ declared, ask: 'allowed' })
    expect(await asked.send(call('files', 'read')).answer).toMatchObject({
      ok: false,
      error: { code: 'not_allowed' },
    })
    expect(asked.asked).toEqual([])
    const granted = dispatcher({ declared, allowed: ['files'] })
    expect(await granted.send(call('files', 'read')).answer).toMatchObject({ value: 'text' })
    expect(granted.asked).toEqual([])
  })

  it("holds each artifact's pages to a rate, giving the budget back over time", async () => {
    let now = 0
    const { send } = dispatcher({ now: () => now })
    for (let i = 0; i < BURST; i++) await send(call('db', 'get', {}, `c${i}`)).answer
    expect(await send(call('db', 'get')).answer).toMatchObject({ error: { code: 'rate_limited' } })
    expect(await send(use('db')).answer).toMatchObject({ value: null })
    now += 1000
    expect(await send(call('db', 'get')).answer).toMatchObject({ ok: true })
  })

  it('streams events and then the end, and ends a stream when it is cancelled', async () => {
    const { send } = dispatcher()
    const quick = send({ v: 1, id: 's1', kind: 'stream', cap: 'db', op: 'watch', args: {} })
    expect(await quick.answer).toEqual({ v: 1, id: 's1', done: true })
    expect(quick.events).toEqual([
      { v: 1, id: 's1', event: { n: 1 } },
      { v: 1, id: 's1', event: { n: 2 } },
    ])
    const controller = new AbortController()
    const long = send(
      { v: 1, id: 's2', kind: 'stream', cap: 'db', op: 'watch', args: { wait: true } },
      controller.signal,
    )
    await tick()
    controller.abort()
    expect(await long.answer).toEqual({ v: 1, id: 's2', done: true })
    // Nothing reaches a page after it cancelled.
    expect(long.events).toHaveLength(2)
  })

  it('refuses streams past the limit an artifact may keep open', async () => {
    const { send } = dispatcher()
    const controller = new AbortController()
    const open = Array.from({ length: MAX_STREAMS }, (_, i) =>
      send(
        { v: 1, id: `s${i}`, kind: 'stream', cap: 'db', op: 'watch', args: { wait: true } },
        controller.signal,
      ),
    )
    await tick()
    const over = send({ v: 1, id: 'over', kind: 'stream', cap: 'db', op: 'watch', args: {} })
    expect(await over.answer).toMatchObject({ error: { code: 'rate_limited' } })
    controller.abort()
    await Promise.all(open.map((s) => s.answer))
    const again = send({ v: 1, id: 'again', kind: 'stream', cap: 'db', op: 'watch', args: {} })
    expect(await again.answer).toMatchObject({ done: true })
  })
})

describe('the runtime requests of each client', () => {
  it("ends a port's stream on its cancel and every one when the port closes", async () => {
    const { d } = dispatcher()
    const requests = new RuntimeRequests(d)
    const stream = (id: string) => ({
      v: 1,
      id,
      kind: 'stream',
      cap: 'db',
      op: 'watch',
      args: { wait: true },
    })
    const events: RuntimeAnswer[] = []
    const one = requests.fromPort('port-1', ID, stream('a'), 'k1', (e) => events.push(e))
    const two = requests.fromPort('port-1', ID, stream('b'), 'k2', (e) => events.push(e))
    const other = requests.fromPort('port-2', ID, stream('c'), 'k1', (e) => events.push(e))
    await requests.fromPort('port-1', ID, { v: 1, id: 'a', kind: 'cancel' }, 'k1', () => {})
    expect(await one).toEqual({ v: 1, id: 'a', done: true })
    requests.portClosed('port-1')
    expect(await two).toEqual({ v: 1, id: 'b', done: true })
    let settled = false
    void other.then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    requests.portClosed('port-2')
    await other
  })

  it("answers main's requests by their id, the last answer too", async () => {
    const { d } = dispatcher()
    const requests = new RuntimeRequests(d)
    const answers: RuntimeAnswer[] = []
    requests.fromMain(7, ID, use('db'), (a) => answers.push(a))
    requests.fromMain(
      8,
      ID,
      { v: 1, id: 's', kind: 'stream', cap: 'db', op: 'watch', args: { wait: true } },
      (a) => answers.push(a),
    )
    await tick()
    requests.cancelMain(8)
    await tick()
    expect(answers.filter((a) => a.id === 'u1')).toEqual([
      { v: 1, id: 'u1', ok: true, value: { ops: ['get', 'watch'] } },
    ])
    expect(answers.filter((a) => a.id === 's')).toEqual([
      { v: 1, id: 's', event: { n: 1 } },
      { v: 1, id: 's', event: { n: 2 } },
      { v: 1, id: 's', done: true },
    ])
  })
})
