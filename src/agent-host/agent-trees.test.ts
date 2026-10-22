import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

async function setup(platform: ProcessControl['platform'], rows: ProcessRow[][]) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-trees-'))
  const calls: string[] = []
  const logs: string[] = []
  let listed = 0
  let release: () => void = () => {}
  const control: ProcessControl = {
    platform,
    list: async () => {
      listed++
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
  return { trees, calls, logs, stored, file, endGrace: () => release(), listed: () => listed }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  it('lists the tree a while after the agent talks, once for a burst', async () => {
    const running = [row(100, 1, 100), row(102, 100, 102)]
    const { trees, stored, listed } = await setup('linux', [running])
    await trees.load()
    trees.launched(root)
    for (let i = 0; i < 50; i++) trees.active(root)
    expect(listed()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(listed()).toBe(1)
    expect(await stored()).toEqual([root, { pid: 102, startedAt: T + 102 }])
  })

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

  it('on Windows, ends the tree with taskkill and leaves no grace', async () => {
    const { trees, calls, stored } = await setup('win32', [[row(101, 100, 101)]])
    await trees.load()
    trees.launched(root)
    await trees.note(root)
    await trees.reap(root, 'Fake agent')
    await settle()
    expect(calls).toEqual(['taskkill 101'])
    expect(await stored()).toEqual([])
  })
})
