import { describe, expect, it } from 'vitest'
import {
  hostFilePath,
  isAbsolutePath,
  isLocalProject,
  relativeToRoot,
  resolveFilePath,
} from './file-location'

const REMOTE = 'kettu-host:0123456789abcdef0123456789abcdef:/home/dev/app'
const REMOTE_WIN = 'kettu-host:0123456789abcdef0123456789abcdef:C:\\Work\\App'

describe('isLocalProject', () => {
  it('returns true only for non-web local paths', () => {
    expect(isLocalProject('/Users/dev/app', false)).toBe(true)
    expect(isLocalProject('C:\\Work\\App', false)).toBe(true)
    expect(isLocalProject('/Users/dev/app', true)).toBe(false)
    expect(isLocalProject(REMOTE, false)).toBe(false)
    expect(isLocalProject(REMOTE, true)).toBe(false)
  })
})

describe('isAbsolutePath', () => {
  it('recognizes POSIX, Windows drive, and UNC paths while rejecting relative and tilde paths', () => {
    expect(isAbsolutePath('/Users/dev/app/a.ts')).toBe(true)
    expect(isAbsolutePath('C:\\Work\\App\\a.ts')).toBe(true)
    expect(isAbsolutePath('C:/Work/App/a.ts')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a.ts')).toBe(true)
    expect(isAbsolutePath('src/a.ts')).toBe(false)
    expect(isAbsolutePath('./src/a.ts')).toBe(false)
    expect(isAbsolutePath('~/notes.txt')).toBe(false)
  })
})

describe('hostFilePath', () => {
  it('joins relative paths using the host separator and strips kettu-host prefixes', () => {
    expect(hostFilePath('/Users/dev/app/', 'src/a.ts')).toBe('/Users/dev/app/src/a.ts')
    expect(hostFilePath('C:\\Work\\App\\', 'src/a.ts')).toBe('C:\\Work\\App\\src\\a.ts')
    expect(hostFilePath(REMOTE, 'src/a.ts')).toBe('/home/dev/app/src/a.ts')
    expect(hostFilePath(REMOTE_WIN, 'src/a.ts')).toBe('C:\\Work\\App\\src\\a.ts')
    expect(hostFilePath(REMOTE, '')).toBe('/home/dev/app')
  })
})

describe('relativeToRoot', () => {
  it('normalizes paths inside POSIX, Windows, and remote project roots', () => {
    expect(relativeToRoot('/Users/dev/app/src/a.ts', '/Users/dev/app')).toBe('src/a.ts')
    expect(relativeToRoot('/Users/dev/app/src/a.ts', '/Users/dev/app/')).toBe('src/a.ts')
    expect(relativeToRoot('./src/a.ts', '/Users/dev/app')).toBe('src/a.ts')
    expect(relativeToRoot('src\\nested\\a.ts', 'C:\\Work\\App')).toBe('src/nested/a.ts')
    expect(relativeToRoot('c:/work/app/src/a.ts', 'C:\\Work\\App')).toBe('src/a.ts')
    expect(relativeToRoot('/home/dev/app/src/a.ts', REMOTE)).toBe('src/a.ts')
  })

  it('returns null for paths outside the root, equal to the root, escaping via .., or starting with ~', () => {
    expect(relativeToRoot('/tmp/outside.ts', '/Users/dev/app')).toBeNull()
    expect(relativeToRoot('/Users/dev/app-other/a.ts', '/Users/dev/app')).toBeNull()
    expect(relativeToRoot('/Users/dev/app', '/Users/dev/app')).toBeNull()
    expect(relativeToRoot('../escape.ts', '/Users/dev/app')).toBeNull()
    expect(relativeToRoot('~/notes.txt', '/Users/dev/app')).toBeNull()
  })
})

describe('resolveFilePath', () => {
  it('resolves local relative and absolute paths inside the project', () => {
    expect(resolveFilePath('/Users/dev/app', 'src/a.ts')).toEqual({
      absolutePath: '/Users/dev/app/src/a.ts',
      relativePath: 'src/a.ts',
    })
    expect(resolveFilePath('/Users/dev/app', '/Users/dev/app/src/a.ts')).toEqual({
      absolutePath: '/Users/dev/app/src/a.ts',
      relativePath: 'src/a.ts',
    })
    expect(resolveFilePath('C:\\Work\\App', 'c:/work/app/src/a.ts')).toEqual({
      absolutePath: 'C:\\Work\\App\\src\\a.ts',
      relativePath: 'src/a.ts',
    })
  })

  it('resolves remote paths without leaking the kettu-host prefix', () => {
    expect(resolveFilePath(REMOTE, '/home/dev/app/src/a.ts')).toEqual({
      absolutePath: '/home/dev/app/src/a.ts',
      relativePath: 'src/a.ts',
    })
    expect(resolveFilePath(REMOTE, 'src/a.ts')).toEqual({
      absolutePath: '/home/dev/app/src/a.ts',
      relativePath: 'src/a.ts',
    })
  })

  it('keeps absolute paths outside the project and leaves tilde paths unexpanded', () => {
    expect(resolveFilePath('/Users/dev/app', '/tmp/outside.txt')).toEqual({
      absolutePath: '/tmp/outside.txt',
      relativePath: null,
    })
    expect(resolveFilePath('/Users/dev/app', '~/notes.txt')).toEqual({
      absolutePath: null,
      relativePath: null,
    })
  })
})
