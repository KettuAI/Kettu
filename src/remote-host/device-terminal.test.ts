// A paired device's terminals through the remote host and the terminal host, both in this process:
// the device's own port to the terminal host, the owner's switch at both hosts, flow control that
// lets a slow device fall behind alone, and the activity it leaves. The pty is a fake one, so the
// test writes the output.

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MainToTerminalHost } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import { PortRequestError, type FromPort } from '@shared/port-rpc'
import type { DeviceActivity } from '@shared/remote/activity'
import type { PortDevice } from '@shared/remote/device'
import { generateKeyPair } from '@shared/remote/noise'
import type {
  TerminalEvent,
  TerminalInfo,
  TerminalMethod,
  TerminalParams,
  TerminalResult,
} from '@shared/terminal-host'
import type { TerminalSettings } from '@shared/settings'
import { startTerminalHost } from '../terminal-host/start'
import type { PtyProcess, PtySpawn } from '../terminal-host/terminals'
import { ActivityLog } from './activity'
import { DeviceTerminal, NOT_ALLOWED } from './device-terminal'
import { DeviceStore } from './devices'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { connectDevice, type TestDevice } from './testing/device'
import { memoryPorts, memoryTransports } from './testing/memory'

class FakePty implements PtyProcess {
  readonly pid = 4242
  readonly process = 'sh'
  readonly written: string[] = []
  size: [number, number]
  pauses = 0
  killed = false
  private readonly listeners: ((data: string) => void)[] = []

  constructor(options: Parameters<PtySpawn>[2]) {
    this.size = [options.cols, options.rows]
  }

  onData(listener: (data: string) => void) {
    this.listeners.push(listener)
    return { dispose: () => {} }
  }

  onExit() {
    return { dispose: () => {} }
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.size = [cols, rows]
  }

  kill(): void {
    this.killed = true
  }

  pause(): void {
    this.pauses++
  }

  resume(): void {}

  emit(data: string): void {
    for (const listener of this.listeners) listener(data)
  }
}

/** A client of the terminal host's protocol on one port: a window's, or a device's of its own. */
class TerminalClient {
  readonly events: TerminalEvent[] = []
  closed = false
  private readonly pending = new Map<number, (message: FromPort<TerminalEvent>) => void>()
  private counter = 0

  constructor(private readonly port: PortChannel) {
    port.onMessage((data) => {
      const message = data as FromPort<TerminalEvent>
      if (message.type === 'event') this.events.push(message.event)
      else this.pending.get(message.id)?.(message)
    })
    port.onClose(() => (this.closed = true))
  }

  request<M extends TerminalMethod>(
    method: M,
    params: TerminalParams<M>,
  ): Promise<TerminalResult<M>> {
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        this.pending.delete(id)
        if (message.type === 'response') resolve(message.result as TerminalResult<M>)
        else if (message.type === 'error') reject(new PortRequestError(message.error))
      })
      this.port.send({ type: 'request', id, method, params })
    })
  }

  data(id: string): string {
    return dataOf(this.events, id)
  }
}

function dataOf(events: TerminalEvent[], id: string): string {
  return events
    .map((event) => (event.type === 'terminal.data' && event.id === id ? event.data : ''))
    .join('')
}

/** A request on the device's channel, as the agent host's requests go. */
function ask<M extends TerminalMethod>(
  device: TestDevice,
  method: M,
  params: TerminalParams<M>,
): Promise<TerminalResult<M>> {
  return device.port.request(method as never, params as never) as Promise<TerminalResult<M>>
}

const eventsOf = (device: TestDevice): TerminalEvent[] =>
  device.port.events as unknown as TerminalEvent[]

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function setup(options: { terminal: boolean; terminalDown?: boolean }) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-device-terminal-')))
  const project = path.join(dir, 'project')
  await mkdir(project)
  const logs: string[] = []
  const log = (level: string, message: string) => logs.push(`${level}: ${message}`)
  const devices = await DeviceStore.load(dir, log)
  const activity = await ActivityLog.load(dir, log)
  const hostKey = await generateKeyPair()
  const phoneKey = await generateKeyPair()
  const phone = (await devices.add({
    publicKey: Buffer.from(phoneKey.publicKey).toString('base64'),
    name: 'Phone',
    kind: 'ios',
    platform: 'iOS 26.1',
    model: 'iPhone 17 Pro',
  }))!

  // The terminal host as main runs it, with a fake pty.
  const ptys: FakePty[] = []
  let toTerminalHost: ((message: MainToTerminalHost) => void) | null = null
  const terminalHost = startTerminalHost(
    { send: () => {}, onMessage: (listener) => (toTerminalHost = listener) },
    {
      loadPty: async () => (_file, _args, ptyOptions) => {
        const pty = new FakePty(ptyOptions)
        ptys.push(pty)
        return pty
      },
    },
  )
  const settings = (allowDevices: boolean): TerminalSettings => ({
    shellPath: '/bin/sh',
    fontSize: 13,
    allowDevices,
  })
  toTerminalHost!({
    type: 'terminal-host:init',
    platform: process.platform,
    appVersion: '0.0.0-test',
    settings: settings(options.terminal),
    projects: [project],
    authCommands: [],
  })

  // Each terminal port the remote host opened, and its terminal host end.
  const opened: PortDevice[] = []
  const terminalPorts: PortChannel[] = []
  const closedPorts = new Set<PortChannel>()
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity,
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
    uploads: path.join(dir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    terminal: options.terminal,
    openTerminalPort: async (device) => {
      opened.push(device)
      if (options.terminalDown) return null
      const [remoteEnd, terminalEnd] = memoryPorts()
      terminalPorts.push(terminalEnd)
      terminalEnd.onClose(() => closedPorts.add(terminalEnd))
      terminalHost.connect(terminalEnd, -1, device)
      return remoteEnd
    },
    changed: () => {},
    log,
  })
  cleanup = async () => {
    await server.stop('stopping')
    await rm(dir, { recursive: true, force: true })
  }

  const connect = (): Promise<TestDevice> => {
    const [deviceEnd, hostEnd] = memoryTransports()
    server.accept(hostEnd)
    return connectDevice({ transport: deviceEnd, hostKey: hostKey.publicKey, key: phoneKey })
  }
  /** A window's port to the terminal host. */
  const window = (): TerminalClient => {
    const [clientEnd, hostEnd] = memoryPorts()
    terminalHost.connect(hostEnd, 1)
    return new TerminalClient(clientEnd)
  }
  /** A device's port straight to the terminal host, past the remote host's own check. */
  const devicePort = (): TerminalClient => {
    const [clientEnd, hostEnd] = memoryPorts()
    terminalHost.connect(hostEnd, -1, { id: phone.id, name: phone.name })
    return new TerminalClient(clientEnd)
  }
  /** The owner's switch, as main passes it to both hosts. */
  const allow = (allowed: boolean): void => {
    server.setTerminal(allowed)
    toTerminalHost!({ type: 'terminal-host:settings', settings: settings(allowed) })
  }
  /** The device's terminal events, oldest first, with their projects. */
  const terminalActivity = (): { kind: DeviceActivity['kind']; projectPath: string }[] =>
    activity
      .list(phone.id)
      .flatMap((event) =>
        event.kind === 'terminal-opened' || event.kind === 'terminal-closed'
          ? [{ kind: event.kind, projectPath: event.projectPath }]
          : [],
      )
      .reverse()
  return {
    project,
    phone,
    activity,
    ptys,
    opened,
    terminalPorts,
    /** Whether the remote host's nth terminal port has closed. */
    portClosed: (index: number) => closedPorts.has(terminalPorts[index]!),
    logs,
    connect,
    window,
    devicePort,
    allow,
    terminalActivity,
  }
}

const SIZE = { cols: 80, rows: 24 }

describe("a device's terminals", () => {
  it('lists, attaches with the replay first, types, resizes, creates and kills', async () => {
    const t = await setup({ terminal: true })
    const window = t.window()
    const shared = await window.request('terminals.create', { projectPath: t.project, ...SIZE })
    t.ptys[0]!.emit('before\r\n')
    await expect.poll(() => window.data(shared.id)).toBe('before\r\n')

    const device = await t.connect()
    expect(await device.first).toMatchObject({ type: 'welcome', terminal: true })
    // The port opens at the device's first terminal request, not with the session.
    expect(t.opened).toEqual([])
    expect(await ask(device, 'terminals.list', {})).toEqual([
      expect.objectContaining({ id: shared.id, projectPath: t.project }),
    ])
    expect(t.opened).toEqual([{ id: t.phone.id, name: 'Phone' }])
    expect(await ask(device, 'terminals.attach', { id: shared.id })).toEqual({
      replay: 'before\r\n',
    })
    t.ptys[0]!.emit('after')
    await expect.poll(() => dataOf(eventsOf(device), shared.id)).toBe('after')
    await ask(device, 'terminals.input', { id: shared.id, data: 'ls\r' })
    expect(t.ptys[0]!.written).toEqual(['ls\r'])
    await ask(device, 'terminals.resize', { id: shared.id, cols: 50, rows: 20 })
    expect(t.ptys[0]!.size).toEqual([50, 20])

    const own = await ask(device, 'terminals.create', {
      projectPath: t.project,
      cols: 40,
      rows: 30,
    })
    expect(t.ptys[1]!.size).toEqual([40, 30])
    // The window hears of the device's terminal as of any other.
    await expect
      .poll(() => window.events.some((e) => e.type === 'terminal.info' && e.info.id === own.id))
      .toBe(true)
    await ask(device, 'terminals.kill', { id: shared.id })
    expect(t.ptys[0]!.killed).toBe(true)
    await expect
      .poll(() => window.events.some((e) => e.type === 'terminal.removed' && e.id === shared.id))
      .toBe(true)
    // Still one port, for every request.
    expect(t.opened).toHaveLength(1)

    expect(t.terminalActivity()).toEqual([
      { kind: 'terminal-opened', projectPath: t.project },
      { kind: 'terminal-opened', projectPath: t.project },
      { kind: 'terminal-closed', projectPath: t.project },
    ])

    // The device goes: its terminal keeps running, and coming back for it within 10 minutes, as a
    // flaky network does, is no new opening.
    device.close()
    await expect.poll(() => t.portClosed(0)).toBe(true)
    const back = await t.connect()
    await back.first
    expect(await ask(back, 'terminals.attach', { id: own.id })).toEqual({ replay: '' })
    expect(t.ptys[1]!.killed).toBe(false)
    expect(t.terminalActivity()).toHaveLength(3)
    // Gone for good, as when the host stops: noted closed when the session ended.
    back.close()
    await expect.poll(() => t.portClosed(1)).toBe(true)
    expect(t.terminalActivity()).toHaveLength(3)
    await t.activity.flush()
    expect(t.terminalActivity()).toEqual([
      { kind: 'terminal-opened', projectPath: t.project },
      { kind: 'terminal-opened', projectPath: t.project },
      { kind: 'terminal-closed', projectPath: t.project },
      { kind: 'terminal-closed', projectPath: t.project },
    ])
  })

  it('refuses every terminal request at both hosts while the owner does not allow it', async () => {
    const t = await setup({ terminal: false })
    const device = await t.connect()
    expect(await device.first).toMatchObject({ type: 'welcome', terminal: false })
    await expect(ask(device, 'terminals.list', {})).rejects.toMatchObject({
      code: 'terminal_not_allowed',
    })
    await expect(
      ask(device, 'terminals.create', { projectPath: t.project, ...SIZE }),
    ).rejects.toMatchObject({ code: 'terminal_not_allowed' })
    expect(t.opened).toEqual([])

    // A device's port that reaches the terminal host anyway is refused there, and told nothing.
    const window = t.window()
    const sneaking = t.devicePort()
    const { id } = await window.request('terminals.create', { projectPath: t.project, ...SIZE })
    await expect(sneaking.request('terminals.attach', { id })).rejects.toMatchObject({
      code: 'terminal_not_allowed',
    })
    await expect(sneaking.request('terminals.list', {})).rejects.toMatchObject({
      code: 'terminal_not_allowed',
    })
    expect(sneaking.events).toEqual([])
    expect(t.logs).toEqual([])
    expect(t.terminalActivity()).toEqual([])
  })

  it("checks a device's terminal requests as any of its requests before routing them", async () => {
    const t = await setup({ terminal: true })
    const device = await t.connect()
    await device.first
    // The remote host's own requests have negative ids; a device's never reach a host.
    await device.send({ type: 'request', id: -1, method: 'terminals.list', params: {} })
    expect(await ask(device, 'terminals.list', {})).toEqual([])
    expect(t.logs).toEqual([`warn: Device ${t.phone.id} sent a request with a negative id`])
    expect(t.opened).toHaveLength(1)
  })

  it('closes every device terminal port when turned off; the terminals keep running', async () => {
    const t = await setup({ terminal: true })
    const device = await t.connect()
    await device.first
    const info = await ask(device, 'terminals.create', { projectPath: t.project, ...SIZE })
    // A device's port the remote host did not open: the terminal host closes it itself.
    const straight = t.devicePort()
    await straight.request('terminals.attach', { id: info.id })

    t.allow(false)
    await expect.poll(() => device.notices).toEqual([{ type: 'terminal', allowed: false }])
    await expect.poll(() => straight.closed).toBe(true)
    expect(t.ptys[0]!.killed).toBe(false)
    t.ptys[0]!.emit('still running')
    await expect(ask(device, 'terminals.list', {})).rejects.toMatchObject({
      code: 'terminal_not_allowed',
    })
    // The port the remote host closed itself: no terminals.restarted.
    expect(device.notices).toEqual([{ type: 'terminal', allowed: false }])
    expect(dataOf(eventsOf(device), info.id)).toBe('')
    expect(t.terminalActivity()).toEqual([
      { kind: 'terminal-opened', projectPath: t.project },
      { kind: 'terminal-closed', projectPath: t.project },
    ])

    // On again: the next request opens a new port, and the terminal is still there.
    t.allow(true)
    await expect
      .poll(() => device.notices)
      .toEqual([
        { type: 'terminal', allowed: false },
        { type: 'terminal', allowed: true },
      ])
    expect(await ask(device, 'terminals.attach', { id: info.id })).toEqual({
      replay: 'still running',
    })
    expect(t.opened).toHaveLength(2)
  })

  it('tells the device its terminals ended with a port that closes, and opens another', async () => {
    const t = await setup({ terminal: true })
    const window = t.window()
    const shared = await window.request('terminals.create', { projectPath: t.project, ...SIZE })
    const device = await t.connect()
    await device.first
    const own = await ask(device, 'terminals.create', { projectPath: t.project, ...SIZE })
    await ask(device, 'terminals.attach', { id: shared.id })
    // As when the terminal host restarts.
    t.terminalPorts[0]!.close()
    await expect
      .poll(() => device.notices)
      .toEqual([{ type: 'terminals.restarted', ids: [own.id, shared.id] }])
    expect(t.terminalActivity().map((event) => event.kind)).toEqual([
      'terminal-opened',
      'terminal-opened',
      'terminal-closed',
      'terminal-closed',
    ])
    expect((await ask(device, 'terminals.list', {})).map((info) => info.id)).toEqual([
      shared.id,
      own.id,
    ])
    expect(t.opened).toHaveLength(2)
    expect(device.notices).toHaveLength(1)
    expect(t.logs).toEqual([`warn: The terminal port of device ${t.phone.id} closed`])
  })

  it('says the terminal host is not running when no port can be opened', async () => {
    const t = await setup({ terminal: true, terminalDown: true })
    const device = await t.connect()
    await device.first
    await expect(ask(device, 'terminals.list', {})).rejects.toMatchObject({
      code: 'host_restarted',
    })
    // Tried again at the next request.
    await expect(ask(device, 'terminals.list', {})).rejects.toMatchObject({
      code: 'host_restarted',
    })
    expect(t.opened).toHaveLength(2)
  })
})

describe('a slow device', () => {
  it('falls behind alone, then catches up through the replay', async () => {
    const t = await setup({ terminal: true })
    const window = t.window()
    const { id } = await window.request('terminals.create', { projectPath: t.project, ...SIZE })
    const device = await t.connect()
    await device.first
    await ask(device, 'terminals.attach', { id })

    // The window draws and acknowledges each chunk; the device acknowledges nothing.
    const chunk = `${'x'.repeat(9_999)}\n`
    let written = ''
    for (let i = 0; i < 15; i++) {
      t.ptys[0]!.emit(chunk)
      written += chunk
      await expect.poll(() => window.data(id).length).toBe(written.length)
      await window.request('terminals.ack', { id, chars: chunk.length })
    }
    expect(t.ptys[0]!.pauses).toBe(0)
    // Data until the device was more than the high watermark behind, with the chunk that put it
    // there, then none.
    await expect.poll(() => dataOf(eventsOf(device), id).length).toBe(11 * chunk.length)

    // It acknowledges what it drew: the screen starts over from the replay, and data follows.
    await ask(device, 'terminals.ack', { id, chars: 11 * chunk.length })
    await expect
      .poll(() => eventsOf(device).filter((event) => event.type === 'terminal.replay').length)
      .toBe(1)
    const replay = eventsOf(device).find((event) => event.type === 'terminal.replay')!
    expect(replay.type === 'terminal.replay' && replay.id === id).toBe(true)
    expect(replay.type === 'terminal.replay' && replay.replay === written).toBe(true)
    t.ptys[0]!.emit('fresh\n')
    await expect.poll(() => dataOf(eventsOf(device), id).endsWith('fresh\n')).toBe(true)
    expect(window.data(id)).toBe(`${written}fresh\n`)
    expect(t.ptys[0]!.pauses).toBe(0)
  })
})

describe('DeviceTerminal', () => {
  interface HostEnd {
    port: PortChannel
    /** The requests it heard, in order. */
    requests: { id: number; method: string }[]
    closed: boolean
  }

  const infoOf = (id: string): TerminalInfo => ({
    id,
    projectPath: '/project',
    shell: 'sh',
    title: 'sh',
    busy: false,
    exitCode: null,
    createdAt: 0,
  })

  /** A device's terminals alone, with the test as the terminal host on each port they open. */
  function alone() {
    const sent: unknown[] = []
    const hosts: HostEnd[] = []
    const terminal = new DeviceTerminal({
      device: { id: 'phone', name: 'Phone' },
      allowed: () => true,
      open: async () => {
        const [remoteEnd, hostEnd] = memoryPorts()
        const host: HostEnd = { port: hostEnd, requests: [], closed: false }
        hostEnd.onMessage((data) => host.requests.push(data as HostEnd['requests'][number]))
        hostEnd.onClose(() => (host.closed = true))
        hosts.push(host)
        return remoteEnd
      },
      send: (value) => sent.push(value),
      opened: () => {},
      closed: () => {},
      log: () => {},
    })
    const request = (id: number, method: string, params: unknown = {}): void =>
      terminal.request({ type: 'request', id, method, params })
    /** The nth port's terminal host end, once that port opened. */
    const host = async (index: number): Promise<HostEnd> => {
      await expect.poll(() => hosts.length).toBe(index + 1)
      return hosts[index]!
    }
    /** Waits until the host heard requests with these ids, the remote host's list being -1. */
    const heard = (end: HostEnd, ids: number[]) =>
      expect.poll(() => end.requests.map((request) => request.id)).toEqual(ids)
    const answer = (end: HostEnd, id: number, result: unknown): void =>
      end.port.send({ type: 'response', id, result })
    return { terminal, sent, hosts, request, host, heard, answer }
  }

  it('names the terminals that ended as its port closes, then answers what waits', async () => {
    const t = alone()
    t.request(1, 'terminals.create', { projectPath: '/project', ...SIZE })
    const first = await t.host(0)
    await t.heard(first, [-1])
    t.answer(first, -1, [infoOf('shared')])
    await t.heard(first, [-1, 1])
    t.answer(first, 1, infoOf('own'))
    t.request(2, 'terminals.attach', { id: 'shared' })
    await t.heard(first, [-1, 1, 2])
    t.answer(first, 2, { replay: '' })
    t.request(3, 'terminals.input', { id: 'own', data: 'ls\r' })
    await t.heard(first, [-1, 1, 2, 3])
    await expect.poll(() => t.sent).toHaveLength(2)

    first.port.close()
    await expect
      .poll(() => t.sent.slice(2))
      .toEqual([
        { type: 'terminals.restarted', ids: ['own', 'shared'] },
        { type: 'error', id: 3, error: expect.objectContaining({ code: 'host_restarted' }) },
      ])

    // The next request opens a new port; one that closes with no terminal open says so too.
    t.request(4, 'terminals.list')
    const second = await t.host(1)
    await t.heard(second, [-1])
    t.answer(second, -1, [infoOf('shared')])
    await t.heard(second, [-1, 4])
    t.answer(second, 4, [infoOf('shared')])
    await expect.poll(() => t.sent).toHaveLength(5)
    expect(t.sent[4]).toEqual({ type: 'response', id: 4, result: [infoOf('shared')] })
    second.port.close()
    await expect.poll(() => t.sent).toHaveLength(6)
    expect(t.sent[5]).toEqual({ type: 'terminals.restarted', ids: [] })
    expect(t.hosts).toHaveLength(2)
  })

  it('says nothing of a port it closes itself, as turned off or as the session ends', async () => {
    const t = alone()
    t.request(1, 'terminals.create', { projectPath: '/project', ...SIZE })
    const first = await t.host(0)
    await t.heard(first, [-1])
    t.answer(first, -1, [])
    await t.heard(first, [-1, 1])
    t.answer(first, 1, infoOf('own'))
    t.request(2, 'terminals.input', { id: 'own', data: 'ls\r' })
    await t.heard(first, [-1, 1, 2])

    t.terminal.close(NOT_ALLOWED)
    await expect.poll(() => first.closed).toBe(true)
    expect(t.sent).toEqual([
      { type: 'response', id: 1, result: infoOf('own') },
      { type: 'error', id: 2, error: NOT_ALLOWED },
    ])

    t.request(3, 'terminals.attach', { id: 'own' })
    const second = await t.host(1)
    await t.heard(second, [-1])
    t.answer(second, -1, [infoOf('own')])
    await t.heard(second, [-1, 3])
    t.answer(second, 3, { replay: '' })
    await expect.poll(() => t.sent).toHaveLength(3)
    t.terminal.close(null)
    await expect.poll(() => second.closed).toBe(true)
    expect(t.sent).toHaveLength(3)
  })
})
