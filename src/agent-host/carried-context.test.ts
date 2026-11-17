import { describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { carriedContext, compactedTurns, compactionPoint, sideContext } from './carried-context'

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
const compaction = (): ThreadEntry => ({
  kind: 'compaction',
  id: `c${++counter}`,
  status: 'completed',
  summary: '',
})
const takeover = (): ThreadEntry => ({
  kind: 'takeover',
  id: `k${++counter}`,
  agentId: 'codex',
  turns: 0,
  omitted: 0,
  carried: '',
  after: null,
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

describe('the conversation after an agent compacted its context', () => {
  it('starts after a compaction the agent marked, which the next command turn leaves empty', () => {
    const entries = [
      user('Turn one'),
      reply('OLD-REPLY'),
      user('/compact'),
      compaction(),
      compaction(),
      user('Turn three'),
      reply('NEW-REPLY'),
    ]
    expect(compactionPoint(entries)).toEqual({ fromTurn: 3, after: null })
    expect(compactedTurns(entries)).toBe(2)
    const side = sideContext(entries, options)!
    expect(side.before).toBe(2)
    expect(side.text).toContain('NEW-REPLY')
    expect(side.text).not.toContain('OLD-REPLY')
    expect(side.header).toMatch(/compacted its own context before turn 3/)
  })

  it('starts at the turn whose reply is the summary, for an agent that writes it as a reply', () => {
    const entries = [
      user('Turn one'),
      reply('OLD-REPLY'),
      user('/compact'),
      reply('SUMMARY-OF-IT-ALL'),
      user('Turn three'),
      reply('NEW-REPLY'),
    ]
    expect(compactionPoint(entries)).toEqual({ fromTurn: 2, after: null })
    const side = sideContext(entries, options)!
    expect(side.text).toContain('SUMMARY-OF-IT-ALL')
    expect(side.text).toContain('NEW-REPLY')
    expect(side.text).not.toContain('OLD-REPLY')
  })

  it('does not take a command that got no reply or a failed compaction for one', () => {
    const failed: ThreadEntry = { kind: 'compaction', id: 'cf', status: 'failed', summary: 'boom' }
    expect(compactionPoint([user('One'), reply('Two'), user('/compact')])).toBeNull()
    expect(compactionPoint([user('One'), failed, user('Three')])).toBeNull()
    expect(compactedTurns([user('One'), reply('Two')])).toBe(0)
    const side = sideContext([user('One'), reply('OLD-REPLY'), user('/compact')], options)!
    expect(side.text).toContain('OLD-REPLY')
    expect(side.before).toBe(0)
  })

  it('keeps a turn compacted in the middle from its request, with what came after the compaction', () => {
    const marker = compaction()
    const entries = [
      user('Turn one'),
      reply('OLD-REPLY'),
      user('The long task'),
      reply('BEFORE-COMPACTION'),
      marker,
      reply('AFTER-COMPACTION'),
    ]
    expect(compactionPoint(entries)).toEqual({ fromTurn: 2, after: marker.id })
    const side = sideContext(entries, options)!
    expect(side.text).toContain('The long task')
    expect(side.text).toContain('AFTER-COMPACTION')
    expect(side.text).not.toContain('BEFORE-COMPACTION')
    expect(side.text).not.toContain('OLD-REPLY')
  })

  it('goes by the latest compaction, and a takeover does not count as a turn', () => {
    const entries = [
      user('One'),
      user('/compact'),
      compaction(),
      user('Three'),
      takeover(),
      user('Four'),
      user('/compact'),
      compaction(),
      user('Six'),
      reply('LAST'),
    ]
    expect(compactionPoint(entries)).toEqual({ fromTurn: 6, after: null })
    expect(compactedTurns(entries)).toBe(5)
  })

  it('has nothing to carry when nothing came after the compaction', () => {
    const entries = [user('One'), reply('Two'), user('/compact'), compaction()]
    expect(compactedTurns(entries)).toBe(2)
    expect(sideContext(entries, options)).toBeNull()
  })
})
