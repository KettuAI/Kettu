import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ComputerApp, ComputerHold, ComputerUseSettings } from '@shared/computer-use'
import { COMPUTER_APP_WAIT_MS } from '@shared/computer-use'
import { ComputerUse, TAKEN_OVER_WAIT_MS, type ComputerUseDeps, type DriverLike } from './service'

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
  /** What `bring_to_front` answers, when not plain success. */
  front: CallToolResult | null = null

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ tool, args })
    if (tool === 'bring_to_front' && this.front) return this.front
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
        structuredContent: {
          snapshot_id: `s${String(args.pid).padStart(8, '0')}`,
          window_title: 'Notes.txt',
          window_bounds: { x: 100, y: 50, width: 400, height: 200 },
          screenshot_width: 800,
          screenshot_height: 400,
          elements: [{ element_index: 1, frame: { x: 140, y: 90, w: 20, h: 20 } }],
        },
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
  holds: (ComputerHold | null)[]
}

function harness(): Harness {
  const driver = new FakeDriver()
  const h: Omit<Harness, 'service'> = {
    driver,
    settings: { enabled: true, allowedApps: [], stopShortcut: '' },
    asked: [],
    settled: [],
    always: [],
    holds: [],
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
    agent: () => ({ id: 'claude-code', name: 'Claude Code' }),
    held: (hold) => h.holds.push(hold),
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

describe('who has the app', () => {
  const TEXTEDIT = [{ id: 'com.apple.textedit', name: 'TextEdit' }]
  const last = (h: Harness) => h.holds[h.holds.length - 1]

  it('tells main the window it uses and where each action lands in it', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    const read = await h.service.call('a', 'computer_get_window_state', READ)
    // The frames Kettu asks for are its own; the agent gets the result it always had.
    expect(h.driver.calls.at(-1)?.args.tree_format).toBe('both')
    expect((read.structuredContent as Record<string, unknown>).elements).toBeUndefined()
    expect(last(h)).toMatchObject({
      sessionId: 'a',
      agentName: 'Claude Code',
      app: 'TextEdit',
      window: { pid: 10, id: 1, title: 'Notes.txt' },
      control: 'agent',
      act: null,
    })
    await h.service.call('a', 'computer_click', { ...READ, x: 200, y: 100 })
    expect(last(h)?.act).toEqual({ seq: 1, kind: 'click', x: 0.25, y: 0.25 })
    // An element's centre, from its frame in screen points.
    await h.service.call('a', 'computer_click', { ...READ, element_token: 's00000010:1' })
    expect(last(h)?.act).toEqual({ seq: 2, kind: 'click', x: 0.125, y: 0.25 })
    // A key has no point of its own: the pointer stays where it was.
    await h.service.call('a', 'computer_press_key', { ...READ, key: 'return' })
    expect(last(h)?.act).toEqual({ seq: 3, kind: 'key', x: 0.125, y: 0.25 })
  })

  it('shows the window when only the light above it keeps the driver from confirming', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    const unverified = (focused: number): CallToolResult => ({
      isError: true,
      content: [{ type: 'text', text: 'bring_to_front: exact window was not verified' }],
      structuredContent: { process_activated: true, observed: { focused_window_id: focused } },
    })
    h.driver.front = unverified(1)
    await expect(h.service.show('a')).resolves.toBeUndefined()
    h.driver.front = unverified(2)
    await expect(h.service.show('a')).rejects.toThrow('not verified')
    await expect(h.service.show('b')).resolves.toBeUndefined()
    expect(h.driver.acted().filter((tool) => tool === 'bring_to_front')).toHaveLength(2)
  })

  it('holds the calls while the user has the app, and goes on when they hand it back', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    expect(last(h)?.control).toBe('you')
    let done = false
    const pending = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    void pending.then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(done).toBe(false)
    expect(h.driver.acted()).toEqual(['get_window_state'])
    h.service.handBack('a')
    expect((await pending).isError).toBeUndefined()
    expect(h.driver.acted()).toEqual(['get_window_state', 'click'])
    expect(last(h)?.control).toBe('agent')
  })

  it('answers a long wait before the harness gives up, without failing', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    const pending = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(TAKEN_OVER_WAIT_MS)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(code(result)).toBe('user_has_control')
    expect(h.driver.acted()).toEqual(['get_window_state'])
    // Holding the app outlasts the hold's own idle limit.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(last(h)?.control).toBe('you')
  })

  it('ends the waiting calls as stopped on Stop and at the end of the turn', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    const stopped = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.service.control('a', 'stop')
    expect(code(await stopped)).toBe('stopped')
    expect(last(h)).toBeNull()

    h.service.turnEnded('a')
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('a')
    const ended = h.service.call('a', 'computer_click', { ...READ, x: 1, y: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.service.turnEnded('a')
    expect(code(await ended)).toBe('stopped')
    expect(h.driver.acted().filter((tool) => tool === 'click')).toEqual([])
  })

  it('lets only the session holding the computer take it over or hand it back', async () => {
    const h = harness()
    h.settings.allowedApps = TEXTEDIT
    await h.service.call('a', 'computer_get_window_state', READ)
    h.service.takeOver('b')
    expect(last(h)?.control).toBe('agent')
    h.service.takeOver('a')
    h.service.handBack('b')
    expect(last(h)?.control).toBe('you')
  })
})
