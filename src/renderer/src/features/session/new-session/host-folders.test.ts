import { describe, expect, it } from 'vitest'
import { crumbs, foldersOf, listing, parentOf } from './host-folders'

describe('host folders', () => {
  it('walks a folder from its root, as the host writes paths', () => {
    expect(crumbs('/home/lin/src', 'linux')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'lin', path: '/home/lin' },
      { name: 'src', path: '/home/lin/src' },
    ])
    expect(crumbs('C:\\Users\\lin', 'win32')).toEqual([
      { name: 'C:\\', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'lin', path: 'C:\\Users\\lin' },
    ])
    expect(crumbs('\\\\nas\\share\\code', 'win32').map((c) => c.path)).toEqual([
      '\\\\nas\\share\\',
      '\\\\nas\\share\\code',
    ])
  })

  it('goes up a folder, and nowhere from a root', () => {
    expect(parentOf('/home/lin', 'linux')).toBe('/home')
    expect(parentOf('/home', 'linux')).toBe('/')
    expect(parentOf('/', 'linux')).toBeNull()
    expect(parentOf('D:\\code', 'win32')).toBe('D:\\')
    expect(parentOf('D:\\', 'win32')).toBeNull()
  })

  it("lists a folder's entries with its separator", () => {
    expect(listing('/home/lin', 'linux')).toBe('/home/lin/')
    expect(listing('/', 'linux')).toBe('/')
    expect(listing('~/', 'darwin')).toBe('~/')
    expect(listing('C:\\Users', 'win32')).toBe('C:\\Users\\')
  })

  it('lists only the folders, hidden ones left out, and marks repositories', () => {
    const folders = foldersOf(
      {
        folder: '/home/lin/src',
        entries: [
          { name: 'web', kind: 'folder', executable: false, repo: true },
          { name: '.cache', kind: 'folder', executable: false },
          { name: 'notes.md', kind: 'file', executable: false },
          { name: 'api', kind: 'folder', executable: false },
        ],
        exact: { kind: 'folder', executable: false },
      },
      'linux',
    )
    expect(folders).toEqual([
      { name: 'api', path: '/home/lin/src/api', repo: false },
      { name: 'web', path: '/home/lin/src/web', repo: true },
    ])
  })
})
