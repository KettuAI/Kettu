import { describe, expect, it } from 'vitest'
import {
  findChips,
  findLinks,
  linkParts,
  mentioned,
  mentionEndingAt,
  mentionResolver,
  splitLines,
} from './chips'

const project = {
  files: new Set(['src/usage/usage-store.ts', 'README.md']),
  folders: new Set(['src/', 'src/usage/']),
}
const attachments = [
  { key: 'a', name: 'usage-store.ts', kind: 'file', status: 'ready' },
  { key: 'b', name: 'usage-bug.png', kind: 'image', status: 'ready', thumb: 'data:x' },
  { key: 'c', name: 'usage', kind: 'folder', status: 'ready' },
  { key: 'd', name: 'old-store.ts', kind: 'file', status: 'failed' },
  { key: 'e', name: 'Pasted text 1', kind: 'text', status: 'ready' },
]
const context = { commands: ['review', 'compact'], resolve: mentionResolver(attachments, project) }

describe('splitLines', () => {
  it('takes a line or a range off the end of a name', () => {
    expect(splitLines('usage-store.ts:41-44')).toEqual({ name: 'usage-store.ts', lines: '41–44' })
    expect(splitLines('usage-store.ts:41')).toEqual({ name: 'usage-store.ts', lines: '41' })
    expect(splitLines('usage-store.ts')).toEqual({ name: 'usage-store.ts', lines: null })
    expect(splitLines(':41')).toEqual({ name: ':41', lines: null })
  })

  it('reads the ranges Claude Code and GitHub write', () => {
    expect(splitLines('usage-store.ts#L4-5')).toEqual({ name: 'usage-store.ts', lines: '4–5' })
    expect(splitLines('usage-store.ts#L4-L5')).toEqual({ name: 'usage-store.ts', lines: '4–5' })
    expect(splitLines('usage-store.ts#L4')).toEqual({ name: 'usage-store.ts', lines: '4' })
  })
})

describe('linkParts', () => {
  it('keeps the host in full and drops a bare slash', () => {
    expect(linkParts('https://date-fns.org/docs/format')).toEqual({
      host: 'date-fns.org',
      path: '/docs/format',
      local: false,
    })
    expect(linkParts('https://www.example.com/')).toEqual({
      host: 'www.example.com',
      path: '',
      local: false,
    })
  })

  it('knows a local address, with its port', () => {
    expect(linkParts('http://localhost:5173/usage')).toEqual({
      host: 'localhost:5173',
      path: '/usage',
      local: true,
    })
    expect(linkParts('http://app.localhost/')?.local).toBe(true)
    expect(linkParts('http://127.0.0.1:3000')?.local).toBe(true)
  })
})

describe('findLinks', () => {
  it('leaves the punctuation that ends a sentence out of a link', () => {
    const text = 'See https://date-fns.org/docs/format. And (https://a.dev/x)，then'
    expect(findLinks(text).map((l) => text.slice(l.from, l.to))).toEqual([
      'https://date-fns.org/docs/format',
      'https://a.dev/x',
    ])
  })
})

describe('findLinks brackets', () => {
  it('keeps a bracket the link opened and drops one it did not', () => {
    const text = '(see https://en.wikipedia.org/wiki/Fork_(software)) and [https://a.dev/x]'
    expect(findLinks(text).map((l) => text.slice(l.from, l.to))).toEqual([
      'https://en.wikipedia.org/wiki/Fork_(software)',
      'https://a.dev/x',
    ])
  })
})

describe('findChips', () => {
  it('leaves the punctuation after a mention out of its chip', () => {
    const text = '看 @usage-store.ts，再看 @src/usage/usage-store.ts:3.'
    expect(findChips(text, context).map((c) => text.slice(c.from, c.to))).toEqual([
      '@usage-store.ts',
      '@src/usage/usage-store.ts:3',
    ])
  })

  it('finds the command, the mentions and the links in order', () => {
    const text =
      '/review 把 @usage-store.ts:41-44 和 @usage-bug.png 改了，参考 https://date-fns.org/x'
    const chips = findChips(text, context)
    expect(chips.map((c) => [c.kind, text.slice(c.from, c.to)])).toEqual([
      ['command', '/review'],
      ['file', '@usage-store.ts:41-44'],
      ['image', '@usage-bug.png'],
      ['link', 'https://date-fns.org/x'],
    ])
    expect(chips[1]).toMatchObject({ label: 'usage-store.ts', lines: '41–44', attachmentKey: 'a' })
    expect(chips[2]).toMatchObject({ thumb: 'data:x' })
  })

  it('leaves an unknown command and an unknown mention as text', () => {
    expect(findChips('/nope @nobody', context)).toEqual([])
  })

  it('takes a command only at the start, and a mention only after a space', () => {
    expect(findChips('say /review a@usage-store.ts', context)).toEqual([])
  })

  it('reads a folder with its slash, and a failed attachment as missing', () => {
    const chips = findChips('@usage/ @old-store.ts', context)
    expect(chips.map((c) => ('label' in c ? c.label : null))).toEqual(['usage/', 'old-store.ts'])
    expect(chips[1]).toMatchObject({ missing: true })
  })

  it('resolves a project path that no attachment has', () => {
    const chips = findChips('@src/usage/usage-store.ts:3 @src/usage', context)
    expect(chips).toMatchObject([
      { kind: 'file', path: 'src/usage/usage-store.ts', label: 'usage-store.ts', lines: '3' },
      { kind: 'folder', path: 'src/usage', label: 'src/usage/' },
    ])
  })

  it('never takes a pasted text for a mention', () => {
    expect(findChips('@Pasted', context)).toEqual([])
  })
})

describe('mentioned', () => {
  it('names the attachments a chip in the text stands for', () => {
    const keys = mentioned(
      '看 @usage-store.ts:3 和 @usage/ 还有 @src/usage/usage-store.ts',
      context.resolve,
    )
    expect([...keys]).toEqual(['a', 'c'])
  })
})

describe('mentionEndingAt', () => {
  it('finds the mention the text ends in, up to its at sign', () => {
    expect(mentionEndingAt('看 @src/us')).toBe(2)
    expect(mentionEndingAt('@')).toBe(0)
  })

  it('has none once a space or CJK punctuation ends it', () => {
    expect(mentionEndingAt('看 @src/usage ')).toBe(-1)
    expect(mentionEndingAt('看 @src/usage，再看')).toBe(-1)
    expect(mentionEndingAt('a@b')).toBe(-1)
  })
})
