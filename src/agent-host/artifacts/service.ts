// The artifacts service: the `overbench` MCP server on 127.0.0.1, which each attached session
// reaches with a token of its own. Streamable HTTP in plain JSON, one stateless transport per
// request. See docs/design/artifacts.md, The artifacts service.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { LogFn } from '../storage'
import { ArtifactTools, INSTRUCTIONS, isToolName, TOOLS, type ArtifactToolsDeps } from './tools'

export const SERVICE_NAME = 'overbench'
export const SERVICE_PATH = '/mcp'
export const BODY_BYTES = 6 * 1024 * 1024
const TOKEN_BYTES = 32

// The SDK loads with the first request rather than with the host, which starts faster without it.
function loadSdk() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([server, transport, types]) => ({ ...server, ...transport, ...types }))
}

type Sdk = Awaited<ReturnType<typeof loadSdk>>

export interface ArtifactServiceDeps extends ArtifactToolsDeps {
  log: LogFn
  appVersion: string
}

interface Grant {
  token: string
  sessionId: string
  project: string
}

/** A name of the session's own, for an agent that keeps one server of each name per folder. */
export function sessionServiceName(sessionId: string): string {
  return `${SERVICE_NAME}-${sessionId.replace(/-/g, '').slice(0, 4).toLowerCase()}`
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
  /** Each session's current token, by its digest. */
  private readonly sessions = new Map<string, string>()
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
  servers(sessionId: string, project: string, name = SERVICE_NAME): McpServer[] {
    const url = this.url
    if (!url) return []
    const held = this.sessions.get(sessionId)
    let grant = held === undefined ? undefined : this.grants.get(held)
    if (grant?.project !== project) {
      this.revoke(sessionId)
      const token = randomBytes(TOKEN_BYTES).toString('base64url')
      grant = { token, sessionId, project }
      const key = digest(token)
      this.grants.set(key, grant)
      this.sessions.set(sessionId, key)
    }
    const { token } = grant
    return [
      {
        type: 'http',
        name,
        url,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      },
    ]
  }

  /** The session's token ends: it closed, was released or was deleted. */
  revoke(sessionId: string): void {
    const key = this.sessions.get(sessionId)
    if (key === undefined) return
    this.sessions.delete(sessionId)
    this.grants.delete(key)
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
    this.sdk ??= loadSdk()
    const sdk = await this.sdk
    const server = this.mcpServer(sdk, { sessionId: grant.sessionId, project: grant.project })
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

  /** A server for one request of the caller, as a stateless transport needs. */
  private mcpServer(sdk: Sdk, caller: { sessionId: string; project: string }): Server {
    const { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } = sdk
    const server = new sdk.Server(
      { name: SERVICE_NAME, title: 'OverBench', version: this.deps.appVersion },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: input } = request.params
      if (!isToolName(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${name}`)
      try {
        return await this.tools.call(caller, name, input)
      } catch (error) {
        this.deps.log('error', `${name} failed: ${(error as Error).message}`)
        throw new McpError(ErrorCode.InternalError, `${name} failed: ${(error as Error).message}`)
      }
    })
    return server
  }
}
