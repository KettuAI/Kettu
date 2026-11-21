import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '@shared/git'
import { afterCommit, leftOutExcept, tickedFiles, tickState, toggled } from './commit-selection'

const file = (path: string, status: ChangedFile['status'] = 'modified'): ChangedFile => ({
  path,
  oldPath: null,
  status,
  insertions: 1,
  deletions: 0,
})

const files = [file('a.ts'), file('b.ts'), file('c.ts', 'conflicted'), file('d.ts', 'untracked')]

describe('the files a commit takes', () => {
  it('ticks every file but a conflicted one when none is left out', () => {
    expect(tickedFiles(files, []).map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'd.ts'])
  })

  it('leaves out what the user unticked, and ticks a file that appears later', () => {
    expect(tickedFiles(files, ['b.ts']).map((f) => f.path)).toEqual(['a.ts', 'd.ts'])
    expect(tickedFiles([...files, file('e.ts')], ['b.ts']).map((f) => f.path)).toContain('e.ts')
  })

  it('reads as all, some or none ticked', () => {
    expect(tickState(files, [])).toBe('all')
    expect(tickState(files, ['a.ts'])).toBe('some')
    expect(tickState(files, ['a.ts', 'b.ts', 'd.ts'])).toBe('none')
  })

  it('leaves out everything but the paths an opener names', () => {
    expect(leftOutExcept(files, null)).toEqual([])
    expect(leftOutExcept(files, ['b.ts'])).toEqual(['a.ts', 'd.ts'])
    expect(leftOutExcept(files, ['c.ts'])).toEqual(['a.ts', 'b.ts', 'd.ts'])
  })

  it('toggles one path', () => {
    expect(toggled([], 'a.ts', false)).toEqual(['a.ts'])
    expect(toggled(['a.ts', 'b.ts'], 'a.ts', true)).toEqual(['b.ts'])
    expect(toggled(['a.ts'], 'a.ts', false)).toEqual(['a.ts'])
  })

  it('drops from the left-out paths those that are no longer changed once a commit is made', () => {
    expect(afterCommit(files, ['b.ts', 'gone.ts'], ['a.ts', 'd.ts'])).toEqual(['b.ts'])
  })
})
