import { describe, expect, it } from 'vitest'
import css from '@renderer/styles/globals.css?raw'
import { breakdownView, contextRows, contextSegments, partFill } from './context-bar'

const category = (name: string, tokens: number) => ({ name, tokens, share: null })

describe('contextRows', () => {
  it('colors the sources in the report order and puts free space, then the buffer, last', () => {
    const rows = contextRows([
      category('System prompt', 4_600),
      category('Free space', 534_900),
      category('Messages', 750),
      category('Autocompact buffer', 33_000),
      category('Skills', 9_500),
    ])
    expect(rows.map((row) => [row.name, row.part])).toEqual([
      ['System prompt', { kind: 'source', color: 1 }],
      ['Messages', { kind: 'source', color: 2 }],
      ['Skills', { kind: 'source', color: 3 }],
      ['Free space', { kind: 'free' }],
      ['Autocompact buffer', { kind: 'buffer' }],
    ])
  })

  it('reuses the last color for a source past the seventh', () => {
    const rows = contextRows(Array.from({ length: 9 }, (_, i) => category(`Source ${i}`, 1)))
    expect(rows.map((row) => row.part)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 7, 7].map((color) => ({ kind: 'source', color })),
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
      ['free', 100],
      ['buffer', 50],
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
    expect(breakdownView(report(), '750/1000', { reports: true, idle: true })).toEqual({
      kind: 'rows',
      rows: contextRows(breakdown.categories),
      dimmed: false,
    })
  })

  it('dims the rows while a newer read loads', () => {
    expect(
      breakdownView(report({ loading: true }), '800/1000', { reports: true, idle: true }),
    ).toEqual({ kind: 'rows', rows: contextRows(breakdown.categories), dimmed: true })
  })

  it('shows skeleton rows for a first read', () => {
    expect(
      breakdownView(report({ breakdown: null, key: '', loading: true }), '750/1000', {
        reports: true,
        idle: true,
      }),
    ).toEqual({ kind: 'loading' })
    expect(breakdownView(undefined, '750/1000', { reports: true, idle: true })).toEqual({
      kind: 'loading',
    })
  })

  it('shows the error with Retry and drops the older rows', () => {
    expect(
      breakdownView(report({ breakdown: null, key: '800/1000', error: 'busy' }), '800/1000', {
        reports: true,
        idle: true,
      }),
    ).toEqual({ kind: 'error', error: 'busy' })
  })

  it('shows the between-turns line while a turn runs, never its older rows', () => {
    expect(breakdownView(report(), '750/1000', { reports: true, idle: false })).toEqual({
      kind: 'betweenTurns',
    })
  })

  it('shows nothing for an agent without the report', () => {
    expect(breakdownView(report(), '750/1000', { reports: false, idle: true })).toEqual({
      kind: 'none',
    })
    expect(breakdownView(undefined, '750/1000', { reports: false, idle: false })).toEqual({
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
