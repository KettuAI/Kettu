import { describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import {
  changesStored,
  EMPTY_SESSION,
  mapRefs,
  opensTurn,
  pageStart,
  parseStoredSession,
  settled,
  turnOf,
} from './model'

const user = (steered?: boolean): ThreadEntry => ({
  kind: 'user',
  id: 'u',
  content: [],
  ...(steered ? { steered } : {}),
})
const agent: ThreadEntry = {
  kind: 'agent',
  id: 'a',
  markdown: '',
  attachments: [],
  streaming: false,
}

describe('turns', () => {
  it('open at a prompt of its own and after a turn ends', () => {
    expect(opensTurn(user(), null)).toBe(true)
    expect(opensTurn(user(), { kind: 'agent' })).toBe(true)
    expect(opensTurn(user(true), { kind: 'agent' })).toBe(false)
    expect(opensTurn(agent, { kind: 'turn_end' })).toBe(true)
    expect(opensTurn(agent, { kind: 'tool' })).toBe(false)
  })

  it('are named by the position of the entry that opened them', () => {
    expect(turnOf(agent, 0, null)).toBe(0)
    expect(turnOf(agent, 5, { kind: 'tool', turn: 3 })).toBe(3)
    expect(turnOf(user(), 5, { kind: 'tool', turn: 3 })).toBe(5)
    expect(turnOf(user(true), 5, { kind: 'tool', turn: 3 })).toBe(3)
  })
})

describe('pageStart', () => {
  // Turns of four entries, as a prompt, a message, a tool call and a message.
  function thread(turns: number) {
    const byId: Record<string, ThreadEntry> = {}
    const order: string[] = []
    for (let i = 0; i < turns * 4; i++) {
      const id = `e:${i}`
      byId[id] = i % 4 === 0 ? { ...user(), id } : { ...agent, id }
      order.push(id)
    }
    return { order, byId }
  }

  it('goes back 60 entries, then on to the start of their turn', () => {
    const { order, byId } = thread(50)
    expect(pageStart(order, byId, 200)).toBe(140)
    expect(pageStart(order, byId, 198)).toBe(136)
    expect(pageStart(order, byId, 20)).toBe(0)
  })

  it('cuts a turn longer than 500 entries', () => {
    const order = Array.from({ length: 700 }, (_, i) => `e:${i}`)
    const byId: Record<string, ThreadEntry> = {}
    for (const [i, id] of order.entries()) byId[id] = i === 0 ? { ...user(), id } : { ...agent, id }
    expect(pageStart(order, byId, 700)).toBe(200)
  })
})

describe('settled', () => {
  it('stops streaming and cuts off unfinished work', () => {
    expect(settled({ ...agent, streaming: true })).toEqual(agent)
    expect(
      settled({ kind: 'compaction', id: 'c', status: 'in_progress', summary: '' }),
    ).toMatchObject({ status: 'cancelled' })
    const tool: ThreadEntry = {
      kind: 'tool',
      id: 't',
      title: 'Run',
      toolKind: 'execute',
      status: 'pending',
      content: [],
      locations: [],
      permission: { requestId: 'p1', options: [] },
      permissionResult: null,
    }
    expect(settled(tool)).toMatchObject({
      status: 'cancelled',
      permission: null,
      permissionResult: 'withdrawn',
    })
  })

  it('returns a settled entry as it was', () => {
    expect(settled(agent)).toBe(agent)
  })
})

describe('changesStored', () => {
  it('names the parts of the view that are stored', () => {
    expect(changesStored({ usage: null })).toBe(true)
    expect(changesStored({ status: 'running', turnStartedAt: 1 })).toBe(false)
  })
})

describe('mapRefs', () => {
  const image = { kind: 'image', mimeType: 'image/png', data: 'AAAA' }
  const link = { kind: 'link', uri: 'https://x', name: 'x' }
  const mark = (ref: Record<string, unknown>) =>
    ref.kind === 'image' ? { ...ref, data: 'B' } : ref

  it('maps the refs in prompts, tool content and attachments', () => {
    const prompt = {
      kind: 'user',
      id: 'u',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'ref', ref: image },
      ],
    }
    expect(mapRefs(prompt, mark)).toEqual({
      ...prompt,
      content: [
        { type: 'text', text: 'hi' },
        { type: 'ref', ref: { ...image, data: 'B' } },
      ],
    })
    const tool = {
      kind: 'tool',
      id: 't',
      content: [
        { type: 'markdown', markdown: 'x' },
        { type: 'ref', ref: image },
      ],
    }
    expect((mapRefs(tool, mark).content as unknown[])[1]).toEqual({
      type: 'ref',
      ref: { ...image, data: 'B' },
    })
    const reply = { kind: 'agent', id: 'a', attachments: [image, link] }
    expect(mapRefs(reply, mark).attachments).toEqual([{ ...image, data: 'B' }, link])
  })

  it('returns what it does not change as it was', () => {
    const prompt = { kind: 'user', id: 'u', content: [{ type: 'ref', ref: link }] }
    expect(mapRefs(prompt, mark)).toBe(prompt)
    const plan = { kind: 'plan', id: 'p', items: [] }
    expect(mapRefs(plan, mark)).toBe(plan)
  })
})

describe('parseStoredSession', () => {
  it('reads a stored view', () => {
    const view = {
      title: 'T',
      config: [{ id: 'model', name: 'Model', category: 'model', type: 'select', value: 'x' }],
      commands: [{ name: 'init', description: 'Set up' }],
      usage: { used: 1, size: 2, cost: null, tokens: null },
      subagent: null,
    }
    expect(parseStoredSession(view)).toEqual(view)
    expect(parseStoredSession(EMPTY_SESSION)).toEqual(EMPTY_SESSION)
  })

  it('refuses one that is malformed', () => {
    expect(parseStoredSession(null)).toBeNull()
    expect(parseStoredSession({ ...EMPTY_SESSION, title: 3 })).toBeNull()
    expect(parseStoredSession({ ...EMPTY_SESSION, config: [{ id: 'x' }] })).toBeNull()
    expect(parseStoredSession({ ...EMPTY_SESSION, commands: [{ name: 'x' }] })).toBeNull()
    expect(parseStoredSession({ ...EMPTY_SESSION, usage: 'full' })).toBeNull()
  })
})
