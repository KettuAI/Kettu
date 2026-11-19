// Turns the events of OpenCode's server into the patches and effects every protocol's mapper
// produces. A session's replies and thoughts stream as deltas; a tool call comes as its input,
// its call and its result. The same mapper reads a session's stored messages, for a history
// Kettu does not have and for what a dropped event stream missed.

import path from 'node:path'
import type {
  ContentRef,
  EntryChanges,
  PlanItem,
  TokenTotals,
  ToolContent,
  ToolEntry,
  UserContent,
} from '@shared/thread'
import { addSpeedSample, latestTime, timeRequest } from '@shared/output-speed'
import { callsOnlyRowless, listsOnlyRowless } from '../acp/kettu-calls'
import { replayedBlock } from '../acp/mapper'
import { diffHunks, fenced } from '../codex/mapper'
import { t } from '../i18n'
import {
  addEntry,
  commandDescription,
  firstUserMessage,
  repeatsFirstMessage,
  titleWithoutAhead,
  toLf,
  toolEffects,
  withoutAhead,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import type {
  AssistantPart,
  EventData,
  EventType,
  MessageFile,
  MessageInfo,
  PermissionRequestInfo,
  ServerEvent,
  StructuredError,
  TokenUsage,
  ToolResultContent,
} from './protocol'

/** Output a tool printed, its start cut once it grows past this. */
const OUTPUT_LIMIT = 64 * 1024

const SHELL = 'shell'
const SUBAGENT = 'subagent'
const QUESTION = 'question'
/** Code Mode's tool: a script that calls MCP tools as `tools.<server>.<tool>`. */
const EXECUTE = 'execute'
const TODO_TOOLS: ReadonlySet<string> = new Set(['todowrite', 'todo_write'])
const DATA_URL = /^data:([^;,]+);base64,([\s\S]+)$/

type ToolChanges = Partial<Omit<ToolEntry, 'kind' | 'id'>>
type ToolFacts = Pick<ToolEntry, 'title' | 'toolKind' | 'locations' | 'content'> &
  Pick<Partial<ToolEntry>, 'rawInput' | 'description' | 'question'>

interface Call {
  name: string
  input: Record<string, unknown>
  /** A script that may show no row, held without one until it ends. */
  held: boolean
}

function output(): MapperOutput {
  return { patches: [], effects: [] }
}

function cut(text: string): string {
  return text.length > OUTPUT_LIMIT ? `…\n${text.slice(text.length - OUTPUT_LIMIT)}` : text
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function absolute(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file)
}

/** A file as a title names it: within the session's folder by its path there. */
function shown(cwd: string, file: string): string {
  const relative = path.relative(cwd, absolute(cwd, file))
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? file : relative
}

/** The entry of the `ordinal`th reply an assistant message holds. */
export function textEntryId(messageId: string, ordinal: number): string {
  return ordinal === 0 ? `m:${messageId}` : `m:${messageId}.${ordinal}`
}

function thoughtEntryId(messageId: string, ordinal: number): string {
  return ordinal === 0 ? `m:${messageId}#thought` : `m:${messageId}#thought.${ordinal}`
}

/** The assistant message a reply's entry is part of, from the message id its entry id holds. */
export function assistantMessageId(entryMessageId: string): string {
  return entryMessageId.replace(/\.\d+$/, '')
}

/** A step's tokens in Kettu's totals. OpenCode counts cached input and reasoning apart. */
export function tokenTotals(tokens: TokenUsage | null | undefined): TokenTotals | null {
  if (!tokens) return null
  const read = tokens.cache?.read ?? 0
  const write = tokens.cache?.write ?? 0
  return {
    total: tokens.input + tokens.output + tokens.reasoning + read + write,
    input: tokens.input,
    output: tokens.output,
    thought: tokens.reasoning,
    cacheRead: read,
    cacheWrite: write,
  }
}

/** The tools a script calls, as `<server>.<tool>`, in the order its code names them. */
function scriptTools(code: string): string[] {
  const names: string[] = []
  for (const match of code.matchAll(
    /\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g,
  )) {
    const name = `${match[1]}.${match[2]}`
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** What the thread shows of a call before its result: its title, kind, files and input. */
export function toolFacts(name: string, input: Record<string, unknown>, cwd: string): ToolFacts {
  const file = str(input.path) ?? str(input.filePath)
  const at = (kind: ToolEntry['toolKind'], title: string): ToolFacts => ({
    title,
    toolKind: kind,
    locations: file ? [{ path: absolute(cwd, file) }] : [],
    content: [],
  })
  const search = (query: string | null, where: string | null): string =>
    query && where
      ? t('codex.tool.searchIn', { query, path: shown(cwd, where) })
      : query
        ? t('codex.tool.search', { query })
        : t('codex.tool.searchAll')
  switch (name) {
    case SHELL: {
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
    case 'read':
      return at(
        'read',
        file ? t('codex.tool.readFile', { path: shown(cwd, file) }) : t('dsh.tool.read'),
      )
    case 'write': {
      const facts = at(
        'edit',
        file ? t('dsh.tool.write', { path: shown(cwd, file) }) : t('dsh.tool.edit'),
      )
      if (file && typeof input.content === 'string') {
        facts.content = [
          { type: 'diff', path: absolute(cwd, file), oldText: null, newText: input.content },
        ]
      }
      return facts
    }
    case 'edit': {
      const facts = at(
        'edit',
        file ? t('dsh.tool.editFile', { path: shown(cwd, file) }) : t('dsh.tool.edit'),
      )
      const { oldString, newString } = input
      if (file && typeof oldString === 'string' && typeof newString === 'string') {
        facts.content = [
          { type: 'diff', path: absolute(cwd, file), oldText: oldString, newText: newString },
        ]
      }
      return facts
    }
    case 'patch':
    case 'apply_patch':
      return { title: t('codex.tool.editFiles'), toolKind: 'edit', locations: [], content: [] }
    case 'glob':
    case 'grep':
      return {
        title: search(str(input.pattern), str(input.path)),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    case 'list':
      return {
        title: file
          ? t('codex.tool.listFilesIn', { path: shown(cwd, file) })
          : t('codex.tool.listFiles'),
        toolKind: 'read',
        locations: [],
        content: [],
      }
    case 'websearch': {
      const query = str(input.query)
      return {
        title: query ? t('codex.tool.webSearch', { query }) : t('codex.tool.webSearchAll'),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'webfetch': {
      const url = str(input.url)
      return {
        title: url ? t('codex.tool.openPage', { url }) : t('dsh.tool.fetch'),
        toolKind: 'fetch',
        locations: [],
        content: [],
      }
    }
    case SUBAGENT:
      return {
        title: str(input.description) ?? t('codex.tool.agent.spawnAgent'),
        toolKind: 'other',
        locations: [],
        content: [],
      }
    case QUESTION: {
      const first = Array.isArray(input.questions) ? record(input.questions[0]) : {}
      const question = str(first.question)
      return {
        title: question ?? t('dsh.tool.ask'),
        toolKind: 'other',
        locations: [],
        content: [],
        ...(question ? { question } : {}),
      }
    }
    case 'skill': {
      const skill = str(input.name) ?? str(input.id) ?? str(input.skill)
      return {
        title: skill ? t('opencode.tool.skill', { name: skill }) : name,
        toolKind: 'read',
        locations: [],
        content: [],
      }
    }
    case EXECUTE: {
      const code = str(input.code)
      const tools = code ? scriptTools(code) : []
      return {
        title: tools.length > 0 ? tools.join(', ') : t('opencode.tool.script'),
        toolKind: 'other',
        locations: [],
        content: [],
        ...(code ? { rawInput: toLf(code) } : {}),
      }
    }
  }
  return {
    title: name || t('opencode.tool.call'),
    toolKind: 'other',
    locations: [],
    content: [],
    ...(Object.keys(input).length > 0 ? { rawInput: JSON.stringify(input, null, 2) } : {}),
  }
}

/** The files a result says it changed, as the diffs their patches hold. */
function changedFiles(metadata: Record<string, unknown>, cwd: string): ToolContent[] {
  const files = Array.isArray(metadata.files) ? metadata.files : []
  return files.flatMap((item): ToolContent[] => {
    const file = record(item)
    const name = str(file.file)
    const patch = str(file.patch)
    if (!name || !patch) return []
    const hunks = diffHunks(patch)
    if (!hunks) return []
    const target = absolute(cwd, name)
    return hunks.map((hunk) => ({
      type: 'diff',
      path: target,
      oldText: file.status === 'added' ? null : hunk.oldText,
      newText: hunk.newText,
    }))
  })
}

/** What a result holds as the tool's output: a shell's printed text fenced, others as written. */
function resultContent(name: string, content: readonly ToolResultContent[]): ToolContent[] {
  const out: ToolContent[] = []
  const text = content
    .flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n')
    .replace(/\n+$/, '')
  if (text !== '') {
    const markdown = name === SHELL ? fenced(cut(toLf(text))) : cut(toLf(text))
    out.push({ type: 'markdown', markdown })
  }
  for (const item of content) {
    if (item.type !== 'file') continue
    const data = DATA_URL.exec(item.uri)
    const ref: ContentRef =
      data && data[1]!.startsWith('image/')
        ? { kind: 'image', mimeType: data[1]!, data: data[2]! }
        : { kind: 'link', uri: item.uri, name: item.name ?? item.uri }
    out.push({ type: 'ref', ref })
  }
  return out
}

function planItems(todos: unknown): PlanItem[] | null {
  if (!Array.isArray(todos)) return null
  return todos.flatMap((item): PlanItem[] => {
    const todo = record(item)
    const content = str(todo.content)
    if (!content) return []
    const priority = todo.priority === 'high' || todo.priority === 'low' ? todo.priority : 'medium'
    return [
      {
        content,
        priority,
        status:
          todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
      },
    ]
  })
}

/** One OpenCode session's mapper, a subagent's included: what Kettu shows of its events. */
export class SessionMapper {
  private readonly calls = new Map<string, Call>()
  /** The entry of the compaction that runs, which its summary's deltas go to. */
  private compactionId: string | null = null
  private contextWindow: number | null = null
  /** The session's cost so far in US dollars, as OpenCode sums it. */
  private cost: number | null = null
  private planId: string | null = null
  /** When the request that runs went out, and when its first token came. */
  private sentAt: number | null = null
  private firstOutputAt: number | null = null
  /** A history Kettu did not write is being listed, in which a subagent's call is all it shows. */
  private listing = false

  constructor(private readonly cwd: string) {}

  /** The context window of the model the session runs on, once the connection knows it. */
  window(size: number | null): void {
    if (size !== null && size > 0) this.contextWindow = size
  }

  /** Whether the call `callId` names starts a subagent. */
  startsSubagent(callId: string): boolean {
    return this.calls.get(callId)?.name === SUBAGENT
  }

  /** The agent the subagent call `callId` names started, as OpenCode's `subagent` tool names it. */
  subagentAgent(callId: string): string | null {
    const call = this.calls.get(callId)
    return call?.name === SUBAGENT ? str(call.input.agent) : null
  }

  /** Maps one event; null for one this mapper does not take. */
  event(event: ServerEvent, ctx: MapperContext): MapperOutput | null {
    const out = output()
    const data = <K extends EventType>(): EventData[K] => (event.data ?? {}) as EventData[K]
    switch (event.type as EventType) {
      case 'session.step.started':
        this.sentAt = ctx.now
        this.firstOutputAt = null
        break
      case 'session.step.first-token':
        this.firstOutputAt ??= ctx.now
        break
      case 'session.step.ended':
        this.stepEnded(ctx, out, data<'session.step.ended'>().tokens)
        break
      case 'session.usage.updated':
        this.spent(ctx, out, data<'session.usage.updated'>().cost)
        break
      case 'session.text.delta': {
        const { assistantMessageID, ordinal, delta } = data<'session.text.delta'>()
        this.appendText(ctx, out, textEntryId(assistantMessageID, ordinal), delta)
        break
      }
      case 'session.text.ended': {
        const { assistantMessageID, ordinal, text } = data<'session.text.ended'>()
        this.text(ctx, out, textEntryId(assistantMessageID, ordinal), text, false)
        break
      }
      case 'session.reasoning.delta': {
        const { assistantMessageID, ordinal, delta } = data<'session.reasoning.delta'>()
        this.appendThought(ctx, out, thoughtEntryId(assistantMessageID, ordinal), delta)
        break
      }
      case 'session.reasoning.ended': {
        const { assistantMessageID, ordinal, text } = data<'session.reasoning.ended'>()
        this.thought(ctx, out, thoughtEntryId(assistantMessageID, ordinal), text, false)
        break
      }
      case 'session.tool.input.started': {
        const { id, name } = data<'session.tool.input.started'>()
        this.toolNamed(ctx, out, id, name)
        break
      }
      case 'session.tool.called': {
        const { id, input } = data<'session.tool.called'>()
        this.toolCalled(ctx, out, id, record(input))
        break
      }
      case 'session.tool.success': {
        const { id, content, metadata } = data<'session.tool.success'>()
        this.toolEnded(ctx, out, id, content ?? [], record(metadata), null)
        break
      }
      case 'session.tool.failed': {
        const { id, content, metadata, error } = data<'session.tool.failed'>()
        this.toolEnded(ctx, out, id, content ?? [], record(metadata), error ?? null)
        break
      }
      case 'session.retry.scheduled': {
        const { attempt, error } = data<'session.retry.scheduled'>()
        addEntry(ctx, out, {
          kind: 'notice',
          id: ctx.nextId(),
          severity: 'warning',
          title: t('opencode.notice.retry', { attempt: attempt ?? 1 }),
          ...(error?.message ? { description: error.message } : {}),
        })
        break
      }
      case 'session.compaction.started': {
        const { inputID } = data<'session.compaction.started'>()
        this.compactionId = `c:${inputID ?? event.id ?? ctx.nextId()}`
        this.compaction(ctx, out, this.compactionId, 'in_progress', null)
        break
      }
      case 'session.compaction.delta': {
        const id = this.compactionId
        const text = data<'session.compaction.delta'>().text
        if (id && text && ctx.thread.byId[id]?.kind === 'compaction') {
          out.patches.push({ op: 'entry.appendText', id, text })
        }
        break
      }
      case 'session.compaction.ended':
        if (this.compactionId) {
          const text = data<'session.compaction.ended'>().text ?? null
          this.compaction(ctx, out, this.compactionId, 'completed', text)
        }
        this.compactionId = null
        break
      case 'session.compaction.failed':
        if (this.compactionId) this.compaction(ctx, out, this.compactionId, 'failed', null)
        this.compactionId = null
        break
      case 'session.renamed':
        this.title(ctx, out, data<'session.renamed'>().title)
        break
      case 'session.execution.started':
        this.planId = null
        break
      default:
        return null
    }
    return out
  }

  /**
   * Maps one stored message: each part becomes its entry, or brings the entry the thread has up
   * to what the message holds. The caller applies each message's output before mapping the next.
   * `own` is for a thread Kettu wrote itself: it has the user's messages, and its subagents show
   * as sessions rather than as calls.
   */
  message(message: MessageInfo, ctx: MapperContext, own = false): MapperOutput {
    const out = output()
    this.listing = !own
    try {
      switch (message.type) {
        case 'user':
          if (!own) this.userMessage(ctx, out, message.id, message.text, message.files ?? [])
          break
        case 'assistant':
          this.assistantMessage(ctx, out, message.id, message.content ?? [])
          break
        case 'compaction':
          this.compaction(
            ctx,
            out,
            `c:${message.id}`,
            message.status === 'failed'
              ? 'failed'
              : message.status === 'running'
                ? 'in_progress'
                : 'completed',
            message.summary ?? null,
          )
          break
      }
    } finally {
      this.listing = false
    }
    return out
  }

  /**
   * The row a permission request is about, and what adds it when the thread has none: a held
   * script shows its row, and a request no call of the thread asked for gets one of its own.
   */
  asked(
    request: PermissionRequestInfo,
    ctx: MapperContext,
  ): { callId: string; output: MapperOutput } {
    const out = output()
    const callId = request.source?.type === 'tool' ? request.source.id : request.id
    const call = this.calls.get(callId)
    if (call) call.held = false
    if (ctx.thread.byId[`t:${callId}`]) return { callId, output: out }
    if (call) {
      this.row(ctx, out, callId, {
        ...toolFacts(call.name, call.input, this.cwd),
        status: 'in_progress',
      })
    } else {
      const what = request.resources.filter((resource) => resource !== '*').join(', ')
      this.row(ctx, out, callId, {
        title: what ? `${request.action}: ${what}` : request.action,
        toolKind: 'other',
        status: 'in_progress',
      })
    }
    return { callId, output: out }
  }

  /** The row of a form no call of the thread asked for, as the form titles it. */
  formRow(formId: string, title: string, ctx: MapperContext): MapperOutput {
    const out = output()
    if (!ctx.thread.byId[`t:${formId}`]) {
      this.row(ctx, out, formId, { title, toolKind: 'other', status: 'in_progress' })
    }
    return out
  }

  /** Ends a row made for a request rather than for a call, once the request is answered. */
  settle(callId: string, allowed: boolean, ctx: MapperContext): MapperOutput {
    const out = output()
    if (this.calls.has(callId)) return out
    const entry = ctx.thread.byId[`t:${callId}`]
    if (entry?.kind === 'tool' && (entry.status === 'in_progress' || entry.status === 'pending')) {
      this.row(ctx, out, callId, { status: allowed ? 'completed' : 'failed' })
    }
    return out
  }

  private appendText(ctx: MapperContext, out: MapperOutput, id: string, delta: string): void {
    if (!delta) return
    if (ctx.thread.byId[id]?.kind === 'agent') {
      out.patches.push({ op: 'entry.appendText', id, text: delta })
      return
    }
    this.text(ctx, out, id, delta, true)
  }

  private text(
    ctx: MapperContext,
    out: MapperOutput,
    id: string,
    text: string,
    streaming: boolean,
  ): void {
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'agent') {
      const changes: EntryChanges = {}
      if (existing.streaming !== streaming) Object.assign(changes, { streaming })
      if (!streaming && text !== '' && existing.markdown !== text) {
        Object.assign(changes, { markdown: text })
      }
      if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
      return
    }
    if (text === '') return
    addEntry(ctx, out, {
      kind: 'agent',
      id,
      markdown: text,
      attachments: [],
      streaming: streaming && !ctx.replaying,
      ...(ctx.replaying ? {} : { at: ctx.now }),
    })
  }

  private appendThought(ctx: MapperContext, out: MapperOutput, id: string, delta: string): void {
    if (!delta) return
    if (ctx.thread.byId[id]?.kind === 'thought') {
      out.patches.push({ op: 'entry.appendText', id, text: delta })
      return
    }
    this.thought(ctx, out, id, delta, true)
  }

  private thought(
    ctx: MapperContext,
    out: MapperOutput,
    id: string,
    text: string,
    streaming: boolean,
  ): void {
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'thought') {
      if (streaming) return
      const startedAt = ctx.scope.thoughts.get(id)
      ctx.scope.thoughts.delete(id)
      const changes: EntryChanges = {}
      if (existing.streaming) Object.assign(changes, { streaming: false })
      if (startedAt !== undefined) {
        Object.assign(changes, { durationMs: Math.max(0, ctx.now - startedAt) })
      }
      if (text !== '' && existing.markdown !== text) Object.assign(changes, { markdown: text })
      if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
      return
    }
    if (text.trim() === '') return
    const live = streaming && !ctx.replaying
    addEntry(ctx, out, { kind: 'thought', id, markdown: text, streaming: live })
    if (live) ctx.scope.thoughts.set(id, ctx.now)
  }

  /** Whether a call shows no row of its own while it runs. */
  private rowless(call: Call): boolean {
    return (call.name === SUBAGENT && !this.listing) || TODO_TOOLS.has(call.name) || call.held
  }

  private toolNamed(ctx: MapperContext, out: MapperOutput, callId: string, name: string): void {
    const call: Call = { name, input: {}, held: false }
    this.calls.set(callId, call)
    // A script's row waits for its code, which says whether it shows one at all.
    if (name === EXECUTE || this.rowless(call) || ctx.replaying) return
    this.row(ctx, out, callId, { ...toolFacts(name, {}, this.cwd), status: 'pending' })
  }

  private toolCalled(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    input: Record<string, unknown>,
  ): void {
    const call = this.take(ctx, out, callId, input)
    if (this.rowless(call)) return
    this.row(ctx, out, callId, {
      ...toolFacts(call.name, input, this.cwd),
      status: 'in_progress',
    })
  }

  /** Notes a call's input, and with it whether it shows a row; a list of todos shows as the plan. */
  private take(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    input: Record<string, unknown>,
  ): Call {
    const call = this.calls.get(callId) ?? { name: '', input, held: false }
    call.input = input
    this.calls.set(callId, call)
    if (TODO_TOOLS.has(call.name)) {
      const items = planItems(input.todos)
      if (items) this.plan(ctx, out, items)
    } else if (call.name === EXECUTE && !ctx.thread.byId[`t:${callId}`]) {
      const code = str(input.code)
      call.held = code !== null && callsOnlyRowless(code)
    }
    return call
  }

  private toolEnded(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    content: readonly ToolResultContent[],
    metadata: Record<string, unknown>,
    error: StructuredError | null,
  ): void {
    const call = this.calls.get(callId)
    if (!call) return
    const id = `t:${callId}`
    // A script that threw ends as a success whose metadata says so.
    const failed = error !== null || (call.name === EXECUTE && metadata.error === true)
    if (TODO_TOOLS.has(call.name) && !failed) return
    if (call.held && !failed && listsOnlyRowless(metadata)) return
    // A subagent that started shows as its session; one that did not, as a row with the reason.
    if (call.name === SUBAGENT && !failed && !this.listing && !ctx.thread.byId[id]) return
    const existing = ctx.thread.byId[id]
    const facts = toolFacts(call.name, call.input, this.cwd)
    let result: ToolContent[]
    if (failed) {
      const said = resultContent(call.name, content)
      result =
        said.length > 0
          ? said
          : error?.message
            ? [{ type: 'markdown', markdown: cut(toLf(error.message)) }]
            : []
    } else {
      const changed = changedFiles(metadata, this.cwd)
      if (changed.length > 0) result = changed
      else if (facts.content.length > 0) result = facts.content
      else result = resultContent(call.name, content)
    }
    const status: ToolEntry['status'] = failed
      ? ctx.cancelling && error?.type !== 'permission.rejected'
        ? 'cancelled'
        : 'failed'
      : 'completed'
    // A row the stream left without its input takes what the call was from here.
    const known = existing?.kind === 'tool' && existing.status === 'in_progress'
    this.row(ctx, out, callId, { ...(known ? {} : facts), status, content: result })
  }

  /** Adds the call's row, or changes the one the thread has. */
  private row(ctx: MapperContext, out: MapperOutput, callId: string, changes: ToolChanges): void {
    const id = `t:${callId}`
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'tool') {
      const after: ToolEntry = { ...existing, ...changes }
      out.patches.push({ op: 'entry.update', id, changes })
      toolEffects(out, callId, id, existing.status, after)
      return
    }
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      title: '',
      toolKind: 'other',
      status: 'pending',
      content: [],
      locations: [],
      permission: null,
      permissionResult: null,
      ...changes,
    }
    addEntry(ctx, out, entry)
    toolEffects(out, callId, id, null, entry)
  }

  private plan(ctx: MapperContext, out: MapperOutput, items: PlanItem[]): void {
    if (this.planId && ctx.thread.byId[this.planId]?.kind === 'plan') {
      out.patches.push({ op: 'entry.update', id: this.planId, changes: { items } })
      return
    }
    this.planId = ctx.nextId()
    addEntry(ctx, out, { kind: 'plan', id: this.planId, items })
  }

  private compaction(
    ctx: MapperContext,
    out: MapperOutput,
    id: string,
    status: 'in_progress' | 'completed' | 'failed',
    summary: string | null,
  ): void {
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'compaction') {
      const changes: EntryChanges = {}
      if (existing.status !== status) Object.assign(changes, { status })
      if (summary !== null && summary !== '' && existing.summary !== summary) {
        Object.assign(changes, { summary })
      }
      if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
      return
    }
    addEntry(ctx, out, { kind: 'compaction', id, status, summary: summary ?? '' })
  }

  /** A request ended: what it left in the context, and how fast its output came. */
  private stepEnded(ctx: MapperContext, out: MapperOutput, tokens: TokenUsage | undefined): void {
    const step = tokenTotals(tokens)
    const firstOutputAt = this.firstOutputAt
    const sentAt = latestTime(this.sentAt, ctx.thread.session.turnStartedAt)
    this.firstOutputAt = null
    this.sentAt = ctx.now
    if (!step || ctx.replaying) return
    const previous = ctx.thread.session.usage
    const request = !ctx.cancelling
    const cache = request
      ? { lastRequestAt: ctx.now, ttl: previous?.cache?.ttl ?? null }
      : previous?.cache
    const generated = step.output + (step.thought ?? 0)
    const sample = request ? timeRequest(generated, sentAt, firstOutputAt, ctx.now) : null
    const session = ctx.thread.session
    const speed = sample && addSpeedSample(session.speed, sample, session.turnStartedAt)
    out.patches.push({
      op: 'session.update',
      changes: {
        usage: {
          used: step.total,
          size: this.contextWindow ?? previous?.size ?? 0,
          cost: this.costOf(previous?.cost ?? null),
          tokens: previous?.tokens ?? null,
          ...(cache ? { cache } : {}),
        },
        ...(speed ? { speed } : {}),
        ...(request
          ? {
              lastRequest: {
                at: sentAt ?? ctx.now,
                input: step.input,
                cacheRead: step.cacheRead,
                cacheWrite: step.cacheWrite,
                output: generated,
                ms: sentAt === null ? null : ctx.now - sentAt,
              },
            }
          : {}),
      },
    })
    if (request) {
      out.effects.push({
        kind: 'request',
        cache: { read: step.cacheRead ?? 0, written: step.cacheWrite ?? 0 },
      })
    }
  }

  private costOf(previous: { amount: number; currency: string } | null) {
    return this.cost === null ? previous : { amount: this.cost, currency: 'USD' }
  }

  private spent(ctx: MapperContext, out: MapperOutput, cost: number | undefined): void {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost === this.cost) return
    this.cost = cost
    const usage = ctx.thread.session.usage
    if (!usage) return
    out.patches.push({
      op: 'session.update',
      changes: { usage: { ...usage, cost: { amount: cost, currency: 'USD' } } },
    })
  }

  private title(ctx: MapperContext, out: MapperOutput, given: string): void {
    const title = titleWithoutAhead(given)
    if (title === '' || repeatsFirstMessage(title, firstUserMessage(ctx.thread))) return
    if (ctx.thread.session.title === title) return
    out.patches.push({ op: 'session.update', changes: { title, updatedAt: ctx.now } })
    out.effects.push({ kind: 'title', title })
  }

  private userMessage(
    ctx: MapperContext,
    out: MapperOutput,
    messageId: string,
    text: string,
    files: readonly MessageFile[],
  ): void {
    const id = `m:${messageId}#user`
    if (ctx.thread.byId[id]) return
    let content: UserContent[] = []
    const said = withoutAhead(text)
    if (said !== '') content.push({ type: 'text', text: said })
    for (const file of files) {
      const name = file.name ?? file.mime
      const block =
        file.source?.type === 'uri'
          ? { type: 'resource_link' as const, uri: file.source.uri, name, mimeType: file.mime }
          : file.mime.startsWith('image/')
            ? { type: 'image' as const, mimeType: file.mime, data: file.data }
            : null
      const refs: UserContent[] = (block ? replayedBlock(block, id, content, out) : null) ?? [
        { type: 'ref', ref: { kind: 'unsupported', label: name } },
      ]
      content = [...content, ...refs]
    }
    if (content.length === 0) return
    addEntry(ctx, out, { kind: 'user', id, content })
  }

  private assistantMessage(
    ctx: MapperContext,
    out: MapperOutput,
    messageId: string,
    parts: readonly AssistantPart[],
  ): void {
    let texts = 0
    let thoughts = 0
    for (const part of parts) {
      if (part.type === 'text') {
        this.text(ctx, out, textEntryId(messageId, texts++), part.text, false)
      } else if (part.type === 'reasoning') {
        this.thought(ctx, out, thoughtEntryId(messageId, thoughts++), part.text, false)
      } else if (part.type === 'tool') {
        const { state } = part
        if (state.status === 'streaming') continue
        const entry = ctx.thread.byId[`t:${part.id}`]
        if (
          entry?.kind === 'tool' &&
          entry.status !== 'pending' &&
          entry.status !== 'in_progress'
        ) {
          continue
        }
        if (!this.calls.has(part.id)) {
          this.calls.set(part.id, { name: part.name, input: {}, held: false })
        }
        const input = record(state.input)
        if (state.status === 'running') {
          this.toolCalled(ctx, out, part.id, input)
          continue
        }
        // One patch for a call that ended: its row with its result.
        this.take(ctx, out, part.id, input)
        this.toolEnded(
          ctx,
          out,
          part.id,
          state.content ?? [],
          record(state.metadata),
          state.status === 'error' ? state.error : null,
        )
      }
    }
  }
}
