import { describe, expect, it, vi } from 'vitest'
import type { DeviceAccessAnswer, DeviceCall, DeviceCallAnswer } from '@shared/device-agent'
import { parseDeviceAccessFile } from './access'
import { actionOf, DeviceArgsError, DeviceTools, type DeviceToolDeps } from './tools'

const caller = { sessionId: 's1', project: '/work/app' }
const SIM = 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF'

// By default the user connected the simulator to the session, so the agent asks before using it.
function tools(
  answer: DeviceAccessAnswer,
  always: string[] = [],
  device: { kind: string; sessionId: string | null } = { kind: 'simulator', sessionId: 's1' },
  extra: Partial<DeviceToolDeps> = {},
) {
  const calls: DeviceCall[] = []
  const stored = new Set(always)
  const deps: DeviceToolDeps = {
    call: async (call): Promise<DeviceCallAnswer> => {
      calls.push(call)
      if (call.kind === 'list') {
        const listed = { id: SIM, name: 'iPhone 17 Pro', ...device }
        return { result: { text: '', value: { devices: [listed] } } }
      }
      return { result: { text: 'done' } }
    },
    sessionOf: (sessionId) => sessionId,
    agentName: () => 'Claude Code',
    projectOf: () => '/work/app',
    ask: vi.fn(async () => answer),
    alwaysAllowed: (id) => stored.has(id),
    allowAlways: (id) => stored.add(id),
    ...extra,
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

  it("asks again after the session's allow is taken back, for that session and device only", async () => {
    const { tools: subject, deps, calls } = tools('session')
    const other = { sessionId: 's2', project: '/work/app' }
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    await subject.call(other, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(2)

    subject.revoke('s1', SIM)
    await subject.call(other, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(2)
    vi.mocked(deps.ask).mockResolvedValueOnce('deny')
    const refused = await subject.call(caller, 'device_tap', { deviceId: SIM, ref: '@e1' })
    expect(deps.ask).toHaveBeenCalledTimes(3)
    expect(refused.structuredContent).toMatchObject({ code: 'not_allowed' })
    expect(calls.filter((call) => call.kind === 'action')).toHaveLength(3)
  })

  it('keeps an always-allowed device allowed when a session takes its allow back', async () => {
    const { tools: subject, deps } = tools('always')
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    subject.revoke('s1', SIM)
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(1)
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

  it('lets the agent use a simulator it connects itself without asking', async () => {
    const {
      tools: subject,
      deps,
      calls,
    } = tools('deny', [], { kind: 'simulator', sessionId: null })
    await subject.call(caller, 'device_open', { deviceId: SIM })
    await subject.call(caller, 'device_tap', { deviceId: SIM, ref: '@e1' })
    expect(deps.ask).not.toHaveBeenCalled()
    expect(calls.filter((call) => call.kind === 'open' || call.kind === 'action')).toHaveLength(2)
  })

  it('asks before a physical device, whoever connects it', async () => {
    const { tools: subject, deps } = tools('deny', [], { kind: 'physical', sessionId: null })
    const result = await subject.call(caller, 'device_open', { deviceId: SIM })
    expect(deps.ask).toHaveBeenCalledTimes(1)
    expect(result.structuredContent).toMatchObject({ code: 'not_allowed' })
  })

  it('asks nothing in full access, and the thread says it used the device', async () => {
    const used = vi.fn()
    const { tools: subject, deps } = tools('deny', [], undefined, {
      fullAccess: () => true,
      used,
    })
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).not.toHaveBeenCalled()
    expect(used).toHaveBeenCalledWith('s1', 'iPhone 17 Pro')
  })

  it('asks nothing for a device the user referenced in a message', async () => {
    const { tools: subject, deps } = tools('deny', [], undefined, { shared: () => true })
    await subject.call(caller, 'device_snapshot', { deviceId: SIM })
    expect(deps.ask).not.toHaveBeenCalled()
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
