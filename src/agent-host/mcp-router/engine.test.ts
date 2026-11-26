import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Answers } from './answers'
import { Instance, Link, type Sharing } from './engine'
import {
  META_CAPABILITIES,
  META_CLIENT,
  META_VERSION,
  MODERN_VERSION,
  type Message,
  type Request,
} from './jsonrpc'

type Handler = (message: Message, server: FakeServer) => void

/** The server end: what the instance sent, and a handler that answers it. */
class FakeServer implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly seen: Message[] = []
  closed = false
  constructor(private readonly handler: Handler) {}
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.seen.push(message as Message)
    queueMicrotask(() => this.handler(message as Message, this))
  }
  emit(message: Message): void {
    this.onmessage?.(message as JSONRPCMessage)
  }
  async close(): Promise<void> {
    this.closed = true
    this.onclose?.()
  }
  requests(method: string): Request[] {
    return this.seen.filter((m): m is Request => 'method' in m && m.method === method && 'id' in m)
  }
}

/** The agent end: what it was sent. */
class FakeClient implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly got: Message[] = []
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.got.push(message as Message)
  }
  async close(): Promise<void> {}
  deliver(message: Message): void {
    this.onmessage?.(message as JSONRPCMessage)
  }
  answer(id: string | number): Message | undefined {
    return this.got.find((m) => 'id' in m && m.id === id && !('method' in m))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/** A server of the old protocol: initialize, tools, and whatever `extra` answers. */
function legacyServer(extra?: (message: Message, server: FakeServer) => boolean): Handler {
  return (message, server) => {
    if (extra?.(message, server)) return
    if (!('id' in message) || !('method' in message)) return
    const reply = (result: Record<string, unknown>) =>
      server.emit({ jsonrpc: '2.0', id: message.id, result })
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake', version: '1' },
        })
      case 'tools/list':
        return reply({ tools: [{ name: 'live', inputSchema: { type: 'object' } }] })
      case 'tools/call':
        return reply({
          content: [{ type: 'text', text: `called ${String(message.params?.name)}` }],
        })
      default:
        server.emit({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        })
    }
  }
}

const SPEC = 'a'.repeat(32)
const instances: Instance[] = []
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.stop('removed')))
  vi.useRealTimers()
})

function setup(options: {
  handler: Handler
  sharing?: Sharing
  answers?: Answers
  idleMs?: number | null
  stderr?: string
}) {
  const answers = options.answers ?? new Answers(null)
  const opened: FakeServer[] = []
  const instance = new Instance({
    serverId: 'srv',
    serverName: 'fake',
    spec: SPEC,
    sharing: options.sharing ?? 'session',
    lazy: true,
    idleMs: options.idleMs ?? null,
    startMs: 2000,
    open: async () => {
      const server = new FakeServer(options.handler)
      opened.push(server)
      return { transport: server, stderr: () => options.stderr ?? '' }
    },
    answers,
    client: { name: 'kettu', version: '0.0.0' },
    log: () => {},
    ended: () => {},
  })
  instances.push(instance)
  const link = () => {
    const client = new FakeClient()
    return { client, link: new Link(instance, client, () => {}) }
  }
  return { instance, opened, answers, link }
}

const initialize = (id: number | string = 1): Message => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: { elicitation: {} },
    clientInfo: { name: 'claude-code', version: '2.1' },
  },
})
const call = (
  id: number | string,
  name = 'live',
  extra: Record<string, unknown> = {},
): Message => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {}, ...extra },
})

describe('a command that waits for its first call', () => {
  it('opens and lists from its last answers, and starts only for a real call', async () => {
    const answers = new Answers(null)
    answers.opened('srv', SPEC, 'legacy', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1' },
    })
    answers.listed('srv', SPEC, 'tools/list', { tools: [{ name: 'kept' }] })
    const { opened, link } = setup({ handler: legacyServer(), answers })
    const { client } = link()
    client.deliver(initialize())
    client.deliver({ jsonrpc: '2.0', method: 'notifications/initialized' })
    client.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await settle()
    expect(opened).toHaveLength(0)
    expect(client.answer(1)).toMatchObject({ result: { protocolVersion: '2025-06-18' } })
    expect(client.answer(2)).toMatchObject({ result: { tools: [{ name: 'kept' }] } })
    client.deliver(call(3))
    await settle()
    expect(opened).toHaveLength(1)
    const [init] = opened[0]!.requests('initialize')
    // The process opens as the agent asked to, with its own name and capabilities.
    expect(init!.params).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'claude-code' },
    })
    expect(
      opened[0]!.seen.some((m) => 'method' in m && m.method === 'notifications/initialized'),
    ).toBe(true)
    expect(client.answer(3)).toMatchObject({ result: { content: [{ text: 'called live' }] } })
  })

  it('starts at once when it has never answered, and keeps what it answers', async () => {
    const { opened, answers, link } = setup({ handler: legacyServer() })
    const { client } = link()
    client.deliver(initialize())
    await settle()
    expect(opened).toHaveLength(1)
    client.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await settle()
    expect(answers.get('srv', SPEC)?.lists['tools/list']).toEqual({
      tools: [{ name: 'live', inputSchema: { type: 'object' } }],
    })
    expect(answers.get('srv', 'b'.repeat(32))).toBeNull()
  })

  it('stops when idle and starts again on the next call', async () => {
    const { opened, link } = setup({ handler: legacyServer(), idleMs: 30 })
    const { client } = link()
    client.deliver(initialize())
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(opened[0]!.closed).toBe(true)
    client.deliver(call(5))
    await settle()
    expect(opened).toHaveLength(2)
    expect(client.answer(5)).toMatchObject({ result: { content: [{ text: 'called live' }] } })
  })

  it('answers what was waiting with the last stderr line when the process exits', async () => {
    const { opened, link } = setup({
      handler: legacyServer((message, server) => {
        if ('method' in message && message.method === 'tools/call') {
          void server.close()
          return true
        }
        return false
      }),
      stderr: 'warming up\nError: DATABASE_URI is not set\n',
    })
    const { client } = link()
    client.deliver(initialize())
    client.deliver(call(7))
    await settle()
    expect(client.answer(7)).toMatchObject({
      error: { message: 'The server exited: Error: DATABASE_URI is not set' },
    })
    expect(opened).toHaveLength(1)
  })
})

describe('ids and requests between links', () => {
  it('renumbers every request, so two links with the same ids get their own answers', async () => {
    const { opened, link } = setup({ handler: legacyServer(), sharing: 'folder' })
    const a = link()
    const b = link()
    a.client.deliver(initialize())
    b.client.deliver(initialize())
    a.client.deliver(call(9, 'first'))
    b.client.deliver(call(9, 'second'))
    await settle()
    expect(a.client.answer(9)).toMatchObject({ result: { content: [{ text: 'called first' }] } })
    expect(b.client.answer(9)).toMatchObject({ result: { content: [{ text: 'called second' }] } })
    const ids = opened[0]!.requests('tools/call').map((request) => request.id)
    expect(new Set(ids).size).toBe(2)
    // A shared process opens as Kettu, never as one session's agent.
    expect(opened[0]!.requests('initialize')[0]!.params).toMatchObject({
      clientInfo: { name: 'kettu' },
      capabilities: {},
    })
  })

  it('gives each link its own progress back under the token it chose', async () => {
    const { link } = setup({
      handler: legacyServer((message, server) => {
        if (!('method' in message) || message.method !== 'tools/call' || !('id' in message)) {
          return false
        }
        const token = (message.params?._meta as { progressToken: string }).progressToken
        server.emit({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: token, progress: 1 },
        })
        server.emit({ jsonrpc: '2.0', id: message.id, result: { content: [] } })
        return true
      }),
    })
    const { client } = link()
    client.deliver(initialize())
    client.deliver(call(4, 'live', { _meta: { progressToken: 'mine' } }))
    await settle()
    expect(client.got).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'mine', progress: 1 },
    })
  })

  it("passes a server's request to the one link that waits on it, and refuses it when unclear", async () => {
    let pending: (() => void) | null = null
    const { opened, link } = setup({
      sharing: 'all',
      handler: legacyServer((message, server) => {
        if ('method' in message && message.method === 'tools/call' && 'id' in message) {
          pending = () => server.emit({ jsonrpc: '2.0', id: message.id, result: { content: [] } })
          server.emit({
            jsonrpc: '2.0',
            id: 'srv-ask',
            method: 'elicitation/create',
            params: { message: 'Which one?' },
          })
          return true
        }
        return false
      }),
    })
    const a = link()
    const b = link()
    a.client.deliver(initialize())
    b.client.deliver(initialize())
    a.client.deliver(call(10))
    await settle()
    const ask = a.client.got.find((m) => 'method' in m && m.method === 'elicitation/create')
    expect(ask).toBeDefined()
    expect(b.client.got.some((m) => 'method' in m && m.method === 'elicitation/create')).toBe(false)
    a.client.deliver({
      jsonrpc: '2.0',
      id: (ask as Request).id,
      result: { action: 'accept', content: { pick: 'a' } },
    })
    await settle()
    expect(opened[0]!.seen).toContainEqual({
      jsonrpc: '2.0',
      id: 'srv-ask',
      result: { action: 'accept', content: { pick: 'a' } },
    })
    pending!()
    // Two links waiting: the server's request belongs to neither for sure.
    a.client.deliver(call(2))
    b.client.deliver(call(2))
    await settle()
    expect(opened[0]!.seen.some((m) => 'error' in m && m.id === 'srv-ask')).toBe(true)
    const asks = (client: FakeClient) =>
      client.got.filter((m) => 'method' in m && m.method === 'elicitation/create').length
    expect([asks(a.client), asks(b.client)]).toEqual([1, 0])
  })

  it('keeps a shared process to what it offers, answering the rest itself', async () => {
    const { opened, link } = setup({ handler: legacyServer(), sharing: 'all' })
    const { client } = link()
    client.deliver(initialize())
    client.deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'logging/setLevel',
      params: { level: 'debug' },
    })
    client.deliver({ jsonrpc: '2.0', id: 3, method: 'sampling/createMessage' })
    client.deliver({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' })
    await settle()
    expect(client.answer(2)).toMatchObject({ result: {} })
    expect(client.answer(3)).toMatchObject({ error: { code: -32601 } })
    const sent = opened[0]!.seen.map((m) => ('method' in m ? m.method : null))
    expect(sent).not.toContain('logging/setLevel')
    expect(sent).not.toContain('notifications/roots/list_changed')
  })
})

describe('the two eras of the protocol', () => {
  /** A server of the stateless protocol only, which asks for input once before it answers. */
  const modernServer: Handler = (message, server) => {
    if (!('id' in message) || !('method' in message)) return
    const reply = (result: Record<string, unknown>) =>
      server.emit({ jsonrpc: '2.0', id: message.id, result })
    if (message.method === 'initialize') {
      server.emit({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: [MODERN_VERSION] },
        },
      })
      return
    }
    if (message.method === 'server/discover') {
      return reply({
        resultType: 'complete',
        supportedVersions: [MODERN_VERSION],
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'new', version: '2' } },
      })
    }
    if (message.method === 'tools/call') {
      if (message.params?.inputResponses === undefined) {
        return reply({
          resultType: 'input_required',
          inputRequests: {
            login: { method: 'elicitation/create', params: { message: 'Your name?' } },
          },
          requestState: 'sealed',
        })
      }
      return reply({ resultType: 'complete', content: [{ type: 'text', text: 'hello' }] })
    }
  }

  it('lets an old agent use a server of the stateless protocol, input requests included', async () => {
    const { opened, link } = setup({ handler: modernServer })
    const { client } = link()
    client.deliver(initialize())
    await settle()
    expect(client.answer(1)).toMatchObject({
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'new', version: '2' },
      },
    })
    client.deliver(call(2))
    await settle()
    const ask = client.got.find((m) => 'method' in m && m.method === 'elicitation/create')
    expect(ask).toMatchObject({ params: { message: 'Your name?' } })
    client.deliver({
      jsonrpc: '2.0',
      id: (ask as Request).id,
      result: { action: 'accept', content: { name: 'octo' } },
    })
    await settle()
    const [first, retry] = opened[0]!.requests('tools/call')
    expect(first!.params?._meta).toMatchObject({
      [META_VERSION]: MODERN_VERSION,
      [META_CAPABILITIES]: { elicitation: {} },
      [META_CLIENT]: { name: 'claude-code' },
    })
    expect(retry!.params).toMatchObject({
      inputResponses: { login: { action: 'accept', content: { name: 'octo' } } },
      requestState: 'sealed',
    })
    expect(retry!.id).not.toBe(first!.id)
    expect(client.answer(2)).toMatchObject({ result: { content: [{ text: 'hello' }] } })
  })

  it('lets a new agent discover and call a server of the old protocol', async () => {
    const { opened, link } = setup({ handler: legacyServer() })
    const { client } = link()
    const meta = {
      [META_VERSION]: MODERN_VERSION,
      [META_CAPABILITIES]: { elicitation: {} },
      [META_CLIENT]: { name: 'new-agent', version: '1' },
    }
    client.deliver({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: meta } })
    await settle()
    // It tried the stateless protocol first, as the agent speaks it, then opened the old way.
    expect(opened[0]!.requests('server/discover')).toHaveLength(1)
    expect(opened[0]!.requests('initialize')[0]!.params).toMatchObject({
      clientInfo: { name: 'new-agent' },
      capabilities: { elicitation: {} },
    })
    expect(client.answer('d')).toMatchObject({
      result: {
        resultType: 'complete',
        supportedVersions: [MODERN_VERSION],
        capabilities: { tools: { listChanged: true } },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake' } },
      },
    })
    client.deliver(call('c', 'live', { _meta: meta }))
    await settle()
    expect(client.answer('c')).toMatchObject({
      result: {
        content: [{ text: 'called live' }],
        resultType: 'complete',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake' } },
      },
    })
  })
})
