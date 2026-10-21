import { describe, expect, it } from 'vitest'
import { filterPaths, foldersAbove, indexFolders, matchPath, treeRows } from './paths'

describe('matchPath', () => {
  it('matches characters in order, ignoring case', () => {
    expect(matchPath('SVT', 'src/views/thread.tsx')?.positions).toEqual([0, 4, 10])
    expect(matchPath('xyz', 'src/views/thread.tsx')).toBeNull()
    expect(matchPath('ts', 'st')).toBeNull()
  })

  it('ranks a match in the file name over one across folders', () => {
    const name = matchPath('thread', 'src/thread.tsx')!
    const spread = matchPath('thread', 'src/tools/hidden/read.ts')!
    expect(name.score).toBeGreaterThan(spread.score)
  })

  it('ignores spaces in the query and matches everything with an empty one', () => {
    expect(matchPath('st ts', 'src/thread.ts')).not.toBeNull()
    expect(matchPath('', 'a/b')?.score).toBe(0)
  })
})

describe('filterPaths', () => {
  it('sorts the best first, caps the list and counts every match', () => {
    const paths = ['docs/readme.md', 'src/read.ts', 'src/reader/index.ts', 'package.json']
    const { matches, total } = filterPaths('read', paths, 2)
    expect(total).toBe(3)
    expect(matches.map((m) => m.path)).toEqual(['src/read.ts', 'docs/readme.md'])
  })
})

describe('the tree', () => {
  const index = indexFolders(['b.ts', 'src/z.ts', 'src/a/x.ts', 'src/A.ts', 'docs/x.md'])

  it('lists folders before files, by name ignoring case', () => {
    expect(treeRows(index, new Set())).toEqual([
      { path: 'docs', depth: 0, folder: true },
      { path: 'src', depth: 0, folder: true },
      { path: 'b.ts', depth: 0, folder: false },
    ])
  })

  it('shows the insides of open folders only', () => {
    expect(treeRows(index, new Set(['src', 'src/a'])).map((r) => `${r.depth}:${r.path}`)).toEqual([
      '0:docs',
      '0:src',
      '1:src/a',
      '2:src/a/x.ts',
      '1:src/A.ts',
      '1:src/z.ts',
      '0:b.ts',
    ])
  })

  it('names the folders above a file, outermost first', () => {
    expect(foldersAbove('src/a/x.ts')).toEqual(['src', 'src/a'])
    expect(foldersAbove('x.ts')).toEqual([])
  })
})
