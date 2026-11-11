import { execFileSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createExec } from '../git/exec'
import { checkIncludeEntry, copyLocalFiles, parseWorktreeInclude } from './copy'

describe('parseWorktreeInclude', () => {
  it('reads one path per line without blanks and comments', () => {
    expect(parseWorktreeInclude('.env\r\n\n# secrets\n  config/local.json  \n')).toEqual([
      '.env',
      'config/local.json',
    ])
  })
})

describe('checkIncludeEntry', () => {
  it('normalizes a relative path', () => {
    expect(checkIncludeEntry('./config//local.json/', 'linux')).toEqual({
      path: 'config/local.json',
    })
    expect(checkIncludeEntry('config\\local.json', 'win32')).toEqual({ path: 'config/local.json' })
  })

  it('rejects paths that could leave the project', () => {
    const rejected: [string, 'linux' | 'win32'][] = [
      ['/etc/passwd', 'linux'],
      ['C:\\Windows\\x', 'win32'],
      ['\\x', 'win32'],
      ['C:x', 'win32'],
      ['a.txt:stream', 'win32'],
      ['../x', 'linux'],
      ['a/../../x', 'linux'],
      ['a\\..\\..\\x', 'win32'],
      ['a\0b', 'linux'],
      ['*.env', 'linux'],
      ['config/?', 'linux'],
      ['[ab]', 'linux'],
      ['.', 'linux'],
      ['.git/config', 'linux'],
      ['.GIT', 'win32'],
    ]
    for (const [entry, platform] of rejected) {
      expect(checkIncludeEntry(entry, platform), entry).toHaveProperty('reason')
    }
  })
})

describe('copyLocalFiles', () => {
  const exec = createExec(() => process.env).exec
  let dir: string
  let project: string
  let worktree: string
  let outside: string

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      stdio: 'ignore',
    })
  }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-copy-')))
    project = path.join(dir, 'project')
    worktree = path.join(dir, 'worktree')
    outside = path.join(dir, 'outside')
    await mkdir(project)
    await mkdir(outside)
    await writeFile(path.join(outside, 'secret'), 'secret')
    git(project, 'init', '-q')
    await writeFile(path.join(project, 'tracked.txt'), 'tracked')
    await mkdir(path.join(project, 'config'))
    await writeFile(path.join(project, 'config', 'shared.json'), '{}')
    await mkdir(path.join(project, 'escape'))
    await symlink(outside, path.join(project, 'escape', 'out'))
    git(project, 'add', '.')
    git(project, 'commit', '-q', '-m', 'init')
    await writeFile(path.join(project, '.env'), 'KEY=1')
    await writeFile(path.join(project, 'config', 'local.json'), '{"local":true}')
    await mkdir(path.join(project, 'config', 'deep'))
    await writeFile(path.join(project, 'config', 'deep', 'a.txt'), 'a')
    await symlink('local.json', path.join(project, 'config', 'link.json'))
    await symlink(path.join(outside, 'secret'), path.join(project, 'config', 'secret'))
    await symlink(outside, path.join(project, 'outside-dir'))
    await writeFile(path.join(project, 'existing.txt'), 'project')
    await writeFile(path.join(project, 'through.txt'), 'x')
    await writeFile(
      path.join(project, '.worktreeinclude'),
      ['# local files', '.env', 'config', '', 'missing.txt'].join('\n'),
    )
    git(project, 'worktree', 'add', '-q', worktree)
    await writeFile(path.join(worktree, 'existing.txt'), 'worktree')
    // A link in the worktree that would take a write outside it.
    await symlink(outside, path.join(worktree, 'redirect'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('copies untracked local files and reports the rest', async () => {
    const extra = [
      'tracked.txt',
      'existing.txt',
      '../outside/secret',
      '/etc/hosts',
      '*.txt',
      'outside-dir',
      'outside-dir/secret',
      'escape/out/secret',
      '.git/config',
    ]
    const result = await copyLocalFiles(exec, process.platform, project, worktree, extra)
    expect(result.copied.sort()).toEqual([
      '.env',
      'config/deep/a.txt',
      'config/link.json',
      'config/local.json',
    ])
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))
    expect(reasons).toEqual({
      'config/shared.json': 'tracked by git',
      'config/secret': 'symbolic link to outside the project',
      'missing.txt': 'does not exist',
      'tracked.txt': 'tracked by git',
      'existing.txt': 'already exists in the worktree',
      '../outside/secret': '".." is not allowed',
      '/etc/hosts': 'absolute paths are not allowed',
      '*.txt': 'globs are not supported',
      'outside-dir': 'resolves outside the project',
      'outside-dir/secret': 'resolves outside the project',
      'escape/out/secret': 'resolves outside the project',
      '.git/config': 'names git metadata',
    })
    expect(await readFile(path.join(worktree, 'config', 'local.json'), 'utf8')).toBe(
      '{"local":true}',
    )
    expect(await readlink(path.join(worktree, 'config', 'link.json'))).toBe('local.json')
    expect(await readFile(path.join(worktree, 'existing.txt'), 'utf8')).toBe('worktree')
  })

  it('never writes through a link in the worktree', async () => {
    await mkdir(path.join(project, 'redirect'), { recursive: true })
    await writeFile(path.join(project, 'redirect', 'planted'), 'x')
    const result = await copyLocalFiles(exec, process.platform, project, worktree, ['redirect'])
    expect(result.copied).toEqual([])
    expect(result.skipped).toContainEqual({
      path: 'redirect',
      reason: 'redirect is not a folder inside the worktree',
    })
    await expect(lstat(path.join(outside, 'planted'))).rejects.toThrow()
  })
})
