// Turns the Claude Agent SDK's messages into patches against Kettu's session model, the same
// patches and effects the ACP mapper produces. A message of a subagent goes to the subagent's
// session, which Kettu shows as a session of its own; everything else to the session it came on.

import type { PlanItem, SlashCommand, ToolEntry, UserContent } from '@shared/thread'
import { t } from '../i18n'
import {
  appendContent,
  attachmentCount,
  base64Size,
  imageCount,
  parseReplayedText,
  replayedAttachment,
  upgradeContext,
} from '../replayed-content'
import {
  addEntry,
  commandDescription,
  mapRateLimit,
  messageEntryId,
  rawInputText,
  toLf,
  toolEffects,
  type MapperContext,
  type MapperEffect,
  type MapperOutput,
} from '../session-updates'
import type {
  AssistantMessage,
  ContentBlock,
  SdkMessage,
  SlashCommandInfo,
  StoredMessage,
  StreamEvent,
  SystemMessage,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from './sdk'
import { PLAN_TOOLS, resultContent, startsBackgroundWork, SUBAGENT_TOOLS, toolView } from './tools'

/** Output for one session, built against its thread when it is delivered. */
export interface Delivery {
  /** The agent's own id of the session: the session's, or a subagent's task id. */
  sessionId: string
  map(ctx: MapperContext): MapperOutput
}

const output = (): MapperOutput => ({ patches: [], effects: [] })

/** Claude Code's model name for the messages it writes itself, such as an error. */
export const SYNTHETIC_MODEL = '<synthetic>'

/** Commands Kettu's own controls replace, or that only work in Claude Code's terminal. */
const UNSUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
  'clear',
  'cost',
  'keybindings-help',
  'login',
  'logout',
  'output-style:new',
  'release-notes',
  'todos',
])

export function mapCommands(
  commands: readonly SlashCommandInfo[],
  terminal: ReadonlySet<string>,
): SlashCommand[] {
  const out: SlashCommand[] = []
  const seen = new Set<string>()
  for (const command of commands) {
    const { name } = command
    if (!name || /\s/.test(name) || seen.has(name)) continue
    if (UNSUPPORTED_COMMANDS.has(name) || terminal.has(name)) continue
    seen.add(name)
    const hint = Array.isArray(command.argumentHint)
      ? command.argumentHint.join(' ')
      : command.argumentHint
    out.push({ name, description: command.description ?? '', ...(hint ? { inputHint: hint } : {}) })
  }
  return out
}

interface Tool {
  name: string
  input: unknown
  /** The session it shows in. */
  sessionId: string
}

interface Task {
  subject: string
  status: PlanItem['status']
}

const TASK_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])

/** Text Claude Code puts in a user message for itself, which no thread shows. */
const META_TEXT =
  /^\s*(<local-command-(stdout|stderr|caveat)>|<system-reminder>|<task-notification>|\[Request interrupted by user)/
const COMMAND_NAME = /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/

function blocksOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return (
    (block.type === 'tool_use' ||
      block.type === 'server_tool_use' ||
      block.type === 'mcp_tool_use') &&
    typeof (block as ToolUseBlock).id === 'string'
  )
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result' && typeof (block as ToolResultBlock).tool_use_id === 'string'
}

/** A user message's text as the thread shows it: a command as typed, meta text as nothing. */
function userText(value: string): string | null {
  const command = COMMAND_NAME.exec(value)
  if (command) {
    const args = COMMAND_ARGS.exec(value)?.[1]?.trim()
    return `/${command[1]}${args ? ` ${args}` : ''}`
  }
  if (META_TEXT.test(value)) return null
  return value
}

export interface ReplayedSubagent {
  taskId: string
  toolUseId: string
}

const AGENT_ID = /agentId:\s*([\w-]+)/

/** One open session's mapping state, across its turns. */
export class ClaudeMapper {
  /** The API message each lane streams now; the main thread's lane is ''. */
  private readonly lanes = new Map<string, string>()
  /** `<message id>:<kind>` of each text or thought that came as stream deltas, until it ends. */
  private readonly streamed = new Set<string>()
  private readonly tools = new Map<string, Tool>()
  /** The task id of the subagent each Agent call started, by the call's id. */
  private readonly subagents = new Map<string, string>()
  private readonly tasks = new Map<string, Task>()
  private readonly taskInputs = new Map<string, Record<string, unknown>>()
  private compacting: string | null = null
  /** In a replay: the subagents its history started, whose own histories follow. */
  readonly replayed: ReplayedSubagent[] = []
  /** In a subagent's replay: its parent, whose prompt its first message is. */
  private prompter: { parentId: string; messageId: string } | null = null

  constructor(
    /** The session's own id, Claude Code's. */
    readonly sessionId: string,
    private readonly cwd: string,
  ) {}

  /** Whether the task id names a subagent this session started. */
  isSubagent(taskId: string): boolean {
    for (const id of this.subagents.values()) if (id === taskId) return true
    return false
  }

  /** The session a message belongs to: a subagent's, or this one. */
  private route(message: { agent_id?: string; parent_tool_use_id?: string | null }): string {
    if (message.agent_id) return message.agent_id
    const parent = message.parent_tool_use_id
    return (parent && this.subagents.get(parent)) || this.sessionId
  }

  /** What one live message adds to the sessions it belongs to; null for one Kettu does not know. */
  live(message: SdkMessage): Delivery[] | null {
    switch (message.type) {
      case 'stream_event':
        return this.streamEvent(message as StreamEvent)
      case 'assistant':
        return this.assistant(message as AssistantMessage, false)
      case 'user':
        return this.user(message as UserMessage, false)
      case 'system':
        return this.system(message as SystemMessage)
      case 'rate_limit_event': {
        const info = (message as { rate_limit_info?: unknown }).rate_limit_info
        return [
          {
            sessionId: this.sessionId,
            map: (ctx) => {
              const out = output()
              const limit = mapRateLimit(info, ctx.now)
              if (limit) out.effects.push({ kind: 'limit', limit })
              return out
            },
          },
        ]
      }
      case 'tool_progress': {
        const id = (message as { tool_use_id?: unknown }).tool_use_id
        const tool = typeof id === 'string' ? this.tools.get(id) : undefined
        if (!tool || typeof id !== 'string') return []
        return [
          { sessionId: tool.sessionId, map: (ctx) => this.toolStatus(ctx, id, 'in_progress') },
        ]
      }
      default:
        return null
    }
  }

  private streamEvent(message: StreamEvent): Delivery[] {
    const { event } = message
    const lane = message.agent_id ?? message.parent_tool_use_id ?? ''
    const sessionId = this.route(message)
    switch (event.type) {
      case 'message_start': {
        const id = event.message?.id
        if (id) this.lanes.set(lane, id)
        if (lane !== '' || !id) return []
        const usage = event.message?.usage
        return [{ sessionId, map: (ctx) => this.request(ctx, usage) }]
      }
      case 'content_block_start': {
        const block = event.content_block
        const messageId = this.lanes.get(lane)
        if (!block || !messageId || !isToolUse(block)) return []
        return [{ sessionId, map: (ctx) => this.toolUse(ctx, block, sessionId, false) }]
      }
      case 'content_block_delta': {
        const messageId = this.lanes.get(lane)
        const delta = event.delta
        if (!messageId || !delta) return []
        if (delta.type === 'text_delta' && delta.text) {
          this.streamed.add(`${messageId}:agent`)
          const value = delta.text
          return [{ sessionId, map: (ctx) => this.chunk(ctx, 'agent', messageId, value) }]
        }
        if (delta.type === 'thinking_delta' && delta.thinking) {
          this.streamed.add(`${messageId}:thought`)
          const value = delta.thinking
          return [{ sessionId, map: (ctx) => this.chunk(ctx, 'thought', messageId, value) }]
        }
        return []
      }
      default:
        return []
    }
  }

  /** The main thread's request to its model: its context so far, and a renewed cache. */
  private request(
    ctx: MapperContext,
    usage: { input_tokens?: number | null; cache_read_input_tokens?: number | null } | undefined,
  ): MapperOutput {
    const out = output()
    if (ctx.replaying) return out
    const previous = ctx.thread.session.usage
    const used = usage ? contextTokens(usage) : null
    const counts = !ctx.cancelling
    if (used === null && !counts) return out
    out.patches.push({
      op: 'session.update',
      changes: {
        usage: {
          used: used ?? previous?.used ?? 0,
          size: previous?.size ?? DEFAULT_CONTEXT_WINDOW,
          cost: previous?.cost ?? null,
          tokens: previous?.tokens ?? null,
          ...(counts
            ? { cache: { lastRequestAt: ctx.now, ttl: previous?.cache?.ttl ?? null } }
            : previous?.cache
              ? { cache: previous.cache }
              : {}),
        },
      },
    })
    if (counts) out.effects.push({ kind: 'request' })
    return out
  }

  private chunk(
    ctx: MapperContext,
    kind: 'agent' | 'thought',
    messageId: string,
    value: string,
  ): MapperOutput {
    const out = output()
    const id = messageEntryId(ctx, kind, messageId)!
    const existing = ctx.thread.byId[id]
    if (existing?.kind === kind) {
      out.patches.push({ op: 'entry.appendText', id, text: toLf(value) })
      return out
    }
    const streaming = !ctx.replaying
    if (kind === 'agent') {
      addEntry(ctx, out, {
        kind: 'agent',
        id,
        markdown: toLf(value),
        attachments: [],
        streaming,
        ...(streaming ? { at: ctx.now } : {}),
      })
    } else {
      addEntry(ctx, out, { kind: 'thought', id, markdown: toLf(value), streaming })
      if (streaming) ctx.scope.thoughts.set(id, ctx.now)
    }
    return out
  }

  private assistant(message: AssistantMessage, replaying: boolean): Delivery[] {
    if (message.message.model === SYNTHETIC_MODEL) return []
    const sessionId = this.route(message)
    const messageId = message.message.id
    const deliveries: Delivery[] = []
    for (const block of blocksOf(message.message.content)) {
      if (block.type === 'text') {
        const value = (block as { text: string }).text
        if (!value || (!replaying && this.streamed.delete(`${messageId}:agent`))) continue
        deliveries.push({ sessionId, map: (ctx) => this.chunk(ctx, 'agent', messageId, value) })
      } else if (block.type === 'thinking') {
        const value = (block as { thinking: string }).thinking
        if (!value || (!replaying && this.streamed.delete(`${messageId}:thought`))) continue
        deliveries.push({ sessionId, map: (ctx) => this.chunk(ctx, 'thought', messageId, value) })
      } else if (isToolUse(block)) {
        deliveries.push({ sessionId, map: (ctx) => this.toolUse(ctx, block, sessionId, true) })
      }
    }
    if (!replaying && sessionId === this.sessionId && message.message.usage) {
      const usage = message.message.usage
      deliveries.push({ sessionId, map: (ctx) => this.contextUsed(ctx, usage) })
    }
    return deliveries
  }

  private contextUsed(
    ctx: MapperContext,
    usage: NonNullable<AssistantMessage['message']['usage']>,
  ): MapperOutput {
    const out = output()
    const previous = ctx.thread.session.usage
    const used = contextTokens(usage) + (usage.output_tokens ?? 0)
    if (previous?.used === used) return out
    out.patches.push({
      op: 'session.update',
      changes: {
        usage: {
          used,
          size: previous?.size ?? DEFAULT_CONTEXT_WINDOW,
          cost: previous?.cost ?? null,
          tokens: previous?.tokens ?? null,
          ...(previous?.cache ? { cache: previous.cache } : {}),
        },
      },
    })
    return out
  }

  /** A tool call as its input stands; `complete` once its input is whole. */
  private toolUse(
    ctx: MapperContext,
    block: ToolUseBlock,
    sessionId: string,
    complete: boolean,
    asked = false,
  ): MapperOutput {
    const out = output()
    const { name } = block
    this.tools.set(block.id, { name, input: block.input, sessionId })
    if (name === 'TodoWrite') {
      if (complete) this.todoPlan(ctx, out, block.input)
      return out
    }
    if (PLAN_TOOLS.has(name)) {
      if (complete) this.taskInputs.set(block.id, inputOf(block.input))
      return out
    }
    // A subagent shows as a session of its own, unless the call needs an answer first.
    if (SUBAGENT_TOOLS.has(name) && !asked) return out
    const id = `t:${block.id}`
    const view = toolView(name, complete ? block.input : {}, this.cwd)
    const existing = ctx.thread.byId[id]
    const raw = complete ? rawInputText(block.input) : undefined
    const description = complete ? commandDescription(block.input) : undefined
    if (existing?.kind === 'tool') {
      if (!complete) return out
      const changes = {
        title: view.title,
        toolKind: view.toolKind,
        locations: view.locations,
        ...(existing.status === 'pending' || view.content.length > 0
          ? { content: view.content }
          : {}),
        ...(raw !== undefined ? { rawInput: raw } : {}),
        ...(description !== undefined ? { description } : {}),
      }
      out.patches.push({ op: 'entry.update', id, changes })
      return out
    }
    if (complete && !ctx.replaying && startsBackgroundWork(name, block.input)) {
      out.effects.push({ kind: 'background' })
    }
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      title: view.title,
      toolKind: view.toolKind,
      status: 'pending',
      content: view.content,
      locations: view.locations,
      permission: null,
      permissionResult: null,
      ...(raw !== undefined ? { rawInput: raw } : {}),
      ...(description !== undefined ? { description } : {}),
    }
    addEntry(ctx, out, entry)
    return out
  }

  /** The tool entry a permission request belongs to, added first if the thread has none. */
  permissionTool(ctx: MapperContext, block: ToolUseBlock, sessionId: string): MapperOutput {
    return this.toolUse(ctx, block, sessionId, true, true)
  }

  /** Moves a tool call to `status`, as a permission or Claude Code's progress tells. */
  toolStatus(ctx: MapperContext, toolUseId: string, status: ToolEntry['status']): MapperOutput {
    const out = output()
    const id = `t:${toolUseId}`
    const entry = ctx.thread.byId[id]
    if (entry?.kind !== 'tool' || entry.status !== 'pending') return out
    out.patches.push({ op: 'entry.update', id, changes: { status } })
    toolEffects(out, toolUseId, id, entry.status, { ...entry, status })
    return out
  }

  private user(message: UserMessage, replaying: boolean): Delivery[] {
    const deliveries: Delivery[] = []
    const blocks = blocksOf(message.message.content)
    for (const block of blocks) {
      if (!isToolResult(block)) continue
      const tool = this.tools.get(block.tool_use_id)
      const sessionId = tool?.sessionId ?? this.route(message)
      const structured = message.tool_use_result
      deliveries.push({ sessionId, map: (ctx) => this.toolResult(ctx, block, structured) })
    }
    // Live, the host added the user's own message when it sent it; others are Claude Code's.
    if (!replaying || message.parent_tool_use_id) return deliveries
    const content = blocks.filter((block) => !isToolResult(block))
    if (content.length === 0 || !message.uuid) return deliveries
    const uuid = message.uuid
    deliveries.push({
      sessionId: this.sessionId,
      map: (ctx) => this.replayedUser(ctx, uuid, content),
    })
    return deliveries
  }

  private toolResult(
    ctx: MapperContext,
    block: ToolResultBlock,
    structured: unknown,
  ): MapperOutput {
    const out = output()
    const tool = this.tools.get(block.tool_use_id)
    const name = tool?.name ?? ''
    if (PLAN_TOOLS.has(name)) {
      if (name !== 'TodoWrite') this.taskResult(ctx, out, block, structured, name)
      return out
    }
    if (SUBAGENT_TOOLS.has(name) && !this.subagents.has(block.tool_use_id)) {
      this.subagentResult(ctx, out, block, structured, tool!)
      return out
    }
    const id = `t:${block.tool_use_id}`
    const entry = ctx.thread.byId[id]
    if (entry?.kind !== 'tool') return out
    const status: ToolEntry['status'] = block.is_error === true ? 'failed' : 'completed'
    const content = resultContent(name, block, structured, entry.content)
    const changes = {
      status,
      ...(content ? { content } : {}),
      ...(name === 'ExitPlanMode' && status === 'completed' ? { title: 'Exited Plan Mode' } : {}),
    }
    out.patches.push({ op: 'entry.update', id, changes })
    toolEffects(out, block.tool_use_id, id, entry.status, { ...entry, ...changes })
    return out
  }

  /**
   * A subagent's result where no task started it here, as in a replay: the subagent's session
   * when the result names it, else the call itself.
   */
  private subagentResult(
    ctx: MapperContext,
    out: MapperOutput,
    block: ToolResultBlock,
    structured: unknown,
    tool: Tool,
  ): void {
    const input = inputOf(tool.input)
    const named = inputOf(structured).agentId
    const taskId =
      typeof named === 'string' ? named : (AGENT_ID.exec(resultText(block))?.[1] ?? null)
    const failed = block.is_error === true
    if (taskId) {
      this.subagents.set(block.tool_use_id, taskId)
      if (ctx.replaying) this.replayed.push({ taskId, toolUseId: block.tool_use_id })
      out.effects.push({
        kind: 'subagent',
        sessionId: taskId,
        title: typeof input.description === 'string' ? input.description : null,
        description: typeof input.subagent_type === 'string' ? input.subagent_type : null,
        canCancel: false,
        state: {
          kind: 'idle',
          stopReason: failed ? 'error' : 'end_turn',
          error: failed ? { message: resultText(block) || t('session.subagent.failed') } : null,
          tokens: null,
        },
      })
      return
    }
    const view = toolView(tool.name, tool.input, this.cwd)
    const content = resultContent(tool.name, block, structured, view.content) ?? view.content
    addEntry(ctx, out, {
      kind: 'tool',
      id: `t:${block.tool_use_id}`,
      title: view.title,
      toolKind: view.toolKind,
      status: failed ? 'failed' : 'completed',
      content,
      locations: view.locations,
      permission: null,
      permissionResult: null,
    })
  }

  private todoPlan(ctx: MapperContext, out: MapperOutput, input: unknown): void {
    const todos = inputOf(input).todos
    if (!Array.isArray(todos)) return
    const items: PlanItem[] = []
    for (const todo of todos as unknown[]) {
      const fields = inputOf(todo)
      if (typeof fields.content !== 'string') continue
      const status = TASK_STATUSES.has(String(fields.status))
        ? (fields.status as PlanItem['status'])
        : 'pending'
      items.push({ content: fields.content, priority: 'medium', status })
    }
    setPlan(ctx, out, items)
  }

  private taskResult(
    ctx: MapperContext,
    out: MapperOutput,
    block: ToolResultBlock,
    structured: unknown,
    name: string,
  ): void {
    if (block.is_error === true) return
    const input = this.taskInputs.get(block.tool_use_id) ?? {}
    const shaped = inputOf(structured)
    const text = resultText(block)
    if (name === 'TaskCreate') {
      const task = inputOf(shaped.task)
      const id = (typeof task.id === 'string' ? task.id : null) ?? /#(\d+)/.exec(text)?.[1] ?? null
      const subject =
        typeof task.subject === 'string'
          ? task.subject
          : typeof input.subject === 'string'
            ? input.subject
            : null
      if (id === null || subject === null) return
      this.tasks.set(id, { subject, status: 'pending' })
    } else if (name === 'TaskUpdate') {
      const id = typeof input.taskId === 'string' ? input.taskId : null
      const task = id === null ? undefined : this.tasks.get(id)
      if (id === null || !task) return
      if (input.status === 'deleted') this.tasks.delete(id)
      else {
        if (typeof input.status === 'string' && TASK_STATUSES.has(input.status)) {
          task.status = input.status as PlanItem['status']
        }
        if (typeof input.subject === 'string') task.subject = input.subject
      }
    } else if (name === 'TaskList' && Array.isArray(shaped.tasks)) {
      this.tasks.clear()
      for (const item of shaped.tasks as unknown[]) {
        const fields = inputOf(item)
        if (typeof fields.id !== 'string' || typeof fields.subject !== 'string') continue
        const status = TASK_STATUSES.has(String(fields.status))
          ? (fields.status as PlanItem['status'])
          : 'pending'
        this.tasks.set(fields.id, { subject: fields.subject, status })
      }
    } else {
      return
    }
    setPlan(
      ctx,
      out,
      [...this.tasks.values()].map((task) => ({
        content: task.subject,
        priority: 'medium',
        status: task.status,
      })),
    )
  }

  private replayedUser(ctx: MapperContext, uuid: string, blocks: ContentBlock[]): MapperOutput {
    const out = output()
    const texts = blocks.flatMap((block) =>
      block.type === 'text' ? [(block as { text: string }).text] : [],
    )
    const joined = texts.join('\n')
    if (COMPACT_SUMMARY.test(joined)) {
      addEntry(ctx, out, {
        kind: 'compaction',
        id: `c:${uuid}`,
        status: 'completed',
        summary: toLf(joined),
      })
      return out
    }
    const prompter = this.prompter
    if (prompter && texts.length > 0) {
      // A subagent's first message is the prompt its parent gave it.
      this.prompter = null
      addEntry(ctx, out, {
        kind: 'session_message',
        id: `sm:${prompter.messageId}`,
        senderId: ctx.sessionIdFor(prompter.parentId),
        content: [{ type: 'text', text: toLf(joined) }],
      })
      return out
    }
    const id = messageEntryId(ctx, 'user', uuid)!
    let content: UserContent[] = []
    for (const block of blocks) {
      if (block.type === 'text') {
        const value = userText((block as { text: string }).text)
        if (value === null) continue
        const upgraded = upgradeContext(content, value)
        if (upgraded) {
          content = upgraded
          continue
        }
        const parts = parseReplayedText(value, id, content, out)
        content = appendContent(content, parts ?? [{ type: 'text', text: value }])
      } else if (block.type === 'image') {
        const source = (block as { source?: { type?: string; media_type?: string; data?: string } })
          .source
        if (source?.type !== 'base64' || !source.media_type || !source.data) continue
        const attachment = replayedAttachment(id, attachmentCount(content) + 1, {
          type: 'image',
          name: t('content.image', { number: imageCount(content) + 1 }),
          uri: null,
          mimeType: source.media_type,
          size: base64Size(source.data),
          sent: 'image',
        })
        out.effects.push({
          kind: 'replayImage',
          entryId: id,
          attachmentId: attachment.id,
          mimeType: source.media_type,
          data: source.data,
        })
        content = appendContent(content, [{ type: 'ref', ref: { kind: 'attachment', attachment } }])
      }
    }
    if (content.length === 0) return out
    // Each user message starts a turn, which scopes "current" plans.
    ctx.scope.planId = null
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'user') {
      out.patches.push({
        op: 'entry.update',
        id,
        changes: { content: appendContent(existing.content, content) },
      })
    } else {
      addEntry(ctx, out, { kind: 'user', id, content })
    }
    return out
  }

  private system(message: SystemMessage): Delivery[] | null {
    const parent = this.sessionId
    switch (message.subtype) {
      case 'init':
      case 'session_state_changed':
      case 'api_retry':
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response':
        return []
      case 'status': {
        const status = message.status
        const mode = message.permissionMode
        const deliveries: Delivery[] = []
        if (typeof mode === 'string') {
          deliveries.push({ sessionId: parent, map: (ctx) => modeChange(ctx, mode) })
        }
        if (status === 'compacting' && !this.compacting) {
          const id = `c:${String(message.uuid ?? Date.now())}`
          this.compacting = id
          deliveries.push({
            sessionId: parent,
            map: (ctx) => {
              const out = output()
              if (!ctx.thread.byId[id]) {
                addEntry(ctx, out, { kind: 'compaction', id, status: 'in_progress', summary: '' })
              }
              return out
            },
          })
        } else if (status !== 'compacting' && this.compacting && message.compact_result) {
          const id = this.compacting
          this.compacting = null
          const failed = message.compact_result === 'failed'
          const error = typeof message.compact_error === 'string' ? message.compact_error : ''
          deliveries.push({
            sessionId: parent,
            map: (ctx) => {
              const out = output()
              if (ctx.thread.byId[id]?.kind !== 'compaction') return out
              out.patches.push({
                op: 'entry.update',
                id,
                changes: failed ? { status: 'failed', summary: error } : { status: 'completed' },
              })
              return out
            },
          })
        }
        return deliveries
      }
      case 'compact_boundary': {
        const id = this.compacting ?? `c:${String(message.uuid ?? Date.now())}`
        this.compacting = null
        return [
          {
            sessionId: parent,
            map: (ctx) => {
              const out = output()
              if (ctx.thread.byId[id]?.kind === 'compaction') {
                out.patches.push({ op: 'entry.update', id, changes: { status: 'completed' } })
              } else {
                addEntry(ctx, out, { kind: 'compaction', id, status: 'completed', summary: '' })
              }
              return out
            },
          },
        ]
      }
      case 'task_started':
        return this.taskStarted(message)
      case 'task_notification':
        return this.taskNotification(message)
      case 'task_updated':
      case 'task_progress':
      case 'background_tasks_changed':
      case 'commands_changed':
        return []
      default:
        return null
    }
  }

  private taskStarted(message: SystemMessage): Delivery[] {
    const taskId = typeof message.task_id === 'string' ? message.task_id : null
    if (!taskId) return []
    const subagent =
      message.task_type === 'local_agent' || typeof message.subagent_type === 'string'
    if (!subagent) {
      return [
        {
          sessionId: this.sessionId,
          map: () => ({ patches: [], effects: [{ kind: 'background' }] }),
        },
      ]
    }
    const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : null
    if (toolUseId) this.subagents.set(toolUseId, taskId)
    const parentTask = typeof message.parent_task_id === 'string' ? message.parent_task_id : null
    const parent = parentTask ?? this.sessionId
    const description = typeof message.description === 'string' ? message.description : null
    const kind = typeof message.subagent_type === 'string' ? message.subagent_type : null
    const prompt = typeof message.prompt === 'string' ? message.prompt : null
    const deliveries: Delivery[] = [
      {
        sessionId: parent,
        map: () => ({
          patches: [],
          effects: [
            {
              kind: 'subagent',
              sessionId: taskId,
              title: description,
              description: kind,
              canCancel: true,
              state: { kind: 'running' },
            },
          ],
        }),
      },
    ]
    if (prompt) {
      const root = this.sessionId
      deliveries.push({
        sessionId: taskId,
        map: (ctx) => {
          const out = output()
          const id = `sm:${toolUseId ?? taskId}`
          if (ctx.thread.byId[id]) return out
          addEntry(ctx, out, {
            kind: 'session_message',
            id,
            senderId: ctx.sessionIdFor(parent) ?? ctx.sessionIdFor(root),
            content: [{ type: 'text', text: toLf(prompt) }],
          })
          return out
        },
      })
    }
    return deliveries
  }

  private taskNotification(message: SystemMessage): Delivery[] {
    const taskId = typeof message.task_id === 'string' ? message.task_id : null
    if (!taskId || !this.isSubagent(taskId)) return []
    const status = message.status
    const summary = typeof message.summary === 'string' ? message.summary : ''
    const effect: MapperEffect = {
      kind: 'subagent',
      sessionId: taskId,
      state: {
        kind: 'idle',
        stopReason:
          status === 'completed' ? 'end_turn' : status === 'stopped' ? 'cancelled' : 'error',
        error: status === 'failed' ? { message: summary || t('session.subagent.failed') } : null,
        tokens: null,
      },
    }
    return [{ sessionId: this.sessionId, map: () => ({ patches: [], effects: [effect] }) }]
  }

  /**
   * A session's history as deliveries to it, each built against the thread as the ones before it
   * left it. A subagent's history is its own: `prompter` names the parent of one replayed here,
   * whose prompt its first message is; `replayed` lists those a parent's history started.
   */
  replay(
    messages: readonly StoredMessage[],
    prompter: { parentId: string; messageId: string } | null = null,
  ): Delivery[] {
    this.prompter = prompter
    const deliveries: Delivery[] = []
    for (const message of messages) {
      if (message.parent_tool_use_id && !prompter) continue
      const common = {
        parent_tool_use_id: null,
        uuid: message.uuid,
        session_id: message.session_id,
      }
      if (message.type === 'assistant') {
        const inner = message.message as AssistantMessage['message']
        deliveries.push(...this.assistant({ type: 'assistant', message: inner, ...common }, true))
      } else if (message.type === 'user') {
        const inner = message.message as UserMessage['message']
        deliveries.push(...this.user({ type: 'user', message: inner, ...common }, true))
      }
    }
    return deliveries.filter((delivery) => delivery.sessionId === this.sessionId)
  }
}

function inputOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function resultText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return block.content
    .flatMap((item) => (item.type === 'text' ? [(item as { text: string }).text] : []))
    .join('\n')
}

function setPlan(ctx: MapperContext, out: MapperOutput, items: PlanItem[]): void {
  const current = ctx.scope.planId ? ctx.thread.byId[ctx.scope.planId] : undefined
  if (current?.kind === 'plan') {
    out.patches.push({ op: 'entry.update', id: current.id, changes: { items } })
    return
  }
  const id = ctx.nextId()
  ctx.scope.planId = id
  addEntry(ctx, out, { kind: 'plan', id, items })
}

function modeChange(ctx: MapperContext, mode: string): MapperOutput {
  const out = output()
  const config = ctx.thread.session.config
  const option = config.find((item) => item.id === MODE_OPTION_ID)
  if (!option || option.value === mode || !option.choices?.some((c) => c.value === mode)) {
    return out
  }
  out.patches.push({
    op: 'session.update',
    changes: {
      config: config.map((item) => (item === option ? { ...item, value: mode } : item)),
    },
  })
  return out
}

/** The option id of the permission mode, as the ACP adapter named it. */
export const MODE_OPTION_ID = 'mode'

/** The context window Claude Code's models have unless it says otherwise. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** The tokens a request read: its input with what it read from and wrote to the cache. */
export function contextTokens(usage: {
  input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}
