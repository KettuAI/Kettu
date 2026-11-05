import { describe, expect, it, vi } from 'vitest'
import type { DeviceAccessAnswer, DeviceCall, DeviceCallAnswer } from '@shared/device-agent'
import { parseDeviceAccessFile } from './access'
import { actionOf, DeviceArgsError, DeviceTools, type DeviceToolDeps } from './tools'

const caller = { sessionId: 's1', project: '/work/app' }
const SIM = 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF'

function tools(answer: DeviceAccessAnswer, always: string[] = []) {
  const calls: DeviceCall[] = []
  const stored = new Set(always)
  const deps: DeviceToolDeps = {
    call: async (call): Promise<DeviceCallAnswer> => {
      calls.push(call)
      if (call.kind === 'list') {
        return { result: { text: '', value: { devices: [{ id: SIM, name: 'iPhone 17 Pro' }] } } }
      }
      return { result: { text: 'done' } }
    },
    sessionOf: (sessionId) => sessionId,
    agentName: () => 'Claude Code',
    projectOf: () => '/work/app',
    ask: vi.fn(async () => answer),
    alwaysAllowed: (id) => stored.has(id),
    allowAlways: (id) => stored.add(id),
  }
  return { tools: new DeviceTools(deps), deps, calls, stored }
}

describe('device tool arguments', () => {
  it('accepts element references and points', () => {
    expect(actionOf('device_tap', { ref: 'e3' })).toEqual({ type: 'tap', ref: '@e3', long: false })
    expect(actionOf('device_tap', { ref: '@e12~s4', long: true })).toEqual({
      type: 'tap',
      ref: '@e12~s4',
      long: true,
    })
    expect(actionOf('device_tap', { x: 20, y: 40 })).toEqual({
      type: 'tap',
      x: 20,
      y: 40,
      long: false,
    })
  })

  it('refuses what could reach a command line as a flag or another command', () => {
    expect(() => actionOf('device_tap', { ref: '--help' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_launch_app', { app: '--session=other' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_launch_app', { app: '../x' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_open_url', { url: '--relaunch' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_install_app', { path: '/tmp/script.sh' })).toThrow(
      DeviceArgsError,
    )
    expect(() => actionOf('device_type', { text: 'a\u0000b' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_press_button', { button: 'power-off' })).toThrow(DeviceArgsError)
    expect(() => actionOf('device_set_location', { latitude: 91, longitude: 0 })).toThrow(
      DeviceArgsError,
    )
  })

  it('keeps apps, links and installs it can name', () => {
    expect(actionOf('device_launch_app', { app: 'com.example.app' })).toEqual({
      type: 'launch',
      app: 'com.example.app',
    })
    expect(actionOf('device_open_url', { url: 'myapp://settings/profile' })).toEqual({
      type: 'open_url',
      url: 'myapp://settings/profile',
    })
    expect(actionOf('device_install_app', { path: 'build/App.app' })).toEqual({
      type: 'install',
      path: 'build/App.app',
    })
  })
})

describe('device access', () => {
  it('asks once per session and device, then lets the session act', async () => {
    const { tools: subject, deps, calls } = tools('session')
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    await subject.call(caller, 'device_tap', { deviceId: SIM, ref: '@e1' })
    expect(deps.ask).toHaveBeenCalledTimes(1)
    expect(deps.ask).toHaveBeenCalledWith('s1', SIM, 'iPhone 17 Pro')
    expect(calls.filter((call) => call.kind === 'action')).toHaveLength(2)
  })

  it('does nothing on the device when the user denies or does not answer', async () => {
    for (const answer of ['deny', 'timeout'] as const) {
      const { tools: subject, calls } = tools(answer)
      const result = await subject.call(caller, 'device_open', { deviceId: SIM })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'not_allowed' })
      expect(calls.some((call) => call.kind !== 'list')).toBe(false)
    }
  })

  it('keeps an always-allowed device and skips the question for it', async () => {
    const first = tools('always')
    await first.tools.call(caller, 'device_open', { deviceId: SIM })
    expect(first.stored.has(SIM)).toBe(true)
    const second = tools('deny', [SIM])
    await second.tools.call(caller, 'device_open', { deviceId: SIM })
    expect(second.deps.ask).not.toHaveBeenCalled()
  })

  it('answers listing without asking', async () => {
    const { tools: subject, deps } = tools('deny')
    const result = await subject.call(caller, 'device_list', {})
    expect(result.isError).toBeUndefined()
    expect(deps.ask).not.toHaveBeenCalled()
  })
})

describe('always-allowed devices file', () => {
  it('keeps only device ids, once each', () => {
    expect(
      parseDeviceAccessFile({ allowed: [SIM, SIM, 'android:emulator-5554', '../etc', 7, 'x:y'] }),
    ).toEqual({ version: 1, allowed: [SIM, 'android:emulator-5554'] })
    expect(typeof parseDeviceAccessFile({ allowed: 'all' })).toBe('string')
  })
})
