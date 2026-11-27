// The two ways an agent reaches the router besides a stateful HTTP session: the bridge's stream,
// newline-separated JSON-RPC both ways after the upgrade, and the stateless protocol's requests,
// each answered on its own HTTP response, as JSON or as an event stream when something comes
// before the result.

import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { isRequest, isResponse, readMessage, type Id, type Message } from './jsonrpc'

/** The longest line the bridge may send, as the service's own requests. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024

export class LineTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private buffer = ''
  private ended = false
  // An upgraded HTTP socket refuses setEncoding, and a character may split across chunks.
  private readonly decoder = new StringDecoder('utf8')

  constructor(private readonly socket: Duplex) {}

  async start(): Promise<void> {
    this.socket.on('data', (chunk: Buffer) => this.read(this.decoder.write(chunk)))
    this.socket.on('error', (error) => this.onerror?.(error))
    this.socket.on('close', () => this.finish())
    // The socket is half-open, so a client that closed its input would otherwise wait for good.
    this.socket.on('end', () => void this.close())
  }

  /** Bytes that came with the upgrade request, ahead of the stream. */
  push(head: Buffer): void {
    if (head.length > 0) this.read(this.decoder.write(head))
  }

  private read(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
      this.onerror?.(new Error('A message is too large'))
      this.socket.destroy()
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() !== '') this.parse(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private parse(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.onerror?.(new Error('A line is not JSON'))
      return
    }
    if (readMessage(value)) this.onmessage?.(value as JSONRPCMessage)
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ended) return
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    if (!this.ended) this.socket.end()
    this.finish()
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    this.onclose?.()
  }
}

interface Waiting {
  res: http.ServerResponse
  streaming: boolean
}

/**
 * The stateless protocol's requests for one caller and server: no session, each request on an
 * HTTP request of its own, cancelled by closing it.
 */
export class StatelessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly waiting = new Map<Id, Waiting>()

  async start(): Promise<void> {}

  /** One POST's message; a notification is accepted at once. */
  deliver(res: http.ServerResponse, message: Message): void {
    if (!isRequest(message)) {
      res.writeHead(202).end()
      this.onmessage?.(message as JSONRPCMessage)
      return
    }
    const { id } = message
    this.waiting.set(id, { res, streaming: false })
    res.on('close', () => {
      if (this.waiting.get(id)?.res !== res) return
      this.waiting.delete(id)
      // Closing the response is how the stateless protocol cancels over HTTP.
      this.onmessage?.({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: id, reason: 'The request was closed' },
      } as JSONRPCMessage)
    })
    this.onmessage?.(message as JSONRPCMessage)
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const read = message as Message
    const id = isResponse(read) ? read.id : options?.relatedRequestId
    if (id === undefined || id === null) return
    const held = this.waiting.get(id)
    if (!held) return
    const { res } = held
    if (isResponse(read)) {
      this.waiting.delete(id)
      if (held.streaming) {
        res.end(`event: message\ndata: ${JSON.stringify(read)}\n\n`)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(read))
      }
      return
    }
    if (!held.streaming) {
      held.streaming = true
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
    }
    res.write(`event: message\ndata: ${JSON.stringify(read)}\n\n`)
  }

  async close(): Promise<void> {
    for (const { res } of this.waiting.values()) res.destroy()
    this.waiting.clear()
    this.onclose?.()
  }
}
