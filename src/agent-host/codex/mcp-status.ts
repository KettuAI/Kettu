// `/mcp`: the MCP servers' status as Markdown, and the startup of the servers a reconnect restarts.
// The format is adapted from codex-acp 2.2.2 (Apache-2.0, Copyright 2025 JetBrains s.r.o.):
// https://github.com/agentclientprotocol/codex-acp

import { t } from '../i18n'
import type {
  McpServerConnectionStatus,
  McpServerStartupNotification,
  McpServerStatus,
} from './protocol'

type Status = McpServerConnectionStatus | null

const SUMMARY_ORDER: Status[] = [
  'connected',
  'starting',
  'notStarted',
  'authenticationRequired',
  'failed',
  'cancelled',
  'disabled',
  null,
]

const GROUP_ORDER: Status[] = [
  'failed',
  'cancelled',
  'authenticationRequired',
  'notStarted',
  'starting',
  'connected',
  null,
]

const KNOWN = new Set<string>(SUMMARY_ORDER.filter((status) => status !== null))

/** The states a reconnect may change, which the answer points to it for. */
const RECONNECTABLE = new Set<Status>([
  'failed',
  'cancelled',
  'authenticationRequired',
  'notStarted',
])

const MAX_ERROR_LENGTH = 160
const MAX_ERROR_SENTENCES = 2
const MAX_INPUT_LENGTH = 2_000
// The prefixes Codex wraps an MCP error in, which say nothing to the user.
const WRAPPER_SEGMENT =
  /^(?:tool discovery failed|mcp startup failed|handshaking with mcp server failed|json-rpc error|startup error|error|mcp client for .+ failed to start|-32\d{3})$/i
const TYPE_PATH = /\S*\w::\w+::\S*/g

function statusOf(server: McpServerStatus): Status {
  const status = server.runtimeStatus
  return status !== null && KNOWN.has(status) ? status : null
}

function label(status: Status): string {
  return t(`codex.mcp.status.${status ?? 'unknown'}`)
}

/** A server's name as inline code, fenced past any backticks in it. */
export function inlineCode(name: string): string {
  const text = name.replace(/\s+/g, ' ')
  if (text === '') return t('codex.mcp.unnamed')
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  const padding = /^[` ]|[` ]$/.test(text) ? ' ' : ''
  return `${fence}${padding}${text}${padding}${fence}`
}

function shorten(text: string): string {
  const points = Array.from(text)
  return points.length > MAX_ERROR_LENGTH
    ? `${points.slice(0, MAX_ERROR_LENGTH).join('').trimEnd()}…`
    : text
}

/** An MCP error's first sentences, without Codex's wrappers, safe inside Markdown. */
export function errorDetail(text: string): string {
  const line = text.slice(0, MAX_INPUT_LENGTH).replace(/\s+/g, ' ').trim()
  const message = line
    .split(': ')
    .map((segment) => segment.replace(TYPE_PATH, '').replace(/\s+/g, ' ').trim())
    .filter((segment) => segment.length > 0 && !WRAPPER_SEGMENT.test(segment))
    .join(': ')
  const cleaned =
    message === ''
      ? shorten(line)
      : shorten(
          message
            .split(/(?<=[.!?])\s+/)
            .slice(0, MAX_ERROR_SENTENCES)
            .join(' '),
        )
  return cleaned.replace(/[\\`*_[\]<>~]/g, (character) => `\\${character}`)
}

function detail(server: McpServerStatus, startupError: string | null): string | null {
  const status = statusOf(server)
  if (status === 'authenticationRequired') return t('codex.mcp.notSignedIn')
  const parts: string[] = []
  const tools = Object.keys(server.tools ?? {}).length
  if (status === 'connected' || tools > 0) parts.push(t('codex.mcp.tools', { count: tools }))
  if (server.authStatus === 'notLoggedIn' && status !== 'disabled') {
    parts.push(t('codex.mcp.notSignedIn'))
  }
  const error = startupError ?? server.toolsError
  const cleaned = error === null ? '' : errorDetail(error)
  if (cleaned !== '') parts.push(cleaned)
  return parts.length === 0 ? null : parts.join('; ')
}

/** The servers by state, with the startup error of each that failed. */
export function mcpStatusMessage(
  servers: readonly McpServerStatus[],
  errors: ReadonlyMap<string, string> = new Map(),
): string {
  if (servers.length === 0) return t('codex.mcp.none')
  const counts = SUMMARY_ORDER.map((status) => ({
    status,
    count: servers.filter((server) => statusOf(server) === status).length,
  }))
    .filter((entry) => entry.count > 0)
    .map((entry) =>
      t('codex.mcp.count', { count: entry.count, status: label(entry.status).toLowerCase() }),
    )
  const lines = [t('codex.mcp.summary', { count: servers.length, counts: counts.join(', ') })]
  for (const status of GROUP_ORDER) {
    const group = servers.filter((server) => statusOf(server) === status)
    if (group.length === 0) continue
    lines.push('', `**${label(status)}**`)
    for (const server of group) {
      const text = detail(server, errors.get(server.name) ?? null)
      lines.push(
        text === null ? `- ${inlineCode(server.name)}` : `- ${inlineCode(server.name)}: ${text}`,
      )
    }
  }
  const disabled = servers.filter((server) => statusOf(server) === 'disabled')
  if (disabled.length > 0) {
    const names = disabled.map((server) => inlineCode(server.name)).join(', ')
    lines.push('', t('codex.mcp.disabled', { names }))
  }
  if (servers.some((server) => RECONNECTABLE.has(statusOf(server)))) {
    lines.push('', t('codex.mcp.reconnectHint'))
  }
  return lines.join('\n')
}

/** What a reconnect did, then the servers' status. */
export function reconnectMessage(notes: readonly string[], status: string): string {
  return (
    [t('codex.mcp.reconnect'), ...notes.map((note) => `- ${note}`)].join('\n') + `\n\n${status}`
  )
}

export interface StartupResult {
  failed: { server: string; error: string; reauthenticate: boolean }[]
}

interface StartupState {
  status: McpServerStartupNotification['status']
  error: string | null
  reauthenticate: boolean
  version: number
}

interface StartupWaiter {
  names: readonly string[]
  after: number
  threadId: string
  done(result: StartupResult | null): void
}

/** The servers' startup states as Codex reports them, which a reconnect waits on. */
export class McpStartup {
  private current = 0
  /** By server, then by thread; a null thread is every thread's. */
  private readonly states = new Map<string, Map<string | null, StartupState>>()
  private readonly waiters = new Set<StartupWaiter>()

  version(): number {
    return this.current
  }

  record(update: McpServerStartupNotification): void {
    this.current += 1
    let states = this.states.get(update.name)
    if (!states) {
      states = new Map()
      this.states.set(update.name, states)
    }
    states.set(update.threadId ?? null, {
      status: update.status,
      error: update.error,
      reauthenticate: update.failureReason === 'reauthenticationRequired',
      version: this.current,
    })
    for (const waiter of [...this.waiters]) {
      const result = this.result(waiter)
      if (result) waiter.done(result)
    }
  }

  /**
   * Resolves once each server reached a final state after version `after`, or with null when
   * `signal` aborts or `timeoutMs` passes first.
   */
  wait(
    names: readonly string[],
    after: number,
    threadId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<StartupResult | null> {
    return new Promise((resolve) => {
      const waiter: StartupWaiter = {
        names,
        after,
        threadId,
        done: (result) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          this.waiters.delete(waiter)
          resolve(result)
        },
      }
      const abort = () => waiter.done(null)
      const timer = setTimeout(abort, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.add(waiter)
      const result = signal.aborted ? null : this.result(waiter)
      if (result || signal.aborted) waiter.done(result)
    })
  }

  /** Ends every wait, as when the connection closes. */
  close(): void {
    for (const waiter of [...this.waiters]) waiter.done(null)
  }

  private latest(name: string, threadId: string): StartupState | undefined {
    let latest: StartupState | undefined
    for (const [thread, state] of this.states.get(name) ?? []) {
      if (thread !== null && thread !== threadId) continue
      if (!latest || state.version > latest.version) latest = state
    }
    return latest
  }

  private result({ names, after, threadId }: StartupWaiter): StartupResult | null {
    const failed: StartupResult['failed'] = []
    for (const name of names) {
      const state = this.latest(name, threadId)
      if (!state || state.version <= after || state.status === 'starting') return null
      if (state.status === 'failed') {
        failed.push({
          server: name,
          error: state.error ?? t('codex.mcp.unknownError'),
          reauthenticate: state.reauthenticate,
        })
      }
    }
    return { failed }
  }
}
