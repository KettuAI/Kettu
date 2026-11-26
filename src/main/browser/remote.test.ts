import { describe, expect, it, vi } from 'vitest'
import type { BrowserForward } from '@shared/browser'
import { forwardedUrl, parseDeviceCall, RemoteBrowser, unmapped } from './remote'

const HOST_ID = '0123456789abcdef0123456789abcdef'

function makeRemote(
  forwardImpl: (
    hostId: string,
    sessionId: string,
    forward: BrowserForward,
  ) => Promise<number | null>,
) {
  const run = vi.fn(async (_callId, _sessionId, _tool, args: Record<string, unknown>) => ({
    result: {
      text: `Opened ${String(args.url ?? '')}`,
      value: { url: String(args.url ?? '') },
    },
  }))
  const forward = vi.fn(forwardImpl)
  const closeForwards = vi.fn()
  const request = vi.fn<(hostId: string, method: string, params: unknown) => boolean>(() => true)
  const remote = new RemoteBrowser({
    run,
    forward,
    closeForwards,
    answerOrigin: vi.fn(),
    request,
    turnEnded: vi.fn(),
    askAnswered: vi.fn(),
    log: vi.fn(),
  })
  return { remote, run, forward, closeForwards, request }
}

describe('parseDeviceCall', () => {
  it('accepts valid companion forwards and rejects malformed or excessive ones', () => {
    const valid = parseDeviceCall({
      callId: 1,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3100/', forward_ports: [8080, 9000] },
      projectPath: '/proj',
      forward: { host: 'localhost', port: 3100 },
      forwards: [
        { host: 'localhost', port: 8080 },
        { host: 'localhost', port: 9000 },
      ],
    })
    expect(valid?.forwards).toEqual([
      { host: 'localhost', port: 8080 },
      { host: 'localhost', port: 9000 },
    ])

    // Rejects invalid port or non-loopback host in forwards.
    expect(
      parseDeviceCall({
        callId: 1,
        sessionId: 's1',
        tool: 'browser_navigate',
        args: { url: 'http://localhost:3100/' },
        projectPath: '/proj',
        forward: { host: 'localhost', port: 3100 },
        forwards: [{ host: 'example.com', port: 8080 }],
      }),
    ).toBeNull()

    // Rejects more than MAX_COMPANION_FORWARDS entries.
    expect(
      parseDeviceCall({
        callId: 1,
        sessionId: 's1',
        tool: 'browser_navigate',
        args: { url: 'http://localhost:3100/' },
        projectPath: '/proj',
        forward: { host: 'localhost', port: 3100 },
        forwards: Array.from({ length: 9 }, (_, i) => ({ host: 'localhost', port: 8000 + i })),
      }),
    ).toBeNull()
  })
})

describe('forwardedUrl and unmapped', () => {
  it('keeps the original origin when bound on the same port and rewrites [::1] to 127.0.0.1', () => {
    expect(forwardedUrl('http://localhost:3100/app', 3100)).toEqual({
      url: 'http://localhost:3100/app',
      mapping: { local: 'http://localhost:3100', remote: 'http://localhost:3100' },
    })
    expect(forwardedUrl('http://[::1]:3100/app', 3100)).toEqual({
      url: 'http://127.0.0.1:3100/app',
      mapping: { local: 'http://127.0.0.1:3100', remote: 'http://[::1]:3100' },
    })
    expect(
      unmapped('fetch http://localhost:61237/api and http://localhost:612370/x', [
        { local: 'http://localhost:61237', remote: 'http://localhost:3100' },
      ]),
    ).toBe('fetch http://localhost:3100/api and http://localhost:612370/x')
  })
})

describe('RemoteBrowser forwarding', () => {
  it('forwards main and companion ports, preserving exact ports when locally free', async () => {
    const { remote, run, forward, request } = makeRemote(async (_h, _s, fwd) => fwd.port)

    await remote.call(HOST_ID, {
      callId: 10,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3100/app', forward_ports: [8080] },
      projectPath: '/proj',
      forward: { host: 'localhost', port: 3100 },
      forwards: [{ host: 'localhost', port: 8080 }],
    })

    expect(forward).toHaveBeenCalledTimes(2)
    expect(forward).toHaveBeenNthCalledWith(1, HOST_ID, 's1', { host: 'localhost', port: 3100 })
    expect(forward).toHaveBeenNthCalledWith(2, HOST_ID, 's1', { host: 'localhost', port: 8080 })
    expect(run.mock.calls[0]?.[3]).toMatchObject({ url: 'http://localhost:3100/app' })
    expect(request).toHaveBeenCalledWith(HOST_ID, 'browser.answer', {
      callId: 10,
      answer: {
        result: {
          text: 'Opened http://localhost:3100/app',
          value: { url: 'http://localhost:3100/app' },
        },
      },
    })
  })

  it('unmaps fallback ports and notes when a companion port had to fall back locally', async () => {
    const { remote, request } = makeRemote(async (_h, _s, fwd) =>
      fwd.port === 3100 ? 61237 : 54321,
    )

    await remote.call(HOST_ID, {
      callId: 11,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3100/', forward_ports: [8080] },
      projectPath: '/proj',
      forward: { host: 'localhost', port: 3100 },
      forwards: [{ host: 'localhost', port: 8080 }],
    })

    const answer = request.mock.calls[0]?.[2] as {
      answer: { result: { text: string; value: { url: string } } }
    }
    expect(answer.answer.result.value.url).toBe('http://localhost:3100/')
    expect(answer.answer.result.text).toContain('Opened http://localhost:3100/')
    expect(answer.answer.result.text).toContain(
      'local port 8080 was busy, so remote port 8080 is forwarded on 127.0.0.1:54321',
    )
  })

  it('rejects companion forwards that were not declared in forward_ports or mismatch host', async () => {
    const { remote, forward, request } = makeRemote(async (_h, _s, fwd) => fwd.port)

    await remote.call(HOST_ID, {
      callId: 12,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3100/', forward_ports: [8080] },
      projectPath: '/proj',
      forward: { host: 'localhost', port: 3100 },
      forwards: [{ host: 'localhost', port: 9999 }],
    })

    expect(forward).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(HOST_ID, 'browser.answer', {
      callId: 12,
      answer: { error: { code: 'invalid', message: expect.stringMatching(/companion forwards/i) } },
    })
  })

  it('closes forwards when the browser pane closes while preserving host ownership until removal', async () => {
    const { remote, closeForwards } = makeRemote(async (_h, _s, fwd) => fwd.port)

    await remote.call(HOST_ID, {
      callId: 13,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3100/' },
      projectPath: '/proj',
      forward: { host: 'localhost', port: 3100 },
    })

    remote.pageClosed('s1')
    expect(closeForwards).toHaveBeenCalledWith(HOST_ID, 's1')
    expect(remote.hostOf('s1')).toBe(HOST_ID)

    remote.pageRemoved('s1')
    expect(remote.hostOf('s1')).toBeNull()
  })
})
