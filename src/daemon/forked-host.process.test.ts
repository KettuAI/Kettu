// Process test: ForkedHost with a small host of its own, which reports ready, echoes, crashes or
// refuses to stop as each test asks.

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Logger } from '../main/log'
import { ForkedHost, isUnavailable, type ForkedHostConfig } from './forked-host'

type ToChild =
  | { type: 'init'; socketPath: string | null }
  | { type: 'echo'; value: number }
  | { type: 'crash' }
  | { type: 'shutdown' }
type FromChild =
  | { type: 'ready' }
  | { type: 'echo'; value: number; socketPath: string | null }
  | { type: 'stopped' }

const HOST = `
let socketPath = null
process.on('message', (message) => {
  const mode = process.env.HOST_MODE
  if (message.type === 'init') {
    socketPath = message.socketPath
    if (mode === 'crash-at-init') process.exit(3)
    if (mode === 'never-ready') return
    if (!socketPath) return process.send({ type: 'ready' })
    // Listens as a host does, so a socket file left behind would fail the next one.
    require('node:net')
      .createServer((socket) => socket.end())
      .on('error', () => process.exit(4))
      .listen(socketPath, () => process.send({ type: 'ready' }))
  } else if (message.type === 'echo') {
    process.send({ type: 'echo', value: message.value, socketPath })
  } else if (message.type === 'crash') {
    process.kill(process.pid, 'SIGKILL')
  } else if (message.type === 'shutdown' && mode !== 'stubborn') {
    process.send({ type: 'stopped' })
    setImmediate(() => process.exit(0))
  }
})
if (process.env.HOST_MODE === 'stubborn') process.on('SIGTERM', () => {})
process.on('disconnect', () => process.exit(0))
`

// The daemon, and so its hosts' supervision, runs on macOS and Linux only.
const describeUnix = describe.skipIf(process.platform === 'win32')

let dir = ''
let modulePath = ''
const hosts: ForkedHost<ToChild, FromChild>[] = []

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-forked-host-'))
  modulePath = path.join(dir, 'host.cjs')
  await writeFile(modulePath, HOST)
})

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
})

afterAll(() => rm(dir, { recursive: true, force: true }))

interface Made {
  host: ForkedHost<ToChild, FromChild>
  received: FromChild[]
  exits: boolean[]
  lines: string[]
}

function make(mode: string, overrides: Partial<ForkedHostConfig<ToChild, FromChild>> = {}): Made {
  const received: FromChild[] = []
  const exits: boolean[] = []
  const lines: string[] = []
  const log: Logger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  }
  const host = new ForkedHost<ToChild, FromChild>({
    log,
    modulePath,
    socketName: 'test-host',
    env: { ...process.env, HOST_MODE: mode },
    initMessage: (socketPath) => ({ type: 'init', socketPath }),
    shutdownMessage: { type: 'shutdown' },
    readyType: 'ready',
    stoppedType: 'stopped',
    onMessage: (message) => received.push(message),
    onExit: (clean) => exits.push(clean),
    timings: { readyMs: 1000, stopMs: 300, killGraceMs: 300 },
    policy: {
      initialDelayMs: 20,
      maxDelayMs: 100,
      healthyAfterMs: 60_000,
      maxCrashes: 3,
      crashWindowMs: 60_000,
    },
    ...overrides,
  })
  hosts.push(host)
  return { host, received, exits, lines }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 10_000) throw new Error(`No ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  )

const listening = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

describeUnix('ForkedHost', () => {
  it('starts a host on its own socket, passes messages and stops it cleanly', async () => {
    const { host, received, exits } = make('normal')
    expect(host.state).toBe('idle')
    expect(host.socketPath).toBeNull()
    await host.ready()
    const socketPath = host.socketPath!
    expect(host.state).toBe('ready')
    expect(await listening(socketPath)).toBe(true)
    expect(host.pid).toBeGreaterThan(0)
    // privateSocketPath's folder, which only the user can open.
    expect(await exists(path.dirname(socketPath))).toBe(true)
    expect(host.post({ type: 'echo', value: 7 })).toBe(true)
    await until(() => received.length > 0, 'echo')
    expect(received).toEqual([{ type: 'echo', value: 7, socketPath }])
    await host.stop()
    expect(host.state).toBe('stopped')
    expect(exits).toEqual([true])
    expect(await exists(path.dirname(socketPath))).toBe(false)
    expect(host.socketPath).toBeNull()
    expect(host.post({ type: 'echo', value: 8 })).toBe(false)
    await expect(host.ready()).rejects.toSatisfy(isUnavailable)
  })

  it('restarts a host that is killed, on the socket it had', async () => {
    // What the host reports just after it hears of the exit, before anything else runs.
    const seen: { state: string; pid: number | null }[] = []
    const made: Made = make('normal', {
      onExit: (clean) => {
        made.exits.push(clean)
        queueMicrotask(() => seen.push({ state: made.host.state, pid: made.host.pid }))
      },
    })
    const { host, exits } = made
    await host.ready()
    const socketPath = host.socketPath!
    const pid = host.pid
    host.post({ type: 'crash' })
    await until(() => host.state === 'waiting' || host.state === 'starting', 'restart')
    // Never ready without a process, as status would otherwise say.
    expect(seen).toEqual([{ state: 'waiting', pid: null }])
    await host.ready()
    expect(host.pid).not.toBe(pid)
    // The killed process's socket file did not keep the new one from listening there.
    expect(host.socketPath).toBe(socketPath)
    expect(await listening(socketPath)).toBe(true)
    expect(host.restarts).toBe(1)
    expect(exits).toEqual([false])
  })

  it('runs a host that takes no ports without a socket', async () => {
    const { host, received } = make('normal', { socketName: null })
    await host.ready()
    expect(host.socketPath).toBeNull()
    host.post({ type: 'echo', value: 1 })
    await until(() => received.length > 0, 'echo')
    expect(received).toEqual([{ type: 'echo', value: 1, socketPath: null }])
  })

  it('gives up on a host that keeps exiting', async () => {
    const { host, lines } = make('crash-at-init')
    await expect(host.ready()).rejects.toSatisfy(isUnavailable)
    expect(host.state).toBe('failed')
    expect(host.restarts).toBe(2)
    expect(lines).toContain('Crashed too often; not restarting it')
    host.start()
    expect(host.state).toBe('failed')
  })

  it('starts a host it gave up on again when the owner asks, and only then', async () => {
    const { host, lines } = make('crash-at-init')
    expect(host.restart()).toBe(false)
    await expect(host.ready()).rejects.toSatisfy(isUnavailable)
    expect(host.restart()).toBe(true)
    expect(host.state).toBe('starting')
    expect(lines).toContain('Restarting, as the owner asked')
    // It gets as many tries as at first before it is given up on again.
    await expect(host.ready()).rejects.toSatisfy(isUnavailable)
    expect(host.state).toBe('failed')
    expect(host.restarts).toBe(4)

    const healthy = make('normal')
    await healthy.host.ready()
    expect(healthy.host.restart()).toBe(false)
    expect(healthy.host.state).toBe('ready')
  })

  it('renews a running host with a new init, on the socket it had, as no crash', async () => {
    let inits = 0
    const { host, received, exits, lines } = make('normal', {
      initMessage: (socketPath) => {
        inits++
        return { type: 'init', socketPath }
      },
    })
    await host.ready()
    const socketPath = host.socketPath!
    const pid = host.pid
    const renewed = host.renew()
    expect(host.state).toBe('stopping')
    // Who waits meanwhile gets the new process.
    const ready = host.ready()
    await renewed
    await ready
    expect(host.state).toBe('ready')
    expect(host.pid).not.toBe(pid)
    expect(inits).toBe(2)
    expect(exits).toEqual([true])
    expect(host.restarts).toBe(0)
    expect(lines).toContain('Renewing it')
    expect(host.socketPath).toBe(socketPath)
    expect(await listening(socketPath)).toBe(true)
    host.post({ type: 'echo', value: 2 })
    await until(() => received.length > 0, 'echo')
    expect(received).toEqual([{ type: 'echo', value: 2, socketPath }])

    // Once stopped, nothing renews it.
    await host.stop()
    await host.renew()
    expect(host.state).toBe('stopped')
    expect(inits).toBe(2)
  })

  it('kills and restarts a host that never reports ready', async () => {
    const { host, lines } = make('never-ready', {
      timings: { readyMs: 100, stopMs: 300, killGraceMs: 300 },
    })
    host.start()
    await until(() => host.restarts >= 1, 'restart')
    expect(lines).toContain('No ready message within 100 ms; killing it')
  })

  it('kills a host that does not stop, with SIGKILL when it ignores SIGTERM', async () => {
    const { host, lines, exits } = make('stubborn')
    await host.ready()
    const started = Date.now()
    await host.stop()
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
    expect(host.state).toBe('stopped')
    expect(exits).toEqual([false])
    expect(lines).toContain('Did not exit within 300 ms; killing it')
  })
})
