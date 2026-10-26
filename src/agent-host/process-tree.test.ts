import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  descendantsOf,
  parseCim,
  parsePs,
  processControl,
  runTool,
  signalTargets,
  stopTrees,
  toolLimits,
  treeOf,
  type ProcessControl,
  type ProcessRow,
} from './process-tree'

const T = 1_800_000_000_000
const row = (pid: number, ppid: number, pgid: number, startedAt = T + pid): ProcessRow => ({
  pid,
  ppid,
  pgid,
  startedAt,
})
const pids = (rows: ProcessRow[]) => rows.map((r) => r.pid).sort((a, b) => a - b)

describe('parsePs', () => {
  it('reads pid, parent, group and the start time from the elapsed time', () => {
    const text = [
      '    1     0     1 13-00:26:03',
      '  556     1   556    01:02:03',
      ' 9000   556  9000       00:07',
      'garbage',
    ].join('\n')
    expect(parsePs(text, T)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, startedAt: T - (13 * 86_400 + 26 * 60 + 3) * 1000 },
      { pid: 556, ppid: 1, pgid: 556, startedAt: T - 3723 * 1000 },
      { pid: 9000, ppid: 556, pgid: 9000, startedAt: T - 7000 },
    ])
  })
})

describe('parseCim', () => {
  it('reads pid, parent and the creation file time; a process has no group but itself', () => {
    // 2026-10-22T00:00:00Z as a Windows file time.
    const fileTime = (Date.UTC(2026, 9, 22) + 11_644_473_600_000) * 10_000
    expect(parseCim(`4 0 0\r\n1234 4 ${fileTime}\r\n\r\n`)).toEqual([
      { pid: 4, ppid: 0, pgid: 4, startedAt: 0 },
      { pid: 1234, ppid: 4, pgid: 1234, startedAt: Date.UTC(2026, 9, 22) },
    ])
  })
})

describe('treeOf', () => {
  const root = { pid: 100, startedAt: T + 100 }

  it('takes the group and every descendant, in other groups too, while the root runs', () => {
    const rows = [
      row(1, 0, 1),
      row(100, 50, 100),
      row(101, 100, 100), // a CLI in the agent's group
      row(102, 101, 102), // a command it runs in a group of its own
      row(103, 102, 102),
      row(200, 1, 200), // unrelated
    ]
    expect(pids(treeOf(rows, root, 'darwin'))).toEqual([100, 101, 102, 103])
  })

  it('finds what is left through the group after the root exits', () => {
    const rows = [row(101, 1, 100), row(102, 101, 102), row(300, 1, 300)]
    expect(pids(treeOf(rows, { ...root, seenAt: T + 5_000 }, 'linux'))).toEqual([101, 102])
  })

  it('after the root exits, takes only what started while it was seen running', () => {
    // 150 joined a group 100 that a later process with pid 100 led, after the root was gone.
    const rows = [row(101, 1, 100), row(150, 1, 100, T + 60_000)]
    expect(pids(treeOf(rows, { ...root, seenAt: T + 5_000 }, 'linux'))).toEqual([101])
    expect(treeOf(rows, root, 'linux')).toEqual([])
  })

  it('leaves the group alone once another process holds the root pid', () => {
    const rows = [row(100, 1, 100, T + 99_000), row(101, 100, 100, T + 99_500)]
    expect(treeOf(rows, root, 'linux')).toEqual([])
  })

  it('skips a child that started before its parent, so a reused pid is not followed', () => {
    const rows = [row(100, 50, 100), row(150, 100, 150, T - 60_000)]
    expect(pids(treeOf(rows, root, 'darwin'))).toEqual([100])
  })

  it('follows the parent links a dead root leaves on Windows', () => {
    const rows = [row(101, 100, 101), row(102, 101, 102), row(103, 100, 103, T - 60_000)]
    expect(pids(treeOf(rows, { ...root, seenAt: T + 5_000 }, 'win32'))).toEqual([101, 102])
  })

  it('does not take the children of a later process with the root pid on Windows', () => {
    const rows = [
      row(100, 4, 100, T + 50_000),
      row(101, 100, 101, T + 1_000), // left by the root
      row(102, 100, 102, T + 60_000), // the new process's own child
    ]
    expect(pids(treeOf(rows, { ...root, seenAt: T + 70_000 }, 'win32'))).toEqual([101])
  })
})

describe('descendantsOf', () => {
  it('follows parent links, past a reused pid', () => {
    const rows = [
      row(10, 1, 1, T),
      row(11, 10, 1, T + 10_000),
      row(12, 11, 1, T + 20_000),
      row(13, 1, 1, T + 30_000),
      // Started well before 11 did: a reused pid that only looks like its child.
      row(14, 11, 1, T + 1_000),
    ]
    expect(descendantsOf(rows, 10).map((r) => r.pid)).toEqual([11, 12])
    expect(descendantsOf(rows, 99)).toEqual([])
  })
})

describe('signalTargets', () => {
  it('addresses each group the tree leads, and a stray member alone', () => {
    const tree = [row(101, 1, 100), row(102, 101, 102), row(103, 102, 102), row(104, 101, 999)]
    const leaders = new Set([100, ...tree.map((r) => r.pid)])
    expect(signalTargets(tree, leaders).sort((a, b) => a - b)).toEqual([-102, -100, 104])
  })
})

function fakeControl(platform: ProcessControl['platform'], rows: ProcessRow[]) {
  const calls: string[] = []
  const gone = new Set<number>()
  const control: ProcessControl = {
    platform,
    list: async () => rows,
    kill(target, signal) {
      calls.push(`kill ${target} ${signal}`)
      if (signal === 0 && gone.has(target)) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      }
    },
    async taskkill(list) {
      calls.push(`taskkill ${list.join(' ')}`)
    },
    async delay(ms) {
      calls.push(`wait ${ms}`)
    },
  }
  return { control, calls, gone }
}

describe('stopTrees', () => {
  const rows = [row(100, 1, 100), row(101, 100, 100), row(102, 101, 102)]
  const root = { pid: 100, startedAt: T + 100 }

  it('sends SIGTERM to each group, then SIGKILL to what outlives the grace', async () => {
    const { control, calls, gone } = fakeControl('darwin', rows)
    gone.add(100).add(101)
    await stopTrees(control, [root], 2000)
    expect(calls).toEqual([
      'kill -100 SIGTERM',
      'kill -102 SIGTERM',
      'wait 2000',
      'kill 100 0',
      'kill 101 0',
      'kill 102 0',
      'kill -102 SIGKILL',
    ])
  })

  it('treats a group already gone as stopped', async () => {
    const { control } = fakeControl('linux', rows)
    control.kill = () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }
    expect((await stopTrees(control, [root], 2000)).failures).toEqual([])
  })

  it('waits for nothing when the tree is gone', async () => {
    const { control, calls } = fakeControl('linux', [])
    await stopTrees(control, [root], 2000)
    expect(calls).toEqual([])
  })

  it('ends the whole tree with taskkill on Windows', async () => {
    const { control, calls } = fakeControl('win32', [row(100, 4, 100), row(101, 100, 101)])
    await stopTrees(control, [root], 2000)
    expect(calls).toEqual(['taskkill 100 101'])
  })
})

describe('toolLimits', () => {
  it('gives a Windows listing the time a slow runner needs, and a quit its seconds', () => {
    // A loaded windows-11-arm runner took 22 to 34 s a listing, and 77 s for its first.
    const windows = toolLimits('win32')
    expect(windows.listMs).toBeGreaterThanOrEqual(90_000)
    expect(windows.quitListMs).toBe(1_500)
    expect(toolLimits('linux').listMs).toBe(10_000)
  })
})

describe('processControl', () => {
  const timedOut = Object.assign(new Error('taskkill did not finish within 7 ms'), {
    code: 'ETIMEDOUT',
  })

  it('gives each tool its limit, a shorter one while quitting, and fails a taskkill that timed out', async () => {
    const calls: string[] = []
    let answer = async (): Promise<string> => '100 4 0\r\n'
    const options = {
      limits: { listMs: 9, taskkillMs: 11, quitListMs: 5, quitTaskkillMs: 7 },
      run: (file: string, _args: string[], timeoutMs: number) => {
        calls.push(`${path.win32.basename(file)} ${timeoutMs}`)
        return answer()
      },
    }
    const control = processControl('win32', options)
    expect(await control.list()).toHaveLength(1)
    await control.list({ quitting: true })
    // A pid that is already gone fails taskkill with an exit code, which is the outcome wanted.
    answer = () => Promise.reject(Object.assign(new Error('Command failed'), { code: 128 }))
    await expect(control.taskkill([100])).resolves.toBeUndefined()
    answer = () => Promise.reject(timedOut)
    await expect(control.taskkill([100], { quitting: true })).rejects.toBe(timedOut)
    await processControl('linux', options)
      .list({ quitting: true })
      .catch(() => {})
    expect(calls).toEqual([
      'powershell.exe 9',
      'powershell.exe 5',
      'taskkill 11',
      'taskkill 7',
      'ps 5',
    ])
  })
})

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runTool', () => {
  it('kills a tool that runs past its limit, and what came with it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-tool-'))
    const pidFile = path.join(dir, 'pid')
    // On Windows the tool is PowerShell, which the listing runs.
    const windows = process.platform === 'win32'
    const file = windows
      ? path.win32.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        )
      : process.execPath
    const args = windows
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Set-Content -LiteralPath '${pidFile}' -Value $PID; Start-Sleep -Seconds 60`,
        ]
      : [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ]
    // PowerShell's cold start on a loaded runner can pass 4 s; the limit must outlast it.
    const limitMs = windows ? 15_000 : 500
    const readPid = async () => Number((await readFile(pidFile, 'utf8').catch(() => '')).trim())
    try {
      const started = Date.now()
      const failed = runTool(file, args, limitMs, {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      }).then(
        () => null,
        (error: unknown) => error,
      )
      expect(await until(async () => (await readPid()) > 0, limitMs)).toBe(true)
      const pid = await readPid()
      // On Windows a conhost, which the app's tools each get for want of a console; under a
      // runner's console PowerShell shares it, and this list can be empty.
      const helpers = (await processControl(process.platform).list()).filter(
        (row) => row.ppid === pid,
      )
      expect(await failed).toMatchObject({
        code: 'ETIMEDOUT',
        message: `${path.win32.basename(file)} did not finish within ${limitMs} ms`,
      })
      expect(Date.now() - started).toBeLessThan(limitMs + 2_000)
      expect(await until(() => !alive(pid), 2_000)).toBe(true)
      for (const helper of helpers) expect(await until(() => !alive(helper.pid), 2_000)).toBe(true)
    } finally {
      const pid = await readPid()
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
      await rm(dir, { recursive: true, force: true })
    }
    // Windows runs the whole limit, so the test needs more than the suite's default timeout.
  }, 45_000)
})

describe('a real process tree', () => {
  it.skipIf(process.platform === 'win32')(
    'stops a detached tree and a command in a group of its own',
    async () => {
      // The shell leads a group; its child starts a command in a group of its own.
      const script =
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); process.stdout.write(String(c.pid)); setInterval(() => {}, 1000)"
      const child = spawn(process.execPath, ['-e', script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      const startedAt = Date.now()
      const grandchild = await new Promise<number>((resolve) =>
        child.stdout.once('data', (data: Buffer) => resolve(Number(String(data)))),
      )
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      try {
        expect(alive(grandchild)).toBe(true)
        const { failures } = await stopTrees(
          processControl(process.platform),
          [{ pid: child.pid!, startedAt }],
          1000,
        )
        expect(failures).toEqual([])
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(alive(child.pid!)).toBe(false)
        expect(alive(grandchild)).toBe(false)
      } finally {
        for (const pid of [child.pid!, grandchild]) if (alive(pid)) process.kill(pid, 'SIGKILL')
      }
    },
  )
})
