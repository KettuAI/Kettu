import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { branchFromTemplate, checkWorktreeBranch, folderNameFor, insideRoot, slugOf } from './names'

describe('slugOf', () => {
  it('keeps the leading ASCII words', () => {
    expect(slugOf('Fix the login button, please!')).toBe('fix-the-login-button-please')
    expect(slugOf("  Don't   break  café ")).toBe('dont-break-caf')
  })

  it('cuts at a word boundary within 40 characters', () => {
    const slug = slugOf('implement the extremely complicated worktree removal dialog now')
    expect(slug).toBe('implement-the-extremely-complicated')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slugOf('a'.repeat(60))).toBe('a'.repeat(40))
  })

  it('is empty when nothing is usable', () => {
    expect(slugOf('修复登录按钮')).toBe('')
    expect(slugOf('  !!! ')).toBe('')
  })
})

describe('branchFromTemplate', () => {
  it('fills the placeholders', () => {
    expect(branchFromTemplate('kettu/{slug}', { slug: 'x' })).toBe('kettu/x')
    expect(branchFromTemplate('{type}/{issue}-{slug}', { slug: 'x', issue: '12' })).toBe(
      'feat/12-x',
    )
    expect(branchFromTemplate('{type}/{slug}', { slug: 'x', type: 'fix' })).toBe('fix/x')
    expect(branchFromTemplate('', { slug: 'x' })).toBe('kettu/x')
  })

  it('drops a missing issue with one dash beside it', () => {
    expect(branchFromTemplate('{type}/{issue}-{slug}', { slug: 'x' })).toBe('feat/x')
    expect(branchFromTemplate('{type}/{slug}-{issue}', { slug: 'x' })).toBe('feat/x')
    expect(branchFromTemplate('a-{issue}-b', { slug: 'x' })).toBe('a-b')
    expect(branchFromTemplate('{issue}/{slug}', { slug: 'x' })).toBe('/x')
  })

  it('rejects unknown placeholders', () => {
    for (const template of ['{user}/{slug}', '{slug}{}', '{ slug }']) {
      expect(() => branchFromTemplate(template, { slug: 'x' })).toThrow(
        expect.objectContaining({ code: 'invalid_params' }),
      )
    }
  })
})

describe('checkWorktreeBranch', () => {
  it('accepts ordinary names', () => {
    for (const name of ['kettu/fix-login', 'feat/12-x', 'a', 'v1.2', 'user@host', 'a{b}']) {
      expect(checkWorktreeBranch(name)).toBe(name)
    }
  })

  it('rejects what git or the command line would misread', () => {
    for (const name of [
      '',
      '-x',
      '--force',
      'a..b',
      'a@{1}',
      '@',
      'HEAD',
      'a b',
      'a\tb',
      'a\nb',
      'a\x00b',
      'a\x7fb',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[b',
      'a\\b',
      '/a',
      'a/',
      'a//b',
      '.a',
      'a/.b',
      'a.',
      'a.lock',
      'a.lock/b',
      'x'.repeat(101),
    ]) {
      expect(() => checkWorktreeBranch(name), JSON.stringify(name)).toThrow(
        expect.objectContaining({ code: 'invalid_params' }),
      )
    }
    expect(checkWorktreeBranch('x'.repeat(100))).toHaveLength(100)
  })
})

describe('folderNameFor', () => {
  it('makes one safe component with a hash', () => {
    expect(folderNameFor('kettu/fix-login', 'darwin')).toMatch(/^kettu-fix-login-[0-9a-f]{8}$/)
    expect(folderNameFor('a/b', 'linux')).not.toBe(folderNameFor('a-b', 'linux'))
    expect(folderNameFor('功能', 'linux')).toMatch(/^[0-9a-f]{8}$/)
    expect(folderNameFor('con.x', 'win32')).toMatch(/^con-x-[0-9a-f]{8}$/)
    const long = folderNameFor(`${'a'.repeat(23)}/b`, 'darwin')
    expect(long).toMatch(/^a{23}-[0-9a-f]{8}$/)
  })

  it('always resolves inside the root', () => {
    const names = ['..', '../..', '.', '-', '...lock', 'a/../../b', '/etc/passwd', '\\..\\x', '']
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const p = platform === 'win32' ? path.win32 : path.posix
      const root =
        platform === 'win32' ? 'C:\\Users\\me\\proj-worktrees' : '/home/me/proj-worktrees'
      for (const name of names) {
        const folder = folderNameFor(name, platform)
        expect(folder).not.toBe('')
        expect(folder).not.toMatch(/[\\/]/)
        expect(insideRoot(root, p.join(root, folder), platform)).toBe(true)
      }
    }
  })
})

describe('insideRoot', () => {
  it('compares by path components', () => {
    expect(insideRoot('/a/b', '/a/b/c', 'linux')).toBe(true)
    expect(insideRoot('/a/b', '/a/b', 'linux')).toBe(false)
    expect(insideRoot('/a/b', '/a/bc', 'linux')).toBe(false)
    expect(insideRoot('/a/b', '/a/b/../c', 'linux')).toBe(false)
    expect(insideRoot('/', '/x', 'linux')).toBe(true)
  })

  it('is case-insensitive on Windows only', () => {
    expect(insideRoot('C:\\A\\B', 'c:\\a\\b\\c', 'win32')).toBe(true)
    expect(insideRoot('C:\\A\\B', 'C:/A/B/c', 'win32')).toBe(true)
    expect(insideRoot('C:\\A\\B', 'C:\\A\\BC', 'win32')).toBe(false)
    expect(insideRoot('/A/B', '/a/b/c', 'darwin')).toBe(false)
  })
})
