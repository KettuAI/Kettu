import { describe, expect, it } from 'vitest'
import {
  isRuntimeAnswer,
  isStrictDeclaration,
  messageHeader,
  parseDeclaration,
  parseRuntimeMessage,
} from './artifact-capabilities'
import { capabilityNamespace, type CapabilityTransport } from './artifact-runtime/capabilities'

describe('a declaration', () => {
  it('names only the known capabilities, sorted and once each', () => {
    expect(parseDeclaration([])).toEqual([])
    expect(parseDeclaration(['sample', 'db', 'sample'])).toEqual(['db', 'sample'])
    expect(parseDeclaration(['db', 'network'])).toMatchObject({ problem: expect.any(String) })
    expect(parseDeclaration('db')).toMatchObject({ problem: expect.any(String) })
    expect(parseDeclaration(Array(7).fill('db'))).toMatchObject({ problem: expect.any(String) })
  })

  it('makes the pages strict when it reads beyond the artifact', () => {
    expect(isStrictDeclaration([])).toBe(false)
    expect(isStrictDeclaration(['db'])).toBe(false)
    expect(isStrictDeclaration(['db', 'files'])).toBe(true)
    expect(isStrictDeclaration(['sample'])).toBe(true)
  })
})

describe('the wire format', () => {
  it('reads the four kinds a page sends', () => {
    expect(parseRuntimeMessage({ v: 1, id: 'a1', kind: 'use', cap: 'db' })).toEqual({
      v: 1,
      id: 'a1',
      kind: 'use',
      cap: 'db',
    })
    expect(
      parseRuntimeMessage({ v: 1, id: 'a2', kind: 'call', cap: 'db', op: 'get', extra: 1 }),
    ).toEqual({ v: 1, id: 'a2', kind: 'call', cap: 'db', op: 'get', args: null })
    expect(
      parseRuntimeMessage({ v: 3, id: 'a3', kind: 'stream', cap: 'sample', op: 'ask', args: [1] }),
    ).toEqual({ v: 3, id: 'a3', kind: 'stream', cap: 'sample', op: 'ask', args: [1] })
    expect(parseRuntimeMessage({ v: 1, id: 'a3', kind: 'cancel' })).toEqual({
      v: 1,
      id: 'a3',
      kind: 'cancel',
    })
  })

  it.each([
    null,
    [],
    'use',
    { v: 0, id: 'a', kind: 'use', cap: 'db' },
    { v: 1.5, id: 'a', kind: 'use', cap: 'db' },
    { v: '1', id: 'a', kind: 'use', cap: 'db' },
    { v: 1, id: '', kind: 'use', cap: 'db' },
    { v: 1, id: 'a b', kind: 'use', cap: 'db' },
    { v: 1, id: 'x'.repeat(65), kind: 'use', cap: 'db' },
    { v: 1, id: 'a', kind: 'use', cap: 'DB' },
    { v: 1, id: 'a', kind: 'use', cap: '__proto__' },
    { v: 1, id: 'a', kind: 'call', cap: 'db' },
    { v: 1, id: 'a', kind: 'call', cap: 'db', op: 'get-all' },
    { v: 1, id: 'a', kind: 'select', cap: 'db' },
  ])('refuses %j', (value) => {
    expect(parseRuntimeMessage(value)).toBeNull()
  })

  it('keeps what it can of an unreadable message for the answer', () => {
    expect(messageHeader({ v: 2, id: 'ok' })).toEqual({ v: 2, id: 'ok' })
    expect(messageHeader({ v: -1, id: 'not ok' })).toEqual({ v: 1, id: '' })
    expect(messageHeader(null)).toEqual({ v: 1, id: '' })
  })

  it('passes on only answers of a known shape', () => {
    expect(isRuntimeAnswer({ v: 1, id: 'a', ok: true, value: null })).toBe(true)
    expect(isRuntimeAnswer({ v: 1, id: 'a', event: {} })).toBe(true)
    expect(isRuntimeAnswer({ v: 1, id: 'a', done: true })).toBe(true)
    expect(
      isRuntimeAnswer({ v: 1, id: 'a', ok: false, error: { code: 'conflict', message: 'x' } }),
    ).toBe(true)
    expect(isRuntimeAnswer({ v: 1, id: 'a', ok: true })).toBe(false)
    expect(
      isRuntimeAnswer({ v: 1, id: 'a', ok: false, error: { code: 'nope', message: '' } }),
    ).toBe(false)
    expect(isRuntimeAnswer({ id: 'a', done: true })).toBe(false)
  })
})

describe("the page's namespaces", () => {
  function transport(events: unknown[] = [], end: { code: string } | null = null) {
    const calls: { cap: string; op: string; args: unknown }[] = []
    let cancelled = 0
    const t: CapabilityTransport = {
      call: async (cap, op, args) => {
        calls.push({ cap, op, args })
        return op === 'read' ? { text: 'hi', base64: btoa('\u0001ÿ') } : { ok: op }
      },
      stream: (cap, op, args, onEvent, onEnd) => {
        calls.push({ cap, op, args })
        queueMicrotask(() => {
          for (const event of events) onEvent(event)
          onEnd?.(end as never)
        })
        return () => cancelled++
      },
    }
    return { t, calls, cancelled: () => cancelled }
  }

  it('offers only the ops the host answered, frozen, and nothing for an unknown capability', () => {
    const { t } = transport()
    const db = capabilityNamespace('db', ['get', 'set', 'drop'], t) as Record<string, unknown>
    expect(Object.keys(db).sort()).toEqual(['get', 'set'])
    expect(Object.isFrozen(db)).toBe(true)
    expect(capabilityNamespace('network', ['get'], t)).toBeNull()
    expect(capabilityNamespace('toString', [], t)).toBeNull()
  })

  it("sends db's arguments by name, the base version only when given", async () => {
    const { t, calls } = transport()
    const db = capabilityNamespace('db', ['set', 'update', 'query'], t) as {
      set: (...args: unknown[]) => Promise<unknown>
      update: (...args: unknown[]) => Promise<unknown>
      query: (...args: unknown[]) => Promise<unknown>
    }
    await db.set('todos', 'a', { text: 'milk' })
    await db.update('todos', 'a', { done: true }, { baseVersion: 2 })
    await db.query('todos', { where: [['done', '==', false]], limit: 5, other: 1 })
    expect(calls).toEqual([
      { cap: 'db', op: 'set', args: { collection: 'todos', id: 'a', value: { text: 'milk' } } },
      {
        cap: 'db',
        op: 'update',
        args: { collection: 'todos', id: 'a', patch: { done: true }, baseVersion: 2 },
      },
      {
        cap: 'db',
        op: 'query',
        args: {
          collection: 'todos',
          where: [['done', '==', false]],
          orderBy: undefined,
          limit: 5,
        },
      },
    ])
  })

  it('reads a file as text, or as bytes', async () => {
    const { t, calls } = transport()
    const files = capabilityNamespace('files', ['read'], t) as {
      read: (path: string, opts?: unknown) => Promise<unknown>
    }
    expect(await files.read('README.md')).toBe('hi')
    expect(await files.read('logo.png', { as: 'bytes' })).toEqual(new Uint8Array([1, 255]))
    expect(calls.map((c) => c.args)).toEqual([
      { path: 'README.md', as: 'text' },
      { path: 'logo.png', as: 'base64' },
    ])
  })

  it("streams sample's text and resolves with the whole answer, or its error", async () => {
    const texts: string[] = []
    const ok = transport([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'answer', text: '{"a":1}', json: { a: 1 } },
    ])
    const sample = (t: CapabilityTransport) =>
      capabilityNamespace('sample', ['ask'], t) as {
        ask: (prompt: string, opts?: unknown) => Promise<unknown>
      }
    expect(await sample(ok.t).ask('Hi', { onText: (text: string) => texts.push(text) })).toBe(
      '{"a":1}',
    )
    expect(texts).toEqual(['Hel', 'lo'])
    expect(await sample(ok.t).ask('Hi', { format: 'json' })).toEqual({ a: 1 })
    const refused = transport([], { code: 'not_allowed' })
    await expect(sample(refused.t).ask('Hi')).rejects.toEqual({ code: 'not_allowed' })
    const silent = transport([])
    await expect(sample(silent.t).ask('Hi')).rejects.toMatchObject({ code: 'failed' })
    const stopped = transport([])
    await expect(
      sample(stopped.t).ask('Hi', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'failed' })
    expect(stopped.cancelled()).toBe(1)
  })
})
