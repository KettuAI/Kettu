import { describe, expect, it } from 'vitest'
import {
  HttpForwardRewriter,
  rewriteRequestHeaders,
  rewriteResponseHeaders,
  type ForwardPortMapping,
} from './forward-http'

function concat(chunks: readonly Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

function feedByByte(
  fn: (chunk: Uint8Array) => Uint8Array[],
  flush: () => Uint8Array[],
  input: string | Buffer,
): Buffer {
  const buf = typeof input === 'string' ? Buffer.from(input, 'latin1') : input
  const out: Uint8Array[] = []
  for (let i = 0; i < buf.length; i++) {
    out.push(...fn(buf.subarray(i, i + 1)))
  }
  out.push(...flush())
  return concat(out)
}

describe('rewriteRequestHeaders', () => {
  const mappings: ForwardPortMapping[] = [
    { localPort: 61237, remotePort: 3100 },
    { localPort: 54321, remotePort: 8080 },
  ]

  it('rewrites loopback Host, Origin, and Referer from fallback local ports to remote ports', () => {
    const raw = Buffer.from(
      [
        'GET /api/items HTTP/1.1',
        'Host: localhost:61237',
        'Origin: http://localhost:61237',
        'Referer: http://localhost:61237/dashboard?tab=1#top',
        'X-Custom: keep-me',
      ].join('\r\n'),
      'latin1',
    )
    const result = rewriteRequestHeaders(raw, 61237, 3100, mappings)
    expect(result.head.toString('latin1')).toBe(
      [
        'GET /api/items HTTP/1.1',
        'Host: localhost:3100',
        'Origin: http://localhost:3100',
        'Referer: http://localhost:3100/dashboard?tab=1#top',
        'X-Custom: keep-me',
        '',
        '',
      ].join('\r\n'),
    )
  })

  it('supports 127.0.0.1, [::1], *.localhost, and default port 80/443 omission', () => {
    const defaultPortMappings: ForwardPortMapping[] = [{ localPort: 55000, remotePort: 80 }]
    const raw = Buffer.from(
      [
        'POST /submit HTTP/1.1',
        'Host: app.localhost:55000',
        'Origin: http://127.0.0.1:55000',
        'Referer: http://[::1]:55000/login',
        'Content-Length: 4',
      ].join('\r\n'),
      'latin1',
    )
    const result = rewriteRequestHeaders(raw, 55000, 80, defaultPortMappings)
    expect(result.contentLength).toBe(4)
    expect(result.head.toString('latin1')).toBe(
      [
        'POST /submit HTTP/1.1',
        'Host: app.localhost',
        'Origin: http://127.0.0.1',
        'Referer: http://[::1]/login',
        'Content-Length: 4',
        '',
        '',
      ].join('\r\n'),
    )
  })

  it('leaves non-loopback hosts and unmapped ports untouched', () => {
    const raw = Buffer.from(
      [
        'GET / HTTP/1.1',
        'Host: example.com:61237',
        'Origin: https://evil.example:61237',
        'Referer: http://localhost:9999/other',
      ].join('\r\n'),
      'latin1',
    )
    const result = rewriteRequestHeaders(raw, 61237, 3100, mappings)
    expect(result.head.toString('latin1')).toBe(
      [
        'GET / HTTP/1.1',
        'Host: example.com:61237',
        'Origin: https://evil.example:61237',
        'Referer: http://localhost:9999/other',
        '',
        '',
      ].join('\r\n'),
    )
  })
})

describe('rewriteResponseHeaders', () => {
  const mappings: ForwardPortMapping[] = [
    { localPort: 61237, remotePort: 3100 },
    { localPort: 54321, remotePort: 80 },
  ]

  it('rewrites Access-Control-Allow-Origin and Location for remapped remote origins', () => {
    const raw = Buffer.from(
      [
        'HTTP/1.1 302 Found',
        'Access-Control-Allow-Origin: http://localhost:3100',
        'Location: http://localhost:3100/home?ok=1',
      ].join('\r\n'),
      'latin1',
    )
    const result = rewriteResponseHeaders(raw, mappings)
    expect(result.status).toBe(302)
    expect(result.head.toString('latin1')).toBe(
      [
        'HTTP/1.1 302 Found',
        'Access-Control-Allow-Origin: http://localhost:61237',
        'Location: http://localhost:61237/home?ok=1',
        '',
        '',
      ].join('\r\n'),
    )
  })

  it('rewrites default-port remote origins without forging ACAO or altering wildcards', () => {
    const wildcard = rewriteResponseHeaders(
      Buffer.from(
        [
          'HTTP/1.1 200 OK',
          'Access-Control-Allow-Origin: *',
          'Location: http://localhost/next',
        ].join('\r\n'),
        'latin1',
      ),
      mappings,
    )
    expect(wildcard.head.toString('latin1')).toContain('Access-Control-Allow-Origin: *\r\n')
    expect(wildcard.head.toString('latin1')).toContain('Location: http://localhost:54321/next\r\n')

    const unrelated = rewriteResponseHeaders(
      Buffer.from(
        ['HTTP/1.1 200 OK', 'Access-Control-Allow-Origin: https://api.example.com'].join('\r\n'),
        'latin1',
      ),
      mappings,
    )
    expect(unrelated.head.toString('latin1')).toContain(
      'Access-Control-Allow-Origin: https://api.example.com\r\n',
    )
  })
})

describe('HttpForwardRewriter', () => {
  const mappings: ForwardPortMapping[] = [{ localPort: 61237, remotePort: 3100 }]

  it('handles HTTP/1.1 keep-alive across fixed-length, chunked, and HEAD requests byte-by-byte', () => {
    const rewriter = new HttpForwardRewriter(61237, 3100, () => mappings)

    const req1 =
      'HEAD /health HTTP/1.1\r\nHost: localhost:61237\r\nOrigin: http://localhost:61237\r\n\r\n'
    const req2 =
      'POST /chunked HTTP/1.1\r\nHost: localhost:61237\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '5;ext=1\r\nhello\r\n0\r\nX-Trailer: ok\r\n\r\n'
    const req3 = 'POST /fixed HTTP/1.1\r\nHost: localhost:61237\r\nContent-Length: 4\r\n\r\nbody'

    const rewrittenReq = feedByByte(
      (c) => rewriter.clientToHost(c),
      () => rewriter.flushClientToHost(),
      req1 + req2 + req3,
    ).toString('latin1')

    expect(rewrittenReq).toBe(
      'HEAD /health HTTP/1.1\r\nHost: localhost:3100\r\nOrigin: http://localhost:3100\r\n\r\n' +
        'POST /chunked HTTP/1.1\r\nHost: localhost:3100\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '5;ext=1\r\nhello\r\n0\r\nX-Trailer: ok\r\n\r\n' +
        'POST /fixed HTTP/1.1\r\nHost: localhost:3100\r\nContent-Length: 4\r\n\r\nbody',
    )

    // HEAD response carries Content-Length but no body; next chunked and fixed responses follow.
    const res1 =
      'HTTP/1.1 200 OK\r\nContent-Length: 999\r\nAccess-Control-Allow-Origin: http://localhost:3100\r\n\r\n'
    const res2 =
      'HTTP/1.1 100 Continue\r\n\r\n' +
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nAccess-Control-Allow-Origin: http://localhost:3100\r\n\r\n' +
      '2\r\nok\r\n0\r\n\r\n'
    const res3 = 'HTTP/1.1 204 No Content\r\nLocation: http://localhost:3100/done\r\n\r\n'

    const rewrittenRes = feedByByte(
      (c) => rewriter.hostToClient(c),
      () => rewriter.flushHostToClient(),
      res1 + res2 + res3,
    ).toString('latin1')

    expect(rewrittenRes).toBe(
      'HTTP/1.1 200 OK\r\nContent-Length: 999\r\nAccess-Control-Allow-Origin: http://localhost:61237\r\n\r\n' +
        'HTTP/1.1 100 Continue\r\n\r\n' +
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nAccess-Control-Allow-Origin: http://localhost:61237\r\n\r\n' +
        '2\r\nok\r\n0\r\n\r\n' +
        'HTTP/1.1 204 No Content\r\nLocation: http://localhost:61237/done\r\n\r\n',
    )
  })

  it('rewrites WebSocket upgrade headers and passes subsequent frames through untouched', () => {
    const rewriter = new HttpForwardRewriter(61237, 3100, () => mappings)
    const upgradeReq = Buffer.from(
      [
        'GET /hmr HTTP/1.1',
        'Host: localhost:61237',
        'Origin: http://localhost:61237',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'),
      'latin1',
    )
    const wsFrame = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f])
    const outReq = concat([
      ...rewriter.clientToHost(Buffer.concat([upgradeReq, wsFrame])),
      ...rewriter.flushClientToHost(),
    ])
    const expectedReqHead = Buffer.from(
      [
        'GET /hmr HTTP/1.1',
        'Host: localhost:3100',
        'Origin: http://localhost:3100',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'),
      'latin1',
    )
    expect(outReq.equals(Buffer.concat([expectedReqHead, wsFrame]))).toBe(true)

    const upgradeRes = Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      'latin1',
    )
    const serverFrame = Buffer.from([0x81, 0x02, 0x6f, 0x6b])
    const outRes = concat([
      ...rewriter.hostToClient(Buffer.concat([upgradeRes, serverFrame])),
      ...rewriter.flushHostToClient(),
    ])
    expect(outRes.equals(Buffer.concat([upgradeRes, serverFrame]))).toBe(true)
  })

  it('passes TLS and short non-HTTP TCP payloads through unchanged', () => {
    const rewriter = new HttpForwardRewriter(61237, 3100, () => mappings)
    const tlsClientHello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05])
    expect(concat(rewriter.clientToHost(tlsClientHello)).equals(tlsClientHello)).toBe(true)

    // A tiny partial prefix ("GE") that ends at EOF must flush without dropping bytes.
    const shortRewriter = new HttpForwardRewriter(61237, 3100, () => mappings)
    expect(shortRewriter.clientToHost(Buffer.from('GE', 'latin1'))).toEqual([])
    expect(concat(shortRewriter.flushClientToHost()).toString('latin1')).toBe('GE')
  })
})
