import { describe, expect, it } from 'vitest'
import { fenceFileName, fenceLanguage, FOLDED_LINES, foldLines } from './code-meta'

describe('fenceFileName', () => {
  it('reads a path after the language', () => {
    expect(fenceFileName('ts', 'src/usage/day-key.ts')).toBe('src/usage/day-key.ts')
  })

  it('reads a title attribute', () => {
    expect(fenceFileName('rust', '{1} title="src/main.rs"')).toBe('src/main.rs')
    expect(fenceFileName('py', "filename='app.py'")).toBe('app.py')
  })

  it('reads a file glued to the language', () => {
    expect(fenceFileName('ts:src/a.ts', undefined)).toBe('src/a.ts')
    expect(fenceLanguage('ts:src/a.ts')).toBe('ts')
  })

  it('ignores line highlights and words that are not paths', () => {
    expect(fenceFileName('ts', '{1,3}')).toBeNull()
    expect(fenceFileName('sh', 'showLineNumbers')).toBeNull()
    expect(fenceFileName('ts', undefined)).toBeNull()
  })
})

describe('foldLines', () => {
  const block = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n')

  it('leaves a block of up to 20 lines whole', () => {
    expect(foldLines(block(20), true)).toEqual({ shown: block(20), hidden: 0 })
  })

  it('folds a longer block to its first lines', () => {
    const { shown, hidden } = foldLines(block(45), true)
    expect(shown.split('\n')).toHaveLength(FOLDED_LINES)
    expect(hidden).toBe(45 - FOLDED_LINES)
  })

  it('counts lines without the final newline', () => {
    expect(foldLines(block(21) + '\n', true).hidden).toBe(21 - FOLDED_LINES)
  })

  it('shows everything once unfolded', () => {
    expect(foldLines(block(45), false).hidden).toBe(0)
  })
})
