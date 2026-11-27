// The library's servers on Kettu's loopback MCP service, one path each, behind the caller's own
// token: the service checks `Origin`, `Host` and the token, and this only lets a caller reach the
// servers its session was handed. Every server goes through the engine, which runs commands in the
// caller's folder with their keys, speaks Streamable HTTP to agents whatever the server speaks,
// leaves the tools turned off, and those of an untrusted server that changed since the user
// accepted them, out of lists and refuses calls to them, and records each call's metadata. Keys and tokens stay here: agents only ever hold the caller's token.

import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AgentId } from '@shared/agents'
import type { McpTerminalApp } from '@shared/mcp-terminal'
import { runOf, type MarketServer } from '@shared/marketplace'
import {
  MCP_STDERR_BYTES,
  type McpInstanceInfo,
  type McpRunState,
  type McpServerLog,
} from '@shared/mcp-insight'
import type { LogFn } from '../storage'
import { Answers, specDigest } from './answers'
import { startCommand, type CommandDeps } from './command'
import {
  Instance,
  Link,
  type CallOutcome,
  type LinkPolicy,
  type Sharing,
  type Upstream,
} from './engine'
import {
  isRecord,
  isRequest,
  META_VERSION,
  metaOf,
  MODERN_VERSION,
  readMessage,
  type Message,
} from './jsonrpc'
import { toolGuard, type ToolChanges } from './tool-changes'
import { LineTransport, StatelessTransport } from './transports'

export const SERVER_PREFIX = '/servers/'
/** Where sessions started before the router reached their OAuth servers; still answered. */
export const OLD_PROXY_PREFIX = '/proxy/'
export const BRIDGE_PREFIX = '/bridge/'
/** The `Upgrade` the bridge asks for, after which the connection carries lines of JSON-RPC. */
export const BRIDGE_UPGRADE = 'kettu-mcp'
export const BRIDGE_CWD_HEADER = 'kettu-cwd'
export const BRIDGE_AGENT_HEADER = 'kettu-agent'
/** Sent by a bridge started inside one of Kettu's own sessions from an entry in the agent's file. */
export const BRIDGE_SESSION_HEADER = 'kettu-session'

const BODY_BYTES = 16 * 1024 * 1024
/** HTTP sessions one caller may hold open to one server; an older one closes for a new one. */
const SESSIONS_PER_CALLER = 16
/** Logs of instances that ended kept per server, besides those that run. */
const ENDED_LOGS = 4
const LIST_CHANGED_TOOLS = 'notifications/tools/list_changed'

/** A server's path: a digest of its id, which leaks nothing and needs no escaping. */
export function serverDigest(serverId: string): string {
  return createHash('sha256').update(serverId).digest('hex').slice(0, 24)
}

export function serverPath(serverId: string): string {
  return `${SERVER_PREFIX}${serverDigest(serverId)}`
}

/** Who a request is from, as the service knows it from the token. */
export interface RouterCaller {
  /** The token's digest; a session's own processes are shared under it. */
  key: string
  sessionId: string | null
  /** Where its processes start: the session's folder, its worktree included. */
  folder: string
  /** The library servers its session was handed, by id. */
  servers: ReadonlySet<string>
  /** For a token a folder's sessions share: those sessions, else absent. */
  sessions?: ReadonlySet<string>
  /** A bridge started from an agent's or app's own file, with no session behind it. */
  terminal?: { agentId: AgentId | null; app?: McpTerminalApp }
}

/** A call through the router, for its record, with who made it. */
export interface RouterCall {
  serverId: string
  /** The session it came from, when the caller's token tells one. */
  sessionId: string | null
  outcome: CallOutcome
  /** For a call from a terminal or an app: the agent or app the bridge named, and its folder. */
  terminal?: { agentId: AgentId | null; app?: McpTerminalApp; folder: string }
}

/** What a command server runs, its keys filled in. */
export interface ServerCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface RouterDeps {
  servers(): readonly MarketServer[]
  /** The program a command server runs, or why it cannot, such as a key with no value. */
  command(server: MarketServer): ServerCommand | string
  /** A remote server's fixed headers and filled inputs. */
  headers(server: MarketServer): Record<string, string>
  /** Whether requests to it carry the user's sign-in, rather than none for an open server. */
  signsIn(server: MarketServer): boolean
  /** A fresh token of a server that signs in, or null when it is not connected. */
  token(serverId: string): Promise<string | null>
  /** The server refused `used`: a renewed token, or null. */
  refused(serverId: string, used: string): Promise<string | null>
  answers: Answers
  /** The tools each server's user accepted, which changed ones are held back against. */
  tools?: ToolChanges
  /** A tool call through the router ended. */
  called?(call: RouterCall): void
  appVersion: string
  home: string
  log: LogFn
  fetch?: typeof fetch
  /** How command servers are started and stopped, their trees recorded with the agents'. */
  processes: Omit<CommandDeps, 'quitting'>
}

type Sdk = Awaited<ReturnType<typeof loadSdk>>

function loadSdk() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
    import('@modelcontextprotocol/sdk/client/index.js'),
  ]).then(([sse, http, server, memory, client]) => ({
    SSEClientTransport: sse.SSEClientTransport,
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
    StreamableHTTPServerTransport: server.StreamableHTTPServerTransport,
    InMemoryTransport: memory.InMemoryTransport,
    Client: client.Client,
  }))
}

function refuse(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

/** A refusal before the upgrade, which the bridge prints as its one line. */
function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = status === 404 ? 'Not Found' : status === 401 ? 'Unauthorized' : 'Forbidden'
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nConnection: close\r\n` +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  )
}

async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > BODY_BYTES) throw new RangeError('The request is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

interface HttpSession {
  callerKey: string
  serverId: string
  transport: StreamableHTTPServerTransport
  link: Link
  at: number
}

interface Linked {
  link: Link
  caller: RouterCaller
  serverId: string
}

/** The stderr of one instance, kept past its end until newer ones push it out. */
interface InstanceLog {
  id: string
  serverId: string
  sessionId: string | null
  folder: string
  text: string
  instance: Instance | null
}

/** The one session a caller stands for, or null for a folder's token several sessions share. */
function sessionOf(caller: RouterCaller): string | null {
  if (caller.sessionId !== null) return caller.sessionId
  const sessions = caller.sessions ? [...caller.sessions] : []
  return sessions.length === 1 ? sessions[0]! : null
}

export class McpRouter {
  private sdk: Promise<Sdk> | null = null
  private readonly instances = new Map<string, Instance>()
  private readonly links = new Set<Linked>()
  /** The connections answered as servers with no tools, closed with the router. */
  private readonly empties = new Set<Duplex>()
  private readonly sessions = new Map<string, HttpSession>()
  private readonly stateless = new Map<string, { transport: StatelessTransport; link: Link }>()
  private readonly clients = new Map<string, Promise<Client>>()
  /** Servers turned off for a session alone, by session id. */
  private readonly sessionOff = new Map<string, Set<string>>()
  /** Each instance's id, which the server page names it by. */
  private readonly ids = new Map<
    Instance,
    { id: string; sessionId: string | null; folder: string }
  >()
  private readonly logs: InstanceLog[] = []
  /** Why a server last failed to start or ended, until it starts again. */
  private readonly failures = new Map<string, { reason: string; at: number }>()
  /** The tools turned off of each server, as links last heard of them. */
  private readonly toolsOffSeen = new Map<string, string>()
  private nextLink = 1
  private nextInstance = 1
  private closing = false

  constructor(private readonly deps: RouterDeps) {}

  private loadSdk(): Promise<Sdk> {
    // A failed load is tried again with the next request rather than kept.
    this.sdk ??= loadSdk().catch((error: unknown) => {
      this.sdk = null
      throw error
    })
    return this.sdk
  }

  /** The server a path names, among those the library keeps. */
  serverAt(path: string): MarketServer | null {
    const prefix = path.startsWith(SERVER_PREFIX)
      ? SERVER_PREFIX
      : path.startsWith(OLD_PROXY_PREFIX)
        ? OLD_PROXY_PREFIX
        : null
    if (!prefix) return null
    const digest = path.slice(prefix.length).replace(/\/$/, '')
    return this.deps.servers().find((server) => serverDigest(server.id) === digest) ?? null
  }

  /** Whether `path` is one of the router's, for the service to pass on. */
  static owns(path: string): boolean {
    return path.startsWith(SERVER_PREFIX) || path.startsWith(OLD_PROXY_PREFIX)
  }

  /** A request the service has checked the token of. */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: RouterCaller,
    path: string,
  ): Promise<void> {
    const server = this.serverAt(path)
    if (!server || !server.on) return refuse(res, 404, 'Not found')
    if (!caller.servers.has(server.id)) {
      return refuse(res, 403, 'This server was not given to this session')
    }
    try {
      await this.engine(req, res, caller, server)
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const status = error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 500
      refuse(res, status, (error as Error).message)
    }
  }

  private async engine(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: RouterCaller,
    server: MarketServer,
  ): Promise<void> {
    const sdk = await this.loadSdk()
    const sessionId = req.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const held = this.sessions.get(sessionId)
      if (!held || held.callerKey !== caller.key || held.serverId !== server.id) {
        return refuse(res, 404, 'Session not found')
      }
      held.at = Date.now()
      return held.transport.handleRequest(req, res)
    }
    if (req.method !== 'POST') {
      return refuse(res, 405, 'Method not allowed', { Allow: 'POST' })
    }
    const parsed = await body(req)
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    const opens = messages.some((item) => isRecord(item) && item.method === 'initialize')
    if (opens) return this.openSession(sdk, req, res, caller, server, parsed)
    const message = messages.length === 1 ? readMessage(messages[0]) : null
    if (message && this.stateless_(message)) {
      return this.statelessFor(caller, server).transport.deliver(res, message)
    }
    refuse(res, 400, 'Open the server with initialize first')
  }

  /** A message of the stateless protocol: it names the version, or is a notification after one. */
  private stateless_(message: Message): boolean {
    if (!isRequest(message)) return 'method' in message
    return metaOf(message.params)[META_VERSION] === MODERN_VERSION
  }

  private async openSession(
    sdk: Sdk,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: RouterCaller,
    server: MarketServer,
    parsed: unknown,
  ): Promise<void> {
    const mine = [...this.sessions.entries()]
      .filter(([, held]) => held.callerKey === caller.key && held.serverId === server.id)
      .sort(([, a], [, b]) => a.at - b.at)
    for (const [, held] of mine.slice(0, Math.max(0, mine.length - SESSIONS_PER_CALLER + 1))) {
      held.link.close()
    }
    let opened: string | null = null
    const transport = new sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        opened = id
        this.sessions.set(id, {
          callerKey: caller.key,
          serverId: server.id,
          transport,
          link,
          at: Date.now(),
        })
      },
    })
    const link = this.link(server, caller, transport)
    transport.onclose = () => {
      if (opened !== null) this.sessions.delete(opened)
      link.close()
    }
    await transport.start()
    await transport.handleRequest(req, res, parsed)
  }

  private statelessFor(
    caller: RouterCaller,
    server: MarketServer,
  ): { transport: StatelessTransport; link: Link } {
    const key = `${caller.key}|${server.id}`
    const held = this.stateless.get(key)
    if (held) return held
    const transport = new StatelessTransport()
    const link = this.link(server, caller, transport, () => this.stateless.delete(key))
    const made = { transport, link }
    this.stateless.set(key, made)
    void transport.start()
    return made
  }

  /**
   * The bridge's upgrade, its token already checked: lines of JSON-RPC from here on. A terminal's
   * bridge for a server its agent or folder does not get answers as a server with no tools, as an
   * entry left in a file after its takeover was turned off does.
   */
  upgrade(socket: Duplex, head: Buffer, caller: RouterCaller, name: string): void {
    const server = this.deps.servers().find((item) => item.name === name && item.on)
    if (!server && caller.terminal) return this.upgradeEmpty(socket, head, name)
    if (!server) return refuseUpgrade(socket, 404, `Kettu has no MCP server named ${name}`)
    if (!caller.servers.has(server.id)) {
      if (caller.terminal) return this.upgradeEmpty(socket, head, name)
      return refuseUpgrade(socket, 403, `${name} was not given to this session`)
    }
    if (caller.terminal) socket.once('close', () => this.forget(caller.key))
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${BRIDGE_UPGRADE}\r\nConnection: Upgrade\r\n\r\n`,
    )
    const transport = new LineTransport(socket)
    this.link(server, caller, transport)
    void transport.start()
    transport.push(head)
  }

  /** A server with no tools, resources or prompts, which never fails the client's start. */
  upgradeEmpty(socket: Duplex, head: Buffer, name: string): void {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${BRIDGE_UPGRADE}\r\nConnection: Upgrade\r\n\r\n`,
    )
    this.empties.add(socket)
    socket.once('close', () => this.empties.delete(socket))
    const transport = new LineTransport(socket)
    transport.onmessage = (received) => {
      const message = received as Message
      if (!isRequest(message)) return
      const answer = (result: Record<string, unknown>) =>
        void transport.send({ jsonrpc: '2.0', id: message.id, result } as never)
      switch (message.method) {
        case 'initialize': {
          const asked = (message.params as { protocolVersion?: unknown } | undefined)
            ?.protocolVersion
          return answer({
            protocolVersion: typeof asked === 'string' ? asked : MODERN_VERSION,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name, version: this.deps.appVersion },
          })
        }
        case 'tools/list':
          return answer({ tools: [] })
        case 'resources/list':
          return answer({ resources: [] })
        case 'resources/templates/list':
          return answer({ resourceTemplates: [] })
        case 'prompts/list':
          return answer({ prompts: [] })
        case 'ping':
          return answer({})
        default:
          void transport.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `${message.method} is not offered here` },
          } as never)
      }
    }
    void transport.start()
    transport.push(head)
  }

  private link(
    server: MarketServer,
    caller: RouterCaller,
    down: Transport,
    closed?: () => void,
  ): Link {
    const instance = this.instanceFor(server, caller)
    const linked: Linked = { link: null as never, caller, serverId: server.id }
    linked.link = new Link(
      instance,
      down,
      () => {
        this.links.delete(linked)
        closed?.()
      },
      this.policy(server.id, caller),
    )
    this.links.add(linked)
    return linked.link
  }

  /** What a caller may use of a server, read from the library and the session as they are now. */
  private policy(serverId: string, caller: RouterCaller): LinkPolicy {
    return {
      toolOff: (name) =>
        this.deps
          .servers()
          .find((item) => item.id === serverId)
          ?.toolsOff?.includes(name) === true,
      serverOff: () => this.offFor(caller, serverId),
      heldTool: (tool) =>
        this.holds(serverId) ? (this.deps.tools?.change(serverId, tool) ?? null) : null,
      heldCall: (name) =>
        this.holds(serverId) ? (this.deps.tools?.changeByName(serverId, name) ?? null) : null,
      called: (outcome) =>
        this.deps.called?.({
          serverId,
          sessionId: sessionOf(caller),
          outcome,
          ...(caller.terminal ? { terminal: { ...caller.terminal, folder: caller.folder } } : {}),
        }),
    }
  }

  /** Whether the server's changed tools wait for the user, as its source is now. */
  private holds(serverId: string): boolean {
    const server = this.deps.servers().find((item) => item.id === serverId)
    return server !== undefined && toolGuard(server) === 'hold'
  }

  /** A folder's token loses a server only once every session that uses it turned it off. */
  private offFor(caller: RouterCaller, serverId: string): boolean {
    const off = (sessionId: string) => this.sessionOff.get(sessionId)?.has(serverId) === true
    if (caller.sessionId !== null) return off(caller.sessionId)
    const sessions = caller.sessions ? [...caller.sessions] : []
    return sessions.length > 0 && sessions.every(off)
  }

  private instanceFor(server: MarketServer, caller: RouterCaller): Instance {
    const run = runOf(server)
    const remote = server.spec.type === 'http'
    const sharing: Sharing = remote
      ? 'link'
      : run.mode === 'folder'
        ? 'folder'
        : run.mode === 'all'
          ? 'all'
          : 'session'
    const key =
      sharing === 'link'
        ? `${server.id}|l|${this.nextLink++}`
        : sharing === 'session'
          ? `${server.id}|s|${caller.key}`
          : sharing === 'folder'
            ? `${server.id}|f|${caller.folder}`
            : `${server.id}|a`
    const held = this.instances.get(key)
    if (held) return held
    const folder = sharing === 'all' ? this.deps.home : caller.folder
    const log: InstanceLog = {
      id: `i${this.nextInstance++}`,
      serverId: server.id,
      sessionId: sharing === 'session' || sharing === 'link' ? sessionOf(caller) : null,
      folder,
      text: '',
      instance: null,
    }
    const instance: Instance = new Instance({
      serverId: server.id,
      serverName: server.name,
      spec: specDigest(server.spec),
      sharing,
      lazy: !remote,
      idleMs: remote ? null : run.idleMinutes * 60_000,
      startMs: run.startSeconds * 1000,
      open: () => this.open(server.id, folder, log),
      answers: this.deps.answers,
      listed: (tools, first) => this.deps.tools?.seen(server.id, tools, first ? 'list' : 'page'),
      client: { name: 'kettu', version: this.deps.appVersion },
      log: this.deps.log,
      status: (error) => {
        if (error === null) this.failures.delete(server.id)
        else this.failures.set(server.id, { reason: error, at: Date.now() })
      },
      ended: (ended) => {
        if (this.instances.get(key) === ended) this.instances.delete(key)
        this.ids.delete(ended)
        log.instance = null
        this.trimLogs(server.id)
      },
    })
    log.instance = instance
    this.ids.set(instance, { id: log.id, sessionId: log.sessionId, folder })
    this.instances.set(key, instance)
    return instance
  }

  /** Drops the oldest logs of instances that ended past what a server keeps. */
  private trimLogs(serverId: string): void {
    const ended = this.logs.filter((log) => log.serverId === serverId && log.instance === null)
    for (const log of ended.slice(0, Math.max(0, ended.length - ENDED_LOGS))) {
      this.logs.splice(this.logs.indexOf(log), 1)
    }
  }

  /** Starts a command in `folder`, or connects to a remote server, as the library has it now. */
  private async open(serverId: string, folder: string, log: InstanceLog): Promise<Upstream> {
    const sdk = await this.loadSdk()
    const server = this.deps.servers().find((item) => item.id === serverId)
    if (!server) throw new Error('The server was removed')
    if (server.spec.type === 'stdio') {
      const command = this.deps.command(server)
      if (typeof command === 'string') throw new Error(command)
      const where = await stat(folder).catch(() => null)
      if (!where?.isDirectory()) throw new Error(`The folder ${folder} does not exist`)
      let tail = ''
      if (!this.logs.includes(log)) this.logs.push(log)
      const transport = await startCommand(
        server.name,
        command,
        folder,
        { ...this.deps.processes, quitting: () => this.closing },
        (text) => {
          tail = (tail + text).slice(-MCP_STDERR_BYTES)
          log.text = tail
        },
      )
      return { transport, stderr: () => tail }
    }
    const url = new URL(server.spec.url)
    const fetch = this.remoteFetch(server)
    const transport =
      server.spec.transport === 'sse'
        ? new sdk.SSEClientTransport(url, { fetch })
        : new sdk.StreamableHTTPClientTransport(url, { fetch })
    return { transport }
  }

  /**
   * Requests to a remote server with its keys and its sign-in's token, renewed once when the
   * server refuses it, and the stateless protocol's routing headers read from the body.
   */
  remoteFetch(server: MarketServer): typeof fetch {
    const base = this.deps.fetch ?? fetch
    const oauth = this.deps.signsIn(server)
    return async (url, init) => {
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(this.deps.headers(server)))
        headers.set(name, value)
      routingHeaders(headers, init?.body)
      let token: string | null = null
      if (oauth) {
        token = await this.deps.token(server.id)
        if (token === null) throw new Error(signInNeeded(server.name))
        headers.set('Authorization', `Bearer ${token}`)
      }
      let answer = await base(url, { ...init, headers })
      if (answer.status !== 401 || token === null) return answer
      void answer.body?.cancel()
      const renewed = await this.deps.refused(server.id, token)
      if (renewed === null) throw new Error(signInNeeded(server.name))
      headers.set('Authorization', `Bearer ${renewed}`)
      answer = await base(url, { ...init, headers })
      if (answer.status === 401) {
        void answer.body?.cancel()
        await this.deps.refused(server.id, renewed)
        throw new Error(signInNeeded(server.name))
      }
      return answer
    }
  }

  /**
   * A client of Kettu's own on a server for `caller`, as an agent's connection: for the tool
   * gateway, which calls servers on behalf of an agent that cannot declare them all.
   */
  client(server: MarketServer, caller: RouterCaller): Promise<Client> {
    const key = `${caller.key}|${server.id}`
    const held = this.clients.get(key)
    if (held) return held
    const made = (async () => {
      const sdk = await this.loadSdk()
      const [mine, theirs] = sdk.InMemoryTransport.createLinkedPair()
      this.link(server, caller, theirs, () => this.clients.delete(key))
      await theirs.start()
      const client = new sdk.Client({ name: 'kettu', version: this.deps.appVersion })
      await client.connect(mine)
      return client
    })()
    made.catch(() => this.clients.delete(key))
    this.clients.set(key, made)
    return made
  }

  /** A server's tools for the gateway, read as an agent would, so kept answers serve it too. */
  async tools(server: MarketServer, caller: RouterCaller): Promise<Tool[]> {
    const client = await this.client(server, caller)
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor !== undefined && tools.length < 2000)
    return tools
  }

  /** A call of the gateway's to one of a server's tools, on behalf of `caller`. */
  async call(
    server: MarketServer,
    caller: RouterCaller,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = await this.client(server, caller)
    return (await client.callTool({ name, arguments: args })) as CallToolResult
  }

  /** The tools a server listed last, as kept, or null when it never has. */
  knownTools(server: MarketServer): unknown[] | null {
    const kept = this.deps.answers.get(server.id, specDigest(server.spec))
    const tools = kept?.lists['tools/list']?.tools
    return Array.isArray(tools) ? tools : null
  }

  /** The caller's token ended: its connections close and its own processes stop. */
  forget(callerKey: string): void {
    for (const linked of [...this.links]) {
      if (linked.caller.key === callerKey) linked.link.close()
    }
    for (const [key, instance] of [...this.instances]) {
      if (key.includes(`|s|${callerKey}`)) void instance.stop('removed')
    }
  }

  /**
   * The library changed: a server removed, or one whose command, keys or run settings changed,
   * has its processes stopped and its connections closed, which agents open again.
   */
  serversChanged(changed: ReadonlySet<string> = new Set()): void {
    const servers = new Map(this.deps.servers().map((server) => [server.id, server]))
    this.deps.answers.keep(new Set(servers.keys()))
    this.deps.tools?.keep(new Set(servers.keys()))
    for (const [key, instance] of [...this.instances]) {
      const server = servers.get(instance.options.serverId)
      const same =
        server !== undefined &&
        server.on &&
        !changed.has(server.id) &&
        specDigest(server.spec) === instance.options.spec &&
        sharingOf(server) === instance.sharing
      if (same) continue
      for (const link of [...instance.links]) link.close()
      void instance.stop('removed')
      this.instances.delete(key)
    }
    for (const log of [...this.logs]) {
      if (!servers.has(log.serverId)) this.logs.splice(this.logs.indexOf(log), 1)
    }
    for (const id of [...this.failures.keys()]) if (!servers.has(id)) this.failures.delete(id)
    for (const server of servers.values()) {
      const off = JSON.stringify(server.toolsOff ?? [])
      const seen = this.toolsOffSeen.get(server.id)
      this.toolsOffSeen.set(server.id, off)
      if (seen !== undefined && seen !== off) this.toolsChanged(server.id, () => true)
    }
    for (const id of [...this.toolsOffSeen.keys()])
      if (!servers.has(id)) this.toolsOffSeen.delete(id)
  }

  /** Tells the links of a server that `which` picks that its tools changed, so they list again. */
  private toolsChanged(serverId: string, which: (caller: RouterCaller) => boolean): void {
    for (const linked of this.links) {
      if (linked.serverId !== serverId || !which(linked.caller)) continue
      linked.link.notify({ jsonrpc: '2.0', method: LIST_CHANGED_TOOLS })
    }
  }

  /** What a server may hand agents changed, as the user accepted tools: every agent lists again. */
  heldChanged(serverId: string): void {
    this.toolsChanged(serverId, () => true)
  }

  /** Turns a server off or on for one session; its agent hears its tools changed. */
  setSessionOff(sessionId: string, serverId: string, off: boolean): void {
    const held = this.sessionOff.get(sessionId) ?? new Set<string>()
    if (off) held.add(serverId)
    else held.delete(serverId)
    if (held.size > 0) this.sessionOff.set(sessionId, held)
    else this.sessionOff.delete(sessionId)
    this.toolsChanged(serverId, (caller) => mine(caller, sessionId))
  }

  /** The servers turned off for a session alone. */
  offIn(sessionId: string): ReadonlySet<string> {
    return this.sessionOff.get(sessionId) ?? new Set()
  }

  /** The session ended: what was turned off for it alone is forgotten. */
  sessionEnded(sessionId: string): void {
    this.sessionOff.delete(sessionId)
  }

  /**
   * Connects a session to a server afresh: its connections close, which its agent opens again,
   * and a process or connection of its own stops; one other sessions share keeps running.
   */
  async reconnect(sessionId: string, serverId: string): Promise<void> {
    const stops = new Set<Instance>()
    for (const linked of [...this.links]) {
      if (linked.serverId !== serverId || !mine(linked.caller, sessionId)) continue
      const { instance } = linked.link
      if (instance.sharing === 'session' || instance.sharing === 'link') stops.add(instance)
      linked.link.close()
    }
    this.failures.delete(serverId)
    await Promise.all([...stops].map((instance) => instance.stop('removed')))
  }

  /** Stops one instance by its id; its links stay and the next request starts it again. */
  async stopInstance(serverId: string, id: string): Promise<boolean> {
    for (const [instance, info] of this.ids) {
      if (info.id !== id || instance.options.serverId !== serverId) continue
      await instance.stop('idle')
      return true
    }
    return false
  }

  /** Where a server stands as the router saw it last, without reaching it. */
  state(server: MarketServer): McpRunState {
    if (server.spec.type === 'stdio' && runOf(server).mode === 'agent') return { state: 'by-agent' }
    const mine = [...this.instances.values()].filter(
      (instance) => instance.options.serverId === server.id,
    )
    const running = mine.filter((instance) => instance.running).length
    if (running > 0) return { state: 'running', instances: running }
    if (mine.some((instance) => instance.isStarting)) return { state: 'starting' }
    const failed = this.failures.get(server.id)
    if (failed) return { state: 'error', reason: failed.reason, at: failed.at }
    return { state: 'idle' }
  }

  /** The processes and connections a server has now. */
  instancesOf(serverId: string): McpInstanceInfo[] {
    const out: McpInstanceInfo[] = []
    for (const [instance, info] of this.ids) {
      if (instance.options.serverId !== serverId) continue
      out.push({
        id: info.id,
        sharing: instance.sharing,
        sessionId: info.sessionId,
        folder: info.folder,
        startedAt: instance.startedAt,
        lastCallAt: instance.lastCallAt,
        stopsAt: instance.stopsAt(),
        running: instance.running,
      })
    }
    return out
  }

  /** The stderr each instance of a server wrote, as it is: the caller masks it. */
  logsOf(serverId?: string): McpServerLog[] {
    return this.logs
      .filter((log) => serverId === undefined || log.serverId === serverId)
      .map((log) => ({
        instance: log.id,
        serverId: log.serverId,
        sessionId: log.sessionId,
        folder: log.folder,
        running: log.instance?.running === true,
        text: log.text,
      }))
  }

  /** Every process stops, as the host shuts down. */
  async close(): Promise<void> {
    this.closing = true
    for (const linked of [...this.links]) linked.link.close()
    for (const socket of this.empties) socket.destroy()
    this.empties.clear()
    await Promise.all([...this.instances.values()].map((instance) => instance.stop('removed')))
    this.instances.clear()
    await this.deps.answers.flush()
    await this.deps.tools?.flush()
  }

  /** How many processes run, by server id, for the server's page. */
  running(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const instance of this.instances.values()) {
      if (!instance.running || instance.sharing === 'link') continue
      counts.set(instance.options.serverId, (counts.get(instance.options.serverId) ?? 0) + 1)
    }
    return counts
  }
}

/**
 * What an agent hears from a server whose sign-in Kettu does not hold: an error that says where to
 * fix it, rather than an HTTP 401 that would send its own client to sign in at Kettu's address.
 */
function signInNeeded(name: string): string {
  return `${name} needs sign-in; sign in to it in Kettu's Marketplace`
}

/** Whether a caller is, or takes in, the session. */
function mine(caller: RouterCaller, sessionId: string): boolean {
  return caller.sessionId === sessionId || caller.sessions?.has(sessionId) === true
}

function sharingOf(server: MarketServer): Sharing {
  if (server.spec.type === 'http') return 'link'
  const mode = runOf(server).mode
  return mode === 'folder' ? 'folder' : mode === 'all' ? 'all' : 'session'
}

/**
 * The stateless protocol's `Mcp-Method` and `Mcp-Name` for a request to a server that speaks
 * it.
 */
export function routingHeaders(headers: Headers, payload: unknown): void {
  if (typeof payload !== 'string' || !payload.includes(MODERN_VERSION)) return
  let message: Message | null
  try {
    message = readMessage(JSON.parse(payload))
  } catch {
    return
  }
  if (!message || !('method' in message)) return
  if (isRequest(message) && metaOf(message.params)[META_VERSION] !== MODERN_VERSION) return
  headers.set('Mcp-Method', message.method)
  const name = message.params?.name ?? message.params?.uri
  if (
    typeof name === 'string' &&
    ['tools/call', 'prompts/get', 'resources/read'].includes(message.method)
  ) {
    // Anything beyond plain printable ASCII goes as the specification's base64 form.
    headers.set(
      'Mcp-Name',
      /^[\x20-\x7e]*$/.test(name) && !name.startsWith('=?')
        ? name
        : `=?base64?${Buffer.from(name).toString('base64')}?=`,
    )
  }
}
