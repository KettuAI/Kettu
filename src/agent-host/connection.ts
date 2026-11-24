// A connection to a running agent, whatever protocol it speaks, and the Kettu types that cross
// it. The session, agent and report code use only this; each protocol's driver implements it.

import type {
  AgentAccount,
  ContextBreakdown,
  ModelProvider,
  PlanLimit,
  PromptCapabilities,
} from '@shared/agent-host'
import type { ContextEstimates } from '@shared/context'
import type {
  ConfigOption,
  DeclaredHook,
  DeclaredMcpServer,
  FormValues,
  PendingElicitation,
  PendingPermission,
  PendingQuestion,
  QuestionAnswer,
  SideChatStep,
  StopReason,
  TokenTotals,
  UserContent,
} from '@shared/thread'
import type { Shell } from './command-safety'
import type { MapperContext, MapperOutput } from './session-updates'

export interface PermissionRequest {
  toolCallId: string
  toolEntryId: string
  /** Adds or updates the tool entry the request belongs to. */
  output: MapperOutput
  options: PendingPermission['options']
  /** An ask's questions, answered together; `options` then serves a client that lacks them. */
  questions?: PendingQuestion[]
  /** A plan to approve, as Markdown; the host numbers it among the session's plans. */
  plan?: string
  /** An MCP server's request: a form, answered with its values, or a page to open. */
  elicitation?: PendingElicitation
  /** The shell a command runs in, when it is not a POSIX one. */
  shell?: Shell
  /**
   * The agent does not wait for the answer, so its turn goes on or ends and the card stays until
   * the user answers it or the session closes.
   */
  nonBlocking?: true
}

/** `note` is set only for an option that takes one, and only when the user wrote something. */
export type PermissionAnswer =
  | { optionId: string; note?: string }
  | { answers: QuestionAnswer[] }
  | { values: FormValues }
  | 'cancelled'

/** An answer that picks an option, which is all a request without questions or a form gets. */
export type OptionAnswer = { optionId: string; note?: string } | 'cancelled'

export function optionAnswer(answer: PermissionAnswer): OptionAnswer {
  return answer === 'cancelled' || 'optionId' in answer ? answer : 'cancelled'
}

/** What a live session gives the connection; Kettu types only. */
export interface SessionTarget {
  context(): MapperContext
  apply(output: MapperOutput): void
  /** Resolves with the user's answer; rejects with `signal.reason` once the agent withdraws it. */
  requestPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>
  /**
   * Sends `text` as the user's own message, such as the note that sends a plan back: at once when
   * the session can start a turn, else behind its queue. With `approval`, the message is the
   * answer a card already shows, such as a plan's approval, which the thread does not draw. With
   * `now`, a running turn takes it as it takes a steered message instead of after it ends.
   */
  send(text: string, options?: { approval?: true; now?: true }): void
  /** The permission mode the settings start the agent's new sessions in, or null for none. */
  startMode(): string | null
  /**
   * The text of a file the agent keeps for this session in its own folder, such as agy's plan;
   * null when it cannot be read there.
   */
  readAgentFile?(path: string): Promise<string | null>
  /**
   * The text of a file in the folder the session works in, read as the Files pane reads one; null
   * when it lies elsewhere, is not there or is not text.
   */
  readProjectFile?(path: string): Promise<string | null>
}

export interface ConnectionHooks {
  traffic(direction: 'in' | 'out', message: unknown): void
  account(account: AgentAccount): void
  /** The providers an agent that signs in to each one itself lists models from (Pi). */
  modelProviders?(providers: ModelProvider[]): void
  /**
   * The sign-in method an answer shows, for an agent that names it only that way, such as Google
   * Antigravity by its plan; null when the answer shows none.
   */
  signInShown?(method: string | null): void
  authState?(state: 'authenticated' | 'unauthenticated' | 'not_required' | 'unknown'): void
  /** Something the agent sent that Kettu does not use. */
  ignored(sessionId: string | null, what: string): void
  /** The agent refused its signed-in account as one its vendor moved to another harness. */
  accountRefused?(): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface AuthMethodInfo {
  id: string
  name: string
  description?: string
  type: 'agent' | 'terminal' | 'env'
  envVars?: { name: string; optional: boolean }[]
  /** The program a terminal sign-in runs, when the agent names it instead of deriving it. */
  command?: string
  args: string[]
  env: Record<string, string>
}

/** The client a sign-in runs for: where a page the agent hands over opens, and its Cancel. */
export interface SignInClient {
  /** Opens the agent's sign-in page on the client that asked, a web address only. */
  openLink(url: string): void
  signal: AbortSignal
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
    authStatus?: boolean
    /** Messages sent into a running turn. */
    steering: boolean
    /** Cuts a session's conversation before a turn, for an edit from a message. */
    rewind?: boolean
    /** MCP servers over HTTP, which the artifacts service needs. */
    mcpHttp: boolean
    /** MCP servers over the older SSE transport. */
    mcpSse: boolean
    /** MCP servers the agent starts as programs and talks to over stdio. */
    mcpStdio: boolean
    prompt: PromptCapabilities
  }
  authMethods: AuthMethodInfo[]
  /** The capabilities as the agent sent them, for diagnostics. */
  raw: unknown
}

export interface SessionSetup {
  config: ConfigOption[]
  /** The version of the harness's program that runs the session, when the agent says. */
  harnessVersion?: string
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

/** A side question as a connection answers it. */
export interface SideQuestion {
  /** The question, with the passage it is about quoted before it. */
  question: string
  /** The earlier questions and answers of the same side chat, oldest first. */
  history: readonly { question: string; answer: string }[]
  /**
   * The options the session opened with, for a fork that keeps its tools so that its prompt
   * stays the session's and reads its cache.
   */
  options?: SessionOptions
}

export interface SideAnswerEvents {
  /** The whole answer so far, each time it grows. */
  text(answer: string): void
  step(step: SideChatStep): void
}

export interface SideAnswer {
  text: string
  /** True when the agent gave a note in place of an answer. */
  synthetic: boolean
  /** What answering it took, where the agent reports it. */
  tokens?: TokenTotals | null
  model?: string | null
}

/** The agent's version has no side question of its own, so another way must answer. */
export class SideQuestionUnsupported extends Error {
  constructor(message = 'This version of the agent has no side questions') {
    super(message)
    this.name = 'SideQuestionUnsupported'
  }
}

/** Where an edit from a message cuts the agent's own session: before the prompt of the message. */
export interface RewindPoint {
  /** The agent's own id for the prompt, as `prompt` reported it; null for one sent before that. */
  ref: string | null
  /** The message's text, which an agent falls back to when it cannot find the id. */
  text: string
  /** 1-based, among the session's user messages up to it whose text holds the same. */
  occurrence: number
}

/** The agent's session an edit from a message carries on in. */
export interface RewoundSession {
  /** The same one, a new one holding only what came before, or '' when nothing came before. */
  sessionId: string
  /** The ids of the prompts kept, by the ids they had, where the cut gave them new ones. */
  refs?: Record<string, string>
}

/** The agent message a fork ends at. */
export interface ForkPoint {
  messageId: string // the agent message's own id
  text: string // its text, which an agent falls back to when it cannot find the id
  occurrence: number // 1-based, among the agent messages up to it with the same text
}

/**
 * An MCP server a session gets: Kettu's artifacts service over HTTP, or one the Marketplace
 * installed, over streamable HTTP, SSE or a program the agent starts.
 */
export type McpServer =
  | {
      type: 'http' | 'sse'
      name: string
      url: string
      headers: { name: string; value: string }[]
      /** Tools of the server that an agent runs without asking, where its own settings can say so. */
      autoAllow?: string[]
      /** A paragraph for the agent's own instructions, where it takes one. */
      prompt?: string
      /** Holds a token or a value from the key store, so it must never reach a command line. */
      secret?: boolean
    }
  | {
      type: 'stdio'
      name: string
      command: string
      args: string[]
      env: { name: string; value: string }[]
      secret?: boolean
    }

/** A content block of a prompt, as Kettu sends it; each protocol converts it for its wire. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; uri?: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; size?: number }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } }

export function promptBlocks(content: readonly UserContent[]): PromptBlock[] {
  // What a mentioned item adds is read as the message is sent, and goes as blocks of its own.
  const own = content.filter((item) => item.type !== 'ref' || item.ref.kind !== 'plugin')
  return own.map((item): PromptBlock => {
    // A command of Kettu's goes as the message it expands to.
    if (item.type === 'text') return { type: 'text', text: item.command?.sent ?? item.text }
    const ref = item.ref
    switch (ref.kind) {
      case 'image':
        // The host reads a stored image's bytes and sends them itself; never reached without.
        return 'data' in ref
          ? { type: 'image', mimeType: ref.mimeType, data: ref.data }
          : { type: 'text', text: ref.mimeType }
      case 'link':
        return { type: 'resource_link', uri: ref.uri, name: ref.name }
      case 'terminal':
        return { type: 'text', text: terminalNotice(ref.terminalId, ref.name) }
      case 'page':
        return { type: 'text', text: pageNotice(ref.name) }
      case 'device':
        return { type: 'text', text: deviceNotice(ref.deviceId, ref.name) }
      // The host turns attachments into images and links before a prompt goes; never reached.
      case 'attachment':
        return { type: 'text', text: ref.attachment.name }
      // Only agents send sounds and clips, so no prompt carries one; never reached.
      case 'audio':
      case 'video':
        return { type: 'text', text: ref.mimeType }
      // Left out above; never reached.
      case 'plugin':
        return { type: 'text', text: ref.name }
      default:
        return { type: 'text', text: ref.label }
    }
  })
}

/** What the agent reads where the user referenced a terminal of the session. */
export function terminalNotice(terminalId: string, name: string): string {
  return `[The user shares their terminal "${name}" with you, id ${terminalId}: read its output with terminal_read, and carry on in it with terminal_input.]`
}

/** What the agent reads where the user referenced a tab of the session's browser. */
export function pageNotice(title: string): string {
  return `[The user shares their browser tab "${title}" with you: find it with browser_tabs and select it to work in it.]`
}

/** What the agent reads where the user referenced a mobile device of the session. */
export function deviceNotice(deviceId: string, name: string): string {
  return `[The user shares the device "${name}" with you, id ${deviceId}: use it with the device tools.]`
}

/** A message of the conversation before an agent took a session over, as it is carried to it. */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  text: string
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
export type HiddenPurpose = 'options' | 'limits' | 'context' | 'titles' | 'sample' | 'side'

/** How a session is opened, loaded, resumed or forked. */
export interface SessionOptions {
  mcpServers?: readonly McpServer[]
  /** Folders whose subfolders are skills Kettu adds, for an agent that takes extra skill roots. */
  skillRoots?: readonly string[]
  /** Plugin folders Kettu adds, for an agent that loads local plugins. */
  localPlugins?: readonly string[]
  /** Set for a session Kettu opens for itself, which no thread shows and nobody sees. */
  hidden?: HiddenPurpose
  /** The user's answers about the MCP servers the folder declares itself; without it none start. */
  projectMcp?: ProjectMcpGate
  /** The user's answers about the hooks the folder declares itself; without it none run. */
  projectHooks?: ProjectHooksGate
  /**
   * Kettu's memory, set while it is on: an agent with `ownInstructions` puts `text` in the
   * session's own instructions, and every agent turns its harness's own memory off.
   */
  memory?: SessionMemory
  /**
   * The session's own instructions get nothing of Kettu's: its guide and memory go ahead of its
   * prompts, as for a session whose agent recorded its instructions outside Kettu.
   */
  promptAhead?: boolean
  /**
   * The instructions of the role the session started as, in the block Kettu's guide stands in:
   * handed over the way the guide and memory are, and ahead of its prompts in the cases they are.
   */
  role?: string
  /**
   * Kettu's guide and memory worded for an agent with `systemPromptAppend`, which adds them to the
   * system prompt of a session it starts; the agent keeps them with the session, so only
   * `newSession` takes it.
   */
  systemPromptAppend?: string
  /**
   * The session starts in full access, for an agent that takes it only as its process starts:
   * agy's flag, which would otherwise cost a restart right after `session/new`.
   */
  fullAccess?: boolean
  /** Ask the agent for a guess at the user's next message after each turn, where it offers one. */
  suggestions?: boolean
}

/** Kettu's memory as a session starts with it. */
export interface SessionMemory {
  /** The index of both layers and how to use them, marked as reference data. */
  text: string
}

/** Decides which of the MCP servers a session's folder declares itself may start. */
export interface ProjectMcpGate {
  /**
   * Of `servers`, the names that may not start in `cwd`; those nobody answered for yet wait for
   * the user in the session's thread.
   */
  hold(cwd: string, servers: readonly DeclaredMcpServer[]): Promise<string[]>
  /** Of `names`, those that still may not start in `cwd`, without asking. */
  held(cwd: string, names: readonly string[]): Promise<string[]>
}

/** The hooks a folder's own settings declare, and a digest of them that any change changes. */
export interface FolderHooks {
  hooks: DeclaredHook[]
  digest: string
}

/** Decides whether the hooks a session's folder declares itself may run. */
export interface ProjectHooksGate {
  /**
   * Whether `cwd`'s hooks may not run; while nobody answered for them, the user is asked in the
   * session's thread.
   */
  hold(cwd: string, hooks: FolderHooks): Promise<boolean>
  /** Whether they still may not run in `cwd`, without asking. */
  held(cwd: string, hooks: FolderHooks): Promise<boolean>
}

/**
 * A connection to one running agent. Session ids here are the agent's own; each session's updates
 * reach the target registered for it.
 */
export interface AgentConnection {
  /** Settles once the connection has closed, from either side. */
  readonly closed: Promise<void>
  /**
   * Whether it hands `SessionOptions.memory` to the agent in the session's own instructions;
   * otherwise the host sends that text ahead of the session's first prompt.
   */
  readonly ownInstructions?: boolean
  /**
   * Whether it takes `SessionOptions.systemPromptAppend` for a new session and keeps it out of
   * the session's messages. Only a session created with it has the text; the host records which.
   */
  readonly systemPromptAppend?: boolean
  readonly isClosed: boolean
  close(): void

  initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit>
  authenticate(methodId: string, client?: SignInClient): Promise<void>
  readAuthStatus?(): Promise<void>
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
  /** A copy of a session under a new id, written from the original without opening it. */
  copySession?(sessionId: string, cwd: string): Promise<string>
  /**
   * Whether the session's conversation can be cut, for an agent with `rewind` whose older sessions
   * may not take it. Asked without opening the session.
   */
  canRewind?(sessionId: string, cwd: string): Promise<boolean>
  /** `rewindSession` cuts only a session that is open. */
  readonly rewindsOpen?: boolean
  /**
   * Cuts the conversation of a session before the prompt `point` names, for an agent with
   * `rewind`: one that is not open, or with `rewindsOpen` one opened with its options first;
   * `title` is the session's, for a new one the cut makes.
   */
  rewindSession?(
    sessionId: string,
    cwd: string,
    point: RewindPoint,
    title: string | null,
  ): Promise<RewoundSession>

  /** Routes a session's updates to `target`, first replaying any that arrived early. */
  register(sessionId: string, target: SessionTarget): void
  /** Stops routing a session's updates; with `target`, only while it is the one registered. */
  unregister(sessionId: string, target?: SessionTarget): void
  /** Updates for a session Kettu closed wait for its next register again, like early ones. */
  reopen(sessionId: string): void
  /** The session `id` runs under: its own if Kettu has it, else the one the agent named. */
  rootOf(id: string): string

  /** `sent` hears the agent's own id for the prompt, for an agent with `rewind`. */
  prompt(
    sessionId: string,
    prompt: readonly PromptBlock[],
    sent?: (ref: string) => void,
  ): Promise<PromptResult>
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
  /** Stops one of the session's background tasks. Absent where the agent reports none. */
  stopTask?(sessionId: string, taskId: string): Promise<void>
  /** The end of a background task's output, at most 8 KiB. */
  taskOutput?(sessionId: string, taskId: string): Promise<{ output: string; truncated: boolean }>
  /**
   * Answers a side question from the session's own conversation, beside its turn and without
   * adding to it. Absent where the agent has no side question of its own; rejects with
   * `SideQuestionUnsupported` where this version lacks it.
   */
  sideQuestion?(
    sessionId: string,
    ask: SideQuestion,
    events: SideAnswerEvents,
    signal: AbortSignal,
  ): Promise<SideAnswer>
  /**
   * Adds earlier messages to the history the session's model sees, ahead of its next turn. False
   * where this agent's version takes none, and the host sends them with the prompt instead.
   */
  injectHistory?(sessionId: string, messages: readonly HistoryMessage[]): Promise<boolean>
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
  /**
   * Whether it can open sessions for Kettu's own use that are only read and never prompted, such
   * as for the agent menu's options, and remove those without a trace. True wherever
   * `hiddenSessions` is.
   */
  readonly unpromptedSessions: boolean
  /** Removes such a session and drops its late updates; failures go to `log` while it is open. */
  removeHidden(sessionId: string, log: (message: string) => void): Promise<void>

  /**
   * Answers one question in a hidden session of its own in `dir`, with no tools, MCP servers,
   * hooks or settings and no history kept, its text streamed to `onText` as it comes; resolves
   * with the whole answer, and `signal` cancels it. Absent where the agent cannot run one so.
   */
  answerQuestion?(
    dir: string,
    prompt: readonly PromptBlock[],
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<string>

  /**
   * The current use of the agent's plan limits, answered by the agent itself. Without it the host
   * runs the agent's report command in a hidden session.
   */
  readLimits?(): Promise<PlanLimit[]>
  /** A request of the agent's own protocol outside any session, for what only its harness has. */
  request?<T>(method: string, params?: unknown): Promise<T>
  /**
   * What fills a session's context, answered by the agent itself. Without it the host runs the
   * agent's report command in a hidden fork of the session.
   */
  readContext?(sessionId: string, cwd: string, options: SessionOptions): Promise<ContextBreakdown>
  readContextEstimates?(sessionId: string, cwd: string): Promise<ContextEstimates>
}
