// OpenCode through its own server: Kettu starts one `opencode serve` for the agent, sends what
// the user does as HTTP requests, and reads every session's output from one event stream. The
// stream carries live events only, so after it drops Kettu reads each open session's messages and
// waiting requests again before it goes on listening.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ConfigOption,
  FormField,
  PendingElicitation,
  PendingQuestion,
  PermissionOption,
  SlashCommand,
  StopReason,
  TokenTotals,
} from '@shared/thread'
import {
  AgentRequestError,
  optionAnswer,
  type AgentConnection,
  type AgentInit,
  type ConnectionHooks,
  type ForkPoint,
  type ListedSession,
  type McpServer,
  type ModelTokens,
  type OpenedSession,
  type PermissionAnswer,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
} from '../connection'
import type { HostedContext } from '../driver'
import { t } from '../i18n'
import type { OpenCodeSessions } from '../model-requests/opencode'
import { addTokenTotals, type MapperContext, type MapperOutput } from '../session-updates'
import { assistantMessageId, SessionMapper, tokenTotals } from './mapper'
import {
  CONFIG,
  DEFAULT_EFFORT,
  configOptions,
  findModel,
  modelValue,
  modes,
  type Chosen,
  type Offer,
} from './options'
import {
  sessionOf,
  type AgentInfo,
  type CommandInfo,
  type EventData,
  type EventType,
  type FormAnswer,
  type FormFieldInfo,
  type FormInfo,
  type MessageInfo,
  type ModelInfo,
  type ModelRef,
  type PermissionRequestInfo,
  type ServerEvent,
  type SessionInfo,
  type StructuredError,
} from './protocol'
import {
  ServerError,
  locationQuery,
  startServer,
  type RunningServer,
  type ServerApi,
  type StartServer,
} from './server'

const PENDING_EVENTS = 2_000
/** Sessions Kettu closed: their late events are dropped, not kept for a later register. */
const CLOSED_SESSIONS = 256
/** How long a folder's models, agents and commands are taken as read. */
const OFFER_TTL_MS = 60_000
/** A folder the server has just opened lists its agents a moment later: how often it is asked. */
const OFFER_RETRIES = 40
const OFFER_RETRY_MS = 150
/** How far the clock that stamps OpenCode's messages may be from the one that times the stream. */
const CLOCK_SLACK_MS = 2_000
/** How long a folder's changes settle before its sessions get their options again. */
const REFRESH_MS = 300
/**
 * A folder the server is still opening answers 503 once its plugins took over 5 s to load, as on
 * a busy computer: how often such a request is sent again, and how long apart.
 */
const LOADING_RETRIES = 8
const LOADING_RETRY_MS = 500
/** How long a prompt waits for a dropped event stream to come back. */
const STREAM_WAIT_MS = 30_000
const RECONNECT_MS = [250, 1_000, 2_000, 5_000]
const MESSAGE_PAGE = 100
/** A linked file larger than this goes as its path, for the agent to read as much as it needs. */
const ATTACH_BYTES = 5 * 1024 * 1024
/** JSON-RPC's code for a resource that is not there, which the host reads as a session gone. */
const NOT_FOUND = -32002
/** The key of the instruction entry that holds Kettu's guide and memory. */
const INSTRUCTIONS_KEY = 'kettu'
const COMPACT = 'compact'
const SESSION_ID = /^ses_[A-Za-z0-9]+$/
const MESSAGE_ID = /^msg_[A-Za-z0-9_]+$/
const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/
const COMMAND = /^\/([A-Za-z][\w-]*)(?:[ \t]+([\s\S]*))?$/
const OPTION = { allow: 'allow-once', always: 'allow-always', reject: 'reject', other: 'other' }
/** An option id answering a question's choice, as a client without the card's questions sends. */
const ANSWER = /^answer:(\d+)$/

interface Turn {
  resolve(result: PromptResult): void
  reject(error: Error): void
  tokens: TokenTotals | null
  models: Map<string, TokenTotals>
  /** Started by OpenCode between Kettu's turns, as when a subagent's result came back. */
  own: boolean
  /** How the turn's last request ended, where that names why the turn stopped. */
  finish: string | null
  since: number
}

interface Session {
  id: string
  cwd: string
  mapper: SessionMapper
  /** The session a subagent runs under; null for one Kettu opened. */
  parentId: string | null
  chosen: Chosen
  turn: Turn | null
  /** OpenCode's agent loop runs for it. */
  running: boolean
  /** A Stop that came before the loop started, made once it does. */
  stopping: boolean
  /** A prompt is on its way to OpenCode, which has not answered for it yet. */
  sending: boolean
  /** Opened for Kettu itself: no thread shows it. */
  hidden: boolean
  /** Never made on the server: it only lists a folder's options. */
  listed: boolean
  /** The cards that wait for the user, by OpenCode's id of the request. */
  requests: Map<string, AbortController>
  /** The replies of a turn Kettu collects instead of showing. */
  collected: string[] | null
  /** The model of the request that runs, which its tokens are counted for. */
  stepModel: string | null
  /** A subagent's tokens since its loop started. */
  spent: TokenTotals | null
  /** Guide and memory that could not go into its instructions, sent ahead of its next prompt. */
  ahead: string | null
  /** The assistant messages whose tokens are counted. */
  counted: Set<string>
}

type Deferred = (ctx: MapperContext) => MapperOutput | null

/**
 * What became of a prompt: a turn of OpenCode's that ends it, or none, with the words a command
 * answered in instead when it did.
 */
interface Sent {
  turn: boolean
  answer: string | null
}

const TURN: Sent = { turn: true, answer: null }

interface PromptFile {
  uri: string
  name?: string
  source?: { type: 'inline' }
}

/** A failed turn as Kettu's error, with OpenCode's own words. */
export function turnError(error: StructuredError | undefined): Error {
  return new AgentRequestError(
    'agent_error',
    error?.message || t('opencode.turnFailed'),
    null,
    error
      ? { type: error.type, ...(error.status !== undefined ? { status: error.status } : {}) }
      : {},
  )
}

function fileName(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname.split('/').filter(Boolean).pop() ?? uri)
  } catch {
    return uri
  }
}

function dataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`
}

/**
 * Kettu's prompt as the text and files OpenCode takes: images and embedded text inline, and a
 * linked file or folder by its address, which OpenCode reads itself. What it cannot attach, a
 * web address or a file too large to embed, is named in the text.
 */
export async function promptInput(
  blocks: readonly PromptBlock[],
  size: (file: string) => Promise<number | null> = fileSize,
): Promise<{ text: string; files: PromptFile[] }> {
  let text = ''
  const files: PromptFile[] = []
  const named: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      case 'image':
        files.push({
          uri: dataUrl(block.mimeType, block.data),
          name: block.uri ? fileName(block.uri) : `image.${block.mimeType.split('/')[1] ?? 'png'}`,
          source: { type: 'inline' },
        })
        break
      case 'resource':
        files.push({
          uri: dataUrl(
            block.resource.mimeType || 'text/plain',
            Buffer.from(block.resource.text, 'utf8').toString('base64'),
          ),
          name: fileName(block.resource.uri),
          source: { type: 'inline' },
        })
        break
      case 'resource_link': {
        const file = block.uri.startsWith('file:') ? localPath(block.uri) : null
        const bytes = file ? await size(file) : null
        if (file && bytes !== null && bytes <= ATTACH_BYTES) {
          files.push({ uri: block.uri, name: block.name })
        } else {
          named.push(file ?? block.uri)
        }
        break
      }
    }
  }
  return { text: withNamed(text, named), files }
}

function withNamed(text: string, named: readonly string[]): string {
  if (named.length === 0) return text
  const list = named.map((item) => `@${item}`).join('\n')
  return text === '' ? list : `${text}\n\n${list}`
}

function localPath(uri: string): string | null {
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

/** The bytes of a file, 0 for a folder, null for what is not there. */
async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file)
    return info.isDirectory() ? 0 : info.size
  } catch {
    return null
  }
}

/** A prompt that is only a slash command, as its name and what follows it. */
export function parseCommand(text: string): { name: string; text: string } | null {
  const match = COMMAND.exec(text.trim())
  return match ? { name: match[1]!, text: match[2]?.trim() ?? '' } : null
}

/** An MCP server as OpenCode's configuration names it; null for a transport it does not take. */
export function mcpConfig(server: McpServer): Record<string, unknown> | null {
  switch (server.type) {
    case 'http':
      return {
        type: 'remote',
        url: server.url,
        headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
        oauth: false,
      }
    case 'stdio':
      return {
        type: 'local',
        command: [server.command, ...server.args],
        environment: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      }
    default:
      return null
  }
}

/** The servers' paragraphs, Kettu's memory and the role, as a session's instructions take them. */
function instructionsFor(options: SessionOptions): string | null {
  const parts = [
    ...(options.mcpServers ?? []).flatMap((server) =>
      server.type === 'stdio' ? [] : (server.prompt ?? []),
    ),
    ...(options.memory ? [options.memory.text] : []),
    ...(options.role ? [options.role] : []),
  ]
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** A form OpenCode's question tool made, as the questions of one card; null for any other form. */
export function formQuestions(form: FormInfo): PendingQuestion[] | null {
  if (form.metadata?.kind !== 'question' || form.fields.length === 0) return null
  const questions: PendingQuestion[] = []
  for (const field of form.fields) {
    if (field.type !== 'string' && field.type !== 'multiselect') return null
    questions.push({
      header: field.title ?? '',
      question: field.description ?? field.title ?? '',
      multiSelect: field.type === 'multiselect',
      options: (field.options ?? []).map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      allowsText: field.custom === true || (field.options ?? []).length === 0,
      secret: false,
    })
  }
  return questions
}

/** The question card's answers as the form's: each answered field by its key. */
export function questionAnswer(form: FormInfo, answer: PermissionAnswer): FormAnswer | null {
  if (answer === 'cancelled' || 'values' in answer) return null
  const result: FormAnswer = {}
  if ('optionId' in answer) {
    const first = form.fields[0]
    const chosen = ANSWER.exec(answer.optionId)
    const options = first && 'options' in first ? (first.options ?? []) : []
    const value = chosen ? options[Number(chosen[1])]?.value : undefined
    if (!first || value === undefined) return null
    result[first.key] = first.type === 'multiselect' ? [value] : value
    return result
  }
  for (const given of answer.answers) {
    const field = form.fields[given.question]
    if (!field || (field.type !== 'string' && field.type !== 'multiselect')) continue
    const options = field.options ?? []
    const values = given.choices.flatMap((choice) => options[choice]?.value ?? [])
    const text = given.text?.trim() ?? ''
    if (field.type === 'multiselect') {
      const all = text ? [...values, text] : values
      if (all.length > 0) result[field.key] = all
    } else {
      const value = text || values[0]
      if (value !== undefined) result[field.key] = value
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

function formField(field: FormFieldInfo): FormField | null {
  const base = {
    key: field.key,
    title: field.title ?? field.key,
    ...(field.description ? { description: field.description } : {}),
    required: field.required === true,
  }
  switch (field.type) {
    case 'string': {
      const options = field.options ?? []
      if (options.length > 0 && field.custom !== true) {
        return {
          ...base,
          type: 'choice',
          choices: options.map(({ value, label }) => ({ value, label })),
          ...(field.default !== undefined ? { default: field.default } : {}),
        }
      }
      return {
        ...base,
        type: 'text',
        ...(field.format ? { format: field.format } : {}),
        ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        ...(field.default !== undefined ? { default: field.default } : {}),
      }
    }
    case 'number':
    case 'integer':
      return {
        ...base,
        type: 'number',
        integer: field.type === 'integer',
        ...(typeof field.minimum === 'number' ? { minimum: field.minimum } : {}),
        ...(typeof field.maximum === 'number' ? { maximum: field.maximum } : {}),
        ...(typeof field.default === 'number' ? { default: field.default } : {}),
      }
    case 'boolean':
      return {
        ...base,
        type: 'boolean',
        ...(field.default !== undefined ? { default: field.default } : {}),
      }
    case 'multiselect':
      return {
        ...base,
        type: 'choices',
        choices: field.options.map(({ value, label }) => ({ value, label })),
        ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
        ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
        ...(field.default !== undefined ? { default: field.default } : {}),
      }
    default:
      return null
  }
}

/** Any other form as a request to fill in, or a page to open; null when a field has no card. */
export function formElicitation(form: FormInfo): PendingElicitation | null {
  const shown = form.fields.filter((field) => field.hidden !== true)
  const page = shown.length === 1 && shown[0]!.type === 'external' ? shown[0]! : null
  if (page && page.type === 'external') {
    return { kind: 'url', server: form.title, message: page.description ?? '', url: page.url }
  }
  const fields: FormField[] = []
  for (const field of shown) {
    const mapped = formField(field)
    if (!mapped) return null
    fields.push(mapped)
  }
  return fields.length > 0 ? { kind: 'form', server: form.title, message: '', fields } : null
}

function stopReason(outcome: 'succeeded' | 'interrupted', finish: string | null): StopReason {
  if (outcome === 'interrupted') return 'cancelled'
  if (finish === 'length') return 'max_tokens'
  if (finish === 'content-filter') return 'refusal'
  return 'end_turn'
}

function agentTurn(
  phase: 'started' | 'joined' | 'ended' | 'failed',
  result?: PromptResult,
  error?: unknown,
): MapperOutput {
  if (phase === 'started' || phase === 'joined') {
    return { patches: [], effects: [{ kind: 'agentTurn', phase }] }
  }
  if (phase === 'ended') {
    return { patches: [], effects: [{ kind: 'agentTurn', phase: 'ended', result: result! }] }
  }
  return { patches: [], effects: [{ kind: 'agentTurn', phase: 'failed', error }] }
}

export class OpenCodeConnection implements AgentConnection {
  readonly closed: Promise<void>
  readonly ownInstructions = true
  private resolveClosed!: () => void
  private done = false
  private server: RunningServer | null = null
  private readonly sessions = new Map<string, Session>()
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, Deferred[]>()
  private readonly unregistered = new Set<string>()
  private pendingCount = 0
  private readonly offers = new Map<string, { offer: Offer; at: number }>()
  /** The MCP servers each folder has on this server, by name, as the configuration last put. */
  private readonly mounted = new Map<string, Map<string, string>>()
  private readonly stream = new AbortController()
  /** Settles once the event stream is open; a new one waits while it is down. */
  private up: Promise<void>
  private streamIsUp: () => void = () => {}
  private streamed = false
  /** When the stream's latest event came: what ended before it, the stream has delivered. */
  private seenAt = 0
  private listings = 0
  /** The folders whose sessions get their options again once their changes settle. */
  private readonly refreshing = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly context: HostedContext,
    private readonly start: StartServer = startServer,
  ) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve))
    this.up = new Promise((resolve) => (this.streamIsUp = resolve))
  }

  get isClosed(): boolean {
    return this.done
  }

  get hiddenSessions(): boolean {
    return true
  }

  get unpromptedSessions(): boolean {
    return true
  }

  private get hooks(): ConnectionHooks {
    return this.context.hooks
  }

  private get api(): ServerApi {
    if (this.done || !this.server) throw new AgentRequestError('closed', 'OpenCode stopped')
    return this.server.api
  }

  close(): void {
    if (this.done) return
    this.done = true
    this.stream.abort()
    for (const timer of this.refreshing.values()) clearTimeout(timer)
    this.refreshing.clear()
    for (const session of this.sessions.values()) {
      this.withdraw(session, 'OpenCode stopped')
      session.turn?.reject(new AgentRequestError('closed', 'OpenCode stopped'))
      session.turn = null
    }
    this.server?.stop()
    this.resolveClosed()
  }

  async initialize(_appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    const server = await this.start(this.context, signal)
    if (this.done) {
      server.stop()
      throw new AgentRequestError('closed', 'OpenCode stopped')
    }
    this.server = server
    void server.exited.then(() => this.close())
    void this.listen()
    // Nothing is sent before the stream is open, since it replays nothing.
    await this.up
    return {
      name: 'OpenCode',
      version: server.version,
      capabilities: {
        loadSession: true,
        listSessions: true,
        resumeSession: true,
        closeSession: true,
        deleteSession: true,
        forkSession: true,
        forkAtMessage: true,
        ownTitles: 'sent',
        logout: false,
        steering: true,
        mcpHttp: true,
        mcpSse: false,
        mcpStdio: true,
        prompt: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: [],
      raw: { version: server.version },
    }
  }

  authenticate(methodId: string): Promise<void> {
    return Promise.reject(
      new AgentRequestError('agent_error', `${methodId} signs in in a terminal`, -32602),
    )
  }

  logout(): Promise<void> {
    return Promise.reject(new AgentRequestError('agent_error', 'OpenCode signs out per provider'))
  }

  /**
   * OpenCode's stored sessions, read from the server that runs them: it answers for what its own
   * version wrote, which a background service left running from an older one may not.
   */
  readonly stored: OpenCodeSessions = {
    messages: async (sessionId, cursor) => {
      if (!SESSION_ID.test(sessionId) || (cursor !== null && !CURSOR.test(cursor))) return null
      const query = cursor === null ? '' : `?cursor=${cursor}`
      const page = await this.read<{ data?: unknown[]; cursor?: { next?: unknown } }>(
        `/api/session/${sessionId}/message${query}`,
      )
      if (!Array.isArray(page?.data)) return null
      const next = page.cursor?.next
      return { messages: page.data, next: typeof next === 'string' && next !== '' ? next : null }
    },
    message: async (sessionId, messageId) => {
      if (!SESSION_ID.test(sessionId) || !MESSAGE_ID.test(messageId)) return null
      const answer = await this.read<{ data?: unknown }>(
        `/api/session/${sessionId}/message/${messageId}`,
      )
      return answer?.data ?? null
    },
    session: async (sessionId) => {
      if (!SESSION_ID.test(sessionId)) return null
      const answer = await this.read<{ data?: unknown }>(`/api/session/${sessionId}`)
      const data = answer?.data
      return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
    },
  }

  /** Reads from the server; null when it cannot answer. */
  private async read<T>(route: string): Promise<T | null> {
    try {
      return await this.api.request<T>('GET', route)
    } catch {
      return null
    }
  }

  // Requests.

  private async call<T>(
    method: string,
    route: string,
    body?: unknown,
    shown: unknown = body,
  ): Promise<T> {
    const api = this.api
    this.hooks.traffic('out', {
      method,
      path: route,
      ...(shown !== undefined ? { body: shown } : {}),
    })
    try {
      return await this.loaded(() => api.request<T>(method, route, body))
    } catch (error) {
      throw this.requestError(error)
    }
  }

  /** Runs a request again while the server says the folder it is for is still loading. */
  private async loaded<T>(run: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await run()
      } catch (error) {
        const loading = error instanceof ServerError && error.status === 503
        if (!loading || tries >= LOADING_RETRIES || this.done) throw error
        await new Promise((resolve) => setTimeout(resolve, LOADING_RETRY_MS))
      }
    }
  }

  private requestError(error: unknown): Error {
    if (error instanceof AgentRequestError) return error
    if (this.done) return new AgentRequestError('closed', 'OpenCode stopped')
    if (error instanceof ServerError) {
      const gone = error.tag === 'SessionNotFoundError'
      return new AgentRequestError('agent_error', error.message, gone ? NOT_FOUND : null, {
        status: error.status,
        ...(error.tag ? { tag: error.tag } : {}),
      })
    }
    return new AgentRequestError('agent_error', (error as Error)?.message ?? String(error))
  }

  // What a folder offers.

  private async offer(cwd: string, fresh = false): Promise<Offer> {
    const known = this.offers.get(cwd)
    if (known && !fresh && Date.now() - known.at < OFFER_TTL_MS) return known.offer
    const query = locationQuery(cwd)
    const list = async <T>(route: string): Promise<T[]> => {
      const answer = await this.loaded(() =>
        this.api.request<{ data?: T[] }>('GET', `${route}?${query}`),
      )
      return Array.isArray(answer?.data) ? answer.data : []
    }
    const listAgents = (): Promise<AgentInfo[]> =>
      list<AgentInfo>('/api/agent').then((all) =>
        all.map(({ id, name, description, mode, hidden }) => ({
          id,
          name,
          mode,
          ...(description ? { description } : {}),
          ...(hidden ? { hidden } : {}),
        })),
      )
    const listCommands = (): Promise<CommandInfo[]> =>
      list<CommandInfo>('/api/command').catch(() => [])
    // The model list holds each provider's settings, keys among them, so only these fields stay.
    const read = Promise.all([
      list<ModelInfo>('/api/model').then((all) =>
        all
          .filter((model) => model.enabled !== false)
          .map(({ id, providerID, name, variants, limit }): ModelInfo => ({
            id,
            providerID,
            name,
            variants: (variants ?? []).map((variant) => ({ id: variant.id })),
            ...(limit?.context ? { limit: { context: limit.context } } : {}),
          })),
      ),
      listAgents(),
      listCommands(),
      this.api
        .request<{ data?: ModelRef | null }>('GET', `/api/model/default?${query}`)
        .then((answer) => answer?.data ?? null)
        .catch(() => null),
    ])
    const [models, first, early, standard] = await read.catch((error: unknown) => {
      throw this.requestError(error)
    })
    let agents = first
    let commands = early
    // Every folder has OpenCode's own agents, so a list without any is one not loaded yet.
    for (let tries = 0; agents.length === 0 && tries < OFFER_RETRIES && !this.done; tries++) {
      await new Promise((resolve) => setTimeout(resolve, OFFER_RETRY_MS))
      ;[agents, commands] = await Promise.all([listAgents(), listCommands()]).catch(
        (error: unknown) => {
          throw this.requestError(error)
        },
      )
    }
    const offer: Offer = {
      models,
      agents,
      commands,
      defaultModel: standard ? { id: standard.id, providerID: standard.providerID } : null,
    }
    this.offers.set(cwd, { offer, at: Date.now() })
    return offer
  }

  private config(session: Session, offer: Offer): ConfigOption[] {
    const model = session.chosen.model ?? offer.defaultModel
    const known = model ? findModel(offer.models, modelValue(model)) : null
    session.mapper.window(known?.limit?.context ?? null)
    return configOptions(offer, session.chosen)
  }

  /**
   * A folder's models, agents or commands changed: its open sessions get their options and
   * commands as they now are, once the changes have settled.
   */
  private refresh(directory: string | null): void {
    const folders =
      directory === null
        ? [...new Set([...this.sessions.values()].map((session) => session.cwd))]
        : [directory]
    for (const cwd of folders) {
      this.offers.delete(cwd)
      if (this.refreshing.has(cwd)) continue
      const timer = setTimeout(() => {
        this.refreshing.delete(cwd)
        this.detached(this.republish(cwd))
      }, REFRESH_MS)
      timer.unref?.()
      this.refreshing.set(cwd, timer)
    }
  }

  private async republish(cwd: string): Promise<void> {
    const open = (): Session[] =>
      [...this.sessions.values()].filter(
        (session) => session.cwd === cwd && !session.hidden && !session.listed,
      )
    if (this.done || open().length === 0) return
    let offer: Offer
    try {
      offer = await this.offer(cwd)
    } catch (error) {
      this.hooks.log('warn', `Could not read what OpenCode offers: ${(error as Error).message}`)
      return
    }
    for (const session of open()) {
      const changes = session.parentId
        ? { config: this.config(session, offer) }
        : { config: this.config(session, offer), commands: this.commands(offer) }
      this.deliver(session.id, { patches: [{ op: 'session.update', changes }], effects: [] })
    }
  }

  private commands(offer: Offer): SlashCommand[] {
    const listed = offer.commands
      .filter((command) => command.name !== COMPACT)
      .map((command) => ({ name: command.name, description: command.description ?? '' }))
    return [...listed, { name: COMPACT, description: t('opencode.command.compact') }]
  }

  // Sessions.

  private open(id: string, cwd: string, options: SessionOptions, parentId: string | null): Session {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const session: Session = {
      id,
      cwd,
      mapper: new SessionMapper(cwd),
      parentId,
      chosen: { model: null, agent: null },
      turn: null,
      running: false,
      stopping: false,
      sending: false,
      hidden: options.hidden !== undefined,
      listed: false,
      requests: new Map(),
      collected: null,
      stepModel: null,
      spent: null,
      ahead: null,
      counted: new Set(),
    }
    this.sessions.set(id, session)
    return session
  }

  private choose(session: Session, info: SessionInfo): void {
    session.chosen = {
      model: info.model
        ? {
            id: info.model.id,
            providerID: info.model.providerID,
            ...(info.model.variant && info.model.variant !== DEFAULT_EFFORT
              ? { variant: info.model.variant }
              : {}),
          }
        : null,
      agent: info.agent ?? null,
    }
  }

  /** Gives a session what Kettu adds to it: its MCP servers, its instructions and its commands. */
  private async attach(
    session: Session,
    options: SessionOptions,
    fresh: boolean,
  ): Promise<ConfigOption[]> {
    const offer = await this.offer(session.cwd)
    if (!session.hidden) {
      await this.mount(session.cwd, options.mcpServers ?? [])
      await this.instruct(session, options, fresh)
      this.deliver(session.id, {
        patches: [{ op: 'session.update', changes: { commands: this.commands(offer) } }],
        effects: [],
      })
    }
    return this.config(session, offer)
  }

  /**
   * Adds the session's MCP servers to its folder on this server. OpenCode keeps them by name for
   * each folder and names the calling session on each tool call, so one that is already there as
   * given is left alone.
   */
  private async mount(cwd: string, servers: readonly McpServer[]): Promise<void> {
    let mounted = this.mounted.get(cwd)
    if (!mounted) {
      mounted = new Map()
      this.mounted.set(cwd, mounted)
    }
    for (const server of servers) {
      const config = mcpConfig(server)
      if (!config) continue
      const signature = JSON.stringify(config)
      if (mounted.get(server.name) === signature) continue
      try {
        await this.call(
          'PUT',
          `/api/experimental/mcp/${encodeURIComponent(server.name)}?${locationQuery(cwd)}`,
          { config },
          // Headers and variables hold tokens, which stay out of the records.
          { config: { type: config.type, ...(server.type === 'http' ? { url: server.url } : {}) } },
        )
        mounted.set(server.name, signature)
      } catch (error) {
        this.hooks.log(
          'warn',
          `OpenCode did not take the MCP server ${server.name}: ${(error as Error).message}`,
        )
      }
    }
  }

  /**
   * Puts Kettu's guide and memory into the session's own instructions, where they outlast a
   * compaction and leave the user's messages as written. A session whose instructions cannot
   * take them gets them ahead of its next prompt instead.
   */
  private async instruct(session: Session, options: SessionOptions, fresh: boolean): Promise<void> {
    if (options.promptAhead) return
    const text = instructionsFor(options)
    const route = `/api/experimental/session/${session.id}/instructions/entries`
    try {
      let current: string | null = null
      if (!fresh) {
        const entries = await this.api.request<{ data?: { key: string; value: unknown }[] }>(
          'GET',
          route,
        )
        const entry = entries?.data?.find((item) => item.key === INSTRUCTIONS_KEY)
        current = typeof entry?.value === 'string' ? entry.value : null
      }
      if (text === current) return
      if (text === null) await this.call('DELETE', `${route}/${INSTRUCTIONS_KEY}`)
      else await this.call('PUT', `${route}/${INSTRUCTIONS_KEY}`, { value: text })
    } catch (error) {
      this.hooks.log(
        'warn',
        `OpenCode did not take the session's instructions: ${(error as Error).message}`,
      )
      session.ahead = text
    }
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    if (options.hidden === 'options') {
      // The lists answer without a session, so none is made only to read them.
      const offer = await this.offer(cwd, true)
      const session = this.open(`kettu-options-${++this.listings}`, cwd, options, null)
      session.listed = true
      return { sessionId: session.id, config: this.config(session, offer) }
    }
    const made = await this.call<{ data: SessionInfo }>('POST', '/api/session', {
      location: { directory: cwd },
    })
    const session = this.open(made.data.id, cwd, options, null)
    this.choose(session, made.data)
    return { sessionId: session.id, config: await this.attach(session, options, true) }
  }

  /** A session OpenCode has, opened here again as it stands there. */
  private async existing(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
  ): Promise<Session> {
    const info = await this.call<{ data: SessionInfo }>('GET', `/api/session/${sessionId}`)
    const session = this.open(sessionId, cwd, options, null)
    session.hidden = options.hidden !== undefined
    this.choose(session, info.data)
    return session
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const session = await this.existing(sessionId, cwd, options)
    const config = await this.attach(session, options, false)
    void this.waiting(session)
    return { config }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const session = await this.existing(sessionId, cwd, options)
    for (const message of await this.messages(sessionId)) {
      this.deliver(sessionId, (ctx) => session.mapper.message(message, ctx))
    }
    const config = await this.attach(session, options, false)
    void this.waiting(session)
    return { config }
  }

  /** A session's messages, oldest first: all of them, or only the latest page. */
  private async messages(sessionId: string, latest = false): Promise<MessageInfo[]> {
    type Page = { data?: MessageInfo[]; cursor?: { next?: string | null } }
    const route = `/api/session/${sessionId}/message`
    if (latest) {
      const page = await this.api.request<Page>('GET', `${route}?limit=${MESSAGE_PAGE}`)
      return [...(page?.data ?? [])].reverse()
    }
    const all: MessageInfo[] = []
    let query = `order=asc&limit=${MESSAGE_PAGE}`
    for (;;) {
      const page = await this.api.request<Page>('GET', `${route}?${query}`).catch((error) => {
        throw this.requestError(error)
      })
      const items = page?.data ?? []
      all.push(...items)
      // A full page always names a next one; the end shows as an empty page.
      const next = page?.cursor?.next
      if (items.length === 0 || !next) return all
      query = `cursor=${encodeURIComponent(next)}`
    }
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    const before = point ? await this.forkBefore(sessionId, point) : null
    const made = await this.call<{ data: SessionInfo }>(
      'POST',
      `/api/session/${sessionId}/fork`,
      before ? { before } : {},
    )
    const fork = made.data
    try {
      if (path.resolve(fork.location.directory) !== path.resolve(cwd)) {
        await this.call('POST', `/api/session/${fork.id}/move`, { directory: cwd })
      }
    } catch (error) {
      await this.api.request('DELETE', `/api/session/${fork.id}`).catch(() => {})
      throw error
    }
    const session = this.open(fork.id, cwd, options, null)
    this.choose(session, fork)
    return { sessionId: fork.id, config: await this.attach(session, options, false) }
  }

  /**
   * The message a fork that ends with the reply `point` names is taken before: the one after
   * that reply's turn marker, or null when nothing follows and the whole session is copied.
   */
  private async forkBefore(sessionId: string, point: ForkPoint): Promise<string | null> {
    const messages = await this.messages(sessionId)
    let index = messages.findIndex((message) => message.id === assistantMessageId(point.messageId))
    if (index < 0) {
      // A reply an earlier connection gave another id is found by its text.
      let seen = 0
      index = messages.findIndex((message) => {
        if (message.type !== 'assistant') return false
        const said = message.content.some(
          (part) => part.type === 'text' && part.text.trim() === point.text.trim(),
        )
        return said && ++seen === point.occurrence
      })
    }
    if (index < 0) {
      throw new AgentRequestError('agent_error', t('opencode.replyGone'))
    }
    let next = index + 1
    if (messages[next]?.type === 'idle') next++
    return messages[next]?.id ?? null
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.running && !session.listed) {
      await this.api.request('POST', `/api/session/${sessionId}/interrupt`).catch(() => {})
    }
    this.forget(sessionId)
  }

  private forget(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.withdraw(session, 'The session closed')
    this.sessions.delete(sessionId)
    this.dropPending(sessionId)
    for (const child of [...this.sessions.values()]) {
      if (child.parentId === sessionId) this.forget(child.id)
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.call('DELETE', `/api/session/${sessionId}`)
    this.forget(sessionId)
  }

  async removeHidden(sessionId: string, log: (message: string) => void): Promise<void> {
    const session = this.sessions.get(sessionId)
    this.closedSession(sessionId)
    this.forget(sessionId)
    if (session?.listed) return
    try {
      await this.api.request('DELETE', `/api/session/${sessionId}`)
    } catch (error) {
      if (!this.done) log(`Could not remove the session ${sessionId}: ${(error as Error).message}`)
    }
  }

  async listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    const query = cursor
      ? `cursor=${encodeURIComponent(cursor)}`
      : `directory=${encodeURIComponent(cwd)}&parentID=null&limit=${MESSAGE_PAGE}`
    const page = await this.call<{ data?: SessionInfo[]; cursor?: { next?: string | null } }>(
      'GET',
      `/api/session?${query}`,
    )
    const items = page?.data ?? []
    return {
      sessions: items
        .filter((item) => !item.parentID && this.sessions.get(item.id)?.hidden !== true)
        .map((item) => ({
          sessionId: item.id,
          title: item.title ?? null,
          updatedAt: new Date(item.time.updated).toISOString(),
          cwd: item.location.directory,
        })),
      // OpenCode names a next page whenever it answers; only a full page has one.
      nextCursor: items.length >= MESSAGE_PAGE ? (page?.cursor?.next ?? null) : null,
    }
  }

  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.unregistered.delete(sessionId)
    const early = this.pending.get(sessionId)
    if (!early) return
    this.pending.delete(sessionId)
    this.pendingCount -= early.length
    for (const map of early) {
      const output = map(target.context())
      if (output) target.apply(output)
    }
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
    this.dropPending(sessionId)
    this.closedSession(sessionId)
  }

  /** Notes a session Kettu closed, whose late events are dropped rather than kept. */
  private closedSession(sessionId: string): void {
    this.unregistered.add(sessionId)
    if (this.unregistered.size > CLOSED_SESSIONS) {
      this.unregistered.delete(this.unregistered.values().next().value!)
    }
  }

  reopen(sessionId: string): void {
    this.unregistered.delete(sessionId)
  }

  rootOf(id: string): string {
    let current = id
    for (let depth = 0; depth < 16; depth++) {
      const parent = this.sessions.get(current)?.parentId
      if (!parent) break
      current = parent
    }
    return current
  }

  private dropPending(sessionId: string): void {
    const held = this.pending.get(sessionId)
    if (!held) return
    this.pending.delete(sessionId)
    this.pendingCount -= held.length
  }

  // Turns.

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const session = this.require(sessionId)
    if (session.turn && !session.turn.own) {
      throw new AgentRequestError('agent_error', 'A turn is already running')
    }
    await this.streaming()
    const result = new Promise<PromptResult>((resolve, reject) => {
      const running = session.turn
      if (running) {
        // The prompt crossed a turn OpenCode started itself: it joins it, and ends with it.
        running.own = false
        running.resolve = resolve
        running.reject = reject
        this.deliver(sessionId, agentTurn('joined'))
      } else {
        session.turn = this.turn(resolve, reject, false)
      }
    })
    const turn = session.turn!
    session.stopping = false
    let sent: Sent
    session.sending = true
    try {
      sent = await this.send(session, prompt, null)
    } catch (error) {
      if (session.turn === turn && !session.running) session.turn = null
      else if (session.turn === turn) this.ownTurn(session, turn)
      throw error
    } finally {
      session.sending = false
    }
    if (sent.answer !== null && !session.hidden) {
      const answer = sent.answer
      this.deliver(sessionId, (ctx) => session.mapper.say(ctx, answer))
    }
    if (!sent.turn && session.turn === turn && !session.running) {
      // Nothing of OpenCode's runs for the command, so no event will end its turn.
      session.turn = null
      session.stopping = false
      return { stopReason: 'end_turn', tokens: null, models: [] }
    }
    return result
  }

  private turn(
    resolve: (result: PromptResult) => void,
    reject: (error: Error) => void,
    own: boolean,
  ): Turn {
    return {
      resolve,
      reject,
      tokens: null,
      models: new Map(),
      own,
      finish: null,
      since: Date.now(),
    }
  }

  /** Hands a turn that goes on without its prompt back to the thread as OpenCode's own. */
  private ownTurn(session: Session, turn: Turn): void {
    turn.own = true
    turn.resolve = (result) => this.deliver(session.id, agentTurn('ended', result))
    turn.reject = (error) => this.deliver(session.id, agentTurn('failed', undefined, error))
  }

  /** Sends a prompt: a slash command through its own request, anything else as a message. */
  private async send(
    session: Session,
    prompt: readonly PromptBlock[],
    delivery: 'steer' | null,
  ): Promise<Sent> {
    const input = await promptInput(prompt)
    const route = `/api/session/${session.id}`
    const command = input.files.length === 0 ? parseCommand(input.text) : null
    if (command?.name === COMPACT) {
      await this.call('POST', `${route}/compact`, {})
      return TURN
    }
    if (command) {
      const offer = await this.offer(session.cwd)
      if (offer.commands.some((item) => item.name === command.name)) {
        const ran = await this.run(session, command)
        if (ran) return ran
      }
    }
    const ahead = session.ahead
    session.ahead = null
    const text = ahead ? `<kettu-guide>\n${ahead}\n</kettu-guide>\n\n${input.text}` : input.text
    const body = (files: PromptFile[], said: string): Record<string, unknown> => ({
      text: said,
      ...(files.length > 0 ? { files } : {}),
      ...(delivery ? { delivery } : {}),
    })
    const shown = (files: PromptFile[], said: string): Record<string, unknown> => ({
      ...body([], said),
      ...(files.length > 0
        ? { files: files.map((file) => ({ name: file.name, inline: file.source !== undefined })) }
        : {}),
    })
    try {
      await this.call('POST', `${route}/prompt`, body(input.files, text), shown(input.files, text))
    } catch (error) {
      const linked = input.files.filter((file) => file.source === undefined)
      const unread = (error as AgentRequestError).data as { tag?: string } | undefined
      if (linked.length === 0 || unread?.tag !== 'InvalidRequestError') {
        session.ahead = ahead
        throw error
      }
      // A linked file OpenCode cannot read goes as its path instead.
      const inline = input.files.filter((file) => file.source !== undefined)
      const named = withNamed(
        text,
        linked.map((file) => localPath(file.uri) ?? file.uri),
      )
      await this.call('POST', `${route}/prompt`, body(inline, named), shown(inline, named))
    }
    return TURN
  }

  /**
   * Runs one of OpenCode's commands. Most start a turn, as a prompt does. One may also take
   * effect without a turn, as clearing a goal does, or only answer in its own words, as it does
   * when there is no goal to clear: OpenCode shows that as a notice, and nothing of it enters the
   * session. Null for a command the folder no longer has, which then goes as the user's words.
   */
  private async run(
    session: Session,
    command: { name: string; text: string },
  ): Promise<Sent | null> {
    try {
      await this.call('POST', `/api/session/${session.id}/command`, command)
    } catch (error) {
      const tag = ((error as AgentRequestError).data as { tag?: string } | undefined)?.tag
      if (tag === 'CommandExecutionError') return { turn: false, answer: (error as Error).message }
      if (tag === 'CommandNotFoundError') return null
      throw error
    }
    return (await this.runsNothing(session)) ? { turn: false, answer: null } : TURN
  }

  /** Whether OpenCode has nothing to run for the session: no loop, and nothing in its inbox. */
  private async runsNothing(session: Session): Promise<boolean> {
    if (session.running) return false
    try {
      const [inbox, active] = await Promise.all([
        this.api.request<{ data?: unknown[] }>('GET', `/api/session/${session.id}/inbox`),
        this.api.request<{ data?: Record<string, unknown> }>('GET', '/api/session/active'),
      ])
      const waiting = (inbox?.data ?? []).length > 0
      const runs = active?.data !== undefined && session.id in active.data
      return !waiting && !runs && !session.running
    } catch {
      // A turn that does run then shows as one OpenCode started itself.
      return true
    }
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const session = this.require(sessionId)
    const texts: string[] = []
    session.collected = texts
    try {
      await this.prompt(sessionId, [{ type: 'text', text }])
    } finally {
      session.collected = null
    }
    return texts
  }

  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    const session = this.sessions.get(sessionId)
    if (!session?.running || !session.turn || this.done) return 'promptRequired'
    const text = prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    // A command is a turn of its own.
    if (prompt.every((block) => block.type === 'text') && parseCommand(text)) {
      return 'promptRequired'
    }
    await this.send(session, prompt, 'steer')
    return 'injected'
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.listed) return
    const answer = await this.call<{ interrupted?: boolean }>(
      'POST',
      `/api/session/${sessionId}/interrupt`,
    )
    if (answer?.interrupted === true || !session.turn || session.running) return
    if (session.sending || !(await this.runsNothing(session))) {
      // A prompt on its way, or one OpenCode took but has not started, is stopped once it starts.
      session.stopping = true
      return
    }
    // Nothing runs for the turn, so no event will end it.
    const turn = session.turn
    if (!turn || session.running) return
    session.turn = null
    turn.resolve({ stopReason: 'cancelled', tokens: turn.tokens, models: [] })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.setConfigOption(sessionId, CONFIG.mode, modeId)
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const session = this.require(sessionId, true)
    if (typeof value !== 'string') {
      throw new AgentRequestError('agent_error', t('agentRun.takesChoice', { option: optionId }))
    }
    const offer = await this.offer(session.cwd)
    const route = `/api/session/${sessionId}`
    const current = session.chosen.model ?? offer.defaultModel
    switch (optionId) {
      case CONFIG.model: {
        const model = findModel(offer.models, value)
        if (!model) throw new AgentRequestError('agent_error', t('agentRun.noModel', { value }))
        // An effort the new model also has is kept; any other falls back to its default.
        const variant = current?.variant
        const kept = variant && model.variants?.some((item) => item.id === variant) ? variant : null
        const next: ModelRef = {
          id: model.id,
          providerID: model.providerID,
          ...(kept ? { variant: kept } : {}),
        }
        if (!session.listed) await this.call('POST', `${route}/model`, { model: next })
        session.chosen = { ...session.chosen, model: next }
        break
      }
      case CONFIG.effort: {
        const model = current ? findModel(offer.models, modelValue(current)) : null
        const known = value === DEFAULT_EFFORT || model?.variants?.some((item) => item.id === value)
        if (!current || !known) {
          throw new AgentRequestError('agent_error', t('agentRun.noEffort', { value }))
        }
        const next: ModelRef = {
          id: current.id,
          providerID: current.providerID,
          ...(value !== DEFAULT_EFFORT ? { variant: value } : {}),
        }
        if (!session.listed) await this.call('POST', `${route}/model`, { model: next })
        session.chosen = { ...session.chosen, model: next }
        break
      }
      case CONFIG.mode: {
        if (!modes(offer.agents).some((agent) => agent.id === value)) {
          throw new AgentRequestError('agent_error', t('agentRun.noMode', { value }))
        }
        if (!session.listed) await this.call('POST', `${route}/agent`, { agent: value })
        session.chosen = { ...session.chosen, agent: value }
        break
      }
      default:
        throw new AgentRequestError('agent_error', t('agentRun.noOption', { option: optionId }))
    }
    return this.config(session, offer)
  }

  // The event stream.

  private streaming(): Promise<void> {
    if (this.done) return Promise.reject(new AgentRequestError('closed', 'OpenCode stopped'))
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AgentRequestError('agent_error', t('opencode.noEvents'))),
        STREAM_WAIT_MS,
      )
    })
    return Promise.race([this.up, late]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  private async listen(): Promise<void> {
    let attempt = 0
    while (!this.done) {
      let opened = false
      try {
        await this.api.events((event) => {
          const seenAt = this.seenAt
          this.seenAt = Date.now()
          if (event.type === 'server.connected') {
            opened = true
            attempt = 0
            this.connected(seenAt)
            return
          }
          try {
            this.onEvent(event)
          } catch (error) {
            this.hooks.log('error', `OpenCode event ${event.type}: ${(error as Error).message}`)
          }
        }, this.stream.signal)
      } catch (error) {
        if (!this.done) {
          this.hooks.log('warn', `OpenCode's event stream dropped: ${(error as Error).message}`)
        }
      }
      if (this.done) return
      if (opened) this.up = new Promise((resolve) => (this.streamIsUp = resolve))
      const wait = RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)]!
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  /** The stream is open. One that opened before dropped after the event that came at `seenAt`. */
  private connected(seenAt: number): void {
    const again = this.streamed
    this.streamed = true
    this.streamIsUp()
    if (!again) return
    this.refresh(null)
    for (const session of [...this.sessions.values()]) {
      if (!session.listed) void this.resync(session, seenAt - CLOCK_SLACK_MS)
    }
  }

  /**
   * Catches a session up after the stream dropped: what its latest messages hold, whether its
   * loop still runs, and the requests that wait for the user.
   */
  private async resync(session: Session, since: number): Promise<void> {
    try {
      const [messages, active] = await Promise.all([
        this.messages(session.id, true),
        this.api.request<{ data?: Record<string, unknown> }>('GET', '/api/session/active'),
      ])
      if (!this.sessions.has(session.id)) return
      const turn = session.turn
      if (!session.hidden) {
        // Only what was not whole when the stream was last heard: the thread has the rest, some
        // of it under ids an earlier connection gave it.
        for (const message of messages) {
          const missed =
            message.type === 'assistant'
              ? (message.time?.completed ?? Infinity) >= since
              : message.type === 'compaction' &&
                (message.status === 'running' || (message.time?.created ?? 0) >= since)
          if (!missed) continue
          this.deliver(session.id, (ctx) => session.mapper.message(message, ctx, true))
        }
      }
      for (const message of messages) {
        if (message.type !== 'assistant' || session.counted.has(message.id)) continue
        if (!turn || (message.time?.created ?? 0) < turn.since) continue
        if (message.time?.completed === undefined) continue
        this.count(session, message.id, message.model ?? null, message.tokens)
        if (message.finish) turn.finish = message.finish
      }
      const runs = active?.data !== undefined && session.id in active.data
      if (session.running && !runs) {
        const last = [...messages].reverse().find((message) => message.type === 'idle')
        const idle = last?.type === 'idle' ? last : null
        this.ended(session, idle?.outcome ?? 'succeeded', idle?.error)
      } else if (!session.running && runs) {
        this.started(session)
      }
      if (runs) await this.waiting(session)
    } catch (error) {
      if (!this.done) {
        this.hooks.log(
          'warn',
          `Could not catch up on the OpenCode session ${session.id}: ${(error as Error).message}`,
        )
      }
    }
  }

  /** Asks the user again for what a session still waits on. */
  private async waiting(session: Session): Promise<void> {
    if (session.hidden) return
    try {
      const route = `/api/session/${session.id}`
      const [permissions, forms] = await Promise.all([
        this.api.request<{ data?: PermissionRequestInfo[] }>('GET', `${route}/permission`),
        this.api.request<{ data?: FormInfo[] }>('GET', `${route}/form`),
      ])
      for (const request of permissions?.data ?? []) {
        if (!session.requests.has(request.id)) this.detached(this.ask(session, request))
      }
      for (const form of forms?.data ?? []) {
        if (!session.requests.has(form.id)) this.detached(this.fill(session, form))
      }
    } catch (error) {
      if (!this.done) {
        this.hooks.log(
          'warn',
          `Could not read what OpenCode waits for: ${(error as Error).message}`,
        )
      }
    }
  }

  private onEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'model.updated':
      case 'agent.updated':
      case 'command.updated':
      case 'provider.updated':
      case 'config.updated':
        this.refresh(event.location?.directory ?? null)
        return
    }
    const sessionId = sessionOf(event)
    if (!sessionId) return
    const data = <K extends EventType>(): EventData[K] => (event.data ?? {}) as EventData[K]
    if (event.type === 'session.created') this.created(data<'session.created'>())
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.hooks.traffic('in', event)
    switch (event.type as EventType) {
      case 'session.execution.started':
        this.started(session)
        break
      case 'session.execution.succeeded':
        this.ended(session, 'succeeded', undefined)
        break
      case 'session.execution.interrupted':
        this.ended(session, 'interrupted', undefined)
        break
      case 'session.execution.failed':
        this.ended(session, 'failed', data<'session.execution.failed'>().error)
        break
      case 'session.step.started': {
        const model = data<'session.step.started'>().model
        session.stepModel = model ? modelValue(model) : null
        // The context is the running model's, also for a subagent and after a switch.
        const known = model
          ? findModel(this.offers.get(session.cwd)?.offer.models ?? [], modelValue(model))
          : null
        session.mapper.window(known?.limit?.context ?? null)
        break
      }
      case 'session.step.ended': {
        const step = data<'session.step.ended'>()
        this.count(session, step.assistantMessageID, null, step.tokens)
        if (session.turn && step.finish) session.turn.finish = step.finish
        break
      }
      case 'session.step.failed': {
        const step = data<'session.step.failed'>()
        this.count(session, step.assistantMessageID, null, step.tokens)
        break
      }
      case 'session.model.selected': {
        const { model } = data<'session.model.selected'>()
        session.chosen = {
          ...session.chosen,
          model: {
            id: model.id,
            providerID: model.providerID,
            ...(model.variant && model.variant !== DEFAULT_EFFORT
              ? { variant: model.variant }
              : {}),
          },
        }
        this.publishConfig(session)
        break
      }
      case 'session.agent.selected':
        session.chosen = { ...session.chosen, agent: data<'session.agent.selected'>().agent }
        this.publishConfig(session)
        break
      case 'session.tool.progress':
        this.progress(session, data<'session.tool.progress'>())
        break
      case 'permission.asked':
        this.detached(this.ask(session, data<'permission.asked'>()))
        return
      case 'permission.replied':
        this.answered(session, data<'permission.replied'>().requestID)
        return
      case 'form.created':
        this.detached(this.fill(session, data<'form.created'>().form))
        return
      case 'form.replied':
      case 'form.cancelled':
        this.answered(session, data<'form.replied'>().id)
        return
      case 'session.deleted':
        this.forget(session.id)
        return
    }
    this.map(session, event)
  }

  private map(session: Session, event: ServerEvent): void {
    if (session.collected) {
      if (event.type === 'session.text.ended') {
        const { text } = (event.data ?? {}) as EventData['session.text.ended']
        if (text) session.collected.push(text)
      }
      return
    }
    if (session.hidden) return
    const target = this.targets.get(session.id)
    if (!target) {
      this.hold(session.id, (ctx) => session.mapper.event(event, ctx))
      return
    }
    const output = session.mapper.event(event, target.context())
    if (output) target.apply(output)
  }

  /** A session OpenCode made under one Kettu has: a subagent's, which shows as its own session. */
  private created(data: EventData['session.created']): void {
    const parent = data.parentID ? this.sessions.get(data.parentID) : undefined
    if (!parent || parent.hidden || this.sessions.has(data.sessionID)) return
    const child = this.open(data.sessionID, parent.cwd, {}, parent.id)
    child.chosen = { ...parent.chosen }
    this.deliver(this.rootOf(parent.id), {
      patches: [],
      effects: [
        {
          kind: 'subagent',
          sessionId: child.id,
          title: data.title ?? null,
          canCancel: true,
          state: { kind: 'running' },
        },
      ],
    })
  }

  /** A subagent call names the session it started, which then takes what the call says of it. */
  private progress(session: Session, data: EventData['session.tool.progress']): void {
    const childId = data.metadata?.sessionID
    if (typeof childId !== 'string' || !session.mapper.startsSubagent(data.id)) return
    if (this.sessions.get(childId)?.parentId !== session.id) return
    const agent = session.mapper.subagentAgent(data.id)
    if (!agent) return
    this.deliver(this.rootOf(session.id), {
      patches: [],
      effects: [{ kind: 'subagent', sessionId: childId, description: agent }],
    })
  }

  private started(session: Session): void {
    session.running = true
    session.spent = null
    if (session.stopping) {
      session.stopping = false
      void this.api.request('POST', `/api/session/${session.id}/interrupt`).catch(() => {})
    }
    if (session.parentId) {
      this.deliver(this.rootOf(session.id), {
        patches: [],
        effects: [{ kind: 'subagent', sessionId: session.id, state: { kind: 'running' } }],
      })
      return
    }
    if (session.turn || session.hidden) return
    session.turn = this.turn(
      () => {},
      () => {},
      true,
    )
    this.ownTurn(session, session.turn)
    this.deliver(session.id, agentTurn('started'))
  }

  private ended(
    session: Session,
    outcome: 'succeeded' | 'failed' | 'interrupted',
    error: StructuredError | undefined,
  ): void {
    session.running = false
    session.stopping = false
    this.withdraw(session, 'The turn ended')
    if (session.parentId) {
      this.deliver(this.rootOf(session.id), {
        patches: [],
        effects: [
          {
            kind: 'subagent',
            sessionId: session.id,
            state: {
              kind: 'idle',
              stopReason:
                outcome === 'interrupted'
                  ? 'cancelled'
                  : outcome === 'failed'
                    ? 'error'
                    : 'end_turn',
              error:
                outcome === 'failed'
                  ? { message: error?.message || t('session.subagent.failed') }
                  : null,
              tokens: session.spent,
            },
          },
        ],
      })
      session.spent = null
      return
    }
    const turn = session.turn
    session.turn = null
    if (!turn) return
    if (outcome === 'failed') {
      turn.reject(turnError(error))
      return
    }
    const models: ModelTokens[] = [...turn.models].map(([model, tokens]) => ({ model, tokens }))
    turn.resolve({ stopReason: stopReason(outcome, turn.finish), tokens: turn.tokens, models })
  }

  /** Adds a request's tokens to the turn, once for each assistant message. */
  private count(
    session: Session,
    messageId: string,
    model: ModelRef | null,
    usage: Parameters<typeof tokenTotals>[0],
  ): void {
    const tokens = tokenTotals(usage)
    if (!tokens || session.counted.has(messageId)) return
    session.counted.add(messageId)
    if (session.parentId) {
      session.spent = addTokenTotals(session.spent, tokens)
      return
    }
    const turn = session.turn
    if (!turn) return
    turn.tokens = addTokenTotals(turn.tokens, tokens)
    const name = model ? modelValue(model) : session.stepModel
    if (name) turn.models.set(name, addTokenTotals(turn.models.get(name) ?? null, tokens))
  }

  private publishConfig(session: Session): void {
    if (session.hidden) return
    const known = this.offers.get(session.cwd)?.offer
    if (!known) return
    this.deliver(session.id, {
      patches: [{ op: 'session.update', changes: { config: this.config(session, known) } }],
      effects: [],
    })
  }

  private deliver(sessionId: string, output: MapperOutput | Deferred): void {
    const map: Deferred = typeof output === 'function' ? output : () => output
    const target = this.targets.get(sessionId)
    if (!target) {
      this.hold(sessionId, map)
      return
    }
    const mapped = map(target.context())
    if (mapped) target.apply(mapped)
  }

  /** Keeps what a session without a target got, as a subagent's first events, for when it has one. */
  private hold(sessionId: string, map: Deferred): void {
    if (this.unregistered.has(sessionId) || this.pendingCount >= PENDING_EVENTS) return
    const list = this.pending.get(sessionId) ?? []
    list.push(map)
    this.pending.set(sessionId, list)
    this.pendingCount++
  }

  // What OpenCode asks.

  /** Takes back the cards of requests that no longer wait: answered elsewhere, or their turn over. */
  private withdraw(session: Session, reason: string): void {
    for (const abort of session.requests.values()) abort.abort(new Error(reason))
    session.requests.clear()
  }

  private answered(session: Session, requestId: string): void {
    session.requests.get(requestId)?.abort(new Error('Answered elsewhere'))
    session.requests.delete(requestId)
  }

  private async ask(session: Session, request: PermissionRequestInfo): Promise<void> {
    const route = `/api/session/${session.id}/permission/${request.id}/reply`
    const target = this.targets.get(session.id)
    if (!target || session.hidden) {
      // Never approve without the user: nobody can answer for a session no thread shows.
      this.hooks.log('warn', `Permission request for a session without a thread: ${session.id}`)
      await this.api.request('POST', route, { decision: 'reject' }).catch(() => {})
      return
    }
    const { callId, output } = session.mapper.asked(request, target.context())
    const saved = (request.save ?? []).filter((pattern) => pattern !== '')
    const options: PermissionOption[] = [
      { id: OPTION.allow, name: t('permission.allowOnce'), kind: 'allow_once' },
      ...(saved.length > 0
        ? [
            {
              id: OPTION.always,
              name: t('permission.allowAlways', {
                changes: saved
                  .map((pattern) => `\`${pattern}\``)
                  .join(t('permission.listSeparator')),
              }),
              kind: 'allow_always' as const,
            },
          ]
        : []),
      { id: OPTION.reject, name: t('dsh.permission.reject'), kind: 'reject_once' },
    ]
    const abort = new AbortController()
    session.requests.set(request.id, abort)
    let answer: PermissionAnswer
    try {
      answer = await target.requestPermission(
        { toolCallId: callId, toolEntryId: `t:${callId}`, output, options },
        abort.signal,
      )
    } catch {
      return
    } finally {
      if (session.requests.get(request.id) === abort) session.requests.delete(request.id)
    }
    const picked = optionAnswer(answer)
    const decision =
      picked === 'cancelled' || picked.optionId === OPTION.reject
        ? 'reject'
        : picked.optionId === OPTION.always
          ? 'always'
          : 'once'
    const note = picked !== 'cancelled' && decision === 'reject' ? picked.note?.trim() : undefined
    try {
      await this.call('POST', route, { decision, ...(note ? { message: note } : {}) })
    } catch (error) {
      this.hooks.log('warn', `OpenCode did not take the answer: ${(error as Error).message}`)
      return
    }
    const current = this.targets.get(session.id)
    if (current)
      current.apply(session.mapper.settle(callId, decision !== 'reject', current.context()))
  }

  private async fill(session: Session, form: FormInfo): Promise<void> {
    const route = `/api/session/${session.id}/form/${form.id}`
    const cancel = (): Promise<unknown> => this.api.request('DELETE', route).catch(() => {})
    const target = this.targets.get(session.id)
    const questions = formQuestions(form)
    const elicitation = questions ? null : formElicitation(form)
    if (!target || session.hidden || (!questions && !elicitation)) {
      if (target && !session.hidden) this.hooks.ignored(session.id, `form ${form.title}`)
      await cancel()
      return
    }
    const toolId = form.metadata?.tool?.id
    const callId = toolId ?? form.id
    const output: MapperOutput = toolId
      ? { patches: [], effects: [] }
      : session.mapper.formRow(form.id, form.title, target.context())
    const first = questions?.[0]
    const options: PermissionOption[] = questions
      ? [
          ...(first?.options ?? []).map((option, index) => ({
            id: `answer:${index}`,
            name: option.label,
            kind: 'allow_once' as const,
            ...(option.description ? { description: option.description } : {}),
          })),
          { id: OPTION.other, name: t('question.other'), kind: 'reject_once' as const },
        ]
      : elicitation?.kind === 'url'
        ? [
            { id: OPTION.allow, name: t('elicitation.open'), kind: 'allow_once' },
            { id: OPTION.reject, name: t('elicitation.decline'), kind: 'reject_once' },
          ]
        : [
            { id: OPTION.allow, name: t('elicitation.submit'), kind: 'allow_once' },
            { id: OPTION.reject, name: t('elicitation.decline'), kind: 'reject_once' },
          ]
    const abort = new AbortController()
    session.requests.set(form.id, abort)
    let answer: PermissionAnswer
    try {
      answer = await target.requestPermission(
        {
          toolCallId: callId,
          toolEntryId: `t:${callId}`,
          output,
          options,
          ...(questions ? { questions } : {}),
          ...(elicitation ? { elicitation } : {}),
        },
        abort.signal,
      )
    } catch {
      return
    } finally {
      if (session.requests.get(form.id) === abort) session.requests.delete(form.id)
    }
    let given: FormAnswer | null
    if (questions) given = questionAnswer(form, answer)
    else if (answer !== 'cancelled' && 'values' in answer) given = answer.values
    else if (
      elicitation?.kind === 'url' &&
      answer !== 'cancelled' &&
      'optionId' in answer &&
      answer.optionId === OPTION.allow
    ) {
      given = {}
    } else given = null
    let sent = false
    if (given) {
      try {
        await this.call('POST', `${route}/reply`, { answer: given })
        sent = true
      } catch (error) {
        this.hooks.log('warn', `OpenCode did not take the answer: ${(error as Error).message}`)
      }
    }
    if (!sent) await cancel()
    if (toolId) return
    const current = this.targets.get(session.id)
    if (current) current.apply(session.mapper.settle(callId, sent, current.context()))
  }

  // Helpers.

  /** Lets work nobody waits for fail quietly: once the connection closed, its requests all do. */
  private detached(work: Promise<unknown>): void {
    work.catch((error: unknown) => {
      if (!this.done) this.hooks.log('warn', (error as Error)?.message ?? String(error))
    })
  }

  /** The open session `sessionId` names; one that only lists options takes no turn. */
  private require(sessionId: string, listed = false): Session {
    if (this.done) throw new AgentRequestError('closed', 'OpenCode stopped')
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new AgentRequestError(
        'agent_error',
        t('agentRun.noSession', { id: sessionId }),
        NOT_FOUND,
      )
    }
    if (session.listed && !listed) {
      throw new AgentRequestError('agent_error', 'This session only lists options')
    }
    return session
  }
}
