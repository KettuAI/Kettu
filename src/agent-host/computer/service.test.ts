import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  ComputerApp,
  ComputerPermissions,
  ComputerSetupStep,
  ComputerUseSettings,
} from '@shared/computer-use'
import {
  COMPUTER_APP_WAIT_MS,
  COMPUTER_SETUP_POLL_MS,
  COMPUTER_SETUP_WAIT_MS,
} from '@shared/computer-use'
import type { ComputerUseView } from '@shared/thread'
import { ComputerUse, HOLD_IDLE_MS, type ComputerUseDeps, type DriverLike } from './service'

const APPS = [
  {
    pid: 10,
    name: 'TextEdit',
    bundle_id: 'com.apple.TextEdit',
    launch_path: '/System/Applications/TextEdit.app',
    running: true,
    active: false,
  },
  { pid: 11, name: 'Terminal', bundle_id: 'com.apple.Terminal', running: true, active: false },
  { pid: 12, name: 'Notes', bundle_id: 'com.apple.Notes', running: true, active: false },
  { pid: 13, name: 'Kettu', bundle_id: 'sh.kettu.app', running: true, active: true },
  { pid: 0, name: 'Pages', bundle_id: 'com.apple.iWork.Pages', running: false, active: false },
]

class FakeDriver implements DriverLike {
  calls: { tool: string; args: Record<string, unknown> }[] = []
  stopped = 0

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ tool, args })
    if (tool === 'list_apps') {
      return { content: [{ type: 'text', text: 'apps' }], structuredContent: { apps: APPS } }
    }
    if (tool === 'get_window_state') {
      return {
        content: [
          { type: 'text', text: '[1] button "Save"' },
          { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
          { type: 'resource_link', uri: 'file:///tmp/x.png', name: 'x' },
        ],
        structuredContent: { snapshot_id: `s${String(args.pid).padStart(8, '0')}` },
      }
    }
    return { content: [{ type: 'text', text: `${tool} done` }] }
  }

  async stop(): Promise<void> {
    this.stopped++
  }

  acted(): string[] {
    return this.calls.map((call) => call.tool).filter((tool) => tool !== 'list_apps')
  }
}

interface Harness {
  service: ComputerUse
  deps: ComputerUseDeps
  driver: FakeDriver
  settings: ComputerUseSettings
  asked: { sessionId: string; requestId: number; app: ComputerApp }[]
  settled: [number, string][]
  always: ComputerApp[]
  using: [string, ComputerUseView | null][]
  refusal: Map<string, string>
  /** What the permission probe reports; null when it cannot tell. */
  permissions: ComputerPermissions | null
  probes: number
  setups: { sessionId: string; requestId: number; steps: ComputerSetupStep[] }[]
  done: [number, ComputerSetupStep[]][]
  setupSettled: [number, string][]
  stopped: string[]
}

function harness(overrides: { driver?: DriverLike | null } = {}): Harness {
  const driver = new FakeDriver()
  const h: Omit<Harness, 'service' | 'deps'> = {
    driver,
    settings: { enabled: true, allowedApps: [] },
    asked: [],
    settled: [],
    always: [],
    using: [],
    refusal: new Map(),
    permissions: { accessibility: true, screenRecording: true },
    probes: 0,
    setups: [],
    done: [],
    setupSettled: [],
    stopped: [],
  }
  const deps: ComputerUseDeps = {
    platform: 'darwin',
    driver: overrides.driver === undefined ? driver : overrides.driver,
    self: { pids: [13], ids: ['sh.kettu.app'] },
    settings: () => h.settings,
    turnRefusal: (sessionId) => h.refusal.get(sessionId) ?? null,
    sessionTitle: (sessionId) => `Title of ${sessionId}`,
    asked: (sessionId, requestId, app) => h.asked.push({ sessionId, requestId, app }),
    settled: (requestId, answer) => h.settled.push([requestId, answer]),
    allowAlways: (app) => h.always.push(app),
    using: (sessionId, view) => h.using.push([sessionId, view]),
    permissions: async () => {
      h.probes++
      return h.permissions && { ...h.permissions }
    },
    setupAsked: (sessionId, requestId, steps) => h.setups.push({ sessionId, requestId, steps }),
    setupDone: (requestId, done) => h.done.push([requestId, done]),
    setupSettled: (requestId, outcome) => h.setupSettled.push([requestId, outcome]),
    stopped: (sessionId) => h.stopped.push(sessionId),
    log: () => {},
  }
  return Object.assign(h, { service: new ComputerUse(deps), deps })
}

/** Runs a call that asks the user, answering the question once it shows. */
async function answered(
  h: Harness,
  sessionId: string,
  name: string,
  input: unknown,
  decision: 'session' | 'always' | 'deny',
): Promise<CallToolResult> {
  const before = h.asked.length
  const pending = h.service.call(sessionId, name, input)
  await vi.waitFor(() => expect(h.asked.length).toBeGreaterThan(before))
  expect(h.service.answer(h.asked[h.asked.length - 1]!.requestId, decision)).toBe(true)
  return pending
}

function code(result: CallToolResult): unknown {
  return (result.structuredContent as { code?: unknown } | undefined)?.code
}

const READ = { pid: 10, window_id: 1 }

afterEach(() => {
  vi.useRealTimers()
})

describe('who may use the computer', () => {
  it('refuses on a host without the driver and for a refused turn, without a setup card', async () => {
    const off = harness()
    off.settings.enabled = false
    off.refusal.set('a', 'This turn came from elsewhere.')
    expect(code(await off.service.call('a', 'computer_list_apps', {}))).toBe('unavailable')
    expect(off.setups).toEqual([])
    const none = harness({ driver: null })
    expect(code(await none.service.call('a', 'computer_list_apps', {}))).toBe('unavailable')
    const remote = harness()
    remote.refusal.set('a', 'This turn came from elsewhere.')
    const result = await remote.service.call('a', 'computer_list_apps', {})
    expect(code(result)).toBe('unavailable')
    expect(result.content[0]).toEqual({ type: 'text', text: 'This turn came from elsewhere.' })
    expect(off.driver.calls).toEqual([])
    expect(remote.driver.calls).toEqual([])
  })

  it('lists the running apps and says which are never used', async () => {
    const h = harness()
    const result = await h.service.call('a', 'computer_list_apps', {})
    expect(result.structuredContent).toEqual({
      apps: [
        { name: 'TextEdit', pid: 10, id: 'com.apple.textedit', available: true },
        { name: 'Terminal', pid: 11, id: 'com.apple.terminal', available: false },
        { name: 'Notes', pid: 12, id: 'com.apple.notes', available: true },
        { name: 'Kettu', pid: 13, id: 'sh.kettu.app', available: false },
      ],
    })
  })
})

describe('approval', () => {
  it('asks on the first use of an app in a session, then not again', async () => {
    const h = harness()
    const first = await answered(h, 'a', 'computer_get_window_state', READ, 'session')
    expect(first.isError).toBeUndefined()
    // Only text and pictures pass; a link to a file of the driver's does not.
    expect(first.content.map((item) => item.type)).toEqual(['text', 'image'])
    expect(h.asked).toEqual([
      { sessionId: 'a', requestId: 1, app: { id: 'com.apple.textedit', name: 'TextEdit' } },
    ])
    expect(h.settled).toEqual([[1, 'session']])
    await h.service.call('a', 'computer_click', { ...READ, x: 5, y: 5 })
    expect(h.asked).toHaveLength(1)
    expect(h.driver.acted()).toEqual(['get_window_state', 'click'])
  })

  it('asks every other session again, and each app on its own', async () => {
    const h = harness()
    await answered(h, 'a', 'computer_list_windows', { pid: 10 }, 'session')
    h.service.turnEnded('a')
    await answered(h, 'b', 'computer_list_windows', { pid: 10 }, 'session')
    await answered(h, 'b', 'computer_list_windows', { pid: 12 }, 'session')
    expect(h.asked.map((ask) => [ask.sessionId, ask.app.id])).toEqual([
      ['a', 'com.apple.textedit'],
      ['b', 'com.apple.textedit'],
      ['b', 'com.apple.notes'],
    ])
  })

  it('keeps a denial for the rest of the turn without asking again', async () => {
    const h = harness()
    expect(code(await answered(h, 'a', 'computer_list_windows', { pid: 10 }, 'deny'))).toBe(
      'not_allowed',
    )
    expect(code(await h.service.call('a', 'computer_list_windows', { pid: 10 }))).toBe(
      'not_allowed',
    )
    expect(h.asked).toHaveLength(1)
    expect(h.driver.acted()).toEqual([])
    h.service.turnEnded('a')
    void h.service.call('a', 'computer_list_windows', { pid: 10 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(2))
  })

  it('hands Always allow to main and asks no more for an app the settings allow', async () => {
    const h = harness()
    await answered(h, 'a', 'computer_list_windows', { pid: 10 }, 'always')
    expect(h.always).toEqual([{ id: 'com.apple.textedit', name: 'TextEdit' }])
    h.settings.allowedApps = [{ id: 'com.apple.notes', name: 'Notes' }]
    await h.service.call('a', 'computer_list_windows', { pid: 12 })
    expect(h.asked).toHaveLength(1)
  })

  it('fails a question nobody answers in time', async () => {
    vi.useFakeTimers()
    const h = harness()
    const pending = h.service.call('a', 'computer_list_windows', { pid: 10 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(COMPUTER_APP_WAIT_MS)
    expect(code(await pending)).toBe('not_allowed')
    expect(h.settled).toEqual([[1, 'timeout']])
  })

  it('ends a question when its turn ends', async () => {
    const h = harness()
    const pending = h.service.call('a', 'computer_list_windows', { pid: 10 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    h.service.turnEnded('a')
    expect(code(await pending)).toBe('not_allowed')
    expect(h.service.answer(1, 'session')).toBe(false)
  })
})

describe('what is never touched', () => {
  it('blocks terminals and Kettu without asking', async () => {
    const h = harness()
    expect(code(await h.service.call('a', 'computer_list_windows', { pid: 11 }))).toBe('blocked')
    expect(
      code(await h.service.call('a', 'computer_click', { pid: 13, window_id: 1, x: 1, y: 1 })),
    ).toBe('blocked')
    expect(h.asked).toEqual([])
    expect(h.driver.acted()).toEqual([])
  })

  it('refuses shortcuts and menu items that quit', async () => {
    const h = harness()
    h.settings.allowedApps = [{ id: 'com.apple.textedit', name: 'TextEdit' }]
    expect(
      code(await h.service.call('a', 'computer_hotkey', { ...READ, keys: ['cmd', 'q'] })),
    ).toBe('blocked')
    expect(
      code(
        await h.service.call('a', 'computer_invoke_menu', {
          ...READ,
          path: ['TextEdit', 'Quit TextEdit'],
        }),
      ),
    ).toBe('blocked')
    expect(h.driver.acted()).toEqual([])
  })

  it('takes an element token only from a read of the same app', async () => {
    const h = harness()
    h.settings.allowedApps = [
      { id: 'com.apple.textedit', name: 'TextEdit' },
      { id: 'com.apple.notes', name: 'Notes' },
    ]
    expect(
      code(await h.service.call('a', 'computer_click', { ...READ, element_token: 's00000010:1' })),
    ).toBe('invalid')
    await h.service.call('a', 'computer_get_window_state', READ)
    await h.service.call('a', 'computer_get_window_state', { pid: 12, window_id: 2 })
    expect(
      code(
        await h.service.call('a', 'computer_click', {
          pid: 12,
          window_id: 2,
          element_token: 's00000010:1',
        }),
      ),
    ).toBe('invalid')
    const ok = await h.service.call('a', 'computer_click', {
      ...READ,
      element_token: 's00000010:1',
    })
    expect(ok.isError).toBeUndefined()
  })

  it('does not trust a process id it cannot find', async () => {
    const h = harness()
    expect(code(await h.service.call('a', 'computer_list_windows', { pid: 99 }))).toBe('invalid')
    expect(h.asked).toEqual([])
  })
})

describe('one session at a time', () => {
  it('refuses another session while one holds the computer, until its turn ends', async () => {
    const h = harness()
    h.settings.allowedApps = [{ id: 'com.apple.textedit', name: 'TextEdit' }]
    await h.service.call('a', 'computer_get_window_state', READ)
    const busy = await h.service.call('b', 'computer_get_window_state', READ)
    expect(code(busy)).toBe('busy')
    expect(busy.content[0]).toMatchObject({ text: expect.stringContaining('Title of a') })
    h.service.turnEnded('a')
    expect((await h.service.call('b', 'computer_get_window_state', READ)).isError).toBeUndefined()
    const textEdit = {
      app: 'TextEdit',
      appPath: '/System/Applications/TextEdit.app',
      action: 'read',
    }
    expect(h.using).toEqual([
      ['a', { app: null, appPath: null, action: null }],
      ['a', textEdit],
      ['a', null],
      ['b', { app: null, appPath: null, action: null }],
      ['b', textEdit],
    ])
  })

  it('lets go after the session goes quiet', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.service.call('a', 'computer_list_apps', {})
    await vi.advanceTimersByTimeAsync(HOLD_IDLE_MS)
    expect(code(await h.service.call('b', 'computer_list_apps', {}))).toBeUndefined()
  })

  it('stops the driver on Stop and refuses the rest of the turn', async () => {
    const h = harness()
    await h.service.call('a', 'computer_list_apps', {})
    h.service.stop('a')
    expect(h.driver.stopped).toBe(1)
    expect(h.stopped).toEqual(['a'])
    expect(code(await h.service.call('a', 'computer_list_apps', {}))).toBe('stopped')
    h.service.turnEnded('a')
    expect(code(await h.service.call('a', 'computer_list_apps', {}))).toBeUndefined()
  })

  it('tells a call waiting on its question that the user stopped it', async () => {
    const h = harness()
    const pending = h.service.call('a', 'computer_list_windows', { pid: 10 })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    h.service.stop('a')
    expect(code(await pending)).toBe('stopped')
    expect(h.settled).toEqual([[1, 'timeout']])
  })

  it('lets go and ends the driver when computer use is turned off', async () => {
    const h = harness()
    await h.service.call('a', 'computer_list_apps', {})
    h.settings.enabled = false
    h.service.settingsChanged()
    expect(h.using[h.using.length - 1]).toEqual(['a', null])
    expect(h.driver.stopped).toBe(1)
  })
})

describe('setup', () => {
  it('waits on a setup card while computer use is off, and goes on once it is on', async () => {
    const h = harness()
    h.settings.enabled = false
    const pending = h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(1))
    expect(h.setups[0]).toMatchObject({ sessionId: 'a', steps: ['enable'] })
    expect(h.driver.calls).toEqual([])
    h.settings.enabled = true
    h.service.settingsChanged()
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(h.done).toEqual([[h.setups[0]!.requestId, ['enable']]])
    expect(h.setupSettled).toEqual([[h.setups[0]!.requestId, 'ready']])
    expect(h.driver.acted()).toEqual([])
    expect(h.driver.calls.map((call) => call.tool)).toEqual(['list_apps'])
  })

  it('asks for the missing macOS permissions and checks them until both are granted', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.permissions = { accessibility: false, screenRecording: false }
    const pending = h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(1))
    const { requestId, steps } = h.setups[0]!
    expect(steps).toEqual(['accessibility', 'screen-recording'])
    h.permissions = { accessibility: true, screenRecording: false }
    await vi.advanceTimersByTimeAsync(COMPUTER_SETUP_POLL_MS)
    expect(h.done).toEqual([[requestId, ['accessibility']]])
    expect(h.setupSettled).toEqual([])
    h.permissions = { accessibility: true, screenRecording: true }
    await vi.advanceTimersByTimeAsync(COMPUTER_SETUP_POLL_MS)
    expect((await pending).isError).toBeUndefined()
    expect(h.setupSettled).toEqual([[requestId, 'ready']])
    const probes = h.probes
    await h.service.call('a', 'computer_list_apps', {})
    expect(h.probes).toBe(probes)
  })

  it('lists every missing step on one card', async () => {
    const h = harness()
    h.settings.enabled = false
    h.permissions = { accessibility: true, screenRecording: false }
    void h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(1))
    expect(h.setups[0]!.steps).toEqual(['enable', 'screen-recording'])
    h.service.turnEnded('a')
  })

  it('goes on when the probe cannot tell, so the driver says what is wrong', async () => {
    const h = harness()
    h.permissions = null
    expect((await h.service.call('a', 'computer_list_apps', {})).isError).toBeUndefined()
    expect(h.setups).toEqual([])
  })

  it('checks no permissions off macOS', async () => {
    const h = harness()
    h.permissions = { accessibility: false, screenRecording: false }
    const linux = new ComputerUse({ ...h.deps, platform: 'linux' })
    expect((await linux.call('a', 'computer_list_apps', {})).isError).toBeUndefined()
    expect(h.probes).toBe(0)
  })

  it('shares one card between the calls of a session', async () => {
    const h = harness()
    h.settings.enabled = false
    const first = h.service.call('a', 'computer_list_apps', {})
    const second = h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.setups).toHaveLength(1)
    h.settings.enabled = true
    h.service.settingsChanged()
    expect((await first).isError).toBeUndefined()
    expect((await second).isError).toBeUndefined()
  })

  it('fails on Not now and asks no more in the turn, until the turn ends', async () => {
    const h = harness()
    h.settings.enabled = false
    const pending = h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(1))
    expect(h.service.declineSetup(h.setups[0]!.requestId)).toBe(true)
    expect(h.service.declineSetup(h.setups[0]!.requestId)).toBe(false)
    const result = await pending
    expect(code(result)).toBe('unavailable')
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('not to set up') })
    expect(h.setupSettled).toEqual([[h.setups[0]!.requestId, 'declined']])
    expect(code(await h.service.call('a', 'computer_list_apps', {}))).toBe('unavailable')
    expect(h.setups).toHaveLength(1)
    h.service.turnEnded('a')
    void h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(2))
    h.service.turnEnded('a')
  })

  it('fails a setup nobody finishes in time', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.settings.enabled = false
    const pending = h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(COMPUTER_SETUP_WAIT_MS)
    expect(code(await pending)).toBe('unavailable')
    expect(h.setupSettled).toEqual([[h.setups[0]!.requestId, 'timeout']])
  })

  it('ends the card when the turn ends', async () => {
    const h = harness()
    h.settings.enabled = false
    const pending = h.service.call('a', 'computer_list_apps', {})
    await vi.waitFor(() => expect(h.setups).toHaveLength(1))
    h.service.turnEnded('a')
    expect(code(await pending)).toBe('unavailable')
    expect(h.setupSettled).toEqual([[h.setups[0]!.requestId, 'timeout']])
  })
})
