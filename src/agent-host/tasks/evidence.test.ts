import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { PRICES, type UsageRow } from '../usage/model'
import {
  collectEvidence,
  costSince,
  entriesSince,
  evidenceOf,
  turnCostUsd,
  turnCount,
} from './evidence'

const root = '/work/feat-1'

function user(id: string, steered = false): ThreadEntry {
  return {
    kind: 'user',
    id,
    content: [{ type: 'text', text: id }],
    ...(steered ? { steered } : {}),
  }
}

function tool(id: string, fields: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: id,
    toolKind: 'execute',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...fields,
  }
}

describe('turns', () => {
  const entries = [
    user('u1'),
    tool('a', {}),
    user('u1b', true),
    user('u2'),
    tool('b', {}),
    user('u3'),
  ]

  it('counts the user messages but those sent into a running turn', () => {
    expect(turnCount(entries)).toBe(3)
  })

  it('reads from the turn after the first n', () => {
    expect(entriesSince(entries, 0)).toHaveLength(6)
    expect(entriesSince(entries, 1).map((e) => e.id)).toEqual(['u2', 'b', 'u3'])
    expect(entriesSince(entries, 2).map((e) => e.id)).toEqual(['u3'])
    expect(entriesSince(entries, 3)).toEqual([])
  })
})

describe('evidenceOf', () => {
  it('takes commands that ran, as run, and edits that completed, relative to the root', () => {
    const evidence = evidenceOf(
      [
        tool('c1', { rawInput: 'pnpm test', title: 'Run tests' }),
        tool('c2', { rawInput: 'pnpm lint', status: 'failed' }),
        tool('c3', { rawInput: 'rm -rf /', status: 'cancelled' }),
        tool('c4', { rawInput: 'git push', status: 'pending' }),
        tool('c5', { title: 'make', rawInput: undefined }),
        tool('c6', { rawInput: 'pnpm test' }),
        tool('e1', { toolKind: 'edit', locations: [{ path: '/work/feat-1/src/a.ts' }] }),
        tool('e2', {
          toolKind: 'edit',
          content: [{ type: 'diff', path: 'src/b.ts', oldText: null, newText: 'x' }],
        }),
        tool('e3', { toolKind: 'edit', status: 'failed', locations: [{ path: 'src/c.ts' }] }),
        tool('e4', { toolKind: 'delete', locations: [{ path: '/elsewhere/d.ts' }] }),
        tool('r1', { toolKind: 'read', locations: [{ path: 'src/e.ts' }] }),
      ],
      root,
      'darwin',
    )
    expect(evidence.commands).toEqual(['pnpm test', 'pnpm lint', 'make'])
    expect(evidence.changedFiles).toEqual(['src/a.ts', 'src/b.ts', '/elsewhere/d.ts'])
  })

  it('writes Windows paths with slashes', () => {
    const evidence = evidenceOf(
      [tool('e', { toolKind: 'edit', locations: [{ path: 'C:\\work\\feat-1\\src\\a.ts' }] })],
      'C:\\work\\feat-1',
      'win32',
    )
    expect(evidence.changedFiles).toEqual(['src/a.ts'])
  })
})

describe('collectEvidence', () => {
  it("reads the round's calls and those of sub-sessions it started, once each", async () => {
    const threads: Record<string, ThreadEntry[]> = {
      s: [
        user('u1'),
        tool('old', { rawInput: 'pnpm build' }),
        { kind: 'subagent', id: 'x0', sessionId: 'old-sub' },
        user('u2'),
        tool('new', { rawInput: 'pnpm test' }),
        { kind: 'subagent', id: 'x1', sessionId: 'sub' },
      ],
      sub: [
        tool('se', { toolKind: 'edit', locations: [{ path: 'lib/x.ts' }] }),
        { kind: 'subagent', id: 'x2', sessionId: 's' },
      ],
      'old-sub': [tool('oe', { toolKind: 'edit', locations: [{ path: 'old.ts' }] })],
    }
    const evidence = await collectEvidence(
      's',
      1,
      async (id) => threads[id] ?? null,
      root,
      'darwin',
    )
    expect(evidence).toEqual({ commands: ['pnpm test'], changedFiles: ['lib/x.ts'], turns: 2 })
  })

  it('finds nothing for a session without a thread', async () => {
    expect(await collectEvidence('gone', 0, async () => null, root, 'darwin')).toEqual({
      commands: [],
      changedFiles: [],
      turns: 0,
    })
  })
})

describe('turn costs', () => {
  const row = (model: string, fields: Partial<UsageRow> = {}): UsageRow => ({
    key: model,
    source: 'kettu',
    agentId: 'claude-code',
    sessionId: 'a',
    project: null,
    model,
    at: 0,
    input: 1_000,
    output: 100,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    turn: 1,
    ...fields,
  })

  it('prices rows as the usage page does and ignores unpriced models', () => {
    const price = PRICES.models['claude-sonnet-4-5']!
    expect(turnCostUsd([row('claude-sonnet-4-5'), row('no-such-model')])).toBeCloseTo(
      1_000 * price.input + 100 * price.output,
    )
    expect(turnCostUsd([row('no-such-model')])).toBeNull()
    expect(turnCostUsd([])).toBeNull()
  })

  it('sums the turns after the round began', () => {
    const costs: [number, number][] = [
      [1, 1],
      [2, 0.5],
      [4, 0.25],
    ]
    expect(costSince(costs, 0)).toBe(1.75)
    expect(costSince(costs, 2)).toBe(0.25)
    expect(costSince(costs, 4)).toBe(0)
  })
})
