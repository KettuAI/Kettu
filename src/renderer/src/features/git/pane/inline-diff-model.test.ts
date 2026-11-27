import { describe, expect, it } from 'vitest'
import type { ChangedFile, FileDiff } from '@shared/git'
import {
  INLINE_DIFF_MAX_CHARS,
  INLINE_DIFF_MAX_LINES,
  prepareInlineDiff,
  pruneExpandedPaths,
  toggleExpandedPath,
} from './inline-diff-model'

function makeFile(
  path: string,
  overrides: Partial<Pick<ChangedFile, 'oldPath' | 'status'>> = {},
): Pick<ChangedFile, 'path' | 'oldPath' | 'status'> {
  return {
    path,
    oldPath: null,
    status: 'modified',
    ...overrides,
  }
}

function makeDiff(path: string, overrides: Partial<Omit<FileDiff, 'path'>> = {}): FileDiff {
  return {
    path,
    oldText: 'a\n',
    newText: 'b\n',
    binary: false,
    tooLarge: false,
    ...overrides,
  }
}

function numberedLines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
}

describe('inline diff expansion state', () => {
  it('toggles each file path independently without collapsing other expanded files', () => {
    const empty = new Set<string>()
    const one = toggleExpandedPath(empty, 'src/a.ts')
    expect([...one]).toEqual(['src/a.ts'])

    const two = toggleExpandedPath(one, 'src/b.ts')
    expect([...two]).toEqual(['src/a.ts', 'src/b.ts'])

    const collapsedFirst = toggleExpandedPath(two, 'src/a.ts')
    expect([...collapsedFirst]).toEqual(['src/b.ts'])
  })

  it('prunes paths that left the change list and keeps the same set when nothing disappeared', () => {
    const open = new Set(['src/a.ts', 'src/b.ts'])
    const unchanged = pruneExpandedPaths(open, [{ path: 'src/a.ts' }, { path: 'src/b.ts' }])
    expect(unchanged).toBe(open)

    const pruned = pruneExpandedPaths(open, [{ path: 'src/b.ts' }])
    expect([...pruned]).toEqual(['src/b.ts'])
  })
})

describe('prepareInlineDiff', () => {
  it('classifies loading, error, binary, tooLarge, empty, empty-added, empty-deleted, and renamed-only states', () => {
    const file = makeFile('src/app.ts')
    expect(prepareInlineDiff(file, null, null)).toEqual({ kind: 'loading' })
    expect(prepareInlineDiff(file, null, 'Host unreachable')).toEqual({
      kind: 'error',
      error: 'Host unreachable',
    })
    expect(prepareInlineDiff(file, makeDiff('src/app.ts', { binary: true }), null)).toEqual({
      kind: 'binary',
    })
    expect(prepareInlineDiff(file, makeDiff('src/app.ts', { tooLarge: true }), null)).toEqual({
      kind: 'too-large',
    })
    expect(
      prepareInlineDiff(
        file,
        makeDiff('src/app.ts', { oldText: 'same\n', newText: 'same\n' }),
        null,
      ),
    ).toEqual({ kind: 'empty' })
    expect(
      prepareInlineDiff(
        makeFile('src/new.ts', { status: 'untracked' }),
        makeDiff('src/new.ts', { oldText: null, newText: '' }),
        null,
      ),
    ).toEqual({ kind: 'empty-added' })
    expect(
      prepareInlineDiff(
        makeFile('src/old.ts', { status: 'deleted' }),
        makeDiff('src/old.ts', { oldText: '', newText: null }),
        null,
      ),
    ).toEqual({ kind: 'empty-deleted' })
    expect(
      prepareInlineDiff(
        makeFile('src/after.ts', { status: 'renamed', oldPath: 'src/before.ts' }),
        makeDiff('src/after.ts', { oldText: 'const x = 1\n', newText: 'const x = 1\n' }),
        null,
      ),
    ).toEqual({ kind: 'renamed-only', oldPath: 'src/before.ts', path: 'src/after.ts' })
  })

  it('keeps deleted files as deletions and does not truncate small edits inside large files', () => {
    const deleted = prepareInlineDiff(
      makeFile('src/removed.ts', { status: 'deleted' }),
      makeDiff('src/removed.ts', { oldText: 'line 1\nline 2\n', newText: null }),
      null,
    )
    expect(deleted).toEqual({
      kind: 'diff',
      oldText: 'line 1\nline 2\n',
      newText: '',
      truncated: false,
      shownLines: 2,
      totalLines: 2,
    })

    // A 600-line file with a single changed line near the bottom stays untruncated.
    const oldLines = Array.from({ length: 600 }, (_, i) => `const v${i} = ${i}`)
    const newLines = [...oldLines]
    newLines[550] = 'const v550 = 999'
    const smallEdit = prepareInlineDiff(
      makeFile('src/big.ts'),
      makeDiff('src/big.ts', {
        oldText: `${oldLines.join('\n')}\n`,
        newText: `${newLines.join('\n')}\n`,
      }),
      null,
    )
    expect(smallEdit.kind).toBe('diff')
    if (smallEdit.kind === 'diff') {
      expect(smallEdit.truncated).toBe(false)
      expect(smallEdit.totalLines).toBeLessThan(20)
    }
  })

  it('truncates oversized added and deleted files at the inline line cap', () => {
    const added = prepareInlineDiff(
      makeFile('src/generated.ts', { status: 'added' }),
      makeDiff('src/generated.ts', {
        oldText: null,
        newText: numberedLines(INLINE_DIFF_MAX_LINES + 50),
      }),
      null,
    )
    expect(added.kind).toBe('diff')
    if (added.kind === 'diff') {
      expect(added.truncated).toBe(true)
      expect(added.shownLines).toBe(INLINE_DIFF_MAX_LINES)
      expect(added.totalLines).toBe(INLINE_DIFF_MAX_LINES + 50)
      expect(added.newText.split('\n')).toHaveLength(INLINE_DIFF_MAX_LINES)
    }

    const deleted = prepareInlineDiff(
      makeFile('src/legacy.ts', { status: 'deleted' }),
      makeDiff('src/legacy.ts', {
        oldText: numberedLines(INLINE_DIFF_MAX_LINES + 30),
        newText: null,
      }),
      null,
    )
    expect(deleted.kind).toBe('diff')
    if (deleted.kind === 'diff') {
      expect(deleted.truncated).toBe(true)
      expect(deleted.shownLines).toBe(INLINE_DIFF_MAX_LINES)
      expect(deleted.totalLines).toBe(INLINE_DIFF_MAX_LINES + 30)
      expect(deleted.oldText?.split('\n')).toHaveLength(INLINE_DIFF_MAX_LINES)
      expect(deleted.newText).toBe('')
    }
  })

  it('truncates oversized multi-hunk and single-hunk modifications cleanly', () => {
    // Many scattered hunks exceeding the inline line cap.
    const oldMany = Array.from({ length: 1200 }, (_, i) => `row ${i}`)
    const newMany = [...oldMany]
    for (let i = 5; i < 1200; i += 20) {
      newMany[i] = `row ${i} updated`
    }
    const multiHunk = prepareInlineDiff(
      makeFile('src/many.ts'),
      makeDiff('src/many.ts', {
        oldText: `${oldMany.join('\n')}\n`,
        newText: `${newMany.join('\n')}\n`,
      }),
      null,
    )
    expect(multiHunk.kind).toBe('diff')
    if (multiHunk.kind === 'diff') {
      expect(multiHunk.truncated).toBe(true)
      expect(multiHunk.shownLines).toBeGreaterThan(0)
      expect(multiHunk.shownLines).toBeLessThanOrEqual(INLINE_DIFF_MAX_LINES)
      expect(multiHunk.totalLines).toBeGreaterThan(INLINE_DIFF_MAX_LINES)
      expect(multiHunk.oldText).not.toBe(multiHunk.newText)
    }

    // One huge contiguous rewrite hunk exceeding the inline line cap.
    const singleHunk = prepareInlineDiff(
      makeFile('src/rewrite.ts'),
      makeDiff('src/rewrite.ts', {
        oldText: numberedLines(INLINE_DIFF_MAX_LINES + 40, 'old'),
        newText: numberedLines(INLINE_DIFF_MAX_LINES + 40, 'new'),
      }),
      null,
    )
    expect(singleHunk.kind).toBe('diff')
    if (singleHunk.kind === 'diff') {
      expect(singleHunk.truncated).toBe(true)
      expect(singleHunk.shownLines).toBe(INLINE_DIFF_MAX_LINES)
      expect(singleHunk.totalLines).toBeGreaterThan(INLINE_DIFF_MAX_LINES)
      expect(singleHunk.oldText).not.toBe(singleHunk.newText)
    }
  })

  it('degrades huge single-line bundles to too-large without hanging', () => {
    const huge = 'x'.repeat(INLINE_DIFF_MAX_CHARS + 10)
    const view = prepareInlineDiff(
      makeFile('dist/bundle.min.js'),
      makeDiff('dist/bundle.min.js', { oldText: huge, newText: `${huge}y` }),
      null,
    )
    expect(view).toEqual({ kind: 'too-large' })
  })
})
