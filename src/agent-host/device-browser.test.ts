import { describe, expect, it } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import type { BrowserCallRequest } from '@shared/browser'
import type { PortDevice } from '@shared/remote/device'
import { answerOf, BROWSER_GONE, browserTarget, DeviceBrowserCalls } from './device-browser'

const laptop: PortDevice = { id: 'b'.repeat(32), name: 'Laptop', browser: true }
const phone: PortDevice = { id: 'a'.repeat(32), name: 'Phone' }

function ports(open: Record<string, PortDevice | null>) {
  return {
    deviceOf: (portId: string) => open[portId] ?? null,
    browserPort: (deviceId: string) =>
      Object.entries(open).findLast(
        ([, device]) => device?.id === deviceId && device.browser,
      )?.[0] ?? null,
  }
}

function request(overrides: Partial<BrowserCallRequest> = {}): BrowserCallRequest {
  return {
    callId: 1,
    sessionId: 's1',
    tool: 'browser_snapshot',
    args: {},
    projectPath: '/work/app',
    ...overrides,
  }
}

describe('browserTarget', () => {
  it('sends the calls of a desktop app’s turn to its port', () => {
    const sender = { portId: 'port-2', device: laptop }
    expect(browserTarget(sender, ports({ 'port-2': laptop }))).toEqual({
      kind: 'device',
      portId: 'port-2',
    })
  })

  it('leaves a window’s, a phone’s and nobody’s turn to main', () => {
    const open = ports({ 'port-1': null, 'port-3': phone })
    expect(browserTarget({ portId: 'port-1', device: null }, open)).toEqual({ kind: 'main' })
    expect(browserTarget({ portId: 'port-3', device: phone }, open)).toEqual({ kind: 'main' })
    expect(browserTarget(null, open)).toEqual({ kind: 'main' })
  })

  it('follows the app to its next port, and says it has gone without one', () => {
    const sender = { portId: 'port-2', device: laptop }
    expect(browserTarget(sender, ports({ 'port-5': laptop }))).toEqual({
      kind: 'device',
      portId: 'port-5',
    })
    expect(browserTarget(sender, ports({ 'port-3': phone }))).toEqual({ kind: 'gone' })
  })
})

describe('DeviceBrowserCalls', () => {
  function calls(servicePort: number | null = 4100) {
    const sent: { portId: string; event: HostEvent }[] = []
    const subject = new DeviceBrowserCalls({
      send: (portId, event) => sent.push({ portId, event }),
      servicePort: () => servicePort,
    })
    return { subject, sent }
  }

  it('names the forward a navigation to a dev server here needs', async () => {
    const { subject, sent } = calls()
    void subject.call(
      'port-2',
      request({ callId: 3, tool: 'browser_navigate', args: { url: 'http://localhost:5173/a' } }),
    )
    void subject.call(
      'port-2',
      request({ callId: 4, tool: 'browser_navigate', args: { url: 'https://example.com/' } }),
    )
    expect(sent).toEqual([
      {
        portId: 'port-2',
        event: {
          type: 'browser.call',
          call: expect.objectContaining({
            callId: 3,
            forward: { host: 'localhost', port: 5173 },
          }),
        },
      },
      {
        portId: 'port-2',
        event: {
          type: 'browser.call',
          call: expect.not.objectContaining({ forward: expect.anything() }),
        },
      },
    ])
  })

  it('refuses a navigation to Kettu’s own service, sending nothing', async () => {
    const { subject, sent } = calls(4100)
    const answer = await subject.call(
      'port-2',
      request({ tool: 'browser_navigate', args: { url: 'http://127.0.0.1:4100/mcp' } }),
    )
    expect(answer).toMatchObject({ error: { code: 'not_allowed' } })
    expect(sent).toEqual([])
  })

  it('takes the answer of the port it asked alone, checked as main’s', async () => {
    const { subject } = calls()
    const answered = subject.call('port-2', request({ callId: 7 }))
    expect(subject.answer('port-9', 7, { result: { text: 'x', value: {} } })).toBe(false)
    expect(subject.owns('port-2', 7)).toBe(true)
    expect(
      subject.answer('port-2', 7, { result: { text: 'Snapshotted.', value: { url: 'u' } } }),
    ).toBe(true)
    expect(await answered).toEqual({ result: { text: 'Snapshotted.', value: { url: 'u' } } })
    expect(subject.answer('port-2', 7, { result: { text: 'again', value: {} } })).toBe(false)
  })

  it('fails the calls of a port that closes as unavailable', async () => {
    const { subject } = calls()
    const answered = subject.call('port-2', request({ callId: 8 }))
    const other = subject.call('port-3', request({ callId: 9 }))
    subject.portClosed('port-2')
    expect(await answered).toEqual({ error: { code: 'unavailable', message: BROWSER_GONE } })
    expect(subject.owns('port-3', 9)).toBe(true)
    subject.answer('port-3', 9, { error: { code: 'timeout', message: 'Late.' } })
    expect(await other).toEqual({ error: { code: 'timeout', message: 'Late.' } })
  })
})

describe('answerOf', () => {
  it('keeps the unavailable code and refuses one it does not know', () => {
    expect(answerOf(undefined, { code: 'unavailable', message: 'No app.' })).toEqual({
      error: { code: 'unavailable', message: 'No app.' },
    })
    expect(answerOf(undefined, { code: 'exploded', message: 'Boom.' })).toMatchObject({
      error: { code: 'invalid' },
    })
  })
})
