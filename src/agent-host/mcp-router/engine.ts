// The router's forwarding between agents and one server. An `Instance` is one connection to the
// server, a process Kettu started or a remote session; a `Link` is one agent's connection to it.
// Every id that crosses is renumbered, so links never see each other's requests, and the two eras
// of the protocol meet here: an old agent can use a server that only speaks the stateless
// protocol, and the other way round. A command's process starts on the first real request; until
// then its last answers to `initialize` and the lists stand in for it.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Answers } from './answers'
import {
  earlierVersion,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  isListMethod,
  isNotification,
  isRecord,
  isRequest,
  isResponse,
  LEGACY_VERSION,
  LIST_CHANGED,
  META_CAPABILITIES,
  META_CLIENT,
  META_SERVER,
  META_SUBSCRIPTION,
  META_VERSION,
  METHOD_NOT_FOUND,
  metaOf,
  MODERN_VERSION,
  readMessage,
  refusesLegacy,
  requestEra,
  resultResponse,
  SERVER_UNAVAILABLE,
  sharedMethod,
  type Era,
  type Id,
  type Message,
  type Notification,
  type Request,
  type Response,
} from './jsonrpc'

/** Where an instance is shared: by one session, a folder, every session, or one link alone. */
export type Sharing = 'session' | 'folder' | 'all' | 'link'

/** How a tool call through a link ended, as its record keeps it: no arguments, no output. */
export interface CallOutcome {
  tool: string
  at: number
  ms: number
  bytes: number
  result: 'ok' | 'tool-error' | 'error' | 'refused' | 'cancelled'
  error?: string
}

/** Why a tool waits for the user: it is new, or its description or parameters changed. */
export type ToolHold = 'added' | 'changed'

/** What a link's agent may use of the server, asked again on every request. */
export interface LinkPolicy {
  /** The tool is turned off, for every agent. */
  toolOff(name: string): boolean
  /** The server is turned off for this link's session. */
  serverOff(): boolean
  /** How a listed tool differs from what the user accepted, while it waits for them; else null. */
  heldTool?(tool: unknown): ToolHold | null
  /** The same for a tool the agent calls by name. */
  heldCall?(name: string): ToolHold | null
  /** A tool call through the link ended. */
  called?(outcome: CallOutcome): void
}

const OPEN_POLICY: LinkPolicy = { toolOff: () => false, serverOff: () => false }

/** What each list answers with while the server is turned off for a session. */
const EMPTY_LISTS: Record<string, Record<string, unknown>> = {
  'tools/list': { tools: [] },
  'prompts/list': { prompts: [] },
  'resources/list': { resources: [] },
  'resources/templates/list': { resourceTemplates: [] },
}

/** A list result without the tools `off` picks; anything else as it is. */
export function withoutTools(
  result: Record<string, unknown>,
  off: (tool: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  if (!Array.isArray(result.tools)) return result
  const tools = result.tools.filter((tool) => !(isRecord(tool) && off(tool)))
  return tools.length === result.tools.length ? result : { ...result, tools }
}

export interface Upstream {
  transport: Transport
  /** The end of what the process wrote to stderr, for the reason it failed. */
  stderr?(): string
}

export interface InstanceOptions {
  serverId: string
  serverName: string
  /** The digest of what it runs, which its kept answers belong to. */
  spec: string
  sharing: Sharing
  /** Whether it may wait for the first real request, answering from what it said last. */
  lazy: boolean
  idleMs: number | null
  startMs: number
  open(): Promise<Upstream>
  answers: Answers
  client: { name: string; version: string }
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** The server listed tools: a list's first page, or a later one. */
  listed?(tools: readonly unknown[], first: boolean): void
  /** It started (null) or failed to start or ended on its own, with the reason. */
  status?(error: string | null): void
  /** It stopped and has no links left. */
  ended(instance: Instance): void
}

interface Forwarded {
  link: Link
  id: Id // the link's own id
  method: string
  params: Record<string, unknown> | undefined
  /** The request was for a list's first page, whose answer is kept. */
  keeps: boolean
}

interface Opening {
  resolve(response: Response): void
}

const STDERR_LINE = 300
/** How long a server has to answer `server/discover` before it is taken to be an old one. */
const PROBE_MS = 5_000

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The last line of a process's stderr, short enough for a reason. */
export function lastLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
  const line = lines.at(-1)?.trim() ?? ''
  return line.length > STDERR_LINE ? `${line.slice(0, STDERR_LINE)}…` : line
}

/** What an old client's `initialize` is answered with, from what the server opened with. */
export function legacyInit(
  era: Era,
  init: Record<string, unknown>,
  requested: unknown,
  serverName: string,
): Record<string, unknown> {
  const asked = typeof requested === 'string' ? requested : LEGACY_VERSION
  if (era === 'legacy') {
    const version = typeof init.protocolVersion === 'string' ? init.protocolVersion : asked
    return { ...init, protocolVersion: earlierVersion(asked, version) }
  }
  const server = metaOf(init)[META_SERVER]
  return {
    protocolVersion: earlierVersion(asked, LEGACY_VERSION),
    capabilities: isRecord(init.capabilities) ? init.capabilities : {},
    serverInfo: isRecord(server) ? server : { name: serverName, version: '0' },
    ...(typeof init.instructions === 'string' ? { instructions: init.instructions } : {}),
  }
}

/** What a new client's `server/discover` is answered with. */
export function modernDiscover(era: Era, init: Record<string, unknown>): Record<string, unknown> {
  if (era === 'modern') return init
  return {
    resultType: 'complete',
    supportedVersions: [MODERN_VERSION],
    capabilities: isRecord(init.capabilities) ? init.capabilities : {},
    ...(typeof init.instructions === 'string' ? { instructions: init.instructions } : {}),
    ...(isRecord(init.serverInfo) ? { _meta: { [META_SERVER]: init.serverInfo } } : {}),
  }
}

export class Instance {
  readonly links = new Set<Link>()
  era: Era | null = null
  init: Record<string, unknown> | null = null
  private upstream: Upstream | null = null
  private starting: Promise<void> | null = null
  private nextId = 1
  private nextToken = 1
  private readonly forwarded = new Map<Id, Forwarded>()
  private readonly opening = new Map<Id, Opening>()
  /** Progress tokens as the server sees them, to the link and token they stand for. */
  private readonly tokens = new Map<string, { link: Link; token: Id }>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastActive = 0
  /** When the running process or connection started. */
  startedAt: number | null = null
  /** When a link last called one of its tools. */
  lastCallAt: number | null = null
  /** Why the last start failed, while nothing has started since. */
  error: string | null = null

  constructor(readonly options: InstanceOptions) {}

  get running(): boolean {
    return this.upstream !== null && this.starting === null
  }

  get sharing(): Sharing {
    return this.options.sharing
  }

  get isStarting(): boolean {
    return this.starting !== null
  }

  /** When it stops while nothing uses it, or null when it does not stop on its own. */
  stopsAt(): number | null {
    const { idleMs } = this.options
    return idleMs === null || !this.running ? null : this.lastActive + idleMs
  }

  /** What the server answered last, kept from an earlier run, while it runs the same command. */
  kept(): { era: Era; init: Record<string, unknown>; lists: Record<string, unknown> } | null {
    if (this.running && this.era && this.init) {
      return { era: this.era, init: this.init, lists: {} }
    }
    const held = this.options.answers.get(this.options.serverId, this.options.spec)
    return held ? { era: held.era, init: held.init, lists: held.lists } : null
  }

  attach(link: Link): void {
    this.links.add(link)
  }

  /** A link closed: what it asked is cancelled at the server, and a link's own instance ends. */
  detach(link: Link): void {
    if (!this.links.delete(link)) return
    for (const [id, forwarded] of this.forwarded) {
      if (forwarded.link !== link) continue
      this.forwarded.delete(id)
      this.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: id, reason: 'The client disconnected' },
      })
    }
    for (const [token, held] of this.tokens) if (held.link === link) this.tokens.delete(token)
    if (this.links.size > 0) return
    if (this.sharing === 'link' || this.sharing === 'session' || !this.running) {
      void this.stop('closed')
    }
  }

  /** Starts the server for `link` unless it runs; failures reject with a reason to show. */
  ensure(link: Link | null): Promise<void> {
    if (this.running) return Promise.resolve()
    this.starting ??= this.start(link).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(link: Link | null): Promise<void> {
    const { startMs, serverName } = this.options
    let upstream: Upstream
    try {
      upstream = await this.options.open()
    } catch (error) {
      this.error = text(error)
      this.options.status?.(this.error)
      throw error
    }
    this.upstream = upstream
    const transport = upstream.transport
    transport.onmessage = (message) => this.received(message)
    transport.onerror = (error) => this.options.log('warn', `${serverName}: ${text(error)}`)
    transport.onclose = () => {
      if (this.upstream === upstream) this.closed(upstream)
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${serverName} did not answer in ${Math.round(startMs / 1000)} s`)),
        startMs,
      )
    })
    try {
      await transport.start()
      await Promise.race([this.open(link), timeout])
      this.error = null
      this.startedAt = Date.now()
      this.options.status?.(null)
      this.touch()
    } catch (error) {
      const reason = this.reason(error, upstream)
      this.error = reason
      this.options.status?.(reason)
      this.upstream = null
      void transport.close().catch(() => undefined)
      throw new Error(reason, { cause: error })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private reason(error: unknown, upstream: Upstream): string {
    const message = text(error)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `Command not found: ${message}`
    const line = lastLine(upstream.stderr?.() ?? '')
    return line ? `${message}: ${line}` : message
  }

  /** The opening exchange, in the era the link speaks first and then the other. */
  private async open(link: Link | null): Promise<void> {
    const shared = this.sharing === 'folder' || this.sharing === 'all'
    const client = shared || !link ? this.options.client : (link.client() ?? this.options.client)
    const capabilities = shared || !link ? {} : link.capabilities()
    const version = !shared && link?.era === 'legacy' ? link.askedVersion() : LEGACY_VERSION
    const legacy = async (): Promise<Response> =>
      this.ask('initialize', { protocolVersion: version, capabilities, clientInfo: client })
    const modern = async (probe: boolean): Promise<Response> => {
      this.upstream?.transport.setProtocolVersion?.(MODERN_VERSION)
      // An old server may never answer a method it does not know, which only means it is old.
      const wait = probe ? Math.min(PROBE_MS, this.options.startMs / 2) : undefined
      return this.ask(
        'server/discover',
        {
          _meta: {
            [META_VERSION]: MODERN_VERSION,
            [META_CLIENT]: client,
            [META_CAPABILITIES]: capabilities,
          },
        },
        wait,
      )
    }
    const accept = (era: Era, result: Record<string, unknown>): void => {
      this.era = era
      this.init = result
      this.options.answers.opened(this.options.serverId, this.options.spec, era, result)
      if (era === 'legacy') {
        const negotiated =
          typeof result.protocolVersion === 'string' ? result.protocolVersion : null
        if (negotiated) this.upstream?.transport.setProtocolVersion?.(negotiated)
        this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      }
    }
    if (link?.era === 'modern' && !shared) {
      const answer = await modern(true)
      if (answer.result) return accept('modern', answer.result)
      const fallback = await legacy()
      if (fallback.result) return accept('legacy', fallback.result)
      throw new Error(fallback.error?.message ?? 'The server refused to open')
    }
    const answer = await legacy()
    if (answer.result) return accept('legacy', answer.result)
    if (refusesLegacy(answer.error)) {
      const discovered = await modern(false)
      if (discovered.result) return accept('modern', discovered.result)
      throw new Error(discovered.error?.message ?? 'The server refused to open')
    }
    throw new Error(answer.error?.message ?? 'The server refused to open')
  }

  /** A request of Kettu's own to the server, answered as an error after `waitMs` if given. */
  private ask(method: string, params: Record<string, unknown>, waitMs?: number): Promise<Response> {
    const id = `kettu-${this.nextId++}`
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      this.opening.set(id, {
        resolve: (response) => {
          if (timer) clearTimeout(timer)
          resolve(response)
        },
      })
      if (waitMs !== undefined) {
        timer = setTimeout(() => {
          if (this.opening.delete(id)) resolve(errorResponse(id, SERVER_UNAVAILABLE, 'No answer'))
        }, waitMs)
      }
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** A link's request, sent on with an id of the instance's own. */
  async forward(link: Link, request: Request): Promise<void> {
    try {
      await this.ensure(link)
    } catch (error) {
      link.reply(errorResponse(request.id, SERVER_UNAVAILABLE, text(error)))
      return
    }
    const keeps = isListMethod(request.method) && request.params?.cursor === undefined
    if (request.method === 'tools/call') this.lastCallAt = Date.now()
    this.sendForwarded({
      link,
      id: request.id,
      method: request.method,
      params: request.params,
      keeps,
    })
  }

  private sendForwarded(forwarded: Forwarded, extra?: Record<string, unknown>): void {
    const id = this.nextId++
    this.forwarded.set(id, forwarded)
    let params = forwarded.params ? { ...forwarded.params, ...extra } : extra
    params = this.ownTokens(forwarded.link, params)
    if (this.era === 'modern' && forwarded.link.era !== 'modern') {
      params = { ...params, _meta: { ...metaOf(params), ...forwarded.link.modernMeta() } }
    }
    this.send({
      jsonrpc: '2.0',
      id,
      method: forwarded.method,
      ...(params ? { params } : {}),
    })
  }

  /** A progress token the link chose, as one of the instance's own. */
  private ownTokens(
    link: Link,
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const meta = metaOf(params)
    const token = meta.progressToken
    if (typeof token !== 'string' && typeof token !== 'number') return params
    const own = `p${this.nextToken++}`
    this.tokens.set(own, { link, token })
    return { ...params, _meta: { ...meta, progressToken: own } }
  }

  /** A link's notification, sent on where it means something to the server. */
  notify(link: Link, notification: Notification): void {
    if (!this.running) return
    if (notification.method === 'notifications/cancelled') {
      const requestId = notification.params?.requestId
      for (const [id, forwarded] of this.forwarded) {
        if (forwarded.link !== link || forwarded.id !== requestId) continue
        this.forwarded.delete(id)
        this.send({ ...notification, params: { ...notification.params, requestId: id } })
      }
      return
    }
    if (this.sharing === 'folder' || this.sharing === 'all') return
    this.send(notification)
  }

  /** The link answered a request of the server's. */
  answer(response: Response): void {
    this.send(response)
  }

  private send(message: Message): void {
    const upstream = this.upstream
    if (!upstream) return
    this.touch()
    upstream.transport.send(message as JSONRPCMessage).catch((error: unknown) => {
      this.options.log('warn', `${this.options.serverName}: could not send: ${text(error)}`)
      if (isRequest(message)) this.failed(message.id, text(error))
    })
  }

  private failed(id: Id, reason: string): void {
    const opening = this.opening.get(id)
    if (opening) {
      this.opening.delete(id)
      opening.resolve(errorResponse(id, SERVER_UNAVAILABLE, reason))
      return
    }
    const forwarded = this.forwarded.get(id)
    if (!forwarded) return
    this.forwarded.delete(id)
    forwarded.link.reply(errorResponse(forwarded.id, SERVER_UNAVAILABLE, reason))
  }

  private received(raw: unknown): void {
    const message = readMessage(raw)
    if (!message) return
    this.touch()
    if (isResponse(message)) return this.response(message)
    if (isRequest(message)) return this.serverRequest(message)
    if (isNotification(message)) return this.serverNotification(message)
  }

  private response(response: Response): void {
    if (response.id === null) return
    const opening = this.opening.get(response.id)
    if (opening) {
      this.opening.delete(response.id)
      opening.resolve(response)
      return
    }
    const forwarded = this.forwarded.get(response.id)
    if (!forwarded) return
    this.forwarded.delete(response.id)
    const { link } = forwarded
    const result = response.result
    if (result?.resultType === 'input_required' && link.era !== 'modern') {
      void this.inputRequired(forwarded, result)
      return
    }
    if (result && forwarded.method === 'tools/list' && Array.isArray(result.tools)) {
      this.options.listed?.(result.tools, forwarded.params?.cursor === undefined)
    }
    if (result && forwarded.keeps && isListMethod(forwarded.method)) {
      this.options.answers.listed(
        this.options.serverId,
        this.options.spec,
        forwarded.method,
        result,
      )
    }
    const shown = result && forwarded.method === 'tools/list' ? link.filterTools(result) : result
    link.reply({
      ...response,
      ...(shown ? { result: shown } : {}),
      id: forwarded.id,
      ...this.modernResult(link, shown),
    })
  }

  /** A result of the old protocol as a new agent reads one: complete, naming the server. */
  private modernResult(
    link: Link,
    result: Record<string, unknown> | undefined,
  ): { result: Record<string, unknown> } | null {
    if (!result || link.era !== 'modern' || this.era === 'modern') return null
    const server = this.init?.serverInfo
    return {
      result: {
        resultType: 'complete',
        ...result,
        _meta: { ...(isRecord(server) ? { [META_SERVER]: server } : {}), ...metaOf(result) },
      },
    }
  }

  /**
   * The stateless protocol asks for input in a result, which an old client cannot read: each
   * request in it goes to the link as the old protocol's own request, and the call is made again
   * with the answers.
   */
  private async inputRequired(
    forwarded: Forwarded,
    result: Record<string, unknown>,
  ): Promise<void> {
    const asks = isRecord(result.inputRequests) ? result.inputRequests : {}
    const answers: Record<string, unknown> = {}
    for (const [key, ask] of Object.entries(asks)) {
      if (!isRecord(ask) || typeof ask.method !== 'string') continue
      const params = isRecord(ask.params) ? ask.params : undefined
      const answer = await forwarded.link.request(ask.method, params, null, forwarded.id)
      answers[key] = answer.result ?? { action: 'decline' }
    }
    if (!this.running) {
      forwarded.link.reply(errorResponse(forwarded.id, SERVER_UNAVAILABLE, 'The server stopped'))
      return
    }
    this.sendForwarded(forwarded, {
      inputResponses: answers,
      ...(result.requestState !== undefined ? { requestState: result.requestState } : {}),
    })
  }

  /** Which link a request of the server's is for, or null when none can be told. */
  private target(): Link | null {
    const asking = [...this.links].filter((link) => link.waiting() > 0)
    if (this.sharing === 'folder' || this.sharing === 'all') {
      return asking.length === 1 ? asking[0]! : null
    }
    if (asking.length > 0) return asking.at(-1)!
    return [...this.links].sort((a, b) => b.lastActive - a.lastActive)[0] ?? null
  }

  private serverRequest(request: Request): void {
    if (request.method === 'ping') {
      this.send(resultResponse(request.id, {}))
      return
    }
    const link = this.target()
    if (!link || link.era === 'modern') {
      this.send(errorResponse(request.id, METHOD_NOT_FOUND, 'No client can answer this request'))
      return
    }
    void link.request(request.method, request.params, null).then((answer) => {
      this.send({ ...answer, id: request.id })
    })
  }

  private serverNotification(notification: Notification): void {
    const { method, params } = notification
    if (method === 'notifications/progress') {
      const token = params?.progressToken
      const held = typeof token === 'string' ? this.tokens.get(token) : undefined
      if (!held) return
      held.link.notify({ ...notification, params: { ...params, progressToken: held.token } })
      return
    }
    if (method === 'notifications/cancelled') {
      for (const link of this.links) link.serverCancelled(params?.requestId)
      return
    }
    const stale = LIST_CHANGED[method]
    if (stale) {
      this.options.answers.stale(this.options.serverId, stale)
      for (const link of this.links) link.notify(notification)
      return
    }
    const shared = this.sharing === 'folder' || this.sharing === 'all'
    if (shared && method !== 'notifications/resources/updated') return
    for (const link of this.links) link.notify(notification)
  }

  private touch(): void {
    this.lastActive = Date.now()
    const { idleMs } = this.options
    if (idleMs === null || this.idleTimer) return
    this.idleTimer = setTimeout(() => this.idleCheck(), idleMs)
    this.idleTimer.unref?.()
  }

  private idleCheck(): void {
    this.idleTimer = null
    const idleMs = this.options.idleMs
    if (idleMs === null || !this.running) return
    const busy = this.forwarded.size > 0 || [...this.links].some((link) => link.asking() > 0)
    const since = Date.now() - this.lastActive
    if (!busy && since >= idleMs) {
      void this.stop('idle')
      return
    }
    this.idleTimer = setTimeout(() => this.idleCheck(), busy ? idleMs : idleMs - since)
    this.idleTimer.unref?.()
  }

  /** The process ended or the connection closed on its own. */
  private closed(upstream: Upstream): void {
    const line = lastLine(upstream.stderr?.() ?? '')
    this.upstream = null
    this.startedAt = null
    const reason = line ? `The server exited: ${line}` : 'The server exited'
    this.options.status?.(reason)
    this.endAll(reason)
    this.options.log('info', `${this.options.serverName} exited${line ? `: ${line}` : ''}`)
    if (this.links.size === 0) this.options.ended(this)
  }

  private endAll(reason: string): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    for (const [id, opening] of this.opening)
      opening.resolve(errorResponse(id, SERVER_UNAVAILABLE, reason))
    this.opening.clear()
    for (const forwarded of this.forwarded.values()) {
      forwarded.link.reply(errorResponse(forwarded.id, SERVER_UNAVAILABLE, reason))
    }
    this.forwarded.clear()
    this.tokens.clear()
  }

  /** Ends the connection; links stay, and the next request starts the server again. */
  async stop(why: 'idle' | 'closed' | 'removed'): Promise<void> {
    const upstream = this.upstream
    this.upstream = null
    this.startedAt = null
    this.endAll(why === 'idle' ? 'The server stopped after being idle' : 'The server stopped')
    if (upstream) {
      if (why === 'idle') this.options.log('info', `${this.options.serverName} stopped while idle`)
      await upstream.transport.close().catch(() => undefined)
    }
    if (this.links.size === 0 || why === 'removed') this.options.ended(this)
  }
}

/** One agent's connection to a server, over whatever carries it to the router. */
export class Link {
  era: Era | null = null
  lastActive = Date.now()
  private initParams: Record<string, unknown> | null = null
  private modern: Record<string, unknown> = {}
  /** The link's requests the instance has not answered, by the link's own id. */
  private readonly open = new Set<Id>()
  private nextAsk = 1
  /** Requests sent to the link, by the id it was sent with. */
  private readonly asked = new Map<Id, { resolve(response: Response): void; serverId: Id | null }>()
  /** The link's tool calls not yet answered, by its own id, for their records. */
  private readonly calls = new Map<Id, { tool: string; at: number; refused?: boolean }>()
  private closed = false

  constructor(
    readonly instance: Instance,
    private readonly down: Transport,
    private readonly onClose: (link: Link) => void,
    readonly policy: LinkPolicy = OPEN_POLICY,
  ) {
    instance.attach(this)
    down.onmessage = (message) => this.received(message)
    down.onclose = () => this.close()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const id of [...this.calls.keys()]) this.ended(id, null, 'The client disconnected')
    for (const [id, asked] of this.asked) {
      asked.resolve(errorResponse(id, INTERNAL_ERROR, 'The client disconnected'))
    }
    this.asked.clear()
    this.instance.detach(this)
    this.onClose(this)
    void this.down.close().catch(() => undefined)
  }

  /** The requests the link waits on. */
  waiting(): number {
    return this.open.size
  }

  /** The requests sent to the link that it has not answered. */
  asking(): number {
    return this.asked.size
  }

  client(): { name: string; version: string } | null {
    const info = this.era === 'legacy' ? this.initParams?.clientInfo : this.modern[META_CLIENT]
    if (!isRecord(info) || typeof info.name !== 'string') return null
    return { name: info.name, version: typeof info.version === 'string' ? info.version : '0' }
  }

  capabilities(): Record<string, unknown> {
    const caps =
      this.era === 'legacy' ? this.initParams?.capabilities : this.modern[META_CAPABILITIES]
    return isRecord(caps) ? caps : {}
  }

  askedVersion(): string {
    const version = this.initParams?.protocolVersion
    return typeof version === 'string' ? version : LEGACY_VERSION
  }

  /** What a request to a server of the new protocol carries for an old client. */
  modernMeta(): Record<string, unknown> {
    return {
      [META_VERSION]: MODERN_VERSION,
      [META_CAPABILITIES]: this.capabilities(),
      ...(this.client() ? { [META_CLIENT]: this.client() } : {}),
    }
  }

  /** A list of tools as this link's agent may see it: without those off or held back. */
  filterTools(result: Record<string, unknown>): Record<string, unknown> {
    return withoutTools(
      result,
      (tool) =>
        this.policy.toolOff(String(tool.name)) || (this.policy.heldTool?.(tool) ?? null) !== null,
    )
  }

  reply(response: Response): void {
    if (response.id !== null) {
      this.open.delete(response.id)
      this.ended(response.id, response)
    }
    this.deliver(response, response.id ?? undefined)
  }

  /** A tool call of the link's ended, answered with `response` or not at all. */
  private ended(id: Id, response: Response | null, why?: string): void {
    const call = this.calls.get(id)
    if (!call) return
    this.calls.delete(id)
    const { called } = this.policy
    if (!called) return
    const answer = response?.error ?? response?.result
    const outcome: CallOutcome = {
      tool: call.tool,
      at: call.at,
      ms: Date.now() - call.at,
      bytes: answer === undefined ? 0 : Buffer.byteLength(JSON.stringify(answer)),
      result: !response
        ? why === 'Cancelled'
          ? 'cancelled'
          : 'error'
        : response.error
          ? call.refused
            ? 'refused'
            : 'error'
          : response.result?.isError === true
            ? 'tool-error'
            : 'ok',
    }
    const error = response?.error?.message ?? (response ? undefined : why)
    if (error !== undefined && outcome.result !== 'ok') outcome.error = error
    called(outcome)
  }

  notify(notification: Notification): void {
    // A new client hears of changes only on a stream it asked for, which names its subscription.
    const subscribed = metaOf(notification.params)[META_SUBSCRIPTION] !== undefined
    if (this.era === 'modern' && notification.method !== 'notifications/progress' && !subscribed) {
      return
    }
    this.deliver(notification, this.related())
  }

  /** A request to the link: the server's, or one the instance makes for it. */
  request(
    method: string,
    params: Record<string, unknown> | undefined,
    serverId: Id | null,
    related?: Id,
  ): Promise<Response> {
    const id = `kettu-ask-${this.nextAsk++}`
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(errorResponse(id, INTERNAL_ERROR, 'The client disconnected'))
        return
      }
      this.asked.set(id, { resolve, serverId })
      this.deliver(
        { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
        related ?? this.related(),
      )
    })
  }

  /** The server cancelled a request of its own, which may be one the link was asked. */
  serverCancelled(serverId: unknown): void {
    for (const [id, asked] of this.asked) {
      if (asked.serverId === null || asked.serverId !== serverId) continue
      this.asked.delete(id)
      this.deliver({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
    }
  }

  /** A request still open, so an HTTP client gets what belongs to it on that request's stream. */
  private related(): Id | undefined {
    return [...this.open].at(-1)
  }

  private deliver(message: Message, related?: Id): void {
    if (this.closed) return
    this.down
      .send(
        message as JSONRPCMessage,
        related !== undefined ? { relatedRequestId: related } : undefined,
      )
      .catch(() => undefined)
  }

  private received(raw: unknown): void {
    const message = readMessage(raw)
    if (!message) return
    this.lastActive = Date.now()
    if (isResponse(message)) {
      if (message.id === null) return
      const asked = this.asked.get(message.id)
      if (!asked) return
      this.asked.delete(message.id)
      asked.resolve(message)
      return
    }
    if (isRequest(message)) {
      this.era ??= requestEra(message) ?? 'legacy'
      if (this.era === 'modern') this.modern = { ...this.modern, ...metaOf(message.params) }
      this.open.add(message.id)
      if (message.method === 'tools/call') {
        this.calls.set(message.id, { tool: String(message.params?.name ?? ''), at: Date.now() })
      }
      void this.handle(message)
      return
    }
    if (isNotification(message)) {
      if (message.method === 'notifications/initialized') return
      if (message.method === 'notifications/cancelled') {
        const requestId = message.params?.requestId
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          this.open.delete(requestId)
          this.ended(requestId, null, 'Cancelled')
        }
      }
      this.instance.notify(this, message)
    }
  }

  private async handle(request: Request): Promise<void> {
    const { instance } = this
    const name = instance.options.serverName
    const shared = instance.sharing === 'folder' || instance.sharing === 'all'
    switch (request.method) {
      case 'initialize': {
        this.era = 'legacy'
        this.initParams = request.params ?? {}
        const known = await this.opened()
        if ('error' in known)
          return this.reply(errorResponse(request.id, SERVER_UNAVAILABLE, known.error))
        const result = legacyInit(known.era, known.init, this.initParams.protocolVersion, name)
        return this.reply(resultResponse(request.id, result))
      }
      case 'server/discover': {
        const known = await this.opened()
        if ('error' in known)
          return this.reply(errorResponse(request.id, SERVER_UNAVAILABLE, known.error))
        return this.reply(resultResponse(request.id, modernDiscover(known.era, known.init)))
      }
      case 'ping':
        return this.reply(resultResponse(request.id, {}))
      case 'logging/setLevel':
        if (shared || !instance.running) return this.reply(resultResponse(request.id, {}))
        break
    }
    const refusal = this.refusal(request)
    if (refusal !== null) {
      const call = this.calls.get(request.id)
      if (call) call.refused = true
      return this.reply(errorResponse(request.id, INVALID_PARAMS, refusal))
    }
    if (this.policy.serverOff()) {
      const empty = EMPTY_LISTS[request.method]
      if (empty) return this.reply(resultResponse(request.id, empty))
    }
    if (shared && !sharedMethod(request.method)) {
      return this.reply(
        errorResponse(
          request.id,
          METHOD_NOT_FOUND,
          `${request.method} is not shared between sessions`,
        ),
      )
    }
    if (isListMethod(request.method) && request.params?.cursor === undefined && !instance.running) {
      const kept = instance.options.lazy ? instance.kept()?.lists[request.method] : undefined
      if (isRecord(kept)) {
        const shown = request.method === 'tools/list' ? this.filterTools(kept) : kept
        return this.reply(resultResponse(request.id, shown))
      }
    }
    await instance.forward(this, request)
  }

  /**
   * Why Kettu refuses a request without passing it on: a tool turned off or held back, or
   * anything but the lists while the server is off for the session. Null to let it through.
   */
  private refusal(request: Request): string | null {
    const name = this.instance.options.serverName
    const offered = sharedMethod(request.method) && request.method !== 'ping'
    if (offered && this.policy.serverOff() && !(request.method in EMPTY_LISTS)) {
      return `${name} is turned off for this session in Kettu`
    }
    if (request.method !== 'tools/call') return null
    const tool = request.params?.name
    if (typeof tool !== 'string') return null
    if (this.policy.toolOff(tool)) return `The tool ${tool} of ${name} is turned off in Kettu`
    const held = this.policy.heldCall?.(tool) ?? null
    if (held === 'added') {
      return `The tool ${tool} of ${name} is new; the user must accept it in Kettu's Marketplace before agents can use it`
    }
    if (held === 'changed') {
      return `The tool ${tool} of ${name} changed since the user accepted it; the user must accept the change in Kettu's Marketplace before agents can use it`
    }
    return null
  }

  /** What the server opened with: as it runs, else kept from before, else from starting it. */
  private async opened(): Promise<{ era: Era; init: Record<string, unknown> } | { error: string }> {
    const { instance } = this
    const kept = instance.options.lazy || instance.running ? instance.kept() : null
    if (kept) return kept
    try {
      await instance.ensure(this)
    } catch (error) {
      return { error: text(error) }
    }
    return instance.era && instance.init
      ? { era: instance.era, init: instance.init }
      : { error: 'The server did not open' }
  }
}
