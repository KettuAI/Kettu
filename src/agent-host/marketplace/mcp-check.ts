import path from 'node:path'
import https from 'node:https'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { runOf, type MarketServer } from '@shared/marketplace'
import type { McpCheck } from '@shared/mcp-discovery'
import { createRedactor, REDACTED } from '@shared/log/redact'
import type { Platform } from '@shared/platform'
import type { NodeRuntime } from '@shared/host-control'
import { findCommand, isExecutableFile, type Env } from '../find-command'
import { isPublicHost, publicLookup } from '../plugin-runtime/network'

import { resolveMcpReference } from './servers'

const publicAddress = publicLookup()

interface CheckOptions {
  env: Env
  home: string
  project?: string
  platform: Platform
  node?: NodeRuntime
  bearer?: string
  /** Every tool the server listed, once all pages were read. */
  listed?(tools: readonly unknown[]): void
}

async function publicRequest(url: URL, init: RequestInit): Promise<Response> {
  if (url.protocol !== 'https:' || !isPublicHost(url.hostname) || url.username || url.password) {
    throw new Error('The MCP endpoint must use a public HTTPS address.')
  }
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined,
        lookup: publicAddress,
      },
      (response) => {
        const status = response.statusCode ?? 500
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const noBody = [204, 205, 304].includes(status)
        if (noBody) response.resume()
        const stream = noBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>)
        resolve(new Response(stream, { status, headers }))
      },
    )
    request.on('error', reject)
    request.end(typeof init.body === 'string' ? init.body : undefined)
  })
}

function resultError(
  reason: Extract<McpCheck, { state: 'error' }>['reason'],
  detail?: string,
): McpCheck {
  return { state: 'error', reason, detail }
}

export async function checkMcp(
  server: MarketServer,
  keys: ReadonlyMap<string, string>,
  options: CheckOptions,
): Promise<McpCheck> {
  const { spec } = server
  const values: Record<string, string> = Object.create(null)
  const sensitive = new Set<string>()
  for (const item of spec.type === 'stdio' ? spec.env : spec.headers) {
    if ('input' in item) {
      const value = keys.get(item.name)
      if (value === undefined) {
        if (item.required) return resultError('missing-variable', item.name)
        continue
      }
      sensitive.add(value)
      values[item.name] = (item.prefix ?? '') + value
    } else {
      const resolved = resolveMcpReference(item.value, options.env, options.platform)
      if (resolved.missing) return resultError('missing-variable', resolved.missing)
      if (resolved.value !== item.value) sensitive.add(resolved.value)
      values[item.name] = resolved.value
    }
  }

  let stderr = ''
  let httpStatus: number | undefined
  let stdio: StdioClientTransport | undefined
  const abort = new AbortController()
  const seconds = runOf(server).startSeconds
  const timeout = seconds * 1000
  let step: 'start' | 'initialize' | 'tools' = 'start'
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const client = new Client({ name: 'Kettu', version: '1.0.0' })
  try {
    let transport: Transport
    if (spec.type === 'stdio') {
      const invocation =
        spec.runtime === 'node' && options.node ? options.node.command : spec.command
      const cwd = options.project ?? options.home
      const paths = options.platform === 'win32' ? path.win32 : path.posix
      const relative = !paths.isAbsolute(invocation) && /[\\/]/.test(invocation)
      if (relative && !options.project) return { state: 'project-only' }
      const env = {
        ...options.env,
        ...(spec.runtime === 'node' ? options.node?.env : {}),
        ...values,
      }
      const command = await findCommand(relative ? paths.resolve(cwd, invocation) : invocation, {
        platform: options.platform,
        env,
        isExecutable: (file) => isExecutableFile(file, options.platform),
      })
      if (!command) return resultError('command-not-found', spec.command)
      stdio = new StdioClientTransport({
        command,
        args: spec.args,
        cwd,
        env: Object.fromEntries(
          Object.entries(env).filter((item): item is [string, string] => item[1] !== undefined),
        ),
        stderr: 'pipe',
      })
      stdio.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-8192)
      })
      transport = stdio
    } else {
      const address = new URL(spec.url)
      if (options.bearer) values.Authorization = 'Bearer ' + options.bearer
      const requestInit = { headers: values }
      const fetcher = async (target: string | URL, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(target)
        if (url.origin !== address.origin) throw new Error('MCP endpoint changed origin.')
        const request = {
          ...init,
          redirect: 'manual' as const,
          signal: init.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal,
        }
        const response =
          server.source === 'manual' ? await fetch(url, request) : await publicRequest(url, request)
        httpStatus = response.ok ? undefined : response.status
        return response
      }
      transport =
        spec.transport === 'sse'
          ? new SSEClientTransport(address, {
              requestInit,
              eventSourceInit: {
                fetch: (input, init) =>
                  fetcher(String(input), {
                    ...init,
                    headers: { ...Object.fromEntries(new Headers(init?.headers)), ...values },
                  }),
              },
              fetch: fetcher,
            })
          : new StreamableHTTPClientTransport(address, { requestInit, fetch: fetcher })
    }

    const run = <T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const stepAbort = new AbortController()
      return Promise.race([
        call(stepAbort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            stepAbort.abort()
            abort.abort()
            reject(new Error('MCP check timed out'))
          }, timeout)
        }),
      ]).finally(() => clearTimeout(timer))
    }
    const started = performance.now()
    let connectedAt = started
    const open = transport.start.bind(transport)
    transport.start = async () => {
      await run(() => open())
      step = 'initialize'
      connectedAt = performance.now()
    }
    await client.connect(transport, { timeout, signal: abort.signal })
    const startMs = Math.round(connectedAt - started)
    const initializeMs = Math.round(performance.now() - connectedAt)
    step = 'tools'
    const toolsStart = performance.now()
    let tools = 0
    if (client.getServerCapabilities()?.tools) {
      tools = await run(async (signal) => {
        const listed: unknown[] = []
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: timeout + 1000,
            signal,
          })
          listed.push(...page.tools)
          cursor = page.nextCursor
          if (cursor && seen.has(cursor)) throw new Error('MCP tools pagination repeated a cursor')
          if (cursor) seen.add(cursor)
        } while (cursor)
        options.listed?.(listed)
        return listed.length
      })
    }
    return {
      state: 'connected',
      tools,
      startMs,
      initializeMs,
      toolsMs: Math.round(performance.now() - toolsStart),
    }
  } catch (error) {
    if (timedOut || (error instanceof McpError && error.code === ErrorCode.RequestTimeout))
      return { state: 'error', reason: 'timeout', step, seconds }
    const status = httpStatus
    if (status === 401) return { state: 'needs-sign-in' }
    if (status !== undefined) return { state: 'error', reason: 'http', status }
    if (stdio) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return resultError('command-not-found')
      let line = stderr.trimEnd().split(/\r?\n/).at(-1) ?? ''
      for (const secret of [...sensitive].sort((a, b) => b.length - a.length)) {
        if (secret) line = line.split(secret).join(REDACTED)
      }
      line = createRedactor({ home: options.home })(line)
        .replace(/\p{Cc}/gu, '')
        .slice(0, 240)
      return resultError('exited', line || undefined)
    }
    return resultError('cannot-connect')
  } finally {
    abort.abort()
    await client.close().catch(() => {})
  }
}
