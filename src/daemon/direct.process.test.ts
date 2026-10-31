// Process test: the direct connections' control calls on a daemon run in this process with small
// hosts of its own. The remote one records what it is sent and reports direct connections as their
// settings ask, as the real one does: listening, or failing on a port the test makes it refuse.

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DirectSettings } from '@shared/settings'
import { callControl, type DaemonStatus } from './control'
import { startDaemon, type RunningDaemon } from './daemon'

const AGENT_HOST = `
process.on('message', (message) => {
  if (message.type === 'host:init') process.send({ type: 'host:ready' })
  if (message.type === 'host:shutdown') {
    process.send({ type: 'host:stopped' })
    setImmediate(() => process.exit(0))
  }
})
process.on('disconnect', () => process.exit(0))
`

// The port in the data folder's refused-port file is one it cannot open.
const REMOTE_HOST = `
const fs = require('node:fs')
const path = require('node:path')
let data = ''
let direct = null
let last = ''
const refused = () => {
  try {
    return Number(fs.readFileSync(path.join(data, 'refused-port'), 'utf8'))
  } catch {
    return null
  }
}
const status = () => ({
  publicKey: 'a2V5',
  plainTextKey: true,
  devices: [],
  online: [],
  refused: 0,
  direct: !direct || !direct.enabled
    ? { state: 'off' }
    : refused() === direct.port
      ? { state: 'failed', port: direct.port, reason: 'port_in_use' }
      : {
          state: 'listening',
          port: direct.port,
          addresses: [...direct.addresses, { host: '192.0.2.10', port: direct.port }],
        },
})
// Only a change is reported, as the real one reports it.
const report = () => {
  const next = JSON.stringify(status())
  if (next !== last) process.send({ type: 'remote-host:status', status: JSON.parse(next) })
  last = next
}
process.on('message', (message) => {
  if (message.type === 'remote-host:init') {
    data = message.userDataPath
    process.send({ type: 'remote-host:ready' })
  }
  if (message.type === 'remote-host:init' || message.type === 'remote-host:direct') {
    const record = { type: message.type, direct: message.direct }
    fs.appendFileSync(path.join(data, 'remote-messages.jsonl'), JSON.stringify(record) + '\\n')
    direct = message.direct
    report()
  }
  if (message.type === 'remote-host:shutdown') {
    process.send({ type: 'remote-host:stopped' })
    setImmediate(() => process.exit(0))
  }
})
process.on('disconnect', () => process.exit(0))
`

interface Sent {
  type: 'remote-host:init' | 'remote-host:direct'
  direct: DirectSettings | undefined
}

const FRP = { host: 'frp.example.com', port: 60021 }

// The daemon runs on macOS and Linux only.
const describeUnix = describe.skipIf(process.platform === 'win32')

let dir = ''
let data = ''
let socket = ''
let daemon: RunningDaemon | null = null

beforeAll(async () => {
  if (process.platform === 'win32') return
  // Short, so the control socket's path fits.
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kdd-')))
  data = path.join(dir, 'data')
  socket = path.join(data, 'control.sock')
  await writeFile(path.join(dir, 'agent-host.cjs'), AGENT_HOST)
  await writeFile(path.join(dir, 'remote-host.cjs'), REMOTE_HOST)
})

afterAll(async () => {
  await daemon?.stop()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function until<T>(check: () => Promise<T | null | false>, what: string, ms = 10_000) {
  const started = Date.now()
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() - started > ms) throw new Error(`No ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function sent(): Promise<Sent[]> {
  const text = await readFile(path.join(data, 'remote-messages.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Sent)
}

async function savedDirect(): Promise<DirectSettings> {
  const file = JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8'))
  return file.remote.direct
}

async function run(): Promise<DaemonStatus> {
  daemon = await startDaemon({
    dataPath: data,
    controlSocket: socket,
    version: '0.0.0',
    bundleDir: dir,
    env: process.env,
  })
  return until(async () => {
    const status = await callControl(socket, 'status', undefined)
    return status.direct !== null && status
  }, 'direct status')
}

describeUnix('direct connections on the daemon', () => {
  it('changes the settings and passes each change to the remote host', async () => {
    // The first run turns direct connections on, which picks their port.
    const first = await run()
    const picked = await until(async () => (await savedDirect()).port, 'the picked port')
    expect(picked).toBeGreaterThanOrEqual(49152)
    expect(await savedDirect()).toEqual({ enabled: true, port: picked, addresses: [] })
    expect(await sent()).toEqual([
      { type: 'remote-host:init', direct: { enabled: true, port: picked, addresses: [] } },
    ])
    const found = { host: '192.0.2.10', port: picked }
    expect(first.direct).toEqual({ state: 'listening', port: picked, addresses: [found] })
    expect(await callControl(socket, 'direct.get', undefined)).toEqual({
      port: picked,
      own: [],
      status: { state: 'listening', port: picked, addresses: [found] },
    })

    // Another port: saved, passed on, and answered once the remote host listens on it.
    const moved = picked === 4567 ? 4568 : 4567
    expect(await callControl(socket, 'direct.port', { port: moved })).toEqual({
      port: moved,
      own: [],
      status: {
        state: 'listening',
        port: moved,
        addresses: [{ host: '192.0.2.10', port: moved }],
      },
    })
    expect((await sent()).at(-1)).toEqual({
      type: 'remote-host:direct',
      direct: { enabled: true, port: moved, addresses: [] },
    })
    await until(async () => (await savedDirect()).port === moved, 'the saved port')

    // A port it cannot open, then the same one again: tried again each time.
    const refused = moved + 1
    await writeFile(path.join(data, 'refused-port'), String(refused))
    expect(await callControl(socket, 'direct.port', { port: refused })).toMatchObject({
      port: refused,
      status: { state: 'failed', port: refused, reason: 'port_in_use' },
    })
    const tries = (await sent()).length
    expect(await callControl(socket, 'direct.port', { port: refused })).toMatchObject({
      status: { state: 'failed', port: refused },
    })
    expect((await sent()).length).toBe(tries + 1)
    expect((await sent()).at(-1)).toEqual({
      type: 'remote-host:direct',
      direct: { enabled: true, port: refused, addresses: [] },
    })
    await rm(path.join(data, 'refused-port'))
    expect(await callControl(socket, 'direct.port', { port: refused })).toMatchObject({
      status: { state: 'listening', port: refused },
    })
    // The port it listens on already: nothing to pass on.
    const listening = (await sent()).length
    await callControl(socket, 'direct.port', { port: refused })
    expect((await sent()).length).toBe(listening)

    // Addresses of the owner's own, refused as the app refuses them.
    expect(await callControl(socket, 'direct.add', FRP)).toMatchObject({ own: [FRP] })
    expect((await sent()).at(-1)).toEqual({
      type: 'remote-host:direct',
      direct: { enabled: true, port: refused, addresses: [FRP] },
    })
    await expect(
      callControl(socket, 'direct.add', { host: 'FRP.example.com', port: 60021 }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'This address is already in the list',
    })
    const more = Array.from({ length: 9 }, (_, i) => ({
      host: `a${i}.example.com`,
      port: 4000 + i,
    }))
    for (const address of more) await callControl(socket, 'direct.add', address)
    await expect(
      callControl(socket, 'direct.add', { host: 'fd00::1', port: 4567 }),
    ).rejects.toMatchObject({ code: 'invalid_params', message: 'You can add up to 10 addresses' })
    for (const address of more) await callControl(socket, 'direct.remove', address)
    await expect(
      callControl(socket, 'direct.remove', { host: 'fd00::1', port: 4567 }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'This address is not in the list' })
    expect(await callControl(socket, 'direct.remove', FRP)).toMatchObject({ own: [] })
    expect((await sent()).at(-1)).toEqual({
      type: 'remote-host:direct',
      direct: { enabled: true, port: refused, addresses: [] },
    })
    await callControl(socket, 'direct.add', FRP)
    // An address is passed on without waiting for the remote host, whose report follows.
    const reported = await until(async () => {
      const { direct } = await callControl(socket, 'status', undefined)
      return direct?.state === 'listening' && direct.addresses.length === 2 && direct
    }, 'the address in the status')
    expect(reported).toEqual({
      state: 'listening',
      port: refused,
      addresses: [FRP, { host: '192.0.2.10', port: refused }],
    })
    await daemon!.stop()
    daemon = null

    // Nothing turns them off: a file that does is turned on again, on the port it keeps.
    const kept = await savedDirect()
    expect(kept).toEqual({ enabled: true, port: refused, addresses: [FRP] })
    const file = JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8'))
    file.remote.direct.enabled = false
    await writeFile(path.join(data, 'settings.json'), JSON.stringify(file))
    await rm(path.join(data, 'remote-messages.jsonl'))
    await run()
    expect(await sent()).toEqual([{ type: 'remote-host:init', direct: kept }])
    await daemon!.stop()
    daemon = null
  }, 60_000)
})
