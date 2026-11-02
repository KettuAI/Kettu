// The pages of other hosts' sessions: an agent on another host that uses the browser in a turn
// this computer sent drives this computer's page, as one of this computer's agents does. A
// navigation to a dev server on that host opens through a forward to it, and the agent reads its
// own addresses in what comes back. Site questions go to the host, for the session's thread.

import {
  BROWSER_TOOL_NAMES,
  isBrowserForward,
  loopbackForward,
  type BrowserCallAnswer,
  type BrowserDeviceCall,
  type BrowserForward,
  type BrowserOriginAnswer,
  type BrowserToolName,
} from '@shared/browser'
import { DEVICE_ID } from '@shared/remote/device'

const MAX_ID_CHARS = 256
const MAX_PATH_CHARS = 32_767
/** Deeper than any result nests. */
const MAX_DEPTH = 64

/** The window's name for a folder on another host, as its sessions' projects carry it. */
export function onHost(hostId: string, path: string): string {
  return path === '' ? '' : `kettu-host:${hostId}:${path}`
}

/** A host's call as main reads it, or null when it is not one. */
export function parseDeviceCall(value: unknown): BrowserDeviceCall | null {
  if (typeof value !== 'object' || value === null) return null
  const { callId, sessionId, tool, args, projectPath, forward } = value as Record<string, unknown>
  if (typeof callId !== 'number' || !Number.isSafeInteger(callId) || callId < 1) return null
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > MAX_ID_CHARS) {
    return null
  }
  if (!(BROWSER_TOOL_NAMES as readonly unknown[]).includes(tool)) return null
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  if (typeof projectPath !== 'string' || projectPath.length > MAX_PATH_CHARS) return null
  if (forward !== undefined && !isBrowserForward(forward)) return null
  return {
    callId,
    sessionId,
    tool: tool as BrowserToolName,
    args: args as Record<string, unknown>,
    projectPath,
    ...(forward ? { forward } : {}),
  }
}

/** A forwarded origin: the address the page opens, and the one on the agent's host. */
interface Mapping {
  local: string
  remote: string
}

/** `url` at the forward's port on this computer, and the origins the page and the agent name. */
export function forwardedUrl(url: string, port: number): { url: string; mapping: Mapping } {
  const parsed = new URL(url)
  const remote = parsed.origin
  // The forward listens on 127.0.0.1 alone; the other names resolve there as a browser does.
  if (parsed.hostname === '[::1]') parsed.hostname = '127.0.0.1'
  parsed.port = String(port)
  return { url: parsed.href, mapping: { local: parsed.origin, remote } }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every string in `value` with the page's origins named as the agent's host names them. */
export function unmapped(value: unknown, mappings: readonly Mapping[], depth = 0): unknown {
  if (mappings.length === 0 || depth > MAX_DEPTH) return value
  if (typeof value === 'string') {
    let text = value
    for (const { local, remote } of mappings) {
      // Not a longer port that starts the same.
      text = text.replace(new RegExp(`${escape(local)}(?![0-9])`, 'g'), remote)
    }
    return text
  }
  if (Array.isArray(value)) return value.map((item) => unmapped(item, mappings, depth + 1))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unmapped(item, mappings, depth + 1)]),
    )
  }
  return value
}

export interface RemoteBrowserDeps {
  /** Runs a call on the session's page, as for this computer's agent host. */
  run(
    callId: number,
    sessionId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
    projectPath: string,
    waiting: (waiting: boolean) => void,
  ): Promise<BrowserCallAnswer>
  /** A port on this computer's loopback that reaches `forward` on the host; null when none can. */
  forward(hostId: string, sessionId: string, forward: BrowserForward): Promise<number | null>
  closeForwards(hostId: string, sessionId: string): void
  /** Main's own request to the host; false while its session is not open. */
  request(hostId: string, method: string, params: unknown): boolean
  log(level: 'info' | 'warn', message: string): void
}

export class RemoteBrowser {
  /** The host each page's session is on, from the first call that drove it. */
  private readonly hosts = new Map<string, string>()
  /** Each page's forwarded origins. */
  private readonly mappings = new Map<string, Mapping[]>()
  /** The sessions whose pages this computer's own agents drive, which no other host may. */
  private readonly local = new Set<string>()

  constructor(private readonly deps: RemoteBrowserDeps) {}

  /** The host whose session the page belongs to, or null for this computer's. */
  hostOf(sessionId: string): string | null {
    return this.hosts.get(sessionId) ?? null
  }

  /** This computer's agent host drives the session's page; false when another host's does. */
  claimLocal(sessionId: string): boolean {
    if (this.hosts.has(sessionId)) return false
    this.local.add(sessionId)
    return true
  }

  /** A host's `browser.call`: it runs on the session's page, and the host hears the answer. */
  async call(hostId: string, value: unknown): Promise<void> {
    const call = parseDeviceCall(value)
    if (!call || !DEVICE_ID.test(hostId)) {
      this.deps.log('warn', `Ignored a browser call from host ${hostId} that is not one`)
      return
    }
    const answer = await this.answer(hostId, call).catch((error: unknown): BrowserCallAnswer => ({
      error: { code: 'invalid', message: (error as Error)?.message ?? String(error) },
    }))
    if (!this.deps.request(hostId, 'browser.answer', { callId: call.callId, answer })) {
      this.deps.log('info', `Host ${hostId} went before its browser call was answered`)
    }
  }

  /** A page asked for a new origin: a host's session shows the question in its thread. */
  originAsked(request: { id: number; sessionId: string; origin: string }): boolean {
    const hostId = this.hosts.get(request.sessionId)
    if (!hostId) return false
    const { id, sessionId, origin } = request
    this.deps.request(hostId, 'browser.origin', { sessionId, requestId: id, origin })
    return true
  }

  /** The question's wait ended, from the pane or the card. */
  originAnswered(request: {
    id: number
    sessionId: string
    decision: BrowserOriginAnswer
  }): boolean {
    const hostId = this.hosts.get(request.sessionId)
    if (!hostId) return false
    this.deps.request(hostId, 'browser.originSettled', {
      requestId: request.id,
      decision: request.decision,
    })
    return true
  }

  /** The session's page is gone with its session: its forwards close. */
  pageRemoved(sessionId: string): void {
    this.local.delete(sessionId)
    const hostId = this.hosts.get(sessionId)
    if (!hostId) return
    this.hosts.delete(sessionId)
    this.mappings.delete(sessionId)
    this.deps.closeForwards(hostId, sessionId)
  }

  /** The host's session ended, which closed its forwards; its pages stay its own. */
  hostClosed(hostId: string): void {
    for (const [sessionId, owner] of this.hosts) {
      if (owner === hostId) this.mappings.delete(sessionId)
    }
  }

  private async answer(hostId: string, call: BrowserDeviceCall): Promise<BrowserCallAnswer> {
    const { callId, sessionId, tool } = call
    const owner = this.hosts.get(sessionId)
    if ((owner !== undefined && owner !== hostId) || this.local.has(sessionId)) {
      return { error: { code: 'no_page', message: 'Another host’s session has this page.' } }
    }
    this.hosts.set(sessionId, hostId)
    let args = call.args
    if (tool === 'browser_navigate' && call.forward && typeof args.url === 'string') {
      const forward = loopbackForward(args.url)
      if (forward?.host !== call.forward.host || forward.port !== call.forward.port) {
        return { error: { code: 'invalid', message: 'The forward does not match the address.' } }
      }
      const port = await this.deps.forward(hostId, sessionId, forward)
      if (port === null) {
        return {
          error: {
            code: 'navigation_failed',
            message: `Port ${forward.port} on the host could not be forwarded to the browser.`,
          },
        }
      }
      const { url, mapping } = forwardedUrl(args.url, port)
      const known = (this.mappings.get(sessionId) ?? []).filter((m) => m.local !== mapping.local)
      this.mappings.set(sessionId, [...known, mapping])
      args = { ...args, url }
    }
    const answer = await this.deps.run(
      callId,
      sessionId,
      tool,
      args,
      onHost(hostId, call.projectPath),
      (waiting) => void this.deps.request(hostId, 'browser.waiting', { callId, waiting }),
    )
    const mappings = this.mappings.get(sessionId) ?? []
    if (mappings.length === 0) return answer
    if ('error' in answer) {
      const { code, message } = answer.error
      return { error: { code, message: unmapped(message, mappings) as string } }
    }
    const { text, value, image } = answer.result
    return {
      result: {
        text: unmapped(text, mappings) as string,
        value: unmapped(value, mappings) as Record<string, unknown>,
        ...(image ? { image } : {}),
      },
    }
  }
}
