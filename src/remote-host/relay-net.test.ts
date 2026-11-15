import { X509Certificate, createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeRelayBytes } from '@shared/remote/relay'
import { PinMismatch, certificatePin, openRelaySocket, relayRequest } from './relay-net'

// A self-signed P-256 certificate, made here so the test holds no key: DER by hand.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : body.length < 0x100
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, body])
}

function selfSigned(): { key: string; cert: string; spki: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const ecdsaSha256 = der(0x30, der(0x06, Buffer.from('2a8648ce3d040302', 'hex')))
  const name = der(
    0x30,
    der(0x31, der(0x30, der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('relay')))),
  )
  const validity = der(
    0x30,
    der(0x17, Buffer.from('250101000000Z')),
    der(0x17, Buffer.from('350101000000Z')),
  )
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ecdsaSha256,
    name,
    validity,
    name,
    spki,
  )
  const signature = sign('sha256', tbs, privateKey)
  const certificate = der(0x30, tbs, ecdsaSha256, der(0x03, Buffer.from([0]), signature))
  const pem = `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: pem, spki }
}

interface Server {
  port: number
  /** Every byte the server decrypted, from any connection. */
  received: Buffer[]
}

const servers: tls.Server[] = []
const sockets = new Set<tls.TLSSocket>()

afterEach(async () => {
  // The pinned agent keeps its connections open between requests.
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
})

/** A TLS server that answers any HTTP request with 204 and keeps the connection. */
async function server(credentials: { key: string; cert: string }): Promise<Server> {
  const received: Buffer[] = []
  const s = tls.createServer(credentials, (socket) => {
    sockets.add(socket)
    let text = ''
    socket.on('data', (data: Buffer) => {
      received.push(data)
      text += data.toString('latin1')
      while (text.includes('\r\n\r\n')) {
        text = text.slice(text.indexOf('\r\n\r\n') + 4)
        socket.write('HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n')
      }
    })
    socket.on('error', () => {})
  })
  servers.push(s)
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done))
  return { port: (s.address() as AddressInfo).port, received }
}

describe('a relay at an IP address, reached by its pin', () => {
  const credentials = selfSigned()
  const pin = encodeRelayBytes(createHash('sha256').update(credentials.spki).digest())

  it('pins the SHA-256 of the certificate’s SubjectPublicKeyInfo', () => {
    expect(certificatePin(new X509Certificate(credentials.cert))).toBe(pin)
  })

  it('takes a self-signed certificate whose key is the pinned one', async () => {
    const s = await server(credentials)
    const url = `https://127.0.0.1:${s.port}/v1/ping`
    const first = await relayRequest(url, { pin, timeoutMs: 5000 })
    const second = await relayRequest(url, { pin, timeoutMs: 5000 })
    expect([first.status, second.status]).toEqual([204, 204])
  })

  it('sends nothing to a server whose key is not the pinned one', async () => {
    const s = await server(credentials)
    const other = encodeRelayBytes(createHash('sha256').update('another key').digest())
    const answer = relayRequest(`https://127.0.0.1:${s.port}/v1/hosts`, {
      pin: other,
      headers: { authorization: 'Bearer relay-token' },
      timeoutMs: 5000,
    })
    await expect(answer).rejects.toBeInstanceOf(PinMismatch)

    const socket = openRelaySocket(`wss://127.0.0.1:${s.port}/v1/hosts/x`, other)
    const closed = await new Promise<number>((done) =>
      socket.addEventListener('close', (event) => done((event as CloseEvent).code)),
    )
    expect(closed).toBe(1006)
    // Give a stray write every chance to arrive.
    await new Promise((done) => setTimeout(done, 100))
    expect(Buffer.concat(s.received).length).toBe(0)
  })

  it('refuses a self-signed certificate without a pin, as any https URL does', async () => {
    const s = await server(credentials)
    await expect(
      relayRequest(`https://127.0.0.1:${s.port}/v1/ping`, { timeoutMs: 5000 }),
    ).rejects.toThrow()
    expect(Buffer.concat(s.received).length).toBe(0)
  })
})
