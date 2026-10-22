import { describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { EMPTY_SESSION, mapRefs, opensTurn, parseStoredSession, turnOf } from './model'

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
