import { describe, expect, it } from 'vitest'
import type { AgentId, ThreadEntry } from '@shared/thread'
import {
  carriedContext,
  historyBudget,
  historyPage,
  threadTurns,
  HISTORY_BUDGET,
} from './carried-context'

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const name = (id: AgentId): string => NAMES[id] ?? id
const base = { firstAgent: 'claude-code' as AgentId, agentName: name }

let n = 0
const user = (text: string): ThreadEntry => ({
  kind: 'user',
  id: `u${++n}`,
  content: [{ type: 'text', text }],
})
const agent = (markdown: string): ThreadEntry => ({
  kind: 'agent',
  id: `a${++n}`,
  markdown,
  attachments: [],
  streaming: false,
})
const turn = (ask: string, reply: string): ThreadEntry[] => [user(ask), agent(reply)]

describe('the context a session carries to its next agent', () => {
  it('keeps every short turn in order, with who said what', () => {
    const entries = [
      ...turn('Add a login page', 'Added it in login.tsx.'),
      {
        kind: 'tool',
        id: 't1',
        title: 'Run pnpm test',
        toolKind: 'execute',
        status: 'completed',
        content: [{ type: 'markdown', markdown: '12 passed' }],
        locations: [],
        permission: null,
        permissionResult: null,
      } satisfies ThreadEntry,
      ...turn('Now style it', 'Styled.'),
    ]
    const carried = carriedContext(entries, base)!
    expect(carried.turns).toBe(2)
    expect(carried.omitted).toBe(0)
    expect(carried.messages.map((m) => m.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(carried.messages[1]!.text).toBe('[Turn 1, the user]\nAdd a login page')
    expect(carried.messages[2]!.text).toContain('[Turn 1, Claude Code]\nAdded it in login.tsx.')
    expect(carried.messages[2]!.text).toContain('[tool: Run pnpm test (completed)]\n12 passed')
    expect(carried.header).toContain('from Claude Code')
    expect(carried.text.startsWith('<earlier_conversation>\n')).toBe(true)
  })

  it('names the agent of each turn across earlier takeovers', () => {
    const entries = [
      ...turn('First', 'From Claude.'),
      {
        kind: 'takeover',
        id: 'k1',
        agentId: 'codex',
        turns: 1,
        omitted: 0,
        carried: '',
        after: null,
      } satisfies ThreadEntry,
      ...turn('Second', 'From Codex.'),
    ]
    const turns = threadTurns(entries, 'claude-code', name)
    expect(turns.map((t) => t.agentId)).toEqual(['claude-code', 'codex'])
    const carried = carriedContext(entries, base)!
    expect(carried.header).toContain('from Claude Code, Codex')
    expect(carried.messages.at(-1)!.text).toBe('[Turn 2, Codex]\nFrom Codex.')
  })

  it('carries the first request and the latest turns that fit the budget', () => {
    const long = 'x'.repeat(3_000)
    const entries = Array.from({ length: 10 }, (_, i) => turn(`Ask ${i + 1}`, long)).flat()
    const carried = carriedContext(entries, { ...base, budget: 10_000 })!
    const kept = carried.messages.map((m) => m.text.split('\n')[0])
    // The header, turn 1's request, then the newest turns that fit, oldest first.
    expect(kept[1]).toBe('[Turn 1, the user]')
    expect(kept.at(-2)).toBe('[Turn 10, the user]')
    expect(carried.turns).toBeGreaterThan(0)
    expect(carried.turns).toBeLessThan(10)
    expect(carried.omitted).toBe(10 - carried.turns)
    const firstCarried = 11 - carried.turns
    expect(carried.header).toContain(`turns 2 to ${firstCarried - 1} are left out`)
    const size = carried.messages.reduce((sum, m) => sum + Buffer.byteLength(m.text) + 2, 0)
    expect(size - Buffer.byteLength(carried.header)).toBeLessThanOrEqual(10_000 + 200)
  })

  it('always carries the latest turn and cuts one long message', () => {
    const entries = turn('Ask', 'y'.repeat(50_000))
    const carried = carriedContext(entries, { ...base, budget: 1_000 })!
    expect(carried.turns).toBe(1)
    const reply = carried.messages.at(-1)!.text
    expect(Buffer.byteLength(reply)).toBeLessThan(6_100)
    expect(reply).toContain('...y')
  })

  it('carries only the turns an agent missed when it takes the session back', () => {
    const entries = [...turn('One', 'A'), ...turn('Two', 'B'), ...turn('Three', 'C')]
    const carried = carriedContext(entries, { ...base, fromTurn: 3 })!
    expect(carried.turns).toBe(1)
    expect(carried.messages.slice(1).map((m) => m.text.split('\n')[0])).toEqual([
      '[Turn 3, the user]',
      '[Turn 3, Claude Code]',
    ])
    expect(carried.header).toContain('before turn 3')
    expect(carriedContext(entries, { ...base, fromTurn: 4 })).toBeNull()
  })

  it('keeps room in a small window and never counts more than the budget', () => {
    expect(historyBudget(undefined)).toBe(HISTORY_BUDGET)
    expect(historyBudget(200_000)).toBe(HISTORY_BUDGET)
    expect(historyBudget(20_000)).toBe(4_000)
    expect(historyBudget(10_000)).toBe(0)
  })

  it('pages the history tool from the newest turns back', () => {
    const turns = threadTurns(
      Array.from({ length: 5 }, (_, i) => turn(`Ask ${i + 1}`, 'ok')).flat(),
      'claude-code',
      name,
    )
    expect(historyPage(turns, undefined, 2).map((t) => t.number)).toEqual([4, 5])
    expect(historyPage(turns, 4, 2).map((t) => t.number)).toEqual([2, 3])
    expect(historyPage(turns, 2, 5).map((t) => t.number)).toEqual([1])
    expect(historyPage(turns, 1, 5)).toEqual([])
  })

  it('asks for a summary first when the user chose it', () => {
    const carried = carriedContext(turn('Ask', 'Reply'), { ...base, summarize: true })!
    expect(carried.header).toContain('give the user a short summary')
  })
})
