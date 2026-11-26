// Kettu MCP 服务的 Bot 工具组：
// 1. 只读与调度工具：list_bots、list_bot_targets、dispatch_bot_session、read_bot_work、
//    send_to_bot_session、archive_bot_session、handoff_to_bot。
// 2. 受控自管理工具（D5 铁律）：create_bot、update_bot、delete_bot 在任何权限模式
//    （含 Full access）下都强制弹出 bot_change 交互确认卡片，单次限提议 1 个，用户不点确认绝不执行。

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { AgentStatus } from '@shared/agent-host'
import { isAgentId, type AgentId } from '@shared/agents'
import {
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_PRESETS,
  BOT_DESCRIPTION_CHARS,
  BOT_MAX_TARGETS,
  BOT_NAME_CHARS,
  BOT_ROLE_CHARS,
  isBotAvatarPalette,
  isBotAvatarPreset,
  isBotHandle,
  isBotTargetRef,
  normalizeBotLimits,
  slugifyBotHandle,
  type BotAvatar,
  type BotCardFields,
  type BotChangeAction,
  type BotChangeOutcome,
  type BotChanges,
  type BotDraft,
  type BotHostTarget,
  type BotList,
  type BotRequest,
  type BotTargetRef,
  type BotView,
} from '@shared/bots'
import { CONTROL_WAIT_MS } from '@shared/control'
import { TIME_LIMITS, type PermissionScope } from '@shared/routines'
import type { BotChangeEntry } from '@shared/thread'
import type { Caller } from '../artifacts/tools'

export const LIST_BOTS = 'list_bots'
export const LIST_BOT_TARGETS = 'list_bot_targets'
export const DISPATCH_BOT_SESSION = 'dispatch_bot_session'
export const READ_BOT_WORK = 'read_bot_work'
export const SEND_TO_BOT_SESSION = 'send_to_bot_session'
export const ARCHIVE_BOT_SESSION = 'archive_bot_session'
export const HANDOFF_TO_BOT = 'handoff_to_bot'
export const CREATE_BOT = 'create_bot'
export const UPDATE_BOT = 'update_bot'
export const DELETE_BOT = 'delete_bot'

export const BOT_TOOL_NAMES = [
  LIST_BOTS,
  LIST_BOT_TARGETS,
  DISPATCH_BOT_SESSION,
  READ_BOT_WORK,
  SEND_TO_BOT_SESSION,
  ARCHIVE_BOT_SESSION,
  HANDOFF_TO_BOT,
  CREATE_BOT,
  UPDATE_BOT,
  DELETE_BOT,
] as const

/** 无论任何权限模式（含 Full access）均强制弹确认卡片的工具。 */
export const BOT_ASKING_TOOLS = [CREATE_BOT, UPDATE_BOT, DELETE_BOT] as const

/** Bot 确认卡片等待超时（10 分钟）。 */
export const BOT_CHANGE_WAIT_MS = 10 * 60_000

const NAMES = new Set<string>(BOT_TOOL_NAMES)

export function isBotToolName(name: string): boolean {
  return NAMES.has(name)
}

const WAITS =
  'This action ALWAYS waits for the user to approve an interactive confirmation card in this ' +
  'session, even in Full access mode; nothing changes until they click confirm (declined or ' +
  'unanswered for 10 minutes cancels it). Propose at most one Bot change at a time. If this ' +
  'call returns saying the user has not answered yet, call it again with the same arguments to ' +
  'wait for the same card.'

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    hostId: {
      type: ['string', 'null'],
      description: 'Target computer hostId from list_bot_targets, or null for this computer.',
    },
    projectPath: {
      type: 'string',
      description: 'Project folder path on that computer.',
    },
    projectName: {
      type: 'string',
      description: 'Optional display name of the project.',
    },
  },
  required: ['hostId', 'projectPath'],
  additionalProperties: false,
}

const BOT_FIELDS_SCHEMA: Record<string, object> = {
  name: {
    type: 'string',
    minLength: 1,
    maxLength: BOT_NAME_CHARS,
    description: 'Display name of the Bot (1-60 characters).',
  },
  handle: {
    type: 'string',
    pattern: '^[a-z0-9][a-z0-9_-]{0,31}$',
    description: 'Unique lowercase @handle used to mention this Bot (e.g. dev, reviewer, oncall).',
  },
  description: {
    type: 'string',
    maxLength: BOT_DESCRIPTION_CHARS,
    description: 'Short one-line summary of what this Bot owns.',
  },
  agent: {
    type: 'string',
    description:
      'Agent id from list_agents for the Bot main conversation. Any enabled agent with MCP ' +
      'support is allowed; defaults to the calling session agent on create.',
  },
  model: {
    type: ['string', 'null'],
    description: 'Optional model id for the chosen agent.',
  },
  effort: {
    type: ['string', 'null'],
    description: 'Optional effort level for the chosen model.',
  },
  avatarPreset: {
    type: 'string',
    enum: [...BOT_AVATAR_PRESETS],
    description: 'Built-in illustrated Bot avatar preset.',
  },
  avatarPalette: {
    type: 'string',
    enum: [...BOT_AVATAR_PALETTES],
    description: 'Color palette for the Bot avatar.',
  },
  targets: {
    type: 'array',
    items: TARGET_SCHEMA,
    maxItems: BOT_MAX_TARGETS,
    description: 'List of computer + project targets this Bot manages.',
  },
  scope: {
    type: 'string',
    enum: ['read', 'edit', 'commands'],
    description:
      'Maximum permission level for work sessions dispatched by this Bot: read, edit or commands.',
  },
  web: {
    type: 'boolean',
    description: 'Whether work sessions dispatched by this Bot may access the web.',
  },
  maxConcurrent: {
    type: 'integer',
    minimum: 1,
    maximum: 20,
    description: 'Max concurrent work sessions for this Bot.',
  },
  maxDaily: {
    type: 'integer',
    minimum: 1,
    maximum: 500,
    description: 'Max daily dispatches for this Bot.',
  },
  timeLimitMinutes: {
    type: 'integer',
    enum: [...TIME_LIMITS],
    description: 'Per-session time limit in minutes.',
  },
  roleMarkdown: {
    type: 'string',
    maxLength: BOT_ROLE_CHARS,
    description: 'Detailed responsibilities, routing rules and workflow guidelines (ROLE.md).',
  },
}

export const BOT_TOOLS: Tool[] = [
  {
    name: LIST_BOTS,
    title: 'List Kettu Bots',
    description:
      'Lists all Bots on this Home Host with their ids, @handles, avatars, agents, status, ' +
      'managed targets and active work counts. Call this before creating or updating a Bot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: LIST_BOT_TARGETS,
    title: 'List cross-computer Bot targets',
    description:
      'Lists this computer (Home Host) and all paired remote computers with online status, ' +
      'projects, available agents and current active load for routing Bot work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: DISPATCH_BOT_SESSION,
    title: 'Dispatch a Bot work session',
    description:
      'Dispatches a real Kettu work session on this computer or a paired remote computer for a ' +
      'Bot. If the target computer is offline, saves a local pending item on Home Host without ' +
      'uploading prompt content to the cloud and notifies the user once it comes back online.',
    inputSchema: {
      type: 'object',
      properties: {
        botId: {
          type: 'string',
          description: 'Bot id (optional when called from the Bot main session).',
        },
        hostId: {
          type: ['string', 'null'],
          description: 'Target computer hostId from list_bot_targets, or null for this computer.',
        },
        projectPath: {
          type: 'string',
          description: 'Absolute project path on the target computer.',
        },
        title: { type: 'string', minLength: 1, maxLength: 120, description: 'Short task title.' },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 30_000,
          description: 'Self-contained instructions for the work session.',
        },
        agent: { type: 'string', description: 'Optional agent id on the target computer.' },
        model: { type: ['string', 'null'], description: 'Optional model id.' },
        scope: { type: 'string', enum: ['read', 'edit', 'commands'] },
        web: { type: 'boolean' },
        worktree: {
          type: 'boolean',
          description: 'Start the work session in an isolated git worktree.',
        },
        dedupKey: {
          type: 'string',
          maxLength: 120,
          description: 'Optional idempotency key to prevent duplicate dispatches.',
        },
      },
      required: ['projectPath', 'title', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: READ_BOT_WORK,
    title: 'Read Bot work ledger',
    description:
      'Reads active, queued, offline-pending and recently finished work sessions of a Bot.',
    inputSchema: {
      type: 'object',
      properties: {
        botId: {
          type: 'string',
          description: 'Bot id (optional when called from the Bot main session).',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: SEND_TO_BOT_SESSION,
    title: 'Send follow-up to a Bot work session',
    description: 'Sends a follow-up instruction to an active work session dispatched by a Bot.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'Work request id from dispatch_bot_session or read_bot_work.',
        },
        text: { type: 'string', minLength: 1, maxLength: 30_000 },
      },
      required: ['requestId', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: ARCHIVE_BOT_SESSION,
    title: 'Archive a finished Bot work session',
    description: 'Archives a completed Bot work session so the sidebar stays clean.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Work request id to archive.' },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: HANDOFF_TO_BOT,
    title: 'Hand off work to a Bot',
    description:
      'Hands off a task from the current session to a Kettu Bot (by botId or @handle). ' +
      'Requires Settings › Bots › allowAgentHandoff to be enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Target Bot id or @handle.' },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 12_000,
          description: 'Clear task description for the Bot.',
        },
        contextSummary: {
          type: 'string',
          maxLength: 4_000,
          description: 'Concise context summary from this session.',
        },
      },
      required: ['bot', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: CREATE_BOT,
    title: 'Create a Bot',
    description: `Proposes creating a new Kettu Bot on this Home Host when the user asks. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: BOT_FIELDS_SCHEMA,
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: UPDATE_BOT,
    title: 'Update a Bot',
    description: `Proposes updating an existing Bot's configuration or ROLE.md when the user asks. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot id or @handle to update.' },
        ...BOT_FIELDS_SCHEMA,
      },
      required: ['bot'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: DELETE_BOT,
    title: 'Delete a Bot',
    description:
      'Proposes deleting a Bot on this Home Host when the user asks. By default, historical ' +
      `work sessions are preserved as regular sessions (keepSessions: true). ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot id or @handle to delete.' },
        keepSessions: {
          type: 'boolean',
          description: 'Keep historical work sessions as normal sessions (default true).',
        },
      },
      required: ['bot'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
]

export type BotAsk = Pick<BotChangeEntry, 'action' | 'botId' | 'bot' | 'before' | 'sessions'>

export type BotAnswer =
  { decision: 'confirm'; keepSessions?: boolean } | { decision: 'decline' | 'expired' | 'ended' }

export interface BotToolsDeps {
  list(): Promise<BotList>
  get(botId: string): Promise<BotView>
  findByHandle(handle: string): BotView | null
  create(draft: BotDraft): Promise<BotView>
  update(botId: string, changes: BotChanges): Promise<BotView>
  delete(botId: string, keepSessions: boolean): Promise<void>
  listTargets(): Promise<BotHostTarget[]>
  dispatch(params: {
    botId: string
    targetHostId: string | null
    projectPath: string
    title: string
    prompt: string
    agentId?: AgentId
    model?: string | null
    scope?: PermissionScope
    worktree?: boolean
    dedupKey?: string | null
    source: { kind: 'main' | 'handoff'; sessionId: string; hostId: null }
  }): Promise<BotRequest>
  workOf(botId: string): Promise<BotRequest[]>
  sendToWorkSession(requestId: string, text: string): Promise<BotRequest>
  archiveRequest(requestId: string): Promise<BotRequest>
  handoff(params: {
    botId: string
    sessionId: string
    text: string
    contextSummary?: string
  }): Promise<{ botSessionId: string; entryId: string }>
  countSessions(botId: string): number
  allowAgentHandoff(): boolean
  botIdOfSession(sessionId: string): string | null
  sessionAgent(sessionId: string): AgentId | null
  agents(): readonly AgentStatus[]
  ask(
    sessionId: string,
    ask: BotAsk,
    waitMs: number,
  ): { entryId: string; answer: Promise<BotAnswer> } | null
  settle(sessionId: string, entryId: string, outcome: BotChangeOutcome): void
}

interface CardJob {
  key: string
  action: BotChangeAction
  name: string
  result: Promise<CallToolResult>
}

class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

function okResult(text: string, data?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(data ? { structuredContent: data } : {}),
  }
}

function errResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code: 'refused', message },
    isError: true,
  }
}

function toCardFields(view: BotView, keepSessions?: boolean): BotCardFields {
  return {
    name: view.name,
    handle: view.handle,
    description: view.description,
    avatar: view.avatar,
    agentId: view.agentId,
    model: view.model,
    effort: view.effort,
    targets: view.targets,
    scope: view.scope,
    limits: view.limits,
    roleMarkdown: view.roleMarkdown,
    ...(keepSessions !== undefined ? { keepSessions } : {}),
  }
}

function parseScopeArg(o: Record<string, unknown>, fallback: PermissionScope): PermissionScope {
  const level =
    o.scope === 'read' || o.scope === 'edit' || o.scope === 'commands' ? o.scope : fallback.level
  const web = typeof o.web === 'boolean' ? o.web : fallback.web
  return { level, web }
}

function parseAvatarArg(o: Record<string, unknown>, fallback: BotAvatar): BotAvatar {
  if (o.avatarPreset === undefined && o.avatarPalette === undefined) return fallback
  const preset = isBotAvatarPreset(o.avatarPreset)
    ? o.avatarPreset
    : fallback.kind === 'preset'
      ? fallback.preset
      : 'architect'
  const palette = isBotAvatarPalette(o.avatarPalette)
    ? o.avatarPalette
    : fallback.kind !== 'image'
      ? fallback.palette
      : 'fox'
  return { kind: 'preset', preset, palette }
}

export class BotTools {
  private readonly jobs = new Map<string, CardJob>()

  constructor(private readonly deps: BotToolsDeps) {}

  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (!isBotToolName(name)) throw new Error(`Unknown Bot tool ${name}`)
    const o =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    try {
      switch (name) {
        case LIST_BOTS:
          return await this.listBots()
        case LIST_BOT_TARGETS:
          return await this.listTargets()
        case DISPATCH_BOT_SESSION:
          return await this.dispatch(caller, o)
        case READ_BOT_WORK:
          return await this.readWork(caller, o)
        case SEND_TO_BOT_SESSION:
          return await this.sendToWork(o)
        case ARCHIVE_BOT_SESSION:
          return await this.archiveWork(o)
        case HANDOFF_TO_BOT:
          return await this.handoff(caller, o)
        case CREATE_BOT:
          return await this.proposeCreate(caller, o)
        case UPDATE_BOT:
          return await this.proposeUpdate(caller, o)
        case DELETE_BOT:
          return await this.proposeDelete(caller, o)
        default:
          return errResult(`Unknown tool ${name}`)
      }
    } catch (error) {
      if (error instanceof Refusal) return errResult(error.message)
      return errResult(error instanceof Error ? error.message : String(error))
    }
  }

  private async resolveBot(ref: unknown): Promise<BotView> {
    if (typeof ref !== 'string' || !ref.trim()) throw new Refusal('Missing bot id or @handle.')
    const clean = ref.trim().replace(/^@/, '')
    const byHandle = this.deps.findByHandle(clean)
    if (byHandle) return byHandle
    return this.deps.get(clean)
  }

  private resolveCallerBotId(caller: Caller, explicit: unknown): string {
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
    const own = this.deps.botIdOfSession(caller.sessionId)
    if (own) return own
    throw new Refusal('botId is required when calling outside a Bot main conversation.')
  }

  private async listBots(): Promise<CallToolResult> {
    const { bots } = await this.deps.list()
    if (bots.length === 0) return okResult('No Bots configured yet.', { bots: [] })
    const lines = bots.map(
      (b) =>
        `- ${b.name} (@${b.handle}, id=${b.id}, agent=${b.agentId}, status=${b.status}, active=${b.activeCount}, needsYou=${b.needsYouCount}, pendingHost=${b.pendingHostCount})`,
    )
    return okResult(lines.join('\n'), { bots })
  }

  private async listTargets(): Promise<CallToolResult> {
    const targets = await this.deps.listTargets()
    const lines = targets.map((t) => {
      const id = t.hostId ?? 'local'
      const projects = t.projects.map((p) => `${p.name} (${p.path})`).join(', ') || '(no projects)'
      const agents = t.agents.map((a) => `${a.id}${a.ready ? '' : ' [not ready]'}`).join(', ')
      return `- ${t.name} [hostId=${id}, ${t.platform}, ${t.online ? 'online' : 'offline'}]\n  projects: ${projects}\n  agents: ${agents}`
    })
    return okResult(lines.join('\n'), { targets })
  }

  private async dispatch(caller: Caller, o: Record<string, unknown>): Promise<CallToolResult> {
    const botId = this.resolveCallerBotId(caller, o.botId)
    if (typeof o.projectPath !== 'string' || !o.projectPath.trim()) {
      throw new Refusal('projectPath is required.')
    }
    if (typeof o.title !== 'string' || !o.title.trim()) throw new Refusal('title is required.')
    if (typeof o.prompt !== 'string' || !o.prompt.trim()) throw new Refusal('prompt is required.')
    const hostId = typeof o.hostId === 'string' && o.hostId.trim() ? o.hostId.trim() : null
    const agentId = typeof o.agent === 'string' && isAgentId(o.agent) ? o.agent : undefined
    const model = typeof o.model === 'string' ? o.model : o.model === null ? null : undefined
    const scope =
      o.scope !== undefined || o.web !== undefined
        ? parseScopeArg(o, { level: 'edit', web: true })
        : undefined
    const req = await this.deps.dispatch({
      botId,
      targetHostId: hostId,
      projectPath: o.projectPath.trim(),
      title: o.title.trim(),
      prompt: o.prompt.trim(),
      agentId,
      model,
      scope,
      worktree: o.worktree === true,
      dedupKey: typeof o.dedupKey === 'string' ? o.dedupKey : null,
      source: {
        kind: this.deps.botIdOfSession(caller.sessionId) === botId ? 'main' : 'handoff',
        sessionId: caller.sessionId,
        hostId: null,
      },
    })
    const msg =
      req.status === 'waiting_host'
        ? `Target computer "${req.targetHostName}" is offline. Saved locally as pending request ${req.id}; the user will be prompted to confirm dispatch when it comes back online.`
        : req.status === 'queued'
          ? `Concurrency limit reached. Queued request ${req.id} for "${req.title}" on ${req.targetHostName} / ${req.projectName}.`
          : req.status === 'failed'
            ? `Failed to dispatch "${req.title}": ${req.error ?? 'unknown error'}`
            : `Dispatched session ${req.sessionId ?? ''} (request ${req.id}) on ${req.targetHostName} / ${req.projectName}. Kettu will report back when it finishes; do not poll in a loop.`
    return okResult(msg, { request: req })
  }

  private async readWork(caller: Caller, o: Record<string, unknown>): Promise<CallToolResult> {
    const botId = this.resolveCallerBotId(caller, o.botId)
    const items = await this.deps.workOf(botId)
    if (items.length === 0) return okResult('This Bot has no work items yet.', { requests: [] })
    const lines = items.slice(0, 30).map((r) => {
      const tail = r.error
        ? ` — error: ${r.error}`
        : r.summary
          ? ` — ${r.summary.slice(0, 140)}`
          : ''
      return `- [${r.id}] ${r.title} (${r.targetHostName} / ${r.projectName}, status=${r.status})${tail}`
    })
    return okResult(lines.join('\n'), { requests: items.slice(0, 30) })
  }

  private async sendToWork(o: Record<string, unknown>): Promise<CallToolResult> {
    if (typeof o.requestId !== 'string' || typeof o.text !== 'string' || !o.text.trim()) {
      throw new Refusal('requestId and text are required.')
    }
    const req = await this.deps.sendToWorkSession(o.requestId.trim(), o.text.trim())
    return okResult(`Sent follow-up to work session ${req.sessionId ?? req.id}.`, { request: req })
  }

  private async archiveWork(o: Record<string, unknown>): Promise<CallToolResult> {
    if (typeof o.requestId !== 'string' || !o.requestId.trim()) {
      throw new Refusal('requestId is required.')
    }
    const req = await this.deps.archiveRequest(o.requestId.trim())
    return okResult(`Archived work request ${req.id} ("${req.title}").`, { request: req })
  }

  private async handoff(caller: Caller, o: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.deps.allowAgentHandoff()) {
      throw new Refusal('Agent handoff to Bots is turned off in Settings.')
    }
    const target = await this.resolveBot(o.bot)
    if (typeof o.text !== 'string' || !o.text.trim()) throw new Refusal('text is required.')
    const res = await this.deps.handoff({
      botId: target.id,
      sessionId: caller.sessionId,
      text: o.text.trim(),
      contextSummary: typeof o.contextSummary === 'string' ? o.contextSummary.trim() : undefined,
    })
    return okResult(
      `Handed off to Bot "${target.name}" (@${target.handle}). Its main session is ${res.botSessionId}.`,
      res,
    )
  }

  private async proposeCreate(caller: Caller, o: Record<string, unknown>): Promise<CallToolResult> {
    if (typeof o.name !== 'string' || !o.name.trim()) throw new Refusal('name is required.')
    const name = o.name.trim().slice(0, BOT_NAME_CHARS)
    const handle =
      typeof o.handle === 'string' && o.handle.trim()
        ? o.handle.trim().toLowerCase()
        : slugifyBotHandle(name)
    if (!isBotHandle(handle)) {
      throw new Refusal('handle must start with a letter/digit and contain only a-z, 0-9, -, _.')
    }
    const callerAgent = this.deps.sessionAgent(caller.sessionId)
    const fallbackAgent = callerAgent ?? this.deps.agents().find((a) => !a.disabled)?.id
    const agentId = typeof o.agent === 'string' && isAgentId(o.agent) ? o.agent : fallbackAgent
    if (!agentId) throw new Refusal('No enabled agent is available for this Bot.')

    const targets: BotTargetRef[] = Array.isArray(o.targets)
      ? (o.targets.filter(isBotTargetRef) as BotTargetRef[]).slice(0, BOT_MAX_TARGETS)
      : []
    const scope = parseScopeArg(o, { level: 'edit', web: true })
    const limits = normalizeBotLimits({
      maxConcurrent: typeof o.maxConcurrent === 'number' ? o.maxConcurrent : undefined,
      maxDaily: typeof o.maxDaily === 'number' ? o.maxDaily : undefined,
      timeLimitMinutes:
        typeof o.timeLimitMinutes === 'number'
          ? (o.timeLimitMinutes as (typeof TIME_LIMITS)[number])
          : undefined,
    })
    const avatar = parseAvatarArg(o, { kind: 'preset', preset: 'architect', palette: 'fox' })
    const draft: BotDraft = {
      name,
      handle,
      description:
        typeof o.description === 'string'
          ? o.description.trim().slice(0, BOT_DESCRIPTION_CHARS)
          : '',
      avatar,
      agentId,
      model: typeof o.model === 'string' ? o.model : null,
      effort: typeof o.effort === 'string' ? o.effort : null,
      targets,
      scope,
      limits,
      roleMarkdown:
        typeof o.roleMarkdown === 'string' ? o.roleMarkdown.slice(0, BOT_ROLE_CHARS) : '',
    }
    const cardFields: BotCardFields = {
      name: draft.name,
      handle: draft.handle,
      description: draft.description ?? '',
      avatar,
      agentId,
      model: draft.model ?? null,
      effort: draft.effort ?? null,
      targets,
      scope,
      limits,
      roleMarkdown: draft.roleMarkdown,
    }
    return this.runCard(caller, `create:${JSON.stringify(cardFields)}`, {
      ask: { action: 'create', botId: null, bot: cardFields, before: null, sessions: null },
      apply: async () => {
        const created = await this.deps.create(draft)
        return {
          botId: created.id,
          text: `Created Bot "${created.name}" (@${created.handle}, id=${created.id}).`,
          data: { bot: created },
        }
      },
    })
  }

  private async proposeUpdate(caller: Caller, o: Record<string, unknown>): Promise<CallToolResult> {
    const existing = await this.resolveBot(o.bot)
    const before = toCardFields(existing)
    const changes: BotChanges = {}
    if (typeof o.name === 'string' && o.name.trim()) changes.name = o.name.trim()
    if (typeof o.handle === 'string' && o.handle.trim())
      changes.handle = o.handle.trim().toLowerCase()
    if (typeof o.description === 'string') changes.description = o.description.trim()
    if (typeof o.agent === 'string' && isAgentId(o.agent)) changes.agentId = o.agent
    if (typeof o.model === 'string' || o.model === null) changes.model = o.model
    if (typeof o.effort === 'string' || o.effort === null) changes.effort = o.effort
    if (o.avatarPreset !== undefined || o.avatarPalette !== undefined) {
      changes.avatar = parseAvatarArg(o, existing.avatar)
    }
    if (Array.isArray(o.targets)) {
      changes.targets = (o.targets.filter(isBotTargetRef) as BotTargetRef[]).slice(
        0,
        BOT_MAX_TARGETS,
      )
    }
    if (o.scope !== undefined || o.web !== undefined) {
      changes.scope = parseScopeArg(o, existing.scope)
    }
    if (
      o.maxConcurrent !== undefined ||
      o.maxDaily !== undefined ||
      o.timeLimitMinutes !== undefined
    ) {
      changes.limits = normalizeBotLimits({
        ...existing.limits,
        ...(typeof o.maxConcurrent === 'number' ? { maxConcurrent: o.maxConcurrent } : {}),
        ...(typeof o.maxDaily === 'number' ? { maxDaily: o.maxDaily } : {}),
        ...(typeof o.timeLimitMinutes === 'number'
          ? { timeLimitMinutes: o.timeLimitMinutes as (typeof TIME_LIMITS)[number] }
          : {}),
      })
    }
    if (typeof o.roleMarkdown === 'string') {
      changes.roleMarkdown = o.roleMarkdown.slice(0, BOT_ROLE_CHARS)
    }
    const onlyRoleEdit = Object.keys(changes).length === 1 && changes.roleMarkdown !== undefined
    const nextFields: BotCardFields = {
      ...before,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.handle !== undefined ? { handle: changes.handle } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.avatar !== undefined ? { avatar: changes.avatar } : {}),
      ...(changes.agentId !== undefined ? { agentId: changes.agentId } : {}),
      ...(changes.model !== undefined ? { model: changes.model } : {}),
      ...(changes.effort !== undefined ? { effort: changes.effort } : {}),
      ...(changes.targets !== undefined ? { targets: changes.targets } : {}),
      ...(changes.scope !== undefined ? { scope: changes.scope } : {}),
      ...(changes.limits !== undefined
        ? { limits: normalizeBotLimits({ ...existing.limits, ...changes.limits }) }
        : {}),
      ...(changes.roleMarkdown !== undefined ? { roleMarkdown: changes.roleMarkdown } : {}),
    }
    const action: BotChangeAction = onlyRoleEdit ? 'role_edit' : 'update'
    return this.runCard(caller, `${action}:${existing.id}:${JSON.stringify(nextFields)}`, {
      ask: { action, botId: existing.id, bot: nextFields, before, sessions: null },
      apply: async () => {
        const updated = await this.deps.update(existing.id, changes)
        return {
          botId: updated.id,
          text: `Updated Bot "${updated.name}" (@${updated.handle}).`,
          data: { bot: updated },
        }
      },
    })
  }

  private async proposeDelete(caller: Caller, o: Record<string, unknown>): Promise<CallToolResult> {
    const existing = await this.resolveBot(o.bot)
    const keepSessions = o.keepSessions !== false
    const sessions = this.deps.countSessions(existing.id)
    const fields = toCardFields(existing, keepSessions)
    return this.runCard(caller, `delete:${existing.id}:${keepSessions}`, {
      ask: { action: 'delete', botId: existing.id, bot: fields, before: null, sessions },
      apply: async (answer) => {
        const finalKeep = answer.keepSessions ?? keepSessions
        await this.deps.delete(existing.id, finalKeep)
        return {
          botId: existing.id,
          text: `Deleted Bot "${existing.name}" (@${existing.handle}). Historical sessions were ${finalKeep ? 'kept as regular sessions' : 'removed'}.`,
          data: { botId: existing.id, keepSessions: finalKeep },
        }
      },
    })
  }

  /** 弹出强制确认卡片并等待用户决议；单会话同时最多允许 1 张待批卡片。 */
  private async runCard(
    caller: Caller,
    key: string,
    plan: {
      ask: BotAsk
      apply(answer: { keepSessions?: boolean }): Promise<{
        botId: string
        text: string
        data: Record<string, unknown>
      }>
    },
  ): Promise<CallToolResult> {
    const existing = this.jobs.get(caller.sessionId)
    if (existing) {
      if (existing.key !== key) {
        return errResult(
          `A confirmation card for "${existing.name}" is already waiting in this session. ` +
            'Wait for the user to answer it before proposing another Bot change.',
        )
      }
      return this.waitForJob(existing)
    }

    const asked = this.deps.ask(caller.sessionId, plan.ask, BOT_CHANGE_WAIT_MS)
    if (!asked) {
      return errResult('This session cannot display a confirmation card right now.')
    }

    const result = asked.answer.then<CallToolResult>(async (answer) => {
      try {
        if (answer.decision !== 'confirm') {
          const reason =
            answer.decision === 'decline'
              ? 'The user declined this Bot change.'
              : answer.decision === 'expired'
                ? 'No answer arrived within 10 minutes; nothing was changed.'
                : 'The turn ended before the user answered; nothing was changed.'
          return okResult(reason, { outcome: answer.decision })
        }
        try {
          const applied = await plan.apply({ keepSessions: answer.keepSessions })
          this.deps.settle(caller.sessionId, asked.entryId, { kind: 'done', botId: applied.botId })
          return okResult(applied.text, { outcome: 'done', ...applied.data })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.deps.settle(caller.sessionId, asked.entryId, { kind: 'failed', message })
          return errResult(message)
        }
      } finally {
        if (this.jobs.get(caller.sessionId)?.key === key) {
          this.jobs.delete(caller.sessionId)
        }
      }
    })

    const job: CardJob = {
      key,
      action: plan.ask.action,
      name: plan.ask.bot.name,
      result,
    }
    this.jobs.set(caller.sessionId, job)
    return this.waitForJob(job)
  }

  private waitForJob(job: CardJob): Promise<CallToolResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(
          okResult(
            `Still waiting for the user to answer the confirmation card for "${job.name}". ` +
              'Call this tool again with the exact same arguments to keep waiting without creating a second card.',
            { outcome: 'waiting' },
          ),
        )
      }, CONTROL_WAIT_MS)
      void job.result.then((res) => {
        clearTimeout(timer)
        resolve(res)
      })
    })
  }
}
