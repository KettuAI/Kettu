import { describe, expect, it } from 'vitest'
import { BYTES_PER_FRAME } from '@shared/remote/channel'
import { LinkRequests, type RequestWire } from './link-requests'

const quiet = (): void => {}

/** A wire that records what goes on it; `hold` keeps sendBytes from settling until released. */
function wire(options: { bytes?: boolean } = {}) {
  const sent: unknown[] = []
  let holding: (() => void) | null = null
  let hold = false
  const w: RequestWire = {
    send: (value) => sent.push(value),
    sendBytes: (stream, data) => {
      sent.push({ bytes: stream, length: data.length })
      if (!hold) return Promise.resolve()
      return new Promise((resolve) => (holding = resolve))
    },
    buffered: () => 0,
    drained: () => Promise.resolve(),
    bytes: options.bytes ?? true,
  }
  return {
    wire: w,
    sent,
    hold: () => (hold = true),
    release: () => {
      hold = false
      holding?.()
      holding = null
    },
    requests: () =>
      sent.filter(
        (m): m is Record<string, unknown> => (m as { type?: unknown }).type === 'request',
      ),
  }
}

function setup() {
  const toMain: Record<string, unknown>[] = []
  let stream = 1
  const requests = new LinkRequests({
    toMain: (message) => toMain.push(message as never),
    nextStream: () => {
      const next = stream
      stream += 2
      return next
    },
    log: quiet,
  })
  return { requests, toMain }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('LinkRequests', () => {
  it('sends a request under an id of its own and answers main under main’s', () => {
    const { requests, toMain } = setup()
    const w = wire()
    requests.attach(w.wire, 0)
    requests.request({ type: 'request', id: 41, method: 'ping', params: null })
    expect(w.sent).toEqual([{ type: 'request', id: 1, method: 'ping', params: null }])
    requests.received({ type: 'response', id: 1, result: 'pong' })
    expect(toMain).toEqual([{ type: 'response', id: 41, result: 'pong' }])
    expect(requests.waiting).toBe(0)
  })

  it('uploads binary values ahead of the request, which names them', async () => {
    const { requests } = setup()
    const w = wire()
    requests.attach(w.wire, 0)
    const bytes = new Uint8Array(BYTES_PER_FRAME + 10).fill(7)
    requests.request({
      type: 'request',
      id: 5,
      method: 'attachments.add',
      params: {
        source: { bytes: bytes.buffer, mimeType: 'image/png', name: 'a.png' },
        thumb: null,
      },
    })
    await tick()
    expect(w.sent).toEqual([
      { type: 'stream.open', stream: 1, size: bytes.length },
      { bytes: 1, length: BYTES_PER_FRAME },
      { bytes: 1, length: 10 },
      { type: 'stream.end', stream: 1 },
      {
        type: 'request',
        id: 1,
        method: 'attachments.add',
        params: {
          source: { bytes: { $stream: 1 }, mimeType: 'image/png', name: 'a.png' },
          thumb: null,
        },
      },
    ])
  })

  it('numbers requests in the order they go, so one behind an upload comes after the rest', async () => {
    const { requests } = setup()
    const w = wire()
    requests.attach(w.wire, 0)
    w.hold()
    requests.request({
      type: 'request',
      id: 1,
      method: 'up',
      params: { bytes: new ArrayBuffer(4) },
    })
    requests.request({ type: 'request', id: 2, method: 'ping', params: null })
    await tick()
    w.release()
    await tick()
    expect(w.requests().map((r) => [r.method, r.id])).toEqual([
      ['ping', 1],
      ['up', 2],
    ])
  })

  it('sends again, upload and all, a request a drop cut short; not one the host read', async () => {
    const { requests, toMain } = setup()
    const first = wire()
    requests.attach(first.wire, 0)
    requests.request({ type: 'request', id: 1, method: 'ping', params: null })
    first.hold()
    requests.request({
      type: 'request',
      id: 2,
      method: 'up',
      params: { bytes: new ArrayBuffer(4) },
    })
    await tick()
    requests.detach()
    first.release()
    await tick()
    // The upload stopped with its session: the request never went on it.
    expect(first.requests().map((r) => r.method)).toEqual(['ping'])

    const second = wire()
    requests.attach(second.wire, 1)
    await tick()
    expect(second.sent).toEqual([
      { type: 'stream.open', stream: 3, size: 4 },
      { bytes: 3, length: 4 },
      { type: 'stream.end', stream: 3 },
      { type: 'request', id: 2, method: 'up', params: { bytes: { $stream: 3 } } },
    ])
    requests.received({ type: 'response', id: 1, result: 'pong' })
    requests.received({ type: 'response', id: 2, result: 'up' })
    expect(toMain.map((m) => m.id)).toEqual([1, 2])
  })

  it('sends again a request the host did not read before the drop', () => {
    const { requests } = setup()
    const first = wire()
    requests.attach(first.wire, 0)
    requests.request({ type: 'request', id: 7, method: 'ping', params: null })
    requests.detach()
    const second = wire()
    // The host read nothing: the request goes again under a new id.
    requests.attach(second.wire, 0)
    expect(second.requests()).toEqual([{ type: 'request', id: 2, method: 'ping', params: null }])
  })

  it('hands main an answer once the bytes of the streams it names came', () => {
    const { requests, toMain } = setup()
    const w = wire()
    requests.attach(w.wire, 0)
    requests.request({ type: 'request', id: 9, method: 'attachments.read', params: { id: 'a' } })
    requests.received({
      type: 'response',
      id: 1,
      result: { mimeType: 'image/png', bytes: { $stream: 2, size: 5 } },
    })
    requests.bytes(2, new Uint8Array([1, 2, 3]))
    expect(toMain).toEqual([])
    requests.bytes(2, new Uint8Array([4, 5]))
    requests.received({ type: 'stream.end', stream: 2 })
    expect(toMain).toHaveLength(1)
    const answer = toMain[0] as { id: number; result: { bytes: ArrayBuffer } }
    expect(answer.id).toBe(9)
    expect([...new Uint8Array(answer.result.bytes)]).toEqual([1, 2, 3, 4, 5])
  })

  it('fails the answer of a stream the host gave up, and stops the others it named', () => {
    const { requests, toMain } = setup()
    const w = wire()
    requests.attach(w.wire, 0)
    requests.request({ type: 'request', id: 3, method: 'two', params: null })
    requests.received({
      type: 'response',
      id: 1,
      result: [
        { $stream: 2, size: 1 },
        { $stream: 4, size: 1 },
      ],
    })
    requests.received({
      type: 'stream.cancel',
      stream: 2,
      error: { code: 'not_found', message: 'gone' },
    })
    expect(toMain).toEqual([
      { type: 'error', id: 3, error: { code: 'not_found', message: 'gone' } },
    ])
    expect(w.sent.at(-1)).toEqual({ type: 'stream.cancel', stream: 4 })
    // What still comes for them is dropped.
    requests.received({ type: 'stream.end', stream: 4 })
    expect(toMain).toHaveLength(1)
  })

  it('refuses bytes for a host that takes no streams, or more than an upload holds', () => {
    const { requests, toMain } = setup()
    requests.attach(wire({ bytes: false }).wire, 0)
    requests.request({
      type: 'request',
      id: 1,
      method: 'up',
      params: { bytes: new ArrayBuffer(1) },
    })
    expect(toMain).toEqual([
      { type: 'error', id: 1, error: expect.objectContaining({ code: 'invalid_params' }) },
    ])
    requests.attach(wire().wire, 0)
    requests.request({
      type: 'request',
      id: 2,
      method: 'up',
      params: { bytes: new ArrayBuffer(20 * 1024 * 1024 + 1) },
    })
    expect(toMain.at(-1)).toEqual({
      type: 'error',
      id: 2,
      error: expect.objectContaining({ code: 'invalid_params' }),
    })
  })

  it('passes everything else from the host on to main', () => {
    const { requests, toMain } = setup()
    requests.received({ type: 'event', event: { type: 'projects.changed', projects: [] } })
    expect(toMain).toEqual([{ type: 'event', event: { type: 'projects.changed', projects: [] } }])
  })
})
