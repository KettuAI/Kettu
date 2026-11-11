import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { processControl } from '../process-tree'
import { runSetup, shellCommand } from './setup'

const PLATFORM = process.platform as Platform

describe('shellCommand', () => {
  it('uses the login shell on POSIX and cmd.exe on Windows', () => {
    expect(shellCommand('make', 'linux', { SHELL: '/bin/bash' })).toEqual({
      file: '/bin/bash',
      args: ['-l', '-c', 'make'],
      verbatim: false,
    })
    expect(shellCommand('make', 'darwin', { SHELL: '/bin/tcsh' }).args).toEqual(['-c', 'make'])
    expect(shellCommand('make', 'darwin', {}).file).toBe('/bin/zsh')
    expect(shellCommand('a && b', 'win32', { ComSpec: 'C:\\cmd.exe' })).toEqual({
      file: 'C:\\cmd.exe',
      args: ['/d', '/s', '/c', '"a && b"'],
      verbatim: true,
    })
  })
})

describe.skipIf(PLATFORM === 'win32')('runSetup', () => {
  const deps = { platform: PLATFORM, control: processControl(PLATFORM), now: Date.now }
  const env = { PATH: process.env.PATH, SHELL: '/bin/sh' }
  let dir: string

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-setup-')))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const options = { projectPath: '/project', env, timeoutMs: 10_000 }

  it('runs in the worktree with its paths and keeps the output', async () => {
    const chunks: string[] = []
    const run = await runSetup(
      'pwd; echo "$KETTU_PROJECT_PATH $KETTU_WORKTREE_PATH"; echo oops >&2; exit 3',
      { ...options, cwd: dir, onOutput: (chunk) => chunks.push(chunk) },
      deps,
    )
    expect(run).toEqual({ exitCode: 3, timedOut: false, tail: chunks.join('') })
    expect(run.tail).toContain(`${dir}\n/project ${dir}\n`)
    expect(run.tail).toContain('oops')
  })

  it('keeps only the last 64 KB', async () => {
    const run = await runSetup(
      'i=0; while [ $i -lt 2000 ]; do printf "%099d\\n" $i; i=$((i+1)); done',
      { ...options, cwd: dir },
      deps,
    )
    expect(run.exitCode).toBe(0)
    expect(run.tail.length).toBe(64 * 1024)
    expect(run.tail.endsWith(`${'0'.repeat(95)}1999\n`)).toBe(true)
  })

  it('stops the whole tree when it runs out of time', async () => {
    const run = await runSetup(
      'sleep 30 & echo "child $!"; wait',
      { ...options, cwd: dir, timeoutMs: 500 },
      deps,
    )
    expect(run).toMatchObject({ exitCode: null, timedOut: true })
    const pid = Number(/child (\d+)/.exec(run.tail)?.[1])
    expect(pid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const run = await runSetup(
      'sleep 30',
      { ...options, cwd: dir, signal: controller.signal },
      deps,
    )
    expect(run).toMatchObject({ exitCode: null, timedOut: false })
  })
})
