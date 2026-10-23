import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTrees } from './agent-trees'
import type { ProcessControl, ProcessRow } from './process-tree'
import { agentProcessesFile } from './storage'

const T = 1_700_000_000_000
const row = (pid: number, ppid: number, pgid: number, startedAt = T + pid): ProcessRow => ({
  pid,
  ppid,
  pgid,
  startedAt,
})

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function setup(
  platform: ProcessControl['platform'],
  rows: ProcessRow[][],
  { closeWaitMs }: { closeWaitMs?: number } = {},
) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-trees-'))
  const calls: string[] = []
  const logs: string[] = []
  let listed = 0
  const listings: boolean[] = []
  let release: () => void = () => {}
  let held: Promise<void> | null = null
  const control: ProcessControl = {
    platform,
    list: async (options) => {
      listed++
      listings.push(options?.quitting ?? false)
      if (held) await held
      const next = rows.shift()
      if (!next) throw new Error('ps failed')
      return next
    },
    kill: (target, signal) => {
      calls.push(`kill ${target} ${signal}`)
    },
    taskkill: async (pids) => {
      calls.push(`taskkill ${pids.join(' ')}`)
    },
    delay: () => new Promise((resolve) => (release = () => resolve())),
  }
  const file = agentProcessesFile(dir, (_level, message) => logs.push(message))
  const trees = new AgentTrees({
    file,
    control,
    graceMs: 3000,
    noteMs: 5,
    ...(closeWaitMs !== undefined ? { closeWaitMs } : {}),
    log: (_l, m) => logs.push(m),
  })
  const stored = async () => {
    await trees.flush()
    const { processes } = JSON.parse(await readFile(file.file, 'utf8')) as {
      processes: { pid: number; startedAt: number }[]
    }
    // When each was last seen running moves with the clock.
    return processes.map(({ pid, startedAt }) => ({ pid, startedAt }))
  }
  // Holds the listings until the returned function is called, as a slow PowerShell would.
  const holdListing = (): (() => void) => {
    let open: () => void = () => {}
    held = new Promise((resolve) => (open = resolve))
    return () => {
      held = null
      open()
    }
  }
  return {
    trees,
    control,
    calls,
    logs,
    stored,
    file,
    endGrace: () => release(),
    listed: () => listed,
    listings,
    holdListing,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
// For tests that hold a stop on purpose, so a slow runner never reaches the deadline.
const NO_DEADLINE = 60_000

describe('AgentTrees', () => {
  const root = { pid: 100, startedAt: T + 100 }

  it('notes the tree before a stop and stops what is left once the agent exits', async () => {
    const running = [row(100, 1, 100), row(101, 100, 100), row(102, 100, 102)]
    // After the exit, the command its root started directly has lost its parent.
    const after = [row(101, 1, 100), row(102, 1, 102)]
    const { trees, calls, stored, endGrace } = await setup('darwin', [running, after])
    await trees.load()
    trees.launched(root)
    await trees.note(root)
    expect(await stored()).toHaveLength(3)

    await trees.reap(root, 'Fake agent')
    expect(calls).toEqual(['kill -100 SIGTERM', 'kill -102 SIGTERM'])
    // Until the grace ends, the next host would stop them if this one went away.
    expect(await stored()).toEqual(expect.arrayContaining([root, { pid: 101, startedAt: T + 101 }]))
    endGrace()
    await settle()
    expect(calls.slice(2)).toEqual([
      'kill 101 0',
      'kill 102 0',
      'kill -100 SIGKILL',
      'kill -102 SIGKILL',
    ])
    expect(await stored()).toEqual([])
  })

  it.each(['linux', 'win32'] as const)(
    'lists the tree a while after the agent talks, once for a burst, on %s',
    async (platform) => {
      const running = [row(100, 1, 100), row(102, 100, 102)]
      const { trees, stored, listed } = await setup(platform, [running])
      await trees.load()
      trees.launched(root)
      for (let i = 0; i < 50; i++) trees.active(root)
      expect(listed()).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(listed()).toBe(1)
      expect(await stored()).toEqual([root, { pid: 102, startedAt: T + 102 }])
    },
  )

  it.each([
    ['linux', true],
    ['win32', false],
  ] as const)(
    "gives a quit's listings the short limit, but not the one after the exit on %s",
    async (platform, reapQuitting) => {
      const tree = [row(100, 1, 100)]
      const { trees, file, listings } = await setup(platform, [[], tree, tree, [], [], []])
      await mkdir(path.dirname(file.file), { recursive: true })
      const leftover = { pid: 200, startedAt: T + 200 }
      await writeFile(file.file, JSON.stringify({ version: 1, processes: [leftover] }))
      await trees.load()
      await trees.stopLeftovers()
      trees.launched(root)
      trees.active(root)
      await new Promise((resolve) => setTimeout(resolve, 30))
      await trees.note(root)
      await trees.reap(root, 'Fake agent')
      // Started again, then stopped by a quit.
      const again = { pid: 300, startedAt: T + 300 }
      trees.launched(again)
      await trees.note(again, { quitting: true })
      await trees.reap(again, 'Fake agent', { quitting: true })
      await trees.close()
      expect(listings).toEqual([false, false, false, false, true, reapQuitting])
    },
  )

  it('forgets an agent that left nothing behind', async () => {
    const { trees, calls, stored } = await setup('linux', [[]])
    await trees.load()
    trees.launched(root)
    await trees.reap(root, 'Fake agent')
    expect(calls).toEqual([])
    expect(await stored()).toEqual([])
  })

  it('keeps what it could not list, for the next host', async () => {
    const { trees, logs, stored } = await setup('linux', [])
    await trees.load()
    trees.launched(root)
    await trees.reap(root, 'Fake agent')
    expect(logs.some((line) => line.includes('ps failed'))).toBe(true)
    expect(await stored()).toEqual([root])
  })

  it('stops what the last run left, and forgets it', async () => {
    const { trees, calls, stored, file, endGrace } = await setup('linux', [
      [row(100, 1, 100), row(101, 100, 100)],
    ])
    await mkdir(path.dirname(file.file), { recursive: true })
    await writeFile(file.file, JSON.stringify({ version: 1, processes: [root] }))
    await trees.load()
    await trees.stopLeftovers()
    expect(calls).toEqual(['kill -100 SIGTERM'])
    expect(await stored()).toEqual([root, { pid: 101, startedAt: T + 101 }])
    endGrace()
    await settle()
    expect(await stored()).toEqual([])
  })

  it('on Windows, ends with taskkill what it noted while the agent ran', async () => {
    // The agent, a CLI in its job object, and a command the CLI started detached.
    const running = [row(100, 1, 100), row(101, 100, 101), row(102, 101, 102)]
    // The job ended the CLI with the agent, so no parent link leads to the command any more.
    const after = [row(102, 101, 102)]
    const { trees, calls, stored } = await setup('win32', [running, after])
    await trees.load()
    trees.launched(root)
    await trees.note(root)
    await trees.reap(root, 'Fake agent')
    await settle()
    expect(calls).toEqual(['taskkill 102'])
    expect(await stored()).toEqual([])
  })

  it('on Windows, finishes a stop running in the background before it closes', async () => {
    // The agent, and a command it started detached that outlives it.
    const running = [row(100, 1, 100), row(101, 100, 101)]
    const after = [row(101, 100, 101)]
    const { trees, calls, file, stored, holdListing } = await setup('win32', [running, after], {
      closeWaitMs: NO_DEADLINE,
    })
    await trees.load()
    trees.launched(root)
    await trees.note(root)
    const release = holdListing()
    // Resolves at once on Windows, before the listing that finds what is left.
    await trees.reap(root, 'Fake agent')
    let closed = false
    const closing = trees.close().then(() => (closed = true))
    // Every write so far has landed, so a close that only wrote what was pending is done.
    await file.flush()
    await settle()
    expect(closed).toBe(false)
    release()
    await closing
    expect(calls).toEqual(['taskkill 101'])
    expect(await stored()).toEqual([])
  })

  it('on Windows, finishes stopping what the last run left before it closes', async () => {
    const { trees, calls, file, stored, holdListing } = await setup(
      'win32',
      [[row(100, 1, 100), row(101, 100, 101)]],
      { closeWaitMs: NO_DEADLINE },
    )
    await mkdir(path.dirname(file.file), { recursive: true })
    await writeFile(file.file, JSON.stringify({ version: 1, processes: [root] }))
    await trees.load()
    const release = holdListing()
    const stopping = trees.stopLeftovers()
    let closed = false
    const closing = trees.close().then(() => (closed = true))
    await file.flush()
    await settle()
    expect(closed).toBe(false)
    release()
    await Promise.all([stopping, closing])
    expect(calls).toEqual(['taskkill 100 101'])
    expect(await stored()).toEqual([])
  })

  it('on Windows, keeps what a taskkill that timed out was ending, for the next host', async () => {
    const running = [row(100, 1, 100), row(101, 100, 101)]
    const after = [row(101, 100, 101)]
    const { trees, control, stored, logs } = await setup('win32', [running, after])
    control.taskkill = () =>
      Promise.reject(
        Object.assign(new Error('taskkill did not finish within 500 ms'), { code: 'ETIMEDOUT' }),
      )
    await trees.load()
    trees.launched(root)
    await trees.note(root)
    await trees.reap(root, 'Fake agent')
    await trees.close()
    expect(logs.filter((line) => line.includes('taskkill did not finish'))).toHaveLength(1)
    expect(await stored()).toEqual(expect.arrayContaining([root, { pid: 101, startedAt: T + 101 }]))
  })

  it('stops waiting at its deadline, leaving what it was stopping to the next host', async () => {
    const running = [row(100, 1, 100), row(101, 100, 101)]
    const after = [row(101, 100, 101)]
    const { trees, calls, file, stored, logs, holdListing } = await setup(
      'win32',
      [running, after],
      { closeWaitMs: 20 },
    )
    await trees.load()
    trees.launched(root)
    await trees.note(root)
    const release = holdListing()
    await trees.reap(root, 'Fake agent')
    // Resolves while the listing never answers.
    await trees.close()
    expect(logs.some((line) => line.includes('Stopped waiting'))).toBe(true)
    const saves = vi.spyOn(file, 'save')
    expect(await stored()).toEqual(expect.arrayContaining([root, { pid: 101, startedAt: T + 101 }]))
    // The stop goes on if the host does, but the record is no longer written.
    release()
    await settle()
    expect(calls).toEqual(['taskkill 101'])
    expect(saves).not.toHaveBeenCalled()
    expect(await stored()).toEqual(expect.arrayContaining([root, { pid: 101, startedAt: T + 101 }]))
  })

  it('writes nothing once closed, leaving what is in its grace to the next host', async () => {
    const running = [row(100, 1, 100), row(101, 100, 100)]
    const after = [row(101, 1, 100)]
    const { trees, calls, file, stored, endGrace } = await setup('linux', [running, after])
    await trees.load()
    trees.launched(root)
    await trees.note(root)
    await trees.reap(root, 'Fake agent')
    await trees.close()
    const saves = vi.spyOn(file, 'save')
    endGrace()
    await settle()
    expect(calls).toContain('kill -100 SIGKILL')
    expect(saves).not.toHaveBeenCalled()
    expect(await stored()).toEqual(expect.arrayContaining([root, { pid: 101, startedAt: T + 101 }]))
  })
})
