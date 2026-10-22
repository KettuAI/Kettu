import { describe, expect, it } from 'vitest'
import { lineBreakOf, lineChange, type LineChange } from './editor-text'

describe('lineBreakOf', () => {
  it('takes the first line break the text has, and LF without one', () => {
    expect(lineBreakOf('a\nb\r\n')).toBe('\n')
    expect(lineBreakOf('a\r\nb\n')).toBe('\r\n')
    expect(lineBreakOf('a\rb')).toBe('\r')
    expect(lineBreakOf('a\r')).toBe('\r')
    expect(lineBreakOf('one line')).toBe('\n')
    expect(lineBreakOf('')).toBe('\n')
  })
})

/** Applies a change to lines joined by one-character breaks, as the editor's positions count. */
function apply(before: string[], change: LineChange | null): string[] {
  if (!change) return before
  const text = before.join('\n')
  return (text.slice(0, change.from) + change.insert.join('\n') + text.slice(change.to)).split('\n')
}

describe('lineChange', () => {
  const cases: [string, string[], string[]][] = [
    ['an edited line', ['a', 'b', 'c'], ['a', 'B', 'c']],
    ['lines added in the middle', ['a', 'c'], ['a', 'b1', 'b2', 'c']],
    ['lines added at the start', ['b', 'c'], ['a', 'b', 'c']],
    ['lines added at the end', ['a', 'b'], ['a', 'b', 'c', 'd']],
    ['lines removed in the middle', ['a', 'b', 'c', 'd'], ['a', 'd']],
    ['lines removed at the start', ['a', 'b', 'c'], ['c']],
    ['lines removed at the end', ['a', 'b', 'c'], ['a']],
    ['everything replaced', ['a', 'b'], ['x', 'y', 'z']],
    ['repeated lines', ['a', 'a', 'a'], ['a', 'a']],
    ['an emptied file', ['a', 'b'], ['']],
    ['a filled file', [''], ['a', 'b']],
  ]
  for (const [name, before, after] of cases) {
    it(`turns one into the other: ${name}`, () => {
      expect(apply(before, lineChange(before, after))).toEqual(after)
    })
  }

  it('keeps the lines that did not change out of the change', () => {
    expect(lineChange(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual({ from: 2, to: 3, insert: ['B'] })
    expect(lineChange(['a', 'b'], ['a', 'b'])).toBeNull()
  })
})
