import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEvent, DeviceInput } from '@shared/device-host'
import type { DriverEvents } from './driver'
import type { FoundDevice } from './discovery'
import { DeviceError, DeviceManager } from './devices'
import { ValidationError, validators } from './validate'

const fake = vi.hoisted(() => ({
  devices: [] as FoundDevice[],
  drivers: [] as Array<{ events: DriverEvents | null; sent: DeviceInput[] }>,
  boots: [] as string[],
  shutdowns: [] as string[],
  /** The user boots the simulator between the host's listing and its own boot. */
  bootedMeanwhile: false,
}))

vi.mock('./discovery', () => ({
  findTools: async () => ({ xcrun: '/usr/bin/xcrun', adb: '/sdk/adb', emulator: null }),
  listSimulators: async () => fake.devices.filter((device) => device.kind === 'simulator'),
  listPhysicalIos: async () => [],
  listAndroid: async () => fake.devices.filter((device) => device.platform === 'android'),
  run: async () => '',
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

vi.mock('./android', () => ({
  bootEmulator: async () => 'emulator-5554',
  AndroidDriver: class {
    events: DriverEvents | null = null
    sent: DeviceInput[] = []
    constructor() {
      fake.drivers.push(this)
    }
    start(events: DriverEvents): Promise<void> {
      this.events = events
      return Promise.resolve()
    }
    stop(): Promise<void> {
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
  fake.devices = [{ ...EMULATOR }, { ...SIMULATOR }, { ...USERS_SIMULATOR }]
  fake.drivers = []
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
