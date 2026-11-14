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
}))

vi.mock('./discovery', () => ({
  findTools: async () => ({ xcrun: '/usr/bin/xcrun', adb: '/sdk/adb', emulator: null }),
  listSimulators: async () => fake.devices.filter((device) => device.kind === 'simulator'),
  listPhysicalIos: async () => [],
  listAndroid: async () => fake.devices.filter((device) => device.platform === 'android'),
  run: async () => '',
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

describe('device access by session', () => {
  let dataDir: string
  let events: { port: string | null; event: DeviceEvent }[]

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'kettu-devices-'))
    events = []
    fake.devices = [{ ...EMULATOR }]
    fake.drivers = []
  })

  const managers: DeviceManager[] = []

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((devices) => devices.dispose()))
    await rm(dataDir, { recursive: true, force: true })
  })

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
    devices.endSessions(['s1'])

    driver.events!.frame('key', new Uint8Array([1]))
    expect(frames('own')).toBe(0)
    await refused(() => devices.input(EMULATOR.id, { type: 'button', button: 'home' }, 's1'))
    expect(driver.sent).toEqual([])
  })
})
