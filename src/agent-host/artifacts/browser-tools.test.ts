import { describe, expect, it, vi } from 'vitest'
import type { BrowserCallRequest } from '@shared/browser'
import { BROWSER_TOOLS, BrowserTools } from './browser-tools'

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
