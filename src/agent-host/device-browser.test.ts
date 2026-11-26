import { describe, expect, it, vi } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import { answerOf, DeviceBrowserCalls } from './device-browser'

describe('answerOf', () => {
  it('keeps the codes that tell the agent how a wait on the user ended', () => {
    for (const code of ['user_has_control', 'stopped'] as const) {
      expect(answerOf(undefined, { code, message: 'The user stopped.' })).toEqual({
        error: { code, message: 'The user stopped.' },
      })
    }
  })

  it("keeps the user's tab a call needs, and nothing else of it", () => {
    expect(
      answerOf(undefined, {
        code: 'needs_allow',
        message: 'Theirs',
        tab: { id: 't2', title: 'x'.repeat(300), url: 'https://mail.example/' },
      }),
    ).toEqual({
      error: { code: 'needs_allow', message: 'Theirs', tab: { id: 't2', title: 'x'.repeat(200) } },
    })
    expect(answerOf(undefined, { code: 'needs_allow', message: 'Theirs' })).toMatchObject({
      error: { code: 'invalid' },
    })
    expect(
      answerOf(undefined, { code: 'needs_allow', message: 'x', tab: { id: 'i'.repeat(65) } }),
    ).toMatchObject({ error: { code: 'invalid' } })
  })

  it('refuses a code it does not know', () => {
    expect(answerOf(undefined, { code: 'made_up', message: 'x' })).toEqual({
      error: { code: 'invalid', message: 'Main gave no answer to the call.' },
    })
  })
})

describe('DeviceBrowserCalls forwards', () => {
  it('attaches deduplicated companion forwards matching the navigated loopback host', async () => {
    const sent: { portId: string; event: HostEvent }[] = []
    const calls = new DeviceBrowserCalls({
      send: (portId, event) => sent.push({ portId, event }),
      servicePort: () => 41234,
    })

    const pending = calls.call('port-1', {
      callId: 1,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3100/', forward_ports: [3100, 8080, 8080, 9000] },
      projectPath: '/proj',
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.event).toEqual({
      type: 'browser.call',
      call: expect.objectContaining({
        forward: { host: 'localhost', port: 3100 },
        forwards: [
          { host: 'localhost', port: 8080 },
          { host: 'localhost', port: 9000 },
        ],
      }),
    })

    calls.answer('port-1', 1, { result: { text: 'ok', value: {} } })
    expect(await pending).toEqual({ result: { text: 'ok', value: {} } })
  })

  it('refuses Kettu’s own service port in either url or forward_ports', async () => {
    const send = vi.fn()
    const calls = new DeviceBrowserCalls({ send, servicePort: () => 41234 })

    const mainBlocked = await calls.call('port-1', {
      callId: 2,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://127.0.0.1:41234/' },
      projectPath: '/proj',
    })
    expect(mainBlocked).toMatchObject({ error: { code: 'not_allowed' } })

    const companionBlocked = await calls.call('port-1', {
      callId: 3,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3100/', forward_ports: [8080, 41234] },
      projectPath: '/proj',
    })
    expect(companionBlocked).toMatchObject({ error: { code: 'not_allowed' } })
    expect(send).not.toHaveBeenCalled()
  })
})
