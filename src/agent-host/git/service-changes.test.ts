import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitStatus } from '@shared/git'
import type { GitServiceApi } from './api'
import { createGitService } from './service'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore' })
}

describe('git.changed for edits that keep the counts', () => {
  let dir: string
  let service: GitServiceApi
  let emitted: GitStatus[]
  let clock = 1_700_000_000

  // A distinct modification time, so a test does not depend on the file system's resolution.
  async function write(name: string, text: string): Promise<void> {
    const file = path.join(dir, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
    clock += 10
    await utimes(file, clock, clock)
  }

  async function refresh(): Promise<number> {
    const before = emitted.length
    await service.status(dir)
    return emitted.length - before
  }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-git-changed-')))
    git(dir, 'init', '-q', '-b', 'main')
    await write('a.txt', 'one\ntwo\nthree\n')
    await write('b.txt', 'b\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
    service = createGitService({ env: ENV, log: () => {} })
    emitted = []
    service.onChanged((status) => emitted.push(status))
    await service.status(dir)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stays quiet while nothing changes', async () => {
    expect(await refresh()).toBe(0)
  })

  it('sends when a tracked file is first modified', async () => {
    await write('a.txt', 'one\nTWO\nthree\n')
    expect(await refresh()).toBe(1)
    expect(await refresh()).toBe(0)
  })

  it('sends when a line of an already modified file is rewritten', async () => {
    const counts = emitted.at(-1)!.changes
    await write('a.txt', 'one\nTWO!\nthree\n')
    expect(await refresh()).toBe(1)
    expect(emitted.at(-1)!.changes).toEqual(counts)
    expect(await refresh()).toBe(0)
  })

  it('sends when one untracked file is swapped for another', async () => {
    await write('u1.txt', 'x\n')
    expect(await refresh()).toBe(1)
    await unlink(path.join(dir, 'u1.txt'))
    await write('u2.txt', 'x\n')
    expect(await refresh()).toBe(1)
    expect(await refresh()).toBe(0)
  })

  it('sends when a file inside an untracked folder is rewritten', async () => {
    await write('fresh/x.txt', 'one\n')
    expect(await refresh()).toBe(1)
    await write('fresh/x.txt', 'two\n')
    expect(await refresh()).toBe(1)
    expect(await refresh()).toBe(0)
  })

  it('sends when the staged content of a file changes under the same status', async () => {
    await write('b.txt', 'b1\n')
    git(dir, 'add', 'b.txt')
    expect(await refresh()).toBe(1)
    await write('b.txt', 'b2\n')
    git(dir, 'add', 'b.txt')
    expect(await refresh()).toBe(1)
  })
})
