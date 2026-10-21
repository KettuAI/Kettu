import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMarkdownIntoBlocks } from 'streamdown'
import { CHUNK_SIZE, splitIntoChunks, type Chunks } from './chunks'

vi.mock('streamdown', async (original) => {
  const actual = await original<typeof import('streamdown')>()
  return { ...actual, parseMarkdownIntoBlocks: vi.fn(actual.parseMarkdownIntoBlocks) }
})
const lexed = vi.mocked(parseMarkdownIntoBlocks)

const section = (i: number): string =>
  [
    `## Step ${i}`,
    '',
    `Paragraph ${i} explains the change in a few sentences, so the block is long enough to count.`,
    'It wraps onto a second line of the same paragraph.',
    '',
    `- first point of ${i}`,
    `- second point of ${i}`,
    '',
    '  still the second point',
    '',
    '```ts',
    `export const value${i} = ${i}`,
    '',
    '',
    `export function f${i}() {}`,
    '```',
    '',
    '| File | Change |',
    '| --- | --- |',
    `| src/${i}.ts | edited |`,
    '',
    `> A quote for ${i}.`,
    '',
    '',
  ].join('\n')

const document = (sections: number): string =>
  Array.from({ length: sections }, (_, i) => section(i)).join('')

/** Where blocks of the whole text end, as offsets. */
const blockEnds = (text: string): Set<number> => {
  const ends = new Set<number>()
  let offset = 0
  for (const block of parseMarkdownIntoBlocks(text)) ends.add((offset += block.length))
  return ends
}

describe('splitIntoChunks', () => {
  beforeEach(() => {
    lexed.mockClear()
  })

  it('keeps a short text whole', () => {
    const text = section(1)
    expect(splitIntoChunks(text).chunks).toEqual([text])
  })

  it('cuts a long text on block boundaries, outside code fences', () => {
    const text = document(120)
    const { chunks } = splitIntoChunks(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.length).toBeGreaterThan(5)
    const ends = blockEnds(text)
    let offset = 0
    for (const chunk of chunks.slice(0, -1)) {
      offset += chunk.length
      expect(ends.has(offset)).toBe(true)
      expect(chunk.match(/^```/gm)?.length ?? 0).toSatisfy((n: number) => n % 2 === 0)
      expect(chunk.length).toBeGreaterThanOrEqual(CHUNK_SIZE)
      expect(chunk.length).toBeLessThan(2 * CHUNK_SIZE)
    }
  })

  it('never changes a settled chunk while text streams in, and lexes rarely', () => {
    const text = document(200)
    let split: Chunks | undefined
    let settled: string[] = []
    let steps = 0
    for (let end = 0; end < text.length + 97; end += 97) {
      const shown = text.slice(0, end)
      split = splitIntoChunks(shown, split)
      expect(split.chunks.join('')).toBe(shown)
      expect(split.chunks.slice(0, settled.length)).toEqual(settled)
      settled = split.chunks.slice(0, -1)
      steps++
    }
    expect(settled.length).toBeGreaterThan(5)
    // About once per settled chunk, not once per update.
    expect(lexed.mock.calls.length).toBeLessThan(steps / 20)
  })

  it('waits on one long block without lexing it on every update', () => {
    const code = '```ts\n' + 'export const line = 1\n'.repeat(2_000)
    let split: Chunks | undefined
    let updates = 0
    for (let end = 0; end < code.length + 200; end += 200) {
      split = splitIntoChunks(code.slice(0, end), split)
      updates++
    }
    expect(split?.chunks).toEqual([code])
    expect(lexed.mock.calls.length).toBeLessThan(updates / 10)
  })

  it('keeps text with footnotes or link definitions whole', () => {
    const long = document(60)
    for (const text of [
      long + 'See [^1].\n\n[^1]: A note.',
      long + '[docs]: https://example.com\n',
    ]) {
      expect(splitIntoChunks(text).chunks).toEqual([text])
    }
    const split = splitIntoChunks(long)
    expect(split.chunks.length).toBeGreaterThan(1)
    const noted = long + 'A late [^1].'
    expect(splitIntoChunks(noted, split).chunks).toEqual([noted])
  })

  it('keeps the chunks before an edit and splits again after it', () => {
    const text = document(120)
    const split = splitIntoChunks(text)
    const at = split.chunks[0].length + split.chunks[1].length + 10
    const edited = text.slice(0, at) + 'edited ' + text.slice(at)
    const again = splitIntoChunks(edited, split)
    expect(again.chunks.join('')).toBe(edited)
    expect(again.chunks.slice(0, 2)).toEqual(split.chunks.slice(0, 2))
  })
})
