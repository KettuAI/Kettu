import { describe, expect, it } from 'vitest'
import type { ContextBreakdown } from '@shared/agent-host'
import type { SessionUsage } from '@shared/thread'
import css from '@renderer/styles/globals.css?raw'
import {
  breakdownView,
  compactsAt,
  contextRows,
  contextSegments,
  partFill,
  shownUsage,
} from './context-bar'

const category = (name: string, tokens: number) => ({ name, tokens, share: null })

const usage = (used: number, size: number): SessionUsage => ({
  used,
  size,
  cost: null,
  tokens: null,
})

const agentRead = (used: number, size: number): ContextBreakdown => ({
  model: null,
  used,
  size,
  categories: [],
  lists: [],
  observedAt: 1,
})

describe('shownUsage', () => {
  it("takes the agent's read while the session counts no context", () => {
    expect(shownUsage(usage(0, 500_000), agentRead(12_300, 500_000))).toMatchObject({
      used: 12_300,
      size: 500_000,
    })
  })

  it('keeps the session usage once it has a count', () => {
    const own = usage(40_000, 500_000)
    expect(shownUsage(own, agentRead(12_300, 500_000))).toBe(own)
  })

  it('keeps the session usage without a read, or with a read of no window', () => {
    const own = usage(0, 500_000)
    expect(shownUsage(own, null)).toBe(own)
    expect(shownUsage(own, agentRead(12_300, 0))).toBe(own)
    expect(shownUsage(null, agentRead(12_300, 500_000))).toBeNull()
  })
})

describe('contextRows', () => {
  it('puts the four kinds first in their fixed colors, the rest in grays, then the buffer and free space', () => {
    const rows = contextRows([
      category('System prompt', 4_600),
      category('Free space', 534_900),
      category('MCP tools', 2_000),
      category('Messages', 750),
      category('Autocompact buffer', 33_000),
      category('Skills', 9_500),
      category('System tools', 9_800),
      category('Memory files', 6_100),
    ])
    expect(rows.map((row) => [row.name, row.part])).toEqual([
      ['Messages', { kind: 'source', color: 1 }],
      ['Memory files', { kind: 'source', color: 2 }],
      ['System tools', { kind: 'source', color: 3 }],
      ['MCP tools', { kind: 'source', color: 4 }],
      ['System prompt', { kind: 'source', color: 5 }],
      ['Skills', { kind: 'source', color: 6 }],
      ['Autocompact buffer', { kind: 'buffer' }],
      ['Free space', { kind: 'free' }],
    ])
  })

  it('reuses the last gray for the small costs past the third', () => {
    const rows = contextRows(Array.from({ length: 5 }, (_, i) => category(`Source ${i}`, 1)))
    expect(rows.map((row) => row.part)).toEqual(
      [5, 6, 7, 7, 7].map((color) => ({ kind: 'source', color })),
    )
  })

  it('takes a report without free space or a buffer as it is', () => {
    expect(contextRows([category('Messages', 10)])).toHaveLength(1)
    expect(contextRows([])).toEqual([])
  })
})

describe('contextSegments', () => {
  it('follows the rows and leaves out the empty ones', () => {
    const rows = contextRows([
      category('Messages', 750),
      category('MCP tools', 0),
      category('Free space', 100),
      category('Autocompact buffer', 50),
    ])
    expect(contextSegments(rows, 750, 900).map((s) => [s.part.kind, s.tokens])).toEqual([
      ['source', 750],
      ['buffer', 50],
      ['free', 100],
    ])
  })

  it('is one neutral segment of what is used without a breakdown', () => {
    expect(contextSegments(null, 25, 100).map((s) => [s.part.kind, s.tokens])).toEqual([
      ['used', 25],
      ['free', 75],
    ])
    expect(contextSegments(null, 120, 100).map((s) => [s.part.kind, s.tokens])).toEqual([
      ['used', 100],
    ])
    expect(contextSegments(null, 0, 100).map((s) => s.part.kind)).toEqual(['free'])
  })
})

const breakdown = {
  model: 'fake-model',
  used: 750,
  size: 1_000,
  categories: [category('Messages', 750), category('Free space', 250)],
  lists: [],
  observedAt: 1,
}

describe('breakdownView', () => {
  const report = (overrides: Partial<Parameters<typeof breakdownView>[0]> = {}) => ({
    key: '750/1000',
    breakdown,
    loading: false,
    error: null,
    ...overrides,
  })

  it('shows the rows read for the context in use', () => {
    expect(breakdownView(report(), '750/1000', { reports: true, idle: true, live: false })).toEqual(
      {
        kind: 'rows',
        rows: contextRows(breakdown.categories),
        dimmed: false,
        stale: false,
      },
    )
  })

  it('dims the rows while a newer read loads', () => {
    expect(
      breakdownView(report({ loading: true }), '800/1000', {
        reports: true,
        idle: true,
        live: false,
      }),
    ).toEqual({ kind: 'rows', rows: contextRows(breakdown.categories), dimmed: true, stale: false })
  })

  it('shows skeleton rows for a first read', () => {
    expect(
      breakdownView(report({ breakdown: null, key: '', loading: true }), '750/1000', {
        reports: true,
        idle: true,
        live: false,
      }),
    ).toEqual({ kind: 'loading' })
    expect(
      breakdownView(undefined, '750/1000', { reports: true, idle: true, live: false }),
    ).toEqual({
      kind: 'loading',
    })
  })

  it('shows the error with Retry and drops the older rows', () => {
    expect(
      breakdownView(report({ breakdown: null, key: '800/1000', error: 'busy' }), '800/1000', {
        reports: true,
        idle: true,
        live: false,
      }),
    ).toEqual({ kind: 'error', error: 'busy' })
  })

  it('keeps the older rows through a turn, marked stale, when the agent cannot read live', () => {
    expect(
      breakdownView(report(), '750/1000', { reports: true, idle: false, live: false }),
    ).toEqual({ kind: 'rows', rows: contextRows(breakdown.categories), dimmed: false, stale: true })
    expect(
      breakdownView(undefined, '750/1000', { reports: true, idle: false, live: false }),
    ).toEqual({ kind: 'betweenTurns' })
  })

  it('shows the rows read through a running turn when the agent reads live', () => {
    expect(breakdownView(report(), '750/1000', { reports: true, idle: false, live: true })).toEqual(
      {
        kind: 'rows',
        rows: contextRows(breakdown.categories),
        dimmed: false,
        stale: false,
      },
    )
    expect(
      breakdownView(undefined, '750/1000', { reports: true, idle: false, live: true }),
    ).toEqual({ kind: 'loading' })
  })

  it('shows nothing for an agent without the report', () => {
    expect(
      breakdownView(report(), '750/1000', { reports: false, idle: true, live: false }),
    ).toEqual({
      kind: 'none',
    })
    expect(
      breakdownView(undefined, '750/1000', { reports: false, idle: false, live: false }),
    ).toEqual({
      kind: 'none',
    })
  })
})

/** The theme variables a utility reads its color from, in the order Tailwind tries them. */
const COLOR_NAMESPACES: Record<string, string[]> = {
  bg: ['--background-color-', '--color-'],
  text: ['--text-color-', '--color-'],
}

const defined = (token: string): boolean => new RegExp(`^\\s*${token}:`, 'm').test(css)

/** Whether the class names a color the stylesheet defines; null for a class that names none. */
function colorOf(name: string): boolean | null {
  // An arbitrary value such as the hatch's is not a named color.
  if (name.includes('(')) return null
  const match = /^([a-z-]+?)-(.+)$/.exec(name)
  if (!match) return null
  const namespaces = COLOR_NAMESPACES[match[1]!]
  if (!namespaces) return null
  return namespaces.some((prefix) => defined(prefix + match[2]!))
}

describe('part fills', () => {
  const fills = [
    partFill({ kind: 'source', color: 1 }),
    partFill({ kind: 'source', color: 7 }),
    partFill({ kind: 'buffer' }),
    partFill({ kind: 'used' }),
  ]

  it.each(fills)(
    '%s names a color the stylesheet defines, or fills with the current one',
    (fill) => {
      expect(fill).not.toBe('')
      for (const name of fill.split(/\s+/)) {
        const color = colorOf(name)
        if (name === 'bg-current' || color === null) continue
        expect(color, `${name} names no color the stylesheet defines`).toBe(true)
      }
    },
  )

  it('gives the used segment of a bar with no breakdown a fill that shows', () => {
    const fill = partFill({ kind: 'used' }).split(/\s+/)
    // A background of the current color takes it from a text class, which must name a color.
    expect(fill).toContain('bg-current')
    const text = fill.filter((name) => name.startsWith('text-'))
    expect(text, 'no text color sets the fill').not.toHaveLength(0)
    for (const name of text) expect(colorOf(name), `${name} names no color`).toBe(true)
  })
})

describe('compactsAt', () => {
  it('is the share of the context left once the buffer is set aside, rounded down', () => {
    const rows = contextRows([category('Messages', 10), category('Autocompact buffer', 33_000)])
    expect(compactsAt(rows, 200_000)).toBe(83)
  })

  it('is unknown without a buffer or a context size', () => {
    expect(compactsAt(contextRows([category('Messages', 10)]), 200_000)).toBeNull()
    expect(compactsAt(null, 200_000)).toBeNull()
    expect(compactsAt(contextRows([category('Autocompact buffer', 10)]), 0)).toBeNull()
  })
})
