import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ComputerApp, ComputerUseSettings } from '@shared/computer-use'
import { COMPUTER_APP_WAIT_MS } from '@shared/computer-use'
import { ComputerUse, type ComputerUseDeps, type DriverLike } from './service'

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

  async stop(): Promise<void> {}

  acted(): string[] {
    return this.calls.map((call) => call.tool).filter((tool) => tool !== 'list_apps')
  }
}

interface Harness {
  service: ComputerUse
  driver: FakeDriver
  settings: ComputerUseSettings
  asked: { sessionId: string; requestId: number; app: ComputerApp }[]
  settled: [number, string][]
  always: ComputerApp[]
}

function harness(): Harness {
  const driver = new FakeDriver()
  const h: Omit<Harness, 'service'> = {
    driver,
    settings: { enabled: true, allowedApps: [] },
    asked: [],
    settled: [],
    always: [],
  }
  const deps: ComputerUseDeps = {
    platform: 'darwin',
    driver,
    self: { pids: [13], ids: ['sh.kettu.app'] },
    settings: () => h.settings,
    turnRefusal: () => null,
    sessionTitle: (sessionId) => `Title of ${sessionId}`,
    asked: (sessionId, requestId, app) => h.asked.push({ sessionId, requestId, app }),
    settled: (requestId, answer) => h.settled.push([requestId, answer]),
    allowAlways: (app) => h.always.push(app),
    using: () => {},
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    setupAsked: () => {},
    setupDone: () => {},
    setupSettled: () => {},
    stopped: () => {},
    log: () => {},
  }
  return Object.assign(h, { service: new ComputerUse(deps) })
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
