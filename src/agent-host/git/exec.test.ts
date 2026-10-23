import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExec, describeFailure, type ExecRunner } from './exec'

const node = process.execPath
let runner: ExecRunner | null = null
const dirs: string[] = []

function make(env: NodeJS.ProcessEnv = process.env): ExecRunner {
  runner = createExec(() => env)
  return runner
}

afterEach(async () => {
  runner?.killAll()
  runner = null
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('createExec', () => {
  it('returns output and a zero exit code', async () => {
    const result = await make().exec(node, ['-e', 'process.stdout.write("hi")'], {
      timeoutMs: 5000,
    })
    expect(result).toMatchObject({ code: 0, stdout: 'hi', failure: null })
  })

  it('reports a non-zero exit code without a failure', async () => {
    const result = await make().exec(node, ['-e', 'process.stderr.write("bad"); process.exit(3)'], {
      timeoutMs: 5000,
    })
    expect(result).toMatchObject({ code: 3, stderr: 'bad', failure: null })
  })

  it('kills a child that outlives its timeout', async () => {
    const started = Date.now()
    const result = await make().exec(node, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 200,
    })
    expect(result.failure).toBe('timeout')
    expect(result.code).toBeNull()
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('ends what the command started when it times out, as gh does a git push', async () => {
    // The child starts a grandchild that writes its pid, then both wait forever.
    const script = [
      "const { spawn } = require('node:child_process')",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'process.stdout.write(String(g.pid))',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const result = await make().exec(node, ['-e', script], { timeoutMs: 1500 })
    expect(result.failure).toBe('timeout')
    const grandchild = Number(result.stdout)
    expect(grandchild).toBeGreaterThan(0)
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100))
    const survived = alive()
    if (survived) process.kill(grandchild, 'SIGKILL')
    expect(survived).toBe(false)
  })

  it('reports a missing command', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ob-exec-'))
    dirs.push(empty)
    const result = await make({ PATH: empty, Path: empty }).exec('ob-no-such-command', [], {
      timeoutMs: 5000,
    })
    expect(result.failure).toBe('not-found')
  })

  it('tells a missing working directory from a missing command', async () => {
    const result = await make().exec(node, ['-v'], {
      cwd: join(tmpdir(), 'ob-does-not-exist-9f3a'),
      timeoutMs: 5000,
    })
    expect(result.failure).toBe('cwd-missing')
  })

  it('applies the base environment and lets options override the caller environment', async () => {
    const result = await make({ ...process.env, GIT_OPTIONAL_LOCKS: '1', OB_A: 'a' }).exec(
      node,
      [
        '-e',
        'process.stdout.write([process.env.GIT_OPTIONAL_LOCKS, process.env.LC_ALL, process.env.OB_A, process.env.OB_B].join(","))',
      ],
      { timeoutMs: 5000, env: { OB_B: 'b' } },
    )
    expect(result.stdout).toBe('0,C,a,b')
  })

  it('closes stdin so a child that reads input does not hang', async () => {
    const result = await make().exec(
      node,
      ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"))'],
      { timeoutMs: 5000 },
    )
    expect(result).toMatchObject({ code: 0, stdout: 'eof' })
  })

  it('reports output beyond the buffer limit', async () => {
    const result = await make().exec(node, ['-e', 'process.stdout.write("x".repeat(5000))'], {
      timeoutMs: 5000,
      maxBuffer: 100,
    })
    expect(result.failure).toBe('max-buffer')
  })

  it('kills running children and refuses new ones after killAll', async () => {
    const exec = make()
    const running = exec.exec(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    exec.killAll()
    expect((await running).failure).toBe('killed')
    expect((await exec.exec(node, ['-v'], { timeoutMs: 5000 })).failure).toBe('killed')
  })
})

describe('the Windows command lookup', () => {
  it('reports a command it cannot find without starting anything', async () => {
    const windows = createExec(() => ({ PATH: 'C:\\Tools' }), {
      platform: 'win32',
      find: async () => null,
    })
    const result = await windows.exec('git', ['--version'], { cwd: tmpdir(), timeoutMs: 5000 })
    expect(result.failure).toBe('not-found')
  })

  it('runs the path it found, looks a command up once, and retries a miss', async () => {
    const names: string[] = []
    const windows = createExec(() => ({ PATH: 'C:\\Tools' }), {
      platform: 'win32',
      find: async (name) => {
        names.push(name)
        return names.length === 1 ? null : node
      },
    })
    runner = windows
    const run = () =>
      windows.exec('git', ['-e', 'process.stdout.write("found")'], { timeoutMs: 5000 })
    expect((await run()).failure).toBe('not-found')
    // The stand-in "git" is node, which takes the arguments of node.
    expect(await run()).toMatchObject({ code: 0, stdout: 'found' })
    await run()
    expect(names).toEqual(['git', 'git'])
  })
})

describe('describeFailure', () => {
  it('prefers stderr for an exit code and names the failures', () => {
    const base = { code: null, stdout: '', stderr: '', failure: null, message: '' } as const
    expect(describeFailure({ ...base, code: 128, stderr: 'fatal: nope\n' })).toBe('fatal: nope')
    expect(describeFailure({ ...base, code: 2 })).toBe('exited with code 2')
    expect(describeFailure({ ...base, failure: 'timeout' })).toBe('timed out')
    expect(describeFailure({ ...base, failure: 'not-found' })).toBe('command not found')
  })
})
