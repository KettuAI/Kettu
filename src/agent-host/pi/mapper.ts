// Turns what `pi --mode rpc` sends into the patches and effects every protocol's mapper produces:
// the events of a running turn, and the entries of a session's tree when its history is replayed.

import path from 'node:path'
import { addSpeedSample, latestTime, timeRequest } from '@shared/output-speed'
import type {
  ThreadEntry,
  TokenTotals,
  ToolContent,
  ToolEntry,
  ToolKind,
  UserContent,
} from '@shared/thread'
import { diffHunks, fenced } from '../codex/mapper'
import type { RewindPoint } from '../connection'
import { t } from '../i18n'
import { isClaudeRowlessCall, isClaudeRowWhenFailed } from '../plan-tool'
import {
  appendContent,
  base64Size,
  imageCount,
  attachmentCount,
  parseReplayedText,
  replayedAttachment,
} from '../replayed-content'
import {
  addEntry,
  commandDescription,
  toLf,
  toolEffects,
  withoutAhead,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import type {
  PiContent,
  PiEntry,
  PiEvent,
  PiMessage,
  PiMessageDelta,
  PiStats,
  PiToolResult,
  PiUiRequest,
  PiUsage,
} from './protocol'

/** Output a tool printed, its start cut once it grows past this. */
const OUTPUT_LIMIT = 64 * 1024
/** A running command's output reaches the thread at most this often. */
const OUTPUT_EVERY_MS = 150
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell'])
const FILE_WRITES: ReadonlySet<string> = new Set(['edit', 'write'])

function output(): MapperOutput {
  return { patches: [], effects: [] }
}

function cut(text: string): string {
  return text.length > OUTPUT_LIMIT ? `…\n${text.slice(text.length - OUTPUT_LIMIT)}` : text
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function absolute(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file)
}

/** Whether a tool call changes the file its `path` names. */
export function writesFile(name: string): boolean {
  return FILE_WRITES.has(name)
}

/** The file a call of pi's file tools names, as an absolute path. */
export function toolPath(args: unknown, cwd: string): string | null {
  const input = record(args)
  const file = str(input.path) ?? str(input.file_path)
  return file ? absolute(cwd, file) : null
}

/** A tool's MCP name `mcp__<server>__<tool>` as its parts, or null for one of pi's own. */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match ? { server: match[1]!, tool: match[2]! } : null
}

/** Each replacement an `edit` call asks for: in `edits`, or alone in older calls. */
function editsOf(args: Record<string, unknown>): { oldText: string; newText: string }[] {
  const edits: { oldText: string; newText: string }[] = []
  const take = (value: unknown): void => {
    const edit = record(value)
    if (typeof edit.oldText === 'string' && typeof edit.newText === 'string') {
      edits.push({ oldText: edit.oldText, newText: edit.newText })
    }
  }
  take(args)
  let list: unknown = args.edits
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = null
    }
  }
  if (Array.isArray(list)) list.forEach(take)
  return edits
}

type ToolFacts = Pick<ToolEntry, 'title' | 'toolKind' | 'locations' | 'content'> &
  Pick<Partial<ToolEntry>, 'rawInput' | 'description'>

/** What the thread shows of a call before its result: its title, kind, files and input. */
export function toolFacts(name: string, args: unknown, cwd: string): ToolFacts {
  const input = record(args)
  const file = toolPath(input, cwd)
  const shown = str(input.path) ?? str(input.file_path)
  const at = (kind: ToolKind, title: string, line?: number): ToolFacts => ({
    title,
    toolKind: kind,
    locations: file ? [line === undefined ? { path: file } : { path: file, line }] : [],
    content: [],
  })
  if (SHELL_TOOLS.has(name)) {
    const command = toLf(str(input.command) ?? '')
    const description = commandDescription(input)
    return {
      title: command || t('codex.tool.runCommand'),
      toolKind: 'execute',
      locations: [],
      content: [],
      ...(command ? { rawInput: command } : {}),
      ...(description ? { description } : {}),
    }
  }
  switch (name) {
    case 'read': {
      const line = typeof input.offset === 'number' && input.offset > 0 ? input.offset : undefined
      return at(
        'read',
        shown ? t('codex.tool.readFile', { path: shown }) : t('dsh.tool.read'),
        line,
      )
    }
    case 'write': {
      const facts = at('edit', shown ? t('dsh.tool.write', { path: shown }) : t('dsh.tool.edit'))
      if (file && typeof input.content === 'string') {
        facts.content = [{ type: 'diff', path: file, oldText: null, newText: toLf(input.content) }]
      }
      return facts
    }
    case 'edit': {
      const facts = at('edit', shown ? t('dsh.tool.editFile', { path: shown }) : t('dsh.tool.edit'))
      if (file) {
        facts.content = editsOf(input).map((edit) => ({
          type: 'diff',
          path: file,
          oldText: toLf(edit.oldText),
          newText: toLf(edit.newText),
        }))
      }
      return facts
    }
    case 'grep':
    case 'find': {
      const pattern = str(input.pattern) ?? str(input.query) ?? ''
      const where = shown ?? str(input.glob)
      return {
        title: where
          ? t('codex.tool.searchIn', { query: pattern, path: where })
          : pattern
            ? t('codex.tool.search', { query: pattern })
            : t('codex.tool.searchAll'),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'ls':
      return {
        title: shown ? t('codex.tool.listFilesIn', { path: shown }) : t('codex.tool.listFiles'),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    case 'tool_search': {
      const query = str(input.query)
      return {
        title: query ? t('pi.tool.toolSearch', { query }) : t('pi.tool.toolSearchAll'),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'codemode': {
      const code = str(input.code)
      return {
        title: t('pi.tool.script'),
        toolKind: 'execute',
        locations: [],
        content: [],
        ...(code ? { rawInput: toLf(code) } : {}),
      }
    }
  }
  const mcp = mcpTool(name)
  const raw = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : null
  return {
    title: mcp ? t('codex.tool.mcp', mcp) : name,
    toolKind: 'other',
    locations: [],
    content: [],
    ...(raw ? { rawInput: raw } : {}),
  }
}

/** The text of a message's or a result's blocks of text, joined. */
export function blockText(content: PiMessage['content'] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

function images(content: readonly PiContent[] | undefined): ToolContent[] {
  return (content ?? []).flatMap((block): ToolContent[] =>
    block.type === 'image'
      ? [{ type: 'ref', ref: { kind: 'image', mimeType: block.mimeType, data: block.data } }]
      : [],
  )
}

/** What a result shows: an edit's patch as diffs, a shell's or a file's text fenced, else as is. */
function resultContent(
  name: string,
  result: PiToolResult | PiMessage | undefined,
  failed: boolean,
  shown: readonly ToolContent[],
  cwd: string,
  args: unknown,
  before?: string | null,
): ToolContent[] {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = toLf(blockText(blocks))
  if (failed) return text ? [{ type: 'markdown', markdown: cut(text) }] : []
  const file = toolPath(args, cwd)
  if (name === 'edit' && file) {
    const patch = str(record(result?.details).patch)
    const hunks = patch ? diffHunks(patch) : null
    if (hunks) return hunks.map((hunk) => ({ type: 'diff', path: file, ...hunk }))
    return shown.some((item) => item.type === 'diff') ? [...shown] : []
  }
  if (name === 'write' && file) {
    const content = record(args).content
    if (typeof content !== 'string') return [...shown]
    return [
      { type: 'diff', path: file, oldText: heldBefore(before, content), newText: toLf(content) },
    ]
  }
  const pictures = images(blocks)
  if (text === '') return pictures
  const fence = SHELL_TOOLS.has(name) || name === 'read' || name === 'codemode'
  return [{ type: 'markdown', markdown: fence ? fenced(cut(text)) : cut(text) }, ...pictures]
}

/** A reply's tokens in Kettu's totals, which count cached input apart from `input` as pi does. */
export function tokenTotals(usage: PiUsage | undefined): TokenTotals | null {
  if (!usage) return null
  // pi takes some providers' own total and reports 0 when one leaves it out.
  const total =
    usage.totalTokens > 0
      ? usage.totalTokens
      : usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  if (!(total > 0)) return null
  return {
    total,
    input: usage.input,
    output: usage.output,
    thought: usage.reasoning ?? null,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  }
}

const SKILL = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]*))?$/

/** A stored prompt as the user typed it: a skill pi expanded goes back to its command. */
export function typedText(text: string): string {
  const skill = SKILL.exec(text)
  if (!skill) return text
  const rest = skill[2]?.trim()
  return rest ? `/skill:${skill[1]} ${rest}` : `/skill:${skill[1]}`
}

interface Call {
  name: string
  args: unknown
  /** When its running output last reached the thread. */
  shownAt: number
}

interface Reply {
  /** The message's own time, which names its entries. */
  key: string
  startedAt: number
  firstOutputAt: number | null
  /** The tool calls its blocks start, by block. */
  calls: Map<number, string>
}

/** One pi session's mapper: what Kettu shows of its events and of its stored entries. */
export class SessionMapper {
  private readonly calls = new Map<string, Call>()
  private reply: Reply | null = null
  private contextWindow: number | null = null
  private compaction: string | null = null
  private compactions = 0

  constructor(private readonly cwd: string) {}

  /** The context window of the session's model, which the usage names as its size. */
  setContextWindow(size: number | null | undefined): void {
    this.contextWindow = typeof size === 'number' && size > 0 ? size : null
  }

  /** The call `toolCallId` names, once its message named it. */
  call(toolCallId: string): { name: string; args: unknown } | null {
    return this.calls.get(toolCallId) ?? null
  }

  /**
   * Maps one event of a running turn; null for one the thread shows nothing of. `before` is the
   * text a `write` call's file held before it, when the connection could read it.
   */
  event(event: PiEvent, ctx: MapperContext, before?: string | null): MapperOutput | null {
    const out = output()
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') this.startReply(ctx, event.message)
        break
      case 'message_update':
        this.delta(ctx, out, event.assistantMessageEvent)
        break
      case 'message_end':
        this.endMessage(ctx, out, event.message)
        break
      case 'tool_execution_start':
        this.toolStart(ctx, out, event.toolCallId, event.toolName, event.args, before)
        break
      case 'tool_execution_update':
        this.toolUpdate(ctx, out, event.toolCallId, event.partialResult)
        break
      case 'tool_execution_end':
        this.toolEnd(
          ctx,
          out,
          event.toolCallId,
          event.toolName,
          event.result,
          !!event.isError,
          before,
        )
        break
      case 'compaction_start':
        this.compactionStart(ctx, out)
        break
      case 'compaction_end':
        this.compactionEnd(ctx, out, event)
        break
      case 'auto_retry_start':
        addEntry(ctx, out, {
          kind: 'notice',
          id: ctx.nextId(),
          severity: 'warning',
          title: t('dsh.notice.retry', { retry: event.attempt, max: event.maxAttempts }),
          ...(event.errorMessage ? { description: event.errorMessage } : {}),
        })
        break
      case 'session_info_changed': {
        const title = event.name?.trim() || null
        out.patches.push({ op: 'session.update', changes: { title, updatedAt: ctx.now } })
        out.effects.push({ kind: 'title', title })
        break
      }
      case 'extension_error':
        addEntry(ctx, out, {
          kind: 'notice',
          id: ctx.nextId(),
          severity: 'warning',
          title: t('pi.notice.extensionError'),
          ...(event.error ? { description: event.error } : {}),
        })
        break
      case 'extension_ui_request':
        if (!this.notify(ctx, out, event)) return null
        break
      default:
        return null
    }
    return out
  }

  /** An extension's notification as a notice; false for any other request of its UI. */
  private notify(ctx: MapperContext, out: MapperOutput, request: PiUiRequest): boolean {
    if (request.method !== 'notify') return false
    const [title = '', ...rest] = toLf(request.message ?? '')
      .trim()
      .split('\n')
    if (title === '') return true
    const severity =
      request.notifyType === 'warning' || request.notifyType === 'error'
        ? request.notifyType
        : 'info'
    const description = rest.join('\n').trim()
    addEntry(ctx, out, {
      kind: 'notice',
      id: ctx.nextId(),
      severity,
      title,
      ...(description ? { description } : {}),
    })
    return true
  }

  // A reply as it streams.

  private startReply(ctx: MapperContext, message: PiMessage): void {
    this.reply = {
      key: String(message.timestamp ?? ctx.now),
      startedAt: ctx.now,
      firstOutputAt: null,
      calls: new Map(),
    }
  }

  private blockId(reply: Reply, index: number): string {
    return `m:${reply.key}-${index}`
  }

  private delta(ctx: MapperContext, out: MapperOutput, delta: PiMessageDelta): void {
    const reply = this.reply
    const index = delta.contentIndex
    if (!reply || typeof index !== 'number') return
    switch (delta.type) {
      case 'text_delta':
      case 'thinking_delta': {
        const text = delta.delta ?? ''
        if (text === '') return
        reply.firstOutputAt ??= ctx.now
        this.append(ctx, out, reply, index, delta.type === 'text_delta' ? 'agent' : 'thought', text)
        return
      }
      case 'text_end':
      case 'thinking_end':
        this.settle(ctx, out, reply, index, delta.type === 'text_end' ? 'agent' : 'thought', delta)
        return
      case 'toolcall_start': {
        // Before 0.84.3 the call was named only in the message so far.
        const block = delta.partial?.content?.[index]
        const partial = block?.type === 'toolCall' ? block : null
        const id = delta.id ?? partial?.id
        const name = delta.toolName ?? partial?.name
        if (!id || !name) return
        reply.firstOutputAt ??= ctx.now
        reply.calls.set(index, id)
        this.announce(ctx, out, id, name, undefined)
        return
      }
      case 'toolcall_end': {
        const call = delta.toolCall
        if (!call?.id || !call.name) return
        reply.calls.set(index, call.id)
        this.announce(ctx, out, call.id, call.name, call.arguments ?? {})
        return
      }
    }
  }

  private append(
    ctx: MapperContext,
    out: MapperOutput,
    reply: Reply,
    index: number,
    kind: 'agent' | 'thought',
    text: string,
  ): void {
    const id = this.blockId(reply, index)
    const existing = ctx.thread.byId[id]
    if (existing?.kind === kind) {
      out.patches.push({ op: 'entry.appendText', id, text })
      return
    }
    if (existing) return
    if (kind === 'agent') {
      addEntry(ctx, out, {
        kind: 'agent',
        id,
        markdown: text,
        attachments: [],
        streaming: true,
        at: ctx.now,
      })
    } else {
      addEntry(ctx, out, { kind: 'thought', id, markdown: text, streaming: true })
      ctx.scope.thoughts.set(id, ctx.now)
    }
  }

  /** A block's end carries its whole text, which stands over what the deltas made of it. */
  private settle(
    ctx: MapperContext,
    out: MapperOutput,
    reply: Reply,
    index: number,
    kind: 'agent' | 'thought',
    delta: PiMessageDelta,
  ): void {
    const id = this.blockId(reply, index)
    const existing = ctx.thread.byId[id]
    const text = delta.content ?? ''
    if (existing?.kind !== kind) {
      if (!existing && text.trim() !== '') this.append(ctx, out, reply, index, kind, text)
      return
    }
    if (text !== '' && text !== existing.markdown) {
      out.patches.push({ op: 'entry.update', id, changes: { markdown: text } })
    }
    if (kind === 'thought') {
      const startedAt = ctx.scope.thoughts.get(id)
      ctx.scope.thoughts.delete(id)
      if (existing.streaming) {
        out.patches.push({
          op: 'entry.update',
          id,
          changes: {
            streaming: false,
            ...(startedAt !== undefined ? { durationMs: Math.max(0, ctx.now - startedAt) } : {}),
          },
        })
      }
    }
  }

  private endMessage(ctx: MapperContext, out: MapperOutput, message: PiMessage): void {
    if (message.role === 'custom') {
      this.custom(ctx, out, message.content, message.display !== false)
      return
    }
    if (message.role !== 'assistant') return
    const reply = this.reply ?? {
      key: String(message.timestamp ?? ctx.now),
      startedAt: ctx.now,
      firstOutputAt: null,
      calls: new Map<number, string>(),
    }
    this.reply = null
    // The whole message stands over what streamed of it, and fills in what did not stream.
    this.blocks(ctx, out, reply.key, message, false)
    const usage = message.usage
    const tokens = tokenTotals(usage)
    if (!tokens || !usage) return
    this.used(ctx, out, tokens.total, usage)
    if (ctx.cancelling || message.stopReason === 'aborted' || message.stopReason === 'error') return
    const sentAt = latestTime(reply.startedAt, ctx.thread.session.turnStartedAt)
    const sample = timeRequest(usage.output, sentAt, reply.firstOutputAt, ctx.now)
    const session = ctx.thread.session
    const speed = sample && addSpeedSample(session.speed, sample, session.turnStartedAt)
    if (speed) out.patches.push({ op: 'session.update', changes: { speed } })
  }

  /** A message's blocks as entries: its text and thoughts, and the calls it makes. */
  private blocks(
    ctx: MapperContext,
    out: MapperOutput,
    key: string,
    message: PiMessage,
    replaying: boolean,
  ): void {
    const content = Array.isArray(message.content) ? message.content : []
    content.forEach((block, index) => {
      const id = `m:${key}-${index}`
      const existing = ctx.thread.byId[id]
      if (block.type === 'text' || block.type === 'thinking') {
        const kind = block.type === 'text' ? 'agent' : 'thought'
        const text = block.type === 'text' ? block.text : block.thinking
        if (existing?.kind === kind) {
          const changes: { markdown?: string; streaming?: false } = {}
          if (text !== '' && text !== existing.markdown) changes.markdown = text
          if (existing.streaming) changes.streaming = false
          if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
          if (kind === 'thought') ctx.scope.thoughts.delete(id)
          return
        }
        if (existing || text.trim() === '') return
        if (kind === 'agent') {
          addEntry(ctx, out, {
            kind: 'agent',
            id,
            markdown: text,
            attachments: [],
            streaming: false,
            ...(replaying ? {} : { at: ctx.now }),
          })
        } else {
          addEntry(ctx, out, { kind: 'thought', id, markdown: text, streaming: false })
        }
        return
      }
      // A call whose arguments already streamed whole has its row as it is.
      if (
        block.type === 'toolCall' &&
        (replaying || this.calls.get(block.id)?.args === undefined)
      ) {
        this.announce(ctx, out, block.id, block.name, block.arguments ?? {}, replaying)
      }
    })
  }

  private used(ctx: MapperContext, out: MapperOutput, used: number, usage: PiUsage): void {
    const previous = ctx.thread.session.usage
    const live = !ctx.replaying && !ctx.cancelling
    out.patches.push({
      op: 'session.update',
      changes: {
        usage: {
          used,
          size: this.contextWindow ?? previous?.size ?? 0,
          cost: previous?.cost ?? null,
          tokens: previous?.tokens ?? null,
          ...(live
            ? { cache: { lastRequestAt: ctx.now, ttl: previous?.cache?.ttl ?? null } }
            : previous?.cache
              ? { cache: previous.cache }
              : {}),
        },
      },
    })
    if (live) {
      out.effects.push({
        kind: 'request',
        cache: { read: usage.cacheRead, written: usage.cacheWrite },
      })
    }
  }

  /**
   * What pi's own count says the context holds and what the session cost, read once a turn has
   * settled; null when it names no context window.
   */
  stats(stats: PiStats, ctx: MapperContext): MapperOutput | null {
    const context = stats.contextUsage
    if (!context || !(context.contextWindow > 0)) return null
    const previous = ctx.thread.session.usage
    const used = typeof context.tokens === 'number' ? context.tokens : (previous?.used ?? 0)
    const cost =
      typeof stats.cost === 'number' && stats.cost > 0
        ? { amount: stats.cost, currency: 'USD' }
        : (previous?.cost ?? null)
    return {
      patches: [
        {
          op: 'session.update',
          changes: {
            usage: {
              used,
              size: context.contextWindow,
              cost,
              tokens: previous?.tokens ?? null,
              ...(previous?.cache ? { cache: previous.cache } : {}),
            },
          },
        },
      ],
      effects: [],
    }
  }

  // Tool calls.

  private hidden(name: string): boolean {
    return isClaudeRowlessCall(name)
  }

  /** A call a message names: its row once named, its input once the arguments are whole. */
  private announce(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    name: string,
    args: unknown,
    replaying = false,
  ): void {
    const known = this.calls.get(callId)
    this.calls.set(callId, { name, args: args ?? known?.args, shownAt: known?.shownAt ?? 0 })
    if (this.hidden(name)) return
    const id = `t:${callId}`
    const existing = ctx.thread.byId[id]
    const facts = toolFacts(name, args ?? {}, this.cwd)
    if (existing?.kind === 'tool') {
      if (args === undefined || existing.status !== 'pending') return
      out.patches.push({ op: 'entry.update', id, changes: { ...facts } })
      return
    }
    if (existing) return
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      status: replaying ? 'completed' : 'pending',
      permission: null,
      permissionResult: null,
      ...facts,
    }
    addEntry(ctx, out, entry)
    toolEffects(out, callId, id, null, entry)
  }

  private toolStart(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    name: string,
    args: unknown,
    before?: string | null,
  ): void {
    const known = this.calls.get(callId)
    const input = args ?? known?.args ?? {}
    this.calls.set(callId, { name, args: input, shownAt: 0 })
    if (this.hidden(name)) return
    const id = `t:${callId}`
    const facts = toolFacts(name, input, this.cwd)
    const content = writeBefore(facts.content, before)
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'tool') {
      const after: ToolEntry = { ...existing, ...facts, content, status: 'in_progress' }
      out.patches.push({
        op: 'entry.update',
        id,
        changes: { ...facts, content, status: 'in_progress' },
      })
      toolEffects(out, callId, id, existing.status, after)
      return
    }
    if (existing) return
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      status: 'in_progress',
      permission: null,
      permissionResult: null,
      ...facts,
      content,
    }
    addEntry(ctx, out, entry)
    toolEffects(out, callId, id, null, entry)
  }

  private toolUpdate(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    partial: PiToolResult | undefined,
  ): void {
    const call = this.calls.get(callId)
    const id = `t:${callId}`
    const existing = ctx.thread.byId[id]
    if (!call || existing?.kind !== 'tool' || !SHELL_TOOLS.has(call.name)) return
    if (ctx.now - call.shownAt < OUTPUT_EVERY_MS) return
    const text = toLf(blockText(partial?.content))
    if (text === '') return
    call.shownAt = ctx.now
    out.patches.push({
      op: 'entry.update',
      id,
      changes: { content: [{ type: 'markdown', markdown: fenced(cut(text)) }] },
    })
  }

  private toolEnd(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    name: string,
    result: PiToolResult | undefined,
    failed: boolean,
    before?: string | null,
  ): void {
    const call = this.calls.get(callId) ?? { name, args: {}, shownAt: 0 }
    this.calls.delete(callId)
    const id = `t:${callId}`
    const existing = ctx.thread.byId[id]
    if (this.hidden(call.name)) {
      // A memory write that failed wrote nothing, so its call shows as a failed row.
      if (!failed || !isClaudeRowWhenFailed(call.name) || existing) return
      const entry: ToolEntry = {
        kind: 'tool',
        id,
        status: 'failed',
        permission: null,
        permissionResult: null,
        ...toolFacts(call.name, call.args, this.cwd),
        content: resultContent(call.name, result, true, [], this.cwd, call.args),
      }
      addEntry(ctx, out, entry)
      toolEffects(out, callId, id, null, entry)
      return
    }
    if (existing?.kind !== 'tool') return
    const content = resultContent(
      call.name,
      result,
      failed,
      existing.content,
      this.cwd,
      call.args,
      before,
    )
    const line = record(result?.details).firstChangedLine
    const locations =
      !failed && typeof line === 'number' && line > 0 && existing.locations.length === 1
        ? [{ path: existing.locations[0]!.path, line }]
        : existing.locations
    const status = failed ? 'failed' : 'completed'
    const after: ToolEntry = { ...existing, status, content, locations }
    out.patches.push({ op: 'entry.update', id, changes: { status, content, locations } })
    toolEffects(out, callId, id, existing.status, after)
  }

  // Compaction.

  private compactionStart(ctx: MapperContext, out: MapperOutput): void {
    const id = `c:${ctx.nextId()}`
    this.compaction = id
    addEntry(ctx, out, { kind: 'compaction', id, status: 'in_progress', summary: '' })
  }

  private compactionEnd(
    ctx: MapperContext,
    out: MapperOutput,
    event: Extract<PiEvent, { type: 'compaction_end' }>,
  ): void {
    const status = event.aborted ? 'cancelled' : event.result ? 'completed' : 'failed'
    const summary = event.result?.summary ?? event.errorMessage ?? ''
    const id = this.compaction
    this.compaction = null
    const existing = id ? ctx.thread.byId[id] : undefined
    if (existing?.kind === 'compaction') {
      out.patches.push({ op: 'entry.update', id: existing.id, changes: { status, summary } })
      return
    }
    addEntry(ctx, out, { kind: 'compaction', id: `c:${ctx.nextId()}`, status, summary })
  }

  /** What an extension put into the conversation, when it means it to be seen. */
  private custom(
    ctx: MapperContext,
    out: MapperOutput,
    content: PiMessage['content'],
    display: boolean,
  ): void {
    const text = blockText(content).trim()
    if (!display || text === '') return
    addEntry(ctx, out, {
      kind: 'agent',
      id: ctx.nextId(),
      markdown: text,
      attachments: [],
      streaming: false,
      ...(ctx.replaying ? {} : { at: ctx.now }),
    })
  }

  // History.

  /** Maps one stored entry of the session's active branch, in order; null for one not shown. */
  entry(entry: PiEntry, ctx: MapperContext): MapperOutput | null {
    const out = output()
    switch (entry.type) {
      case 'message':
        if (!entry.message || !this.stored(ctx, out, entry.message, entry.id)) return null
        break
      case 'compaction':
        addEntry(ctx, out, {
          kind: 'compaction',
          id: `c:${entry.id}-${++this.compactions}`,
          status: 'completed',
          summary: entry.summary ?? '',
        })
        break
      case 'custom_message':
        this.custom(ctx, out, entry.content, entry.display !== false)
        break
      case 'session_info': {
        const title = entry.name?.trim() || null
        out.patches.push({ op: 'session.update', changes: { title } })
        out.effects.push({ kind: 'title', title })
        break
      }
      default:
        return null
    }
    return out
  }

  private stored(
    ctx: MapperContext,
    out: MapperOutput,
    message: PiMessage,
    entryId: string,
  ): boolean {
    switch (message.role) {
      case 'user':
        this.storedPrompt(ctx, out, message, entryId)
        return true
      case 'assistant': {
        this.blocks(ctx, out, String(message.timestamp ?? ctx.nextId()), message, true)
        const tokens = tokenTotals(message.usage)
        if (tokens && message.usage) this.used(ctx, out, tokens.total, message.usage)
        return true
      }
      case 'toolResult':
        if (message.toolCallId) this.storedResult(ctx, out, message.toolCallId, message)
        return true
      case 'bashExecution': {
        const command = toLf(message.command ?? '')
        const text = toLf(message.output ?? '')
        addEntry(ctx, out, {
          kind: 'tool',
          id: `t:${ctx.nextId()}`,
          status:
            typeof message.exitCode === 'number' && message.exitCode !== 0 ? 'failed' : 'completed',
          permission: null,
          permissionResult: null,
          title: command || t('codex.tool.runCommand'),
          toolKind: 'execute',
          locations: [],
          content: text ? [{ type: 'markdown', markdown: fenced(cut(text)) }] : [],
          ...(command ? { rawInput: command } : {}),
        })
        return true
      }
      case 'custom':
        this.custom(ctx, out, message.content, message.display !== false)
        return true
      default:
        return false
    }
  }

  private storedPrompt(
    ctx: MapperContext,
    out: MapperOutput,
    message: PiMessage,
    entryId: string,
  ): void {
    // Each stored prompt starts a turn, which scopes "current" plans.
    ctx.scope.planId = null
    const id = ctx.nextId()
    const blocks: PiContent[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (message.content ?? [])
    let content: UserContent[] = []
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = typedText(withoutAhead(block.text))
        if (text === '') continue
        const parts = parseReplayedText(text, id, content, out) ?? [{ type: 'text', text }]
        content = appendContent(content, parts)
      } else if (block.type === 'image') {
        const attachment = replayedAttachment(id, attachmentCount(content) + 1, {
          type: 'image',
          name: t('content.image', { number: imageCount(content) + 1 }),
          uri: null,
          mimeType: block.mimeType,
          size: base64Size(block.data),
          sent: 'image',
        })
        out.effects.push({
          kind: 'replayImage',
          entryId: id,
          attachmentId: attachment.id,
          mimeType: block.mimeType,
          data: block.data,
        })
        content = [...content, { type: 'ref', ref: { kind: 'attachment', attachment } }]
      }
    }
    if (content.length === 0) return
    const entry: ThreadEntry = {
      kind: 'user',
      id,
      content,
      ...(entryId ? { agentRef: entryId } : {}),
    }
    addEntry(ctx, out, entry)
  }

  private storedResult(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    message: PiMessage,
  ): void {
    const call = this.calls.get(callId) ?? { name: message.toolName ?? '', args: {}, shownAt: 0 }
    this.calls.delete(callId)
    const failed = message.isError === true
    const id = `t:${callId}`
    const existing = ctx.thread.byId[id]
    if (existing?.kind !== 'tool') {
      if (this.hidden(call.name) && !(failed && isClaudeRowWhenFailed(call.name))) return
      if (existing) return
      addEntry(ctx, out, {
        kind: 'tool',
        id,
        status: failed ? 'failed' : 'completed',
        permission: null,
        permissionResult: null,
        ...toolFacts(call.name, call.args, this.cwd),
        content: resultContent(call.name, message, failed, [], this.cwd, call.args),
      })
      return
    }
    const content = resultContent(call.name, message, failed, existing.content, this.cwd, call.args)
    const line = record(message.details).firstChangedLine
    const locations =
      !failed && typeof line === 'number' && line > 0 && existing.locations.length === 1
        ? [{ path: existing.locations[0]!.path, line }]
        : existing.locations
    out.patches.push({
      op: 'entry.update',
      id,
      changes: { status: failed ? 'failed' : 'completed', content, locations },
    })
  }
}

/**
 * The text a `write` call's file held before it, or null to show only what it wrote: for a new
 * file, when nobody read the file in time, and when what was read is what the call wrote, which a
 * read that came after the call also finds.
 */
function heldBefore(before: string | null | undefined, written: string): string | null {
  if (before === undefined || before === null) return null
  const text = toLf(before)
  return text === toLf(written) ? null : text
}

/** A `write` call's diff with the text its file held before, once that is known. */
function writeBefore(content: ToolContent[], before: string | null | undefined): ToolContent[] {
  return content.map((item) =>
    item.type === 'diff' && item.oldText === null
      ? { ...item, oldText: heldBefore(before, item.newText) }
      : item,
  )
}

/**
 * The entries of the active branch, from its root to `leafId`, which a replay shows: the tree also
 * holds branches the user left.
 */
export function activeBranch(entries: readonly PiEntry[], leafId: string | null): PiEntry[] {
  if (leafId === null) return []
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: PiEntry[] = []
  const seen = new Set<string>()
  for (let id: string | null = leafId; id !== null && !seen.has(id);) {
    const entry = byId.get(id)
    if (!entry) break
    seen.add(id)
    branch.push(entry)
    id = entry.parentId
  }
  return branch.reverse()
}

/**
 * The user message a fork that ends at a reply starts from: the first prompt after that reply on
 * the branch. The reply is found by its entry's time when Kettu named the entry after it, else as
 * the `occurrence`-th reply with that text. Null when no prompt follows it, so the fork takes the
 * whole branch, or when the reply is not on the branch.
 */
export function forkEntry(
  branch: readonly PiEntry[],
  point: { messageId: string; text: string; occurrence: number },
): { found: boolean; entryId: string | null } {
  const time = /^(\d+)-\d+$/.exec(point.messageId)?.[1]
  let at = -1
  if (time) {
    at = branch.findIndex(
      (entry) =>
        entry.type === 'message' &&
        entry.message?.role === 'assistant' &&
        String(entry.message.timestamp) === time,
    )
  }
  if (at === -1) {
    let seen = 0
    at = branch.findIndex((entry) => {
      if (entry.type !== 'message' || entry.message?.role !== 'assistant') return false
      const content = Array.isArray(entry.message.content) ? entry.message.content : []
      for (const block of content) {
        if (block.type === 'text' && block.text === point.text && ++seen === point.occurrence) {
          return true
        }
      }
      return false
    })
  }
  if (at === -1) return { found: false, entryId: null }
  const next = branch
    .slice(at + 1)
    .find((entry) => entry.type === 'message' && entry.message?.role === 'user')
  return { found: true, entryId: next?.id ?? null }
}

/** Prefix for user message references recorded from live stream timestamps. */
export const TIMESTAMP_REF_PREFIX = 'ts:'

const CONVERSATION_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'message',
  'compaction',
  'branch_summary',
  'custom_message',
])

/**
 * The user entry an edit from a message cuts before on the active branch: found by its entry id
 * (from history replay) or live message timestamp (`ts:<ms>`), else as the `occurrence`-th user
 * message matching the prompt's first line. `hasPriorHistory` is false when no conversation entry
 * precedes it on the branch (only metadata such as model or thinking level changes).
 */
export function rewindEntry(
  branch: readonly PiEntry[],
  point: RewindPoint,
): { entry: PiEntry; hasPriorHistory: boolean } | null {
  const isUser = (entry: PiEntry): boolean =>
    entry.type === 'message' && entry.message?.role === 'user'

  let at = -1
  if (point.ref !== null) {
    if (point.ref.startsWith(TIMESTAMP_REF_PREFIX)) {
      const ts = point.ref.slice(TIMESTAMP_REF_PREFIX.length)
      if (ts !== '') {
        at = branch.findIndex((entry) => isUser(entry) && String(entry.message?.timestamp) === ts)
      }
    } else {
      at = branch.findIndex((entry) => isUser(entry) && entry.id === point.ref)
    }
  }
  if (at === -1) {
    const line = point.text.trim()
    let seen = 0
    at = branch.findIndex((entry) => {
      if (!isUser(entry)) return false
      if (line !== '') {
        const raw = blockText(entry.message?.content)
        const shown = typedText(withoutAhead(raw))
        if (!raw.includes(line) && !shown.includes(line)) return false
      }
      return ++seen === point.occurrence
    })
  }
  if (at === -1) return null
  const hasPriorHistory = branch
    .slice(0, at)
    .some((entry) => CONVERSATION_ENTRY_TYPES.has(entry.type))
  return { entry: branch[at]!, hasPriorHistory }
}
