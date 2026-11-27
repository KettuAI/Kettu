import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { LineTransport } from './transports'

describe('LineTransport', () => {
  it('ends the stream once the client has ended its side', async () => {
    // Upgraded HTTP sockets are half-open: the client's end alone closes nothing.
    const server = net.createServer({ allowHalfOpen: true })
    const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo
    const client = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    const transport = new LineTransport(await accepted)
    let closed = false
    transport.onclose = () => (closed = true)
    await transport.start()
    const ended = new Promise<boolean>((resolve) => {
      client.once('end', () => resolve(true))
      setTimeout(() => resolve(false), 2000)
    })
    client.resume()
    client.end()
    expect(await ended).toBe(true)
    expect(closed).toBe(true)
    client.destroy()
    server.close()
  })
})
