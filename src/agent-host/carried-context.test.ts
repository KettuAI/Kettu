import { describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { carriedContext, sideContext } from './carried-context'

const options = { firstAgent: 'claude-code' as const, agentName: () => 'Claude Code' }

let counter = 0
const user = (text: string): ThreadEntry => ({
  kind: 'user',
  id: `u${++counter}`,
  content: [{ type: 'text', text }],
})
const reply = (markdown: string): ThreadEntry => ({
  kind: 'agent',
  id: `m${++counter}`,
  markdown,
  attachments: [],
  streaming: false,
})
const tool = (title: string, rawInput: string, result: string): ThreadEntry => ({
  kind: 'tool',
  id: `t${++counter}`,
  title,
  toolKind: 'read',
  status: 'completed',
  content: [{ type: 'markdown', markdown: result }],
  locations: [],
  permission: null,
  permissionResult: null,
  rawInput,
})

describe('the conversation a side question gets', () => {
  it('keeps a long reply and a tool call input whole, which the agent switch cuts', () => {
    const long = 'x'.repeat(20_000)
    const entries = [user('Fix it'), tool('Read file', 'rg --files src', 'one line'), reply(long)]
    const side = sideContext(entries, options)!
    expect(side.text).toContain(long)
    expect(side.text).toContain('input: rg --files src')
    expect(side.omitted).toBe(0)
    const switched = carriedContext(entries, options)!
    expect(switched.text).not.toContain(long)
    expect(switched.text).not.toContain('input:')
  })

  it('thins the tool output of every turn before it leaves one out, the latest turn last', () => {
    const entries: ThreadEntry[] = []
    for (let i = 1; i <= 20; i++) {
      entries.push(user(`Step ${i}`))
      entries.push(tool('Read', `cat ${i}`, `START-${i} ${'a'.repeat(3_900)} END-${i}`))
      entries.push(reply(`Done ${i}`))
    }
    // A window of 64k leaves 48k for the conversation: 20 whole results would take about 86k.
    const side = sideContext(entries, { ...options, window: 64_000 })!
    expect(side.total).toBe(20)
    expect(side.omitted).toBe(0)
    expect(side.keepsFirst).toBe(false)
    expect(Buffer.byteLength(side.text)).toBeLessThan(48_000)
    // The latest result is whole; an older one keeps its start and its end only.
    expect(side.text.split('a'.repeat(3_900))).toHaveLength(2)
    expect(side.text).toContain('START-3 ')
    expect(side.text).toContain('END-3')
  })

  it('keeps the first request and the newest turns when even the titles do not fit, and says so', () => {
    const entries: ThreadEntry[] = []
    for (let i = 1; i <= 10; i++) {
      entries.push(user(i === 1 ? 'The first request' : `Request ${i}`))
      entries.push(reply(`REPLY-${i} ${'y'.repeat(1_500)}`))
    }
    // A window of 20k leaves 4k.
    const side = sideContext(entries, { ...options, window: 20_000 })!
    expect(side.total).toBe(10)
    expect(side.omitted).toBeGreaterThan(0)
    expect(side.keepsFirst).toBe(true)
    expect(side.text).toContain('The first request')
    expect(side.text).toContain('REPLY-10')
    expect(side.text).not.toContain('REPLY-5')
    expect(side.header).toMatch(/left out/)
  })

  it('has nothing to carry for a session with no turn', () => {
    expect(sideContext([], options)).toBeNull()
  })
})
