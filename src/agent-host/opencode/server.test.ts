// How Kettu reads OpenCode's server: its address, its errors and its event stream.

import { describe, expect, it } from 'vitest'
import { ServerError, SseParser, httpApi, listeningUrl, locationQuery } from './server'
import type { ServerEvent } from './protocol'

describe('the event stream', () => {
  it('reads events whole however the chunks fall, and skips heartbeats', () => {
    const parser = new SseParser()
    expect(parser.push(': heartbeat\n\ndata: {"type":"a"')).toEqual([])
    expect(parser.push('}\n\ndata: {"type":"b"}\n')).toEqual(['{"type":"a"}'])
    expect(parser.push('\n')).toEqual(['{"type":"b"}'])
  })

  it('takes Windows line ends and data over several lines', () => {
    const parser = new SseParser()
    expect(parser.push('data: one\r\ndata: two\r\n\r\n')).toEqual(['one\ntwo'])
  })
})

describe('the server address', () => {
  it('is the loopback address the server prints as JSON, and nothing else', () => {
    expect(listeningUrl('{"url":"http://127.0.0.1:56654"}')).toBe('http://127.0.0.1:56654')
    expect(listeningUrl('{"url":"http://0.0.0.0:4096"}')).toBeNull()
    expect(listeningUrl('{"url":"http://127.0.0.1:1/x"}')).toBeNull()
    expect(listeningUrl('server listening on http://127.0.0.1:4096')).toBeNull()
  })

  it('names a folder as the location parameter takes it', () => {
    expect(locationQuery('/work/my app')).toBe('location%5Bdirectory%5D=%2Fwork%2Fmy%20app')
  })
})

describe('requests', () => {
  const answer = (status: number, body: string): typeof fetch =>
    (async () => new Response(body === '' ? null : body, { status })) as typeof fetch

  it('signs in with the password over HTTP Basic, as the user OpenCode fixes', async () => {
    let seen: RequestInit | undefined
    const api = httpApi('http://127.0.0.1:1', 'secret', (async (_url, init) => {
      seen = init
      return new Response('{"data":1}')
    }) as typeof fetch)
    expect(await api.request('POST', '/api/session', { a: 1 })).toEqual({ data: 1 })
    expect(seen?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('opencode:secret').toString('base64')}`,
      'content-type': 'application/json',
    })
    expect(seen?.body).toBe('{"a":1}')
  })

  it('answers nothing for an empty response', async () => {
    const api = httpApi('http://127.0.0.1:1', 'p', answer(204, ''))
    expect(await api.request('DELETE', '/api/session/ses_1')).toBeUndefined()
  })

  it("rejects with the server's own error", async () => {
    const api = httpApi(
      'http://127.0.0.1:1',
      'p',
      answer(404, '{"_tag":"SessionNotFoundError","message":"Session not found: ses_1"}'),
    )
    const error = await api.request('GET', '/api/session/ses_1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServerError)
    expect(error).toMatchObject({
      status: 404,
      tag: 'SessionNotFoundError',
      message: 'Session not found: ses_1',
    })
  })

  it('hands each event of the stream to its reader until the stream ends', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string): void => controller.enqueue(new TextEncoder().encode(text))
        send('data: {"type":"server.connected","data":{}}\n\n: heartbeat\n\n')
        send('data: {"type":"session.renamed","data":{"sessionID":"ses_1","title":"T"}}\n\n')
        send('data: not json\n\n')
        controller.close()
      },
    })
    const api = httpApi('http://127.0.0.1:1', 'p', (async () => new Response(body)) as typeof fetch)
    const events: ServerEvent[] = []
    await api.events((event) => events.push(event), new AbortController().signal)
    expect(events.map((event) => event.type)).toEqual(['server.connected', 'session.renamed'])
  })
})
