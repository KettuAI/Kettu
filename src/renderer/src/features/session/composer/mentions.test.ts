import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ThreadState, ToolEntry } from '@shared/thread'
import {
  foldersOf,
  insertAt,
  markedRuns,
  matchMentions,
  MENTION_LIMIT,
  mentionAt,
  mentionName,
  mentionShown,
  popoverKey,
  replaceMention,
  usedFiles,
} from './mentions'

describe('mentionAt', () => {
  it('finds an @ that starts the word at the caret', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('look at @src/th', 15)).toEqual({ start: 8, query: 'src/th' })
    expect(mentionAt('see @thread.tsx now', 8)).toEqual({ start: 4, query: 'thr' })
    expect(mentionAt('first line\n@notes', 17)).toEqual({ start: 11, query: 'notes' })
  })

  it('takes the full-width at sign some input methods type', () => {
    expect(mentionAt('\uFF20ui', 3)).toEqual({ start: 0, query: 'ui' })
  })

  it('ignores an @ inside a word, a caret before it, and a selected range', () => {
    expect(mentionAt('me@example.com', 14)).toBeNull()
    expect(mentionAt('@notes', 0)).toBeNull()
    expect(mentionAt('@notes ', 7)).toBeNull()
    expect(mentionAt('@notes', null)).toBeNull()
    expect(mentionAt('', 4)).toBeNull()
  })
})

describe('matchMentions', () => {
  const files = ['docs/readme.md', 'src/read.ts', 'src/reader/index.ts', 'package.json']

  it('lists every folder once, with a slash after it', () => {
    expect(foldersOf(['a/b/c.ts', 'a/b/d.ts', 'a/e.ts', 'f.ts']).sort()).toEqual(['a/', 'a/b/'])
    expect(foldersOf(files)).toBe(foldersOf(files))
  })

  it('ranks files and folders together, best first, with their matched characters', () => {
    const rows = matchMentions('read', files, foldersOf(files))
    expect(rows.map((r) => [r.path, r.folder])).toEqual([
      ['src/read.ts', false],
      ['src/reader', true],
      ['docs/readme.md', false],
      ['src/reader/index.ts', false],
    ])
    expect(rows[0]!.positions).toEqual([4, 5, 6, 7])
    expect(matchMentions('nothing', files, foldersOf(files))).toEqual([])
  })

  it('shows at most 50 rows', () => {
    const many = Array.from({ length: 80 }, (_, i) => `src/file-${i}.ts`)
    expect(matchMentions('file', many, foldersOf(many))).toHaveLength(MENTION_LIMIT)
  })
})

describe('usedFiles', () => {
  const tool = (id: string, toolKind: ToolEntry['toolKind'], paths: string[]): ThreadEntry => ({
    kind: 'tool',
    id,
    title: id,
    toolKind,
    status: 'completed',
    content: [],
    locations: paths.map((path) => ({ path })),
    permission: null,
    permissionResult: null,
  })
  const thread = (entries: ThreadEntry[]): ThreadState => ({
    session: {} as ThreadState['session'],
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  })
  const known = new Set(['src/a.ts', 'src/b.ts', 'README.md'])

  it("lists the project's files that tool calls read or edited, most recent first", () => {
    const state = thread([
      tool('t1', 'read', ['/work/app/src/a.ts']),
      tool('t2', 'execute', ['/work/app/README.md']),
      tool('t3', 'edit', ['/work/app/src/b.ts']),
      tool('t4', 'read', ['/work/app/src/a.ts']),
      tool('t5', 'read', ['/elsewhere/x.ts']),
      tool('t6', 'read', ['/work/app/gone.ts']),
    ])
    expect(usedFiles(state, '/work/app', known)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(usedFiles(null, '/work/app', known)).toEqual([])
  })

  it("takes an edit's files from its diffs when it has them", () => {
    const edit = {
      ...(tool('t1', 'edit', []) as ToolEntry),
      content: [{ type: 'diff' as const, path: '/work/app/README.md', oldText: '', newText: 'x' }],
    }
    expect(usedFiles(thread([edit]), '/work/app', known)).toEqual(['README.md'])
  })
})

describe('choosing a row', () => {
  it("writes a file's name, or a folder's with a slash", () => {
    expect(mentionName({ path: 'src/thread.tsx', folder: false })).toBe('thread.tsx')
    expect(mentionName({ path: 'src/views', folder: true })).toBe('views/')
  })

  it('replaces the @ word with @name and a space, and puts the caret after them', () => {
    const text = 'look at @thr and fix it'
    const mention = mentionAt(text, 12)!
    expect(replaceMention(text, mention, 'thread.tsx')).toEqual({
      text: 'look at @thread.tsx and fix it',
      caret: 20,
    })
    expect(replaceMention('@th', mentionAt('@th', 3)!, 'thread.tsx')).toEqual({
      text: '@thread.tsx ',
      caret: 12,
    })
    // With the caret inside a word, what follows it stays.
    expect(replaceMention('fix @this', mentionAt('fix @this', 5)!, 'a.ts')).toEqual({
      text: 'fix @a.ts this',
      caret: 10,
    })
  })

  it('marks each run of matched characters once, counting UTF-16 units', () => {
    expect(markedRuns('thread.tsx', 4, [4, 5, 6, 10])).toEqual([
      { text: 'thr', marked: true },
      { text: 'ead', marked: false },
      { text: '.', marked: true },
      { text: 'tsx', marked: false },
    ])
    expect(markedRuns('a\u{1F600}x.ts', 0, [1, 2, 3])).toEqual([
      { text: 'a', marked: false },
      { text: '\u{1F600}x', marked: true },
      { text: '.ts', marked: false },
    ])
    expect(markedRuns('plain', 0, [])).toEqual([{ text: 'plain', marked: false }])
  })

  it('puts @ at the caret at the start of a word', () => {
    expect(insertAt('', 0, 0)).toEqual({ text: '@', caret: 1 })
    expect(insertAt('fix ', 4, 4)).toEqual({ text: 'fix @', caret: 5 })
    expect(insertAt('fix', 3, 3)).toEqual({ text: 'fix @', caret: 5 })
    expect(insertAt('fix this now', 4, 8)).toEqual({ text: 'fix @ now', caret: 5 })
  })
})

describe('keys', () => {
  const closed = {
    composing: false,
    modified: false,
    slashOpen: false,
    mentionOpen: false,
    mentionRows: false,
  }
  const open = { ...closed, mentionOpen: true, mentionRows: true }

  it('lets no key reach a popover while an input method composes', () => {
    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowDown']) {
      expect(popoverKey(key, { ...open, composing: true })).toBe('block')
      expect(popoverKey(key, { ...closed, slashOpen: true, composing: true })).toBe('block')
    }
  })

  it('leaves moving, Enter and Esc to the open mention popover, and chooses on Tab', () => {
    expect(popoverKey('ArrowDown', open)).toBe('composer')
    expect(popoverKey('Enter', open)).toBe('popover')
    expect(popoverKey('Escape', open)).toBe('popover')
    expect(popoverKey('Tab', open)).toBe('choose')
  })

  it('leaves a key with a modifier to the composer, as Base UI does', () => {
    for (const key of ['Enter', 'Tab', 'Escape']) {
      expect(popoverKey(key, { ...open, modified: true })).toBe('composer')
      expect(popoverKey(key, { ...closed, slashOpen: true, modified: true })).toBe('composer')
    }
  })

  it('sends with Enter when the popover has no row to choose', () => {
    const empty = { ...open, mentionRows: false }
    expect(popoverKey('Enter', empty)).toBe('composer')
    expect(popoverKey('Tab', empty)).toBe('composer')
    expect(popoverKey('Escape', empty)).toBe('popover')
    expect(popoverKey('Enter', closed)).toBe('composer')
  })

  it('keeps the slash popover as it was', () => {
    const slash = { ...closed, slashOpen: true }
    expect(popoverKey('Enter', slash)).toBe('popover')
    expect(popoverKey('Tab', slash)).toBe('popover')
    expect(popoverKey('a', slash)).toBe('composer')
  })
})

describe('mentionShown', () => {
  const mention = { start: 4, query: '' }

  it('shows until Esc closes it for that @', () => {
    expect(mentionShown(mention, null, null)).toBe(true)
    expect(mentionShown(mention, 4, null)).toBe(false)
    expect(mentionShown({ ...mention, start: 9 }, 4, null)).toBe(true)
    expect(mentionShown(null, null, null)).toBe(false)
  })

  it('opens for an @ an input method typed only once the composition ends', () => {
    expect(mentionShown(mention, null, { open: false })).toBe(false)
    expect(mentionShown(mention, null, { open: true })).toBe(true)
  })
})
