import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ToolContent, ToolEntry } from '@shared/thread'
import {
  diffCounts,
  DIGEST_INPUT_BYTES,
  DIGEST_OUTPUT_BYTES,
  digestEntries,
  digestEntry,
} from './digest'

const tool = (changes: Partial<ToolEntry> = {}): ToolEntry => ({
  kind: 'tool',
  id: 't1',
  title: 'Run',
  toolKind: 'execute',
  status: 'completed',
  content: [],
  locations: [],
  permission: null,
  permissionResult: null,
  ...changes,
})

const numbered = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, i) => `line ${from + i}\n`).join('')

describe('tool digests', () => {
  it('leaves other entries, short outputs and inputs, small diffs and images alone', () => {
    const agent: ThreadEntry = {
      kind: 'agent',
      id: 'a1',
      markdown: 'x'.repeat(DIGEST_OUTPUT_BYTES * 4),
      attachments: [],
      streaming: false,
    }
    const short = tool({
      rawInput: 'x'.repeat(DIGEST_INPUT_BYTES),
      content: [
        { type: 'markdown', markdown: 'x'.repeat(DIGEST_OUTPUT_BYTES) },
        { type: 'diff', path: '/p/a.ts', oldText: 'a\n', newText: 'b\n' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', blob: 'ab'.repeat(32) } },
      ],
    })
    expect(digestEntry(agent)).toBe(agent)
    expect(digestEntry(short)).toBe(short)
  })

  it('turns a long output into its size and lines, by UTF-8 bytes', () => {
    const markdown = 'é'.repeat(DIGEST_OUTPUT_BYTES / 2) + '\nend\n'
    const image: ToolContent = {
      type: 'ref',
      ref: { kind: 'image', mimeType: 'image/png', blob: 'cd'.repeat(32) },
    }
    const entry = tool({ content: [{ type: 'markdown', markdown }, image] })
    expect(digestEntry(entry)).toEqual({
      ...entry,
      content: [{ type: 'digest', of: 'markdown', size: DIGEST_OUTPUT_BYTES + 5, lines: 2 }, image],
    })
    expect(entry.content[0]).toEqual({ type: 'markdown', markdown })
  })

  it('turns a long input into its size and lines in place of rawInput', () => {
    const rawInput = `cat <<EOF\n${'x'.repeat(DIGEST_INPUT_BYTES)}\nEOF`
    const digested = digestEntry(tool({ rawInput, title: 'cat' }))
    expect(digested).not.toHaveProperty('rawInput')
    expect(digested).toMatchObject({
      title: 'cat',
      rawInputDigest: { size: rawInput.length, lines: 3 },
    })
  })

  it('turns a large diff into its path, size and the lines it adds and removes', () => {
    const oldText = numbered(600)
    const newText = numbered(600).replace('line 10\n', 'ten\n').replace('line 500\n', '')
    const digested = digestEntry(
      tool({ toolKind: 'edit', content: [{ type: 'diff', path: '/p/a.ts', oldText, newText }] }),
    )
    expect(digested).toMatchObject({
      content: [
        {
          type: 'digest',
          of: 'diff',
          path: '/p/a.ts',
          size: oldText.length + newText.length,
          added: 1,
          removed: 2,
        },
      ],
    })
    const created = digestEntry(
      tool({
        content: [{ type: 'diff', path: '/p/b.ts', oldText: null, newText: numbered(1000) }],
      }),
    )
    expect(created).toMatchObject({ content: [{ added: 1000, removed: 0 }] })
  })

  it('keeps a call that waits for an answer whole', () => {
    const waiting = tool({
      status: 'pending',
      rawInput: 'x'.repeat(DIGEST_INPUT_BYTES * 2),
      content: [{ type: 'markdown', markdown: 'x'.repeat(DIGEST_OUTPUT_BYTES * 2) }],
      permission: { requestId: 'r1', options: [] },
    })
    expect(digestEntry(waiting)).toBe(waiting)
  })

  it('digests every entry of a page and keeps the rest of it', () => {
    const long = tool({ rawInput: 'x'.repeat(DIGEST_INPUT_BYTES + 1) })
    const page = { entries: [long], older: 3 }
    const digested = digestEntries(page)
    expect(digested.older).toBe(3)
    expect(digested.entries[0]).toHaveProperty('rawInputDigest')
    expect(page.entries[0]).toBe(long)
  })
})

describe('diff counts', () => {
  it('counts the lines of changes far apart as the diff view does', () => {
    const before = numbered(50)
    const after = before.replace('line 3\n', 'three\n').replace('line 40\n', 'line 40\nnew\n')
    expect(diffCounts(before, after)).toEqual({ added: 2, removed: 1 })
    expect(diffCounts(before, before)).toEqual({ added: 0, removed: 0 })
    expect(diffCounts('', 'a\nb')).toEqual({ added: 2, removed: 0 })
    expect(diffCounts('a\nb\n', '')).toEqual({ added: 0, removed: 2 })
  })

  it('gives no counts for a change too large to compare quickly', () => {
    expect(diffCounts(numbered(3000), numbered(3000, 10_000))).toEqual({
      added: null,
      removed: null,
    })
  })
})
