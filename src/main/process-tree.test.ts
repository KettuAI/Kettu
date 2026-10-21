import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { killProcessTrees, type ProcessTreeKiller } from './process-tree'

function esrch(): Error {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
}

function fakeKiller(platform: ProcessTreeKiller['platform'], aliveAfterTerm: boolean) {
  const calls: string[] = []
  const killer: ProcessTreeKiller = {
    platform,
    kill(pid, signal) {
      calls.push(`kill ${pid} ${signal}`)
      if (signal === 0 && !aliveAfterTerm) throw esrch()
    },
    async run(command, args) {
      calls.push([command, ...args].join(' '))
    },
    async delay(ms) {
      calls.push(`wait ${ms}`)
    },
  }
  return { killer, calls }
}

describe('killProcessTrees', () => {
  it('terminates the process group on POSIX and stops when it is gone', async () => {
    const { killer, calls } = fakeKiller('darwin', false)
    expect(await killProcessTrees([42], killer)).toEqual([])
    expect(calls).toEqual(['kill -42 SIGTERM', 'wait 2000', 'kill -42 0'])
  })

  it('kills a process group that outlives SIGTERM', async () => {
    const { killer, calls } = fakeKiller('linux', true)
    await killProcessTrees([7], killer)
    expect(calls).toEqual(['kill -7 SIGTERM', 'wait 2000', 'kill -7 0', 'kill -7 SIGKILL'])
  })

  it('treats a group that is already gone as stopped', async () => {
    const { killer } = fakeKiller('linux', false)
    killer.kill = () => {
      throw esrch()
    }
    expect(await killProcessTrees([7], killer)).toEqual([])
  })

  it('uses taskkill on Windows', async () => {
    const { killer, calls } = fakeKiller('win32', false)
    await killProcessTrees([1234, 99], killer)
    expect(calls).toEqual(['taskkill /PID 1234 /T /F', 'taskkill /PID 99 /T /F'])
  })

  it('reports invalid pids instead of signalling them', async () => {
    const { killer, calls } = fakeKiller('darwin', false)
    expect(await killProcessTrees([0, -5], killer)).toHaveLength(2)
    expect(calls).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('stops a real detached process tree', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30 & wait'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid!
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(-pid, 0)).not.toThrow()
    expect(await killProcessTrees([pid])).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(-pid, 0)).toThrow()
  })
})
