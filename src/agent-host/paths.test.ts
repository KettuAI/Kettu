import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalizePath, folderName, isAbsolutePath, pathKey, samePath } from './paths'

describe('canonicalizePath', () => {
  it('rejects relative paths before touching the file system', async () => {
    const calls: string[] = []
    const fake = async (p: string): Promise<string> => {
      calls.push(p)
      return p
    }
    await expect(canonicalizePath('project', 'linux', fake)).rejects.toThrow('absolute')
    await expect(canonicalizePath('C:project', 'win32', fake)).rejects.toThrow('absolute')
    expect(calls).toEqual([])
  })

  it('resolves dot segments and trailing separators before realpath', async () => {
    const seen: string[] = []
    const fake = async (p: string): Promise<string> => {
      seen.push(p)
      return p
    }
    expect(await canonicalizePath('/home/me/a/../b/', 'linux', fake)).toBe('/home/me/b')
    expect(await canonicalizePath('C:\\Users\\me\\a\\..\\b\\', 'win32', fake)).toBe(
      'C:\\Users\\me\\b',
    )
    expect(seen).toEqual(['/home/me/b', 'C:\\Users\\me\\b'])
  })

  it('strips the extended-length prefixes Windows realpath can return', async () => {
    expect(await canonicalizePath('D:\\x', 'win32', async () => '\\\\?\\D:\\x')).toBe('D:\\x')
    expect(
      await canonicalizePath(
        '\\\\server\\share\\x',
        'win32',
        async () => '\\\\?\\UNC\\server\\share\\x',
      ),
    ).toBe('\\\\server\\share\\x')
  })

  describe('on this machine', () => {
    let root: string
    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-paths-')))
      await mkdir(path.join(root, 'Real'))
      await symlink(path.join(root, 'Real'), path.join(root, 'link'), 'junction')
    })
    afterAll(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('follows symlinks and fails for a missing folder', async () => {
      const platform = process.platform
      const real = (p: string): Promise<string> => realpath(p)
      expect(await canonicalizePath(path.join(root, 'link'), platform, real)).toBe(
        path.join(root, 'Real'),
      )
      await expect(canonicalizePath(path.join(root, 'missing'), platform, real)).rejects.toThrow()
    })
  })
})

describe('pathKey and samePath', () => {
  it('compares Windows paths case-insensitively, including drives and UNC hosts', () => {
    expect(samePath('C:\\Users\\Me\\Repo', 'c:\\users\\me\\repo\\', 'win32')).toBe(true)
    expect(samePath('C:/Users/Me/Repo', 'C:\\Users\\Me\\Repo', 'win32')).toBe(true)
    expect(samePath('\\\\Server\\Share\\Repo', '\\\\server\\share\\repo', 'win32')).toBe(true)
    expect(samePath('C:\\Repo', 'D:\\Repo', 'win32')).toBe(false)
    expect(pathKey('C:\\', 'win32')).toBe('c:\\')
  })

  it('compares macOS and Linux paths exactly, after canonicalization', () => {
    expect(samePath('/Users/me/Repo', '/Users/me/Repo/', 'darwin')).toBe(true)
    expect(samePath('/Users/me/Repo', '/Users/me/repo', 'darwin')).toBe(false)
    expect(samePath('/home/me/repo', '/home/me/Repo', 'linux')).toBe(false)
    expect(pathKey('/', 'linux')).toBe('/')
  })
})

describe('isAbsolutePath and folderName', () => {
  it('follows each platform', () => {
    expect(isAbsolutePath('/x', 'linux')).toBe(true)
    expect(isAbsolutePath('C:\\x', 'win32')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share', 'win32')).toBe(true)
    // Rooted on whatever drive the process happens to run on: not a project path.
    expect(isAbsolutePath('\\x', 'win32')).toBe(false)
    expect(isAbsolutePath('/x', 'win32')).toBe(false)
    expect(isAbsolutePath('C:x', 'win32')).toBe(false)
    expect(isAbsolutePath('x', 'darwin')).toBe(false)
    expect(folderName('/Users/me/kettu', 'darwin')).toBe('kettu')
    expect(folderName('C:\\Users\\me\\kettu', 'win32')).toBe('kettu')
    expect(folderName('C:\\', 'win32')).toBe('C:')
    expect(folderName('/', 'linux')).toBe('/')
  })
})
