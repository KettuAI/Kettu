// The artifacts service: the `overbench` MCP server on 127.0.0.1, which each attached session
// reaches with a token of its own, or for OpenCode with its process and folder's token. Streamable
// HTTP in plain JSON, one stateless transport per request. See docs/design/artifacts.md, The
// artifacts service.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ArtifactLink } from '@shared/thread'
import type { LogFn } from '../storage'
import { artifactLink } from './links'
import {
  ArtifactTools,
  INSTRUCTIONS,
  isToolName,
  TOOLS,
  type ArtifactToolsDeps,
  type Caller,
} from './tools'

export const SERVICE_NAME = 'overbench'
export const SERVICE_PATH = '/mcp'
export const BODY_BYTES = 6 * 1024 * 1024
const TOKEN_BYTES = 32
/** Where OpenCode names the calling session on each `tools/call`, a subagent's own included. */
const SESSION_META = 'ai.opencode/sessionID'

// The SDK loads with the first request rather than with the host, which starts faster without it.
function loadSdk() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([server, transport, types]) => ({ ...server, ...transport, ...types }))
}

type Sdk = Awaited<ReturnType<typeof loadSdk>>

/** An agent process that keeps one server of a name per folder, such as OpenCode's. */
export interface AgentProcess {
  /** Settles when the process exits, which ends its tokens. */
  readonly closed: Promise<void>
}

export interface ArtifactServiceDeps extends ArtifactToolsDeps {
  log: LogFn
  appVersion: string
  /**
   * The session in memory that a call of `process` names, a subagent's counting as the session
   * it runs under; null for an id OverBench does not have.
   */
  sessionOf(process: AgentProcess, id: string): string | null
  /** A call of the session's acted on one artifact, for its tool call in the thread. */
  linked?(sessionId: string, tool: string, link: ArtifactLink): void
}

/** A token for one session. */
interface SessionGrant {
  token: string
  project: string
  sessionId: string
}

/** A token for one agent process and folder, whose calls name their session in `_meta`. */
interface FolderGrant {
  token: string
  project: string
  process: AgentProcess
  /** The sessions in memory that attached through it. */
  sessions: Set<string>
}

type Grant = SessionGrant | FolderGrant

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

function entry(url: string, token: string): McpServer[] {
  return [
    {
      type: 'http',
      name: SERVICE_NAME,
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ]
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
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

export class ArtifactService {
  private server: http.Server | null = null
  private port: number | null = null
  /** The live tokens by their SHA-256, so a lookup compares no secret byte by byte. */
  private readonly grants = new Map<string, Grant>()
  /** The token each session attached with, by its digest. */
  private readonly sessions = new Map<string, string>()
  /** Each agent process's folder tokens by folder, kept until the process exits. */
  private readonly folders = new Map<AgentProcess, Map<string, string>>()
  private readonly tools: ArtifactTools
  private sdk: Promise<Sdk> | null = null

  constructor(private readonly deps: ArtifactServiceDeps) {
    this.tools = new ArtifactTools(deps)
  }

  /** Listens on a port the system picks; without it, sessions attach with no service. */
  async start(): Promise<void> {
    if (this.server) return
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.deps.log('error', `The artifacts service failed: ${(error as Error).message}`)
        if (!res.headersSent) refuse(res, 500, 'The artifacts service failed')
        else res.destroy()
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.deps.log('error', `The artifacts service cannot listen: ${(error as Error).message}`)
      return
    }
    server.on('error', (error) => {
      this.deps.log('error', `The artifacts service: ${error.message}`)
    })
    // The host's own channel keeps its process alive; the service alone must not.
    server.unref()
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  /** Stops listening; every token ends with it. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    this.grants.clear()
    this.sessions.clear()
    this.folders.clear()
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  get url(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}${SERVICE_PATH}`
  }

  /**
   * What an attach of the session passes in `mcpServers`: the service with the session's token,
   * made at its first attach and kept while it stays in memory, since Codex ignores new servers
   * when it resumes a session it still holds open. Empty while the service is not running.
   */
  servers(sessionId: string, project: string): McpServer[] {
    const url = this.url
    if (!url) return []
    const held = this.sessions.get(sessionId)
    let grant = held === undefined ? undefined : this.grants.get(held)
    if (!grant || !('sessionId' in grant) || grant.project !== project) {
      this.revoke(sessionId)
      grant = { token: newToken(), sessionId, project }
      this.sessions.set(sessionId, this.add(grant))
    }
    return entry(url, grant.token)
  }

  /**
   * The same for an agent that keeps one server of a name per folder and names the session on
   * each call: one token for the process and folder, kept while a session there stays in memory
   * and the process runs, since each attach there replaces the folder's server for every session.
   */
  folderServers(process: AgentProcess, folder: string, sessionId: string): McpServer[] {
    const url = this.url
    if (!url) return []
    let byFolder = this.folders.get(process)
    if (!byFolder) {
      byFolder = new Map()
      this.folders.set(process, byFolder)
      const exited = (): void => this.exited(process)
      void process.closed.then(exited, exited)
    }
    let key = byFolder.get(folder)
    let grant = key === undefined ? undefined : this.grants.get(key)
    if (key === undefined || !grant || 'sessionId' in grant) {
      grant = { token: newToken(), project: folder, process, sessions: new Set() }
      key = this.add(grant)
      byFolder.set(folder, key)
    }
    if (this.sessions.get(sessionId) !== key) {
      this.leave(sessionId)
      grant.sessions.add(sessionId)
      this.sessions.set(sessionId, key)
    }
    return entry(url, grant.token)
  }

  /** The session left memory: it closed, was released or was deleted. */
  revoke(sessionId: string): void {
    this.tools.forget(sessionId)
    this.leave(sessionId)
  }

  private add(grant: Grant): string {
    const key = digest(grant.token)
    this.grants.set(key, grant)
    return key
  }

  /** Its own token ends; a folder's ends with the last session there. */
  private leave(sessionId: string): void {
    const key = this.sessions.get(sessionId)
    if (key === undefined) return
    this.sessions.delete(sessionId)
    const grant = this.grants.get(key)
    if (!grant) return
    if ('sessionId' in grant) {
      this.grants.delete(key)
      return
    }
    grant.sessions.delete(sessionId)
    if (grant.sessions.size > 0) return
    this.grants.delete(key)
    const byFolder = this.folders.get(grant.process)
    if (byFolder?.get(grant.project) === key) byFolder.delete(grant.project)
  }

  /** The process exited: its folder tokens end, and its sessions get new ones as they attach. */
  private exited(process: AgentProcess): void {
    const byFolder = this.folders.get(process)
    if (!byFolder) return
    this.folders.delete(process)
    for (const key of byFolder.values()) {
      const grant = this.grants.get(key)
      this.grants.delete(key)
      if (!grant || 'sessionId' in grant) continue
      for (const sessionId of grant.sessions) {
        if (this.sessions.get(sessionId) === key) this.sessions.delete(sessionId)
      }
    }
  }

  /** Who a call is from: the token's session, or the session a folder token's call names. */
  private callerOf(grant: Grant, meta: Record<string, unknown> | undefined): Caller | null {
    if ('sessionId' in grant) return { sessionId: grant.sessionId, project: grant.project }
    const id = meta?.[SESSION_META]
    const sessionId = typeof id === 'string' ? this.deps.sessionOf(grant.process, id) : null
    if (sessionId === null || !grant.sessions.has(sessionId)) return null
    return { sessionId, project: grant.project }
  }

  private grantOf(header: string | undefined): Grant | null {
    const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(header ?? '')
    if (!match) return null
    const token = match[1]!
    const grant = this.grants.get(digest(token))
    if (!grant) return null
    const given = Buffer.from(token)
    const known = Buffer.from(grant.token)
    return given.length === known.length && timingSafeEqual(given, known) ? grant : null
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A browser sends Origin on every cross-origin request; no agent's MCP client does.
    if (req.headers.origin !== undefined) {
      return refuse(res, 403, 'Requests from web pages are refused')
    }
    // A name that resolves here by DNS rebinding still carries its own Host.
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      return refuse(res, 403, 'Unknown host')
    }
    if (req.url !== SERVICE_PATH) return refuse(res, 404, 'Not found')
    if (req.method !== 'POST') {
      // Plain JSON only: no event stream to open, and no session to end.
      return refuse(res, 405, 'Method not allowed', { Allow: 'POST' })
    }
    const grant = this.grantOf(req.headers.authorization)
    if (!grant) {
      return refuse(res, 401, 'A session token is required', { 'WWW-Authenticate': 'Bearer' })
    }
    // A failed load is tried again with the next request rather than kept.
    this.sdk ??= loadSdk().catch((error: unknown) => {
      this.sdk = null
      throw error
    })
    const sdk = await this.sdk
    const server = this.mcpServer(sdk, grant)
    const transport = new sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: BODY_BYTES,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  /** Hands the thread the artifact a call acted on; a failure only costs the row its link. */
  private async link(
    sessionId: string,
    tool: string,
    input: unknown,
    result: CallToolResult,
  ): Promise<void> {
    const { linked, store } = this.deps
    if (!linked) return
    const titleOf = (id: string) =>
      store.get(id).then(
        (found) => found.artifact.title,
        () => null,
      )
    try {
      const link = await artifactLink(tool, input, result, titleOf)
      if (link) linked(sessionId, tool, link)
    } catch (error) {
      this.deps.log('warn', `Could not link ${tool} to its tool call: ${(error as Error).message}`)
    }
  }

  /** A server for one request with the token, as a stateless transport needs. */
  private mcpServer(sdk: Sdk, grant: Grant): Server {
    const { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } = sdk
    const server = new sdk.Server(
      { name: SERVICE_NAME, title: 'OverBench', version: this.deps.appVersion },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: input, _meta: meta } = request.params
      const caller = this.callerOf(grant, meta)
      if (!caller) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'The call names no session of this agent in this folder',
        )
      }
      if (!isToolName(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${name}`)
      try {
        const result = await this.tools.call(caller, name, input)
        // Before the answer, while the agent still shows its tool call as running.
        await this.link(caller.sessionId, name, input, result)
        return result
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    })
    return server
  }
}
