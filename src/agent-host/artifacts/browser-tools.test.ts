import { describe, expect, it, vi } from 'vitest'
import type { BrowserCallAnswer, BrowserCallRequest } from '@shared/browser'
import { CONTROL_WAIT_MS, type SurfaceAccessAnswer } from '@shared/control'
import {
  BROWSER_TOOLS,
  BrowserTools,
  type BrowserToolDeps as BrowserToolsDeps,
} from './browser-tools'

function tools() {
  const call = vi.fn(async (request: BrowserCallRequest) => ({
    result: { text: 'ok', value: { args: request.args } },
  }))
  const service = new BrowserTools({
    call,
    pageOf: (sessionId) => sessionId,
    projectOf: () => '/project',
  })
  return { service, call }
}

const caller = { sessionId: 's1', project: '/project' }

describe('browser_tabs arguments', () => {
  it('is offered with its actions', () => {
    const tool = BROWSER_TOOLS.find((t) => t.name === 'browser_tabs')
    expect(tool?.inputSchema.required).toEqual(['action'])
  })

  it.each([
    [{ action: 'list' }],
    [{ action: 'new' }],
    [{ action: 'select', index: 2 }],
    [{ action: 'close' }],
    [{ action: 'close', index: 0 }],
  ])('forwards %j to main as given', async (input) => {
    const { service, call } = tools()
    const result = await service.call(caller, 'browser_tabs', input)
    expect(result.isError).toBeUndefined()
    expect(call).toHaveBeenCalledOnce()
    expect(call.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      tool: 'browser_tabs',
      args: input,
    })
  })

  it.each([
    [{}, /action must be/],
    [{ action: 'open' }, /action must be/],
    [{ action: 'select' }, /index is needed/],
    [{ action: 'select', index: -1 }, /whole number/],
    [{ action: 'select', index: 1.5 }, /whole number/],
    [{ action: 'select', index: '1' }, /whole number/],
    [{ action: 'close', index: 50 }, /whole number/],
    [{ action: 'list', index: 0 }, /select and close/],
    [{ action: 'new', index: 0 }, /select and close/],
    [{ action: 'new', url: 'https://example.com/' }, /Unknown argument url/],
  ])('refuses %j before main sees it', async (input, message) => {
    const { service, call } = tools()
    const result = await service.call(caller, 'browser_tabs', input)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'invalid' })
    expect(String((result.content[0] as { text: string }).text)).toMatch(message)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('browser_resize arguments', () => {
  it.each([
    [{ size: 'desktop' }, { size: 'desktop' }],
    [{ size: 'tablet' }, { size: 'tablet' }],
    [{ size: 'phone' }, { size: 'phone' }],
    [
      { width: 1440, height: 900 },
      { width: 1440, height: 900 },
    ],
    [
      { width: 320, height: 2560 },
      { width: 320, height: 2560 },
    ],
  ])('forwards %j to main as %j', async (input, args) => {
    const { service, call } = tools()
    const result = await service.call(caller, 'browser_resize', input)
    expect(result.isError).toBeUndefined()
    expect(call.mock.calls[0][0]).toMatchObject({ tool: 'browser_resize', args })
  })

  it.each([
    [{}, /Give size/],
    [{ size: 'watch' }, /desktop, tablet or phone/],
    [{ size: 'phone', width: 390 }, /not both/],
    [{ width: 1440 }, /width and height must both/],
    [{ width: 319, height: 800 }, /320 to 2560/],
    [{ width: 1280, height: 2561 }, /320 to 2560/],
    [{ width: 1280.5, height: 800 }, /whole numbers/],
    [{ width: '1280', height: '800' }, /whole numbers/],
    [{ size: 'phone', mobile: true }, /Unknown argument mobile/],
  ])('refuses %j before main sees it', async (input, message) => {
    const { service, call } = tools()
    const result = await service.call(caller, 'browser_resize', input)
    expect(result.structuredContent).toMatchObject({ code: 'invalid' })
    expect(String((result.content[0] as { text: string }).text)).toMatch(message)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('an agent using a tab the user opened', () => {
  /** Main says the call needs the user's tab "t2" until a call brings the allow for it. */
  function userTab(access: Partial<NonNullable<BrowserToolsDeps['access']>> = {}) {
    const call = vi.fn(async (request: BrowserCallRequest): Promise<BrowserCallAnswer> => {
      if (request.allowTab !== 't2') {
        return {
          error: { code: 'needs_allow', message: 'theirs', tab: { id: 't2', title: 'Mail' } },
        }
      }
      return { result: { text: 'ok', value: { url: 'https://mail.example/' } } }
    })
    const ask = vi.fn(async (): Promise<SurfaceAccessAnswer> => 'allow')
    const used = vi.fn()
    const service = new BrowserTools({
      call,
      pageOf: (sessionId) => sessionId,
      projectOf: () => '/project',
      access: { fullAccess: () => false, ask, used, shared: () => false, ...access },
    })
    const snapshot = () => service.call(caller, 'browser_snapshot', {})
    return { service, call, ask, used, snapshot }
  }

  it('asks the user, then sends the call again with the tab they allowed', async () => {
    const { call, ask, snapshot } = userTab()
    const result = await snapshot()
    expect(ask).toHaveBeenCalledWith('s1', { id: 't2', title: 'Mail' })
    expect(call.mock.calls.map(([request]) => request.allowTab)).toEqual([undefined, 't2'])
    expect(result.isError).toBeUndefined()
  })

  it('leaves the tab alone when the user denies it', async () => {
    const { call, snapshot } = userTab({ ask: async () => 'deny' })
    const result = await snapshot()
    expect(result.structuredContent).toMatchObject({ code: 'not_allowed' })
    expect(call).toHaveBeenCalledOnce()
  })

  it('asks nothing in full access or for a tab the user referenced', async () => {
    const full = userTab({ fullAccess: () => true })
    await full.snapshot()
    expect(full.ask).not.toHaveBeenCalled()
    expect(full.used).toHaveBeenCalledWith('s1', 'Mail')
    const shared = userTab({ shared: () => true })
    await shared.snapshot()
    expect(shared.ask).not.toHaveBeenCalled()
    expect(shared.call.mock.calls.at(-1)?.[0].allowTab).toBe('t2')
  })

  it('takes an allow given while no call waited to the next call, once', async () => {
    vi.useFakeTimers()
    try {
      let answer: (value: SurfaceAccessAnswer) => void = () => undefined
      const ask = vi.fn(() => new Promise<SurfaceAccessAnswer>((resolve) => (answer = resolve)))
      const { call, snapshot } = userTab({ ask })
      const first = snapshot()
      await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS)
      expect(await first).toMatchObject({ structuredContent: { code: 'needs_allow' } })
      answer('allow')
      await vi.advanceTimersByTimeAsync(0)
      const second = await snapshot()
      expect(second.isError).toBeUndefined()
      expect(ask).toHaveBeenCalledOnce()
      expect(call.mock.calls.at(-1)?.[0].allowTab).toBe('t2')
    } finally {
      vi.useRealTimers()
    }
  })
})
