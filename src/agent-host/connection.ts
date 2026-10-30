// A connection to a running agent, whatever protocol it speaks, and the Kettu types that cross
// it. The session, agent and report code use only this; each protocol's driver implements it.

import type {
  AgentAccount,
  ContextBreakdown,
  PlanLimit,
  PromptCapabilities,
} from '@shared/agent-host'
import type {
  ConfigOption,
  PendingPermission,
  StopReason,
  TokenTotals,
  UserContent,
} from '@shared/thread'
import type { MapperContext, MapperOutput } from './session-updates'

export interface PermissionRequest {
  toolCallId: string
  toolEntryId: string
  /** Adds or updates the tool entry the request belongs to. */
  output: MapperOutput
  options: PendingPermission['options']
}

export type PermissionAnswer = { optionId: string } | 'cancelled'

/** What a live session gives the connection; Kettu types only. */
export interface SessionTarget {
  context(): MapperContext
  apply(output: MapperOutput): void
  /** Resolves with the user's answer; rejects with `signal.reason` once the agent withdraws it. */
  requestPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>
}

export interface ConnectionHooks {
  traffic(direction: 'in' | 'out', message: unknown): void
  account(account: AgentAccount): void
  /** Something the agent sent that Kettu does not use. */
  ignored(sessionId: string | null, what: string): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface AuthMethodInfo {
  id: string
  name: string
  description?: string
  type: 'agent' | 'terminal'
  /** The program a terminal sign-in runs, when the agent names it instead of deriving it. */
  command?: string
  args: string[]
  env: Record<string, string>
}

/** How an agent's session titles arrive: as `session_info_update`, or only through `session/list`. */
export type OwnTitles = 'sent' | 'listed'

export interface AgentInit {
  /** The version of its protocol the agent answered with, where the protocol has one. */
  protocolVersion?: number
  name: string | null
  version: string | null
  capabilities: {
    loadSession: boolean
    listSessions: boolean
    resumeSession: boolean
    closeSession: boolean
    deleteSession: boolean
    forkSession: boolean
    /** A fork up to a message, which only some adapters take, outside ACP. */
    forkAtMessage: boolean
    /** How its own session titles arrive, or null when Kettu writes one. */
    ownTitles: OwnTitles | null
    logout: boolean
    /** Messages sent into a running turn. */
    steering: boolean
    /** MCP servers over HTTP, which the artifacts service needs. */
    mcpHttp: boolean
    prompt: PromptCapabilities
  }
  authMethods: AuthMethodInfo[]
  /** The capabilities as the agent sent them, for diagnostics. */
  raw: unknown
}

export interface SessionSetup {
  config: ConfigOption[]
}

/** A session the agent opened, with its own id for it. */
export interface OpenedSession extends SessionSetup {
  sessionId: string
}

export interface ListedSession {
  /** The agent's own id for the session. */
  sessionId: string
  title: string | null
  updatedAt: string | null
  cwd: string
}

export type AgentErrorKind = 'auth_required' | 'agent_error' | 'closed'

/** A request to the agent that failed, in Kettu's terms. */
export class AgentRequestError extends Error {
  constructor(
    readonly kind: AgentErrorKind,
    message: string,
    readonly code: number | null = null,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'AgentRequestError'
  }
}

/** The agent message a fork ends at. */
export interface ForkPoint {
  messageId: string // the agent message's own id
  text: string // its text, which an agent falls back to when it cannot find the id
  occurrence: number // 1-based, among the agent messages up to it with the same text
}

/** An MCP server a session gets: Kettu's artifacts service, over HTTP. */
export interface McpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/** A content block of a prompt, as Kettu sends it; each protocol converts it for its wire. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; uri?: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; size?: number }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } }

export function promptBlocks(content: readonly UserContent[]): PromptBlock[] {
  return content.map((item): PromptBlock => {
    if (item.type === 'text') return { type: 'text', text: item.text }
    const ref = item.ref
    switch (ref.kind) {
      case 'image':
        return { type: 'image', mimeType: ref.mimeType, data: ref.data }
      case 'link':
        return { type: 'resource_link', uri: ref.uri, name: ref.name }
      // The host turns attachments into images and links before a prompt goes; never reached.
      case 'attachment':
        return { type: 'text', text: ref.attachment.name }
      // Only agents send sounds and clips, so no prompt carries one; never reached.
      case 'audio':
      case 'video':
        return { type: 'text', text: ref.mimeType }
      default:
        return { type: 'text', text: ref.label }
    }
  })
}

/** A turn's tokens for one model, as the agent names it. */
export interface ModelTokens {
  model: string
  tokens: TokenTotals
}

export interface PromptResult {
  stopReason: StopReason
  tokens: TokenTotals | null
  models: ModelTokens[]
}

/** What Kettu opens a session no thread shows for. */
export type HiddenPurpose = 'options' | 'limits' | 'context' | 'titles'

/** How a session is opened, loaded, resumed or forked. */
export interface SessionOptions {
  mcpServers?: readonly McpServer[]
  /** Set for a session Kettu opens for itself, which no thread shows and nobody sees. */
  hidden?: HiddenPurpose
  /** Kettu's ultracode switch, for an agent that has one; unset leaves the agent's own. */
  ultracode?: boolean
}

/**
 * A connection to one running agent. Session ids here are the agent's own; each session's updates
 * reach the target registered for it.
 */
export interface AgentConnection {
  /** Settles once the connection has closed, from either side. */
  readonly closed: Promise<void>
  readonly isClosed: boolean
  close(): void

  initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit>
  authenticate(methodId: string): Promise<void>
  logout(): Promise<void>

  newSession(cwd: string, options?: SessionOptions): Promise<OpenedSession>
  /** Opens a session again, replaying its history to its target. */
  loadSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<SessionSetup>
  /** Opens a session again without replaying its history. */
  resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<SessionSetup>
  /** A new session that starts from this one, up to `point` for an agent with `forkAtMessage`. */
  forkSession(
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
    point?: ForkPoint,
  ): Promise<OpenedSession>
  closeSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }>

  /** Routes a session's updates to `target`, first replaying any that arrived early. */
  register(sessionId: string, target: SessionTarget): void
  /** Stops routing a session's updates; with `target`, only while it is the one registered. */
  unregister(sessionId: string, target?: SessionTarget): void
  /** Updates for a session Kettu closed wait for its next register again, like early ones. */
  reopen(sessionId: string): void
  /** The session `id` runs under: its own if Kettu has it, else the one the agent named. */
  rootOf(id: string): string

  prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult>
  /**
   * Prompts a session no thread shows, such as one made for a report, with `text`, and returns
   * the text of each agent message of the turn, in order. Its other updates are dropped.
   */
  collect(sessionId: string, text: string): Promise<string[]>
  /**
   * Sends a message into the running turn. An agent with no turn running answers
   * `promptRequired` instead of starting one, and the message stays Kettu's.
   */
  steer(sessionId: string, prompt: readonly PromptBlock[]): Promise<'injected' | 'promptRequired'>
  cancel(sessionId: string): Promise<void>
  setMode(sessionId: string, modeId: string): Promise<void>
  setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]>

  /**
   * Whether it can open sessions for Kettu's own use and remove them without a trace in the
   * agent's history. Known once `initialize` has answered.
   */
  readonly hiddenSessions: boolean
  /** Removes such a session and drops its late updates; failures go to `log` while it is open. */
  removeHidden(sessionId: string, log: (message: string) => void): Promise<void>

  /**
   * The current use of the agent's plan limits, answered by the agent itself. Without it the host
   * runs the agent's report command in a hidden session.
   */
  readLimits?(): Promise<PlanLimit[]>
  /**
   * What fills a session's context, answered by the agent itself. Without it the host runs the
   * agent's report command in a hidden fork of the session.
   */
  readContext?(sessionId: string, cwd: string, options: SessionOptions): Promise<ContextBreakdown>
}
