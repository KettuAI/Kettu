import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { fileQuote, selectedPassage } from './file-quote'

const doc = Text.of(['one', '  two', 'three', '', 'five'])
const at = (line: number, column = 0) => doc.line(line).from + column

describe('selectedPassage', () => {
  it('takes the text and lines of a selection inside the file', () => {
    expect(selectedPassage(doc, at(2, 2), at(3, 3))).toEqual({ lines: [2, 3], text: 'two\nthr' })
  })

  it('leaves out the line a selection of whole lines ends at the start of', () => {
    expect(selectedPassage(doc, at(2), at(4))).toEqual({ lines: [2, 3], text: '  two\nthree' })
  })

  it('starts on the next line when a selection starts at the end of one', () => {
    expect(selectedPassage(doc, at(1, 3), at(2, 5))).toEqual({ lines: [2, 2], text: '  two' })
  })

  it('is null for nothing but white space, and for the whole file', () => {
    expect(selectedPassage(doc, at(3, 5), at(5))).toBeNull()
    expect(selectedPassage(doc, at(2), at(2))).toBeNull()
    expect(selectedPassage(doc, 0, doc.length)).toBeNull()
  })

  it('drops a carriage return the file keeps at the end of a line', () => {
    const mixed = Text.of(['a\r', 'b', 'c'])
    expect(selectedPassage(mixed, 0, 4)).toEqual({ lines: [1, 2], text: 'a\nb' })
  })
})

describe('fileQuote', () => {
  it('names the file and its lines, then fences the code in its language', () => {
    expect(fileQuote('src/a.ts', { lines: [12, 13], text: 'const a = 1\n  b()' })).toBe(
      '`src/a.ts#L12-13`\n```ts startLine=12\nconst a = 1\n  b()\n```',
    )
    expect(fileQuote('Makefile', { lines: [4, 4], text: 'all:' })).toBe(
      '`Makefile#L4`\n```text startLine=4\nall:\n```',
    )
  })

  it('fences code holding backticks with a longer fence', () => {
    expect(fileQuote('a.md', { lines: [1, 3], text: '```js\nx\n```' })).toBe(
      '`a.md#L1-3`\n````md startLine=1\n```js\nx\n```\n````',
    )
  })

  it('quotes a passage of rendered Markdown as a reply passage is quoted', () => {
    expect(fileQuote('docs/a.md', { lines: null, text: 'First\nsecond' })).toBe(
      '`docs/a.md`\n> First\n> second',
    )
  })

  it('cuts a long passage at the end of a line', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
    const quote = fileQuote('a.txt', { lines: [1, 400], text })
    expect(quote.length).toBeLessThan(2100)
    expect(quote.endsWith('\n…\n```')).toBe(true)
    expect(quote).toContain('`a.txt#L1-400`')
  })
})
