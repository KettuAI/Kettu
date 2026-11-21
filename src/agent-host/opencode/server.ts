// Kettu's own `opencode serve`: one process for all of an agent's sessions, on a loopback port
// OpenCode picks, behind a password made for this run. It is not the background service the
// user's terminal talks to, so what Kettu adds to a folder there never reaches a terminal session.

import { randomBytes } from 'node:crypto'
import { addLogSecret } from '@shared/log/process-log'
import type { HostedContext } from '../driver'
import { t } from '../i18n'
import type { ServerEvent, ServerInfo } from './protocol'

const START_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 60_000
/** OpenCode sends a heartbeat comment every 15 s; a stream quiet for three has stalled. */
const QUIET_STREAM_MS = 45_000
const USER = 'opencode'

/** A request the server refused, with the `_tag` its error body names. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'ServerError'
  }
}

export interface ServerApi {
  /** Resolves with the response's JSON, or undefined for an empty one. */
  request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>
  /**
   * Reads the event stream, which carries live events only, until it ends or `signal` aborts.
   * Rejects when it cannot open, fails or goes quiet.
   */
  events(onEvent: (event: ServerEvent) => void, signal: AbortSignal): Promise<void>
}

export interface RunningServer {
  api: ServerApi
  version: string
  /** Settles once the process has exited. */
  exited: Promise<void>
  stop(): void
}

export type StartServer = (context: HostedContext, signal?: AbortSignal) => Promise<RunningServer>

/** The `data` of each event a server-sent event stream completes, chunk by chunk. */
export class SseParser {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n')
    const events: string[] = []
    for (;;) {
      const end = this.buffer.indexOf('\n\n')
      if (end < 0) return events
      const block = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const data = block
        .split('\n')
        .flatMap((line) => (line.startsWith('data:') ? [line.slice(5).replace(/^ /, '')] : []))
      if (data.length > 0) events.push(data.join('\n'))
    }
  }
}

/** A query string that names a folder as OpenCode's `location` parameter takes it. */
export function locationQuery(directory: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(directory)}`
}

function errorOf(status: number, text: string): ServerError {
  let tag: string | null = null
  let message = text.slice(0, 500)
  try {
    const body = JSON.parse(text) as { _tag?: unknown; message?: unknown }
    if (typeof body._tag === 'string') tag = body._tag
    if (typeof body.message === 'string') message = body.message
  } catch {
    // Not JSON: the text is the message.
  }
  return new ServerError(status, tag, message || t('opencode.answered', { status }))
}

export function httpApi(url: string, password: string, fetcher: typeof fetch = fetch): ServerApi {
  const authorization = `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}`
  return {
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<T> {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const response = await fetcher(url + path, {
        method,
        headers: {
          authorization,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      const text = await response.text()
      if (!response.ok) throw errorOf(response.status, text)
      return (text === '' ? undefined : JSON.parse(text)) as T
    },

    async events(onEvent, signal): Promise<void> {
      const quiet = new AbortController()
      const response = await fetcher(`${url}/api/event`, {
        headers: { authorization, accept: 'text/event-stream' },
        signal: AbortSignal.any([signal, quiet.signal]),
      })
      if (!response.ok || !response.body) {
        throw errorOf(response.status, await response.text().catch(() => ''))
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      let timer: ReturnType<typeof setTimeout> | null = null
      const watch = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(
          () => quiet.abort(new Error('The event stream went quiet')),
          QUIET_STREAM_MS,
        )
        timer.unref?.()
      }
      try {
        watch()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          watch()
          for (const data of parser.push(decoder.decode(value, { stream: true }))) {
            let event: ServerEvent
            try {
              event = JSON.parse(data) as ServerEvent
            } catch {
              continue
            }
            if (typeof event?.type === 'string') onEvent(event)
          }
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

/** The address `opencode serve --stdio` prints once it listens: one line of JSON. */
export function listeningUrl(line: string): string | null {
  try {
    const url = (JSON.parse(line) as { url?: unknown }).url
    return typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(url) ? url : null
  } catch {
    return null
  }
}

/**
 * Starts the server with the user's own `opencode`. `--stdio` ties it to this process: it prints
 * its address and exits once its stdin closes, so it never outlives the agent host.
 */
export const startServer: StartServer = async (context, signal) => {
  const { spec, env } = context
  const password = randomBytes(32).toString('base64url')
  addLogSecret(password)
  const child = context.spawn({
    command: spec.command,
    args: ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'],
    env: { ...env, ...spec.env, OPENCODE_PASSWORD: password },
    ...(signal ? { signal } : {}),
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const stop = (): void => {
    child.stdin?.end()
  }
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error('OpenCode did not start its server')),
      START_TIMEOUT_MS,
    )
    const settle = (result: string | Error): void => {
      clearTimeout(timer)
      child.stdout?.off('data', read)
      if (typeof result === 'string') resolve(result)
      else reject(result)
    }
    const read = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const found = listeningUrl(buffer.slice(0, end).trim())
        buffer = buffer.slice(end + 1)
        if (found) return settle(found)
      }
    }
    child.stdout?.on('data', read)
    void exited.then(() => settle(new Error('OpenCode exited before its server listened')))
    child.once('error', (error) => settle(error))
  }).catch((error: unknown) => {
    stop()
    throw error
  })
  // Whatever it prints later is not read, and must not fill the pipe.
  child.stdout?.resume()
  const api = httpApi(url, password)
  try {
    const info = await api.request<ServerInfo>('GET', '/api/info', undefined, signal)
    if (typeof info?.version !== 'string') throw new Error('OpenCode did not name its version')
    return { api, version: info.version, exited, stop }
  } catch (error) {
    stop()
    throw error
  }
}
