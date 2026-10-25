import { describe, expect, it } from 'vitest'
import { contextRows, contextSegments } from './context-bar'

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
