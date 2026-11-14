import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceCall, DeviceCallAnswer } from '@shared/device-agent'
import type { DeviceEvent, DeviceInput } from '@shared/device-host'
import type { MainToDeviceHost } from '@shared/host-control'
import type { FromPort } from '@shared/port-rpc'
import type { DriverEvents } from './driver'
import type { FoundDevice } from './discovery'
import { DeviceError, DeviceManager } from './devices'
import { startDeviceHost, type StartedDeviceHost } from './start'
import { ValidationError, validators } from './validate'

const fake = vi.hoisted(() => {
  const fake = {
    devices: [] as FoundDevice[],
    drivers: [] as Array<{ events: DriverEvents | null; sent: DeviceInput[]; stopped: boolean }>,
    /** While set, a stream does not finish starting. */
    starting: null as Promise<void> | null,
    boots: [] as string[],
    shutdowns: [] as string[],
    /** The user boots the simulator between the host's listing and its own boot. */
    bootedMeanwhile: false,
    /** The AVD each running emulator was started from. */
    avds: new Map<string, string>(),
    /** An AVD runs as `serial`, so adb lists the emulator in its place. */
    runEmulator(avd: string, serial: string): void {
      fake.devices = fake.devices.filter((device) => device.id !== `avd:${avd}`)
      fake.devices.push({
        id: `android:${serial}`,
        platform: 'android',
        kind: 'emulator',
        name: avd.replace(/_/g, ' '),
        osVersion: '16',
        model: null,
        state: 'booted',
        connection: null,
        problems: [],
        target: serial,
      })
      fake.avds.set(serial, avd)
    },
    /** The emulator `serial` went down, so its AVD is listed again. */
    stopEmulator(serial: string): void {
      const avd = fake.avds.get(serial)!
      fake.devices = fake.devices.filter((device) => device.id !== `android:${serial}`)
      fake.devices.push({
        id: `avd:${avd}`,
        platform: 'android',
        kind: 'emulator',
        name: avd.replace(/_/g, ' '),
        osVersion: null,
        model: null,
        state: 'shutdown',
        connection: null,
        problems: [],
        target: avd,
      })
    },
  }
  return fake
})

vi.mock('./discovery', () => ({
  findTools: async () => ({
    xcrun: '/usr/bin/xcrun',
    adb: '/sdk/adb',
    emulator: '/sdk/emulator/emulator',
  }),
  listSimulators: async () => fake.devices.filter((device) => device.kind === 'simulator'),
  listPhysicalIos: async () => [],
  listAndroid: async () => fake.devices.filter((device) => device.platform === 'android'),
  run: async (_file: string, args: string[]) => {
    if (args[2] === 'emu' && args[3] === 'kill') {
      fake.shutdowns.push(args[1]!)
      fake.stopEmulator(args[1]!)
    }
    return ''
  },
}))

vi.mock('./ios-simulator', () => ({
  IosSimulatorDriver: class {},
  // Answers as simctl does: false when the simulator was already booted.
  bootSimulator: async (_xcrun: string, udid: string) => {
    const device = fake.devices.find((found) => found.target === udid)
    const wasBooted = fake.bootedMeanwhile || device?.state === 'booted'
    if (device) device.state = 'booted'
    if (!wasBooted) fake.boots.push(udid)
    return !wasBooted
  },
  shutdownSimulator: async (_xcrun: string, udid: string) => {
    const device = fake.devices.find((found) => found.target === udid)
    if (device) device.state = 'shutdown'
    fake.shutdowns.push(udid)
  },
}))

vi.mock('../agent-host/shell-env', () => ({
  resolveShellEnvironment: async () => ({ env: {} }),
}))

vi.mock('./agent', () => {
  class ActionError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return {
    ActionError,
    // An agent's action that runs until it is stopped.
    AgentActions: class {
      run(_session: string, _target: unknown, _action: unknown, signal: AbortSignal) {
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new ActionError('stopped', 'Stopped'))),
        )
      }
    },
  }
})

vi.mock('./android', () => ({
  bootEmulator: async (_emulator: string, _adb: string, avd: string) => {
    fake.boots.push(avd)
    fake.runEmulator(avd, 'emulator-5556')
    return 'emulator-5556'
  },
  AndroidDriver: class {
    events: DriverEvents | null = null
    sent: DeviceInput[] = []
    stopped = false
    constructor() {
      fake.drivers.push(this)
    }
    async start(events: DriverEvents): Promise<void> {
      this.events = events
      await fake.starting
    }
    stop(): Promise<void> {
      this.stopped = true
      return Promise.resolve()
    }
    send(input: DeviceInput): void {
      this.sent.push(input)
    }
    requestKeyframe(): void {}
    screenshot(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array([1]))
    }
  },
}))

describe('device host request validators', () => {
  it('accepts well-formed requests', () => {
    expect(
      validators['devices.input']({
        deviceId: 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
        sessionId: 's1',
        input: { type: 'touch', phase: 'begin', x: 0.5, y: 0.25, finger: 1 },
      }),
    ).toEqual({
      deviceId: 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
      sessionId: 's1',
      input: { type: 'touch', phase: 'begin', x: 0.5, y: 0.25, finger: 1 },
    })
    expect(validators['devices.open']({ deviceId: 'avd:Pixel_9', sessionId: 's1' })).toEqual({
      deviceId: 'avd:Pixel_9',
      sessionId: 's1',
    })
    expect(
      validators['devices.input']({
        deviceId: 'android:emulator-5554',
        sessionId: 's1',
        input: { type: 'text', text: '你好\nworld' },
      }).input,
    ).toEqual({ type: 'text', text: '你好\nworld' })
    expect(
      validators['devices.input']({
        deviceId: 'ios-sim:x',
        sessionId: 's1',
        input: { type: 'frameButton', name: 'volume-up', phase: 'down' },
      }).input,
    ).toEqual({ type: 'frameButton', name: 'volume-up', phase: 'down' })
  })

  it('refuses what is not a device, an input or in range', () => {
    const bad: [keyof typeof validators, unknown][] = [
      ['devices.watch', { deviceId: '/dev/disk0' }],
      ['devices.watch', { deviceId: 'ios-sim:a b' }],
      ['devices.watch', { deviceId: 'ios-sim:x', sessionId: 's1', extra: 1 }],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'touch', phase: 'begin', x: 2, y: 0 } },
      ],
      ['devices.input', { deviceId: 'ios-sim:x', input: { type: 'button', button: 'shutdown' } }],
      ['devices.input', { deviceId: 'ios-sim:x', input: { type: 'text', text: 'a\u001b[2J' } }],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'key', phase: 'down', code: 'a;b' } },
      ],
      ['devices.input', { deviceId: 'ios-sim:x', input: { type: 'shell', command: 'ls' } }],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'frameButton', name: '../x', phase: 'down' } },
      ],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'frameButton', name: 'power', phase: 'hold' } },
      ],
      [
        'devices.input',
        {
          deviceId: 'ios-sim:x',
          input: { type: 'frameButton', name: 'power', phase: 'up', usage: 48 },
        },
      ],
      ['devices.ack', { deviceId: 'ios-sim:x', sessionId: 's1', seq: -1 }],
      // Watching, acknowledging, input and screenshots name the session they act for.
      ['devices.watch', { deviceId: 'ios-sim:x' }],
      ['devices.ack', { deviceId: 'ios-sim:x', seq: 1 }],
      ['devices.input', { deviceId: 'ios-sim:x', input: { type: 'button', button: 'home' } }],
      ['devices.screenshot', { deviceId: 'ios-sim:x' }],
      ['devices.unwatch', { deviceId: 'ios-sim:x' }],
      ['devices.handBack', { deviceId: 'ios-sim:x' }],
      ['devices.stopAgent', { deviceId: 'ios-sim:x' }],
      ['devices.frame', { deviceId: 'ios-sim:x' }],
      ['devices.close', { deviceId: 'ios-sim:x', sessionId: 's1', shutdown: 'yes' }],
    ]
    for (const [method, params] of bad) {
      expect(() => validators[method](params), `${method} ${JSON.stringify(params)}`).toThrow(
        ValidationError,
      )
    }
  })
})

const EMULATOR: FoundDevice = {
  id: 'android:emulator-5554',
  platform: 'android',
  kind: 'emulator',
  name: 'Pixel 9',
  osVersion: '16',
  model: null,
  state: 'booted',
  connection: null,
  problems: [],
  target: 'emulator-5554',
}

const SIMULATOR: FoundDevice = {
  id: 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
  platform: 'ios',
  kind: 'simulator',
  name: 'iPhone 17',
  osVersion: '26.5',
  model: null,
  state: 'shutdown',
  connection: null,
  problems: [],
  target: '0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
}

const AVD: FoundDevice = {
  id: 'avd:Pixel_9_Pro',
  platform: 'android',
  kind: 'emulator',
  name: 'Pixel 9 Pro',
  osVersion: null,
  model: null,
  state: 'shutdown',
  connection: null,
  problems: [],
  target: 'Pixel_9_Pro',
}

const USERS_SIMULATOR: FoundDevice = {
  ...SIMULATOR,
  id: 'ios-sim:5A1F3C70-2B7E-4C8D-9E0A-1B2C3D4E5F60',
  name: 'iPad Air',
  state: 'booted',
  target: '5A1F3C70-2B7E-4C8D-9E0A-1B2C3D4E5F60',
}

let dataDir: string
let events: { port: string | null; event: DeviceEvent }[]
const managers: DeviceManager[] = []

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'kettu-devices-'))
  events = []
  fake.devices = [{ ...EMULATOR }, { ...AVD }, { ...SIMULATOR }, { ...USERS_SIMULATOR }]
  fake.avds = new Map([[EMULATOR.target, 'Pixel_9']])
  fake.drivers = []
  fake.starting = null
  fake.boots = []
  fake.shutdowns = []
  fake.bootedMeanwhile = false
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map((devices) => devices.dispose()))
  await rm(dataDir, { recursive: true, force: true })
})

/** A device host's devices; a second one on the same folder is the host after a restart. */
function manager(): DeviceManager {
  const devices = new DeviceManager({
    platform: 'darwin',
    dataDir,
    env: async () => ({}),
    resourcesPath: null,
    emit: (port, event) => events.push({ port, event }),
    log: () => undefined,
  })
  managers.push(devices)
  return devices
}

async function restart(devices: DeviceManager): Promise<DeviceManager> {
  managers.splice(managers.indexOf(devices), 1)
  await devices.dispose()
  return manager()
}

describe('device access by session', () => {
  const frames = (port: string) =>
    events.filter((sent) => sent.port === port && sent.event.type === 'device.frame').length

  async function refused(call: Promise<unknown> | (() => unknown)): Promise<void> {
    const error = await Promise.resolve()
      .then(() => (typeof call === 'function' ? call() : call))
      .then(
        () => null,
        (reason: unknown) => reason,
      )
    expect(error).toBeInstanceOf(DeviceError)
    expect((error as DeviceError).code).toBe('forbidden')
  }

  it('serves the screen, input and screenshots only to the session that holds the device', async () => {
    const devices = manager()
    await devices.open(EMULATOR.id, 's1')
    await devices.watch('own', EMULATOR.id, 's1')
    const driver = fake.drivers[0]!

    await refused(devices.watch('other', EMULATOR.id, 's2'))
    await refused(() => devices.input(EMULATOR.id, { type: 'button', button: 'home' }, 's2'))
    await refused(() => devices.ack('other', EMULATOR.id, 1, 's2'))
    await refused(devices.screenshot(EMULATOR.id, 's2'))
    expect(driver.sent).toEqual([])

    driver.events!.frame('key', new Uint8Array([1]))
    expect(frames('own')).toBe(1)
    expect(frames('other')).toBe(0)

    devices.input(EMULATOR.id, { type: 'button', button: 'home' }, 's1')
    devices.ack('own', EMULATOR.id, 1, 's1')
    expect(driver.sent).toEqual([{ type: 'button', button: 'home' }])
    expect(await devices.screenshot(EMULATOR.id, 's1')).toEqual(new Uint8Array([1]))
  })

  it('refuses a device no session holds', async () => {
    const devices = manager()
    await devices.list()
    await refused(devices.watch('port', EMULATOR.id, 's1'))
    await refused(devices.screenshot(EMULATOR.id, 's1'))
  })

  it('stops sending frames to a session once it lets go of the device', async () => {
    const devices = manager()
    await devices.open(EMULATOR.id, 's1')
    await devices.watch('own', EMULATOR.id, 's1')
    const driver = fake.drivers[0]!
    await devices.endSessions(['s1'])

    driver.events!.frame('key', new Uint8Array([1]))
    expect(frames('own')).toBe(0)
    await refused(() => devices.input(EMULATOR.id, { type: 'button', button: 'home' }, 's1'))
    expect(driver.sent).toEqual([])
  })
})

describe('device streams', () => {
  it('stops a stream whose watchers left while it started', async () => {
    const devices = manager()
    await devices.open(EMULATOR.id, 's1')
    let started!: () => void
    fake.starting = new Promise<void>((resolve) => (started = resolve))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const left = devices.watch('left', EMULATOR.id, 's1')
      const closed = devices.watch('closed', EMULATOR.id, 's1')
      for (let i = 0; i < 50 && !fake.drivers.some((driver) => driver.events); i++) {
        await Promise.resolve()
      }
      devices.unwatch('left', EMULATOR.id, 's1')
      devices.portClosed('closed')
      started()
      await Promise.all([left, closed])
      // Two watches at once share one capture.
      expect(fake.drivers).toHaveLength(1)

      fake.drivers[0]!.events!.frame('key', new Uint8Array([1]))
      expect(events.filter((sent) => sent.event.type === 'device.frame')).toEqual([])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fake.drivers[0]!.stopped).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('simulators the host booted', () => {
  it('shuts one down when its only tab closes, and leaves the one the user started on', async () => {
    const devices = manager()
    await devices.open(SIMULATOR.id, 's1')
    await devices.open(USERS_SIMULATOR.id, 's1')
    expect(fake.boots).toEqual([SIMULATOR.target])

    await devices.close(SIMULATOR.id, 's1', false)
    await devices.close(USERS_SIMULATOR.id, 's1', false)
    expect(fake.shutdowns).toEqual([SIMULATOR.target])
  })

  it('shuts one down when the session holding it ends', async () => {
    const devices = manager()
    await devices.open(SIMULATOR.id, 's1')
    await devices.open(USERS_SIMULATOR.id, 's1')
    await devices.endSessions(['s1'])
    expect(fake.shutdowns).toEqual([SIMULATOR.target])
  })

  it('remembers which it booted across a restart of the host', async () => {
    let devices = manager()
    await devices.open(SIMULATOR.id, 's1')
    await devices.open(USERS_SIMULATOR.id, 's2')
    devices = await restart(devices)

    await devices.close(SIMULATOR.id, 's1', false)
    await devices.endSessions(['s2'])
    expect(fake.shutdowns).toEqual([SIMULATOR.target])
  })

  it('leaves one on that the user booted again after it was shut down', async () => {
    let devices = manager()
    await devices.open(SIMULATOR.id, 's1')
    // The user shuts it down while the session holds it, and later boots it themselves.
    fake.devices.find((device) => device.id === SIMULATOR.id)!.state = 'shutdown'
    await devices.list()
    fake.devices.find((device) => device.id === SIMULATOR.id)!.state = 'booted'
    devices = await restart(devices)

    await devices.close(SIMULATOR.id, 's1', false)
    expect(fake.shutdowns).toEqual([])
  })

  it('leaves one on that the user booted while the host was about to', async () => {
    const devices = manager()
    fake.bootedMeanwhile = true
    await devices.open(SIMULATOR.id, 's1')
    await devices.close(SIMULATOR.id, 's1', false)
    expect(fake.shutdowns).toEqual([])
  })
})

/** The device host as main runs it, its agent calls in and a port per client. */
function startHost(): {
  call(request: DeviceCall): Promise<DeviceCallAnswer>
  port(): { request(method: string, params: unknown): Promise<unknown> }
} {
  const answers = new Map<number, (answer: DeviceCallAnswer) => void>()
  let control: ((message: MainToDeviceHost) => void) | null = null
  const host: StartedDeviceHost = startDeviceHost({
    send: (message) => {
      if (message.type === 'device-host:answer') answers.get(message.callId)?.(message.answer)
    },
    onMessage: (listener) => (control = listener),
  })
  control!({
    type: 'device-host:init',
    platform: 'darwin',
    appVersion: '0.0.0',
    nodeRuntime: { command: 'node', env: {} },
    // No folder, so the leases stay in memory.
    dataDir: '',
    resourcesPath: null,
    allowDevices: true,
  })
  let calls = 0
  return {
    call: (request) =>
      new Promise((resolve) => {
        const callId = ++calls
        answers.set(callId, resolve)
        control!({ type: 'device-host:call', callId, call: request })
      }),
    port: () => {
      const waiting = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>()
      let toHost: ((data: unknown) => void) | null = null
      let requests = 0
      host.connect(
        {
          send: (message: FromPort<DeviceEvent>) => {
            if (message.type === 'response') waiting.get(message.id)?.resolve(message.result)
            if (message.type === 'error') waiting.get(message.id)?.reject(message.error)
          },
          onMessage: (listener) => (toHost = listener),
          onClose: () => undefined,
          close: () => undefined,
        },
        1,
      )
      return {
        request: (method, params) =>
          new Promise((resolve, reject) => {
            const id = ++requests
            waiting.set(id, { resolve, reject })
            toHost!({ type: 'request', id, method, params })
          }),
      }
    },
  }
}

describe('emulators the host booted', () => {
  it('shuts one down when its only tab closes, and leaves the one the user started on', async () => {
    const devices = manager()
    const started = await devices.open(AVD.id, 's1')
    await devices.open(EMULATOR.id, 's1')
    expect(fake.boots).toEqual([AVD.target])

    await devices.close(started.id, 's1', false)
    await devices.close(EMULATOR.id, 's1', false)
    expect(fake.shutdowns).toEqual([started.id.slice('android:'.length)])
  })

  it('shuts one down when the session holding it ends', async () => {
    const devices = manager()
    const started = await devices.open(AVD.id, 's1')
    await devices.open(EMULATOR.id, 's1')
    await devices.endSessions(['s1'])
    expect(fake.shutdowns).toEqual([started.id.slice('android:'.length)])
  })

  it('remembers which it booted across a restart of the host', async () => {
    let devices = manager()
    const started = await devices.open(AVD.id, 's1')
    await devices.open(EMULATOR.id, 's2')
    devices = await restart(devices)

    await devices.close(started.id, 's1', false)
    await devices.endSessions(['s2'])
    expect(fake.shutdowns).toEqual([started.id.slice('android:'.length)])
  })

  it('still shuts one down that was offline for a while', async () => {
    const devices = manager()
    const started = await devices.open(AVD.id, 's1')
    const running = fake.devices.find((device) => device.id === started.id)!
    // adb lists an offline emulator without reading its AVD, so the AVD is listed as well.
    running.state = 'unavailable'
    fake.devices.push({ ...AVD })
    await devices.list()
    running.state = 'booted'
    fake.devices = fake.devices.filter((device) => device.id !== AVD.id)
    await devices.list()

    await devices.close(started.id, 's1', false)
    expect(fake.shutdowns).toEqual([started.id.slice('android:'.length)])
  })

  it('leaves one on that the user started again under the same serial', async () => {
    let devices = manager()
    const started = await devices.open(AVD.id, 's1')
    const serial = started.id.slice('android:'.length)
    // The user shuts it down while the session holds it, and later starts it themselves.
    fake.stopEmulator(serial)
    await devices.list()
    fake.runEmulator(AVD.target, serial)
    devices = await restart(devices)

    await devices.close(started.id, 's1', false)
    expect(fake.shutdowns).toEqual([])
  })
})

describe('device operations by session', () => {
  it('lets only the session holding a device stop its agent, hand it back or take its frames', async () => {
    const host = startHost()
    const own = host.port()
    const other = host.port()
    expect(
      await host.call({ kind: 'open', sessionId: 's1', agentName: 'Agent', deviceId: EMULATOR.id }),
    ).toHaveProperty('result')
    const acting = host.call({
      kind: 'action',
      sessionId: 's1',
      agentName: 'Agent',
      deviceId: EMULATOR.id,
      action: { type: 'snapshot' },
      projectPath: null,
    })

    const asOther: [string, Record<string, unknown>][] = [
      ['devices.stopAgent', {}],
      ['devices.handBack', {}],
      ['devices.frame', {}],
      ['devices.ack', { seq: 1 }],
      ['devices.unwatch', {}],
    ]
    for (const [method, params] of asOther) {
      await expect(
        other.request(method, { deviceId: EMULATOR.id, sessionId: 's2', ...params }),
        method,
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
    const running = await Promise.race([
      acting,
      new Promise((resolve) => setTimeout(() => resolve('running'), 20)),
    ])
    expect(running).toBe('running')

    await own.request('devices.stopAgent', { deviceId: EMULATOR.id, sessionId: 's1' })
    expect(await acting).toMatchObject({ error: { code: 'stopped' } })
    await own.request('devices.handBack', { deviceId: EMULATOR.id, sessionId: 's1' })
    await own.request('devices.frame', { deviceId: EMULATOR.id, sessionId: 's1' })
    await own.request('devices.unwatch', { deviceId: EMULATOR.id, sessionId: 's1' })
  })
})
