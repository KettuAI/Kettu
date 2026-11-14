// Turns DeepSeek Harness session events into the patches and effects every protocol's mapper
// produces. dsh commits a step's whole message at once, so replies, thoughts and tool calls arrive
// complete rather than as deltas.

import path from 'node:path'
import type {
  BackgroundTaskView,
  PlanItem,
  TokenTotals,
  ToolContent,
  ToolEntry,
  ToolKind,
} from '@shared/thread'
import { fenced } from '../codex/mapper'
import { t } from '../i18n'
import { isClaudeRowlessCall, isClaudeRowWhenFailed } from '../plan-tool'
import {
  addEntry,
  commandDescription,
  toLf,
  toolEffects,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import type { ContentBlock, EventData, FileChangeMeta, SessionEvent, TodoItem } from './protocol'

/** Output a tool printed, its start cut once it grows past this. */
const OUTPUT_LIMIT = 64 * 1024

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
/** Tools whose call the thread shows another way, as the plan: dsh's own and Kettu's. */
function hidden(name: string): boolean {
  return name === 'todo_write' || isClaudeRowlessCall(name)
}

/** Calls that start a subagent, which shows as a session of its own instead of a row. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork'])

function output(): MapperOutput {
  return { patches: [], effects: [] }
}

function cut(text: string): string {
  return text.length > OUTPUT_LIMIT ? `…\n${text.slice(text.length - OUTPUT_LIMIT)}` : text
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function absolute(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file)
}

/** The text of a message's blocks of `type`, joined. */
function blockText(blocks: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return blocks
    .flatMap((block) => (block.type === type ? [block.text] : []))
    .join('')
    .trim()
}

/** A dsh tool's MCP name `mcp__<server>__<tool>` as its parts, or null for a built-in tool. */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/.exec(name)
  return match ? { server: match[1]!, tool: match[2]! } : null
}

type ToolFacts = Pick<ToolEntry, 'title' | 'toolKind' | 'locations' | 'content'> &
  Pick<Partial<ToolEntry>, 'rawInput' | 'description' | 'question'>

/** What the thread shows of a call before its result: its title, kind, files and input. */
export function toolFacts(name: string, args: Record<string, unknown>, cwd: string): ToolFacts {
  const file = str(args.file_path) ?? str(args.path)
  const at = (kind: ToolKind, title: string): ToolFacts => ({
    title,
    toolKind: kind,
    locations: file ? [{ path: absolute(cwd, file) }] : [],
    content: [],
  })
  if (SHELL_TOOLS.has(name)) {
    const command = toLf(str(args.command) ?? '')
    const description = commandDescription(args)
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
    case 'read':
      return at('read', file ? t('codex.tool.readFile', { path: file }) : t('dsh.tool.read'))
    case 'read_image':
      return at('read', file ? t('codex.tool.viewImage', { path: file }) : t('dsh.tool.read'))
    case 'write': {
      const facts = at('edit', file ? t('dsh.tool.write', { path: file }) : t('dsh.tool.edit'))
      const content = str(args.content) ?? ''
      if (file)
        facts.content = [
          { type: 'diff', path: absolute(cwd, file), oldText: null, newText: content },
        ]
      return facts
    }
    case 'edit': {
      const facts = at('edit', file ? t('dsh.tool.editFile', { path: file }) : t('dsh.tool.edit'))
      const oldText = typeof args.old_string === 'string' ? args.old_string : null
      const newText = typeof args.new_string === 'string' ? args.new_string : null
      if (file && oldText !== null && newText !== null) {
        facts.content = [{ type: 'diff', path: absolute(cwd, file), oldText, newText }]
      }
      return facts
    }
    case 'glob': {
      const pattern = str(args.pattern) ?? ''
      const where = str(args.path)
      return {
        title: where
          ? t('codex.tool.searchIn', { query: pattern, path: where })
          : t('codex.tool.search', { query: pattern }),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'grep': {
      const pattern = str(args.pattern) ?? ''
      const where = str(args.path) ?? str(args.include)
      return {
        title: where
          ? t('codex.tool.searchIn', { query: pattern, path: where })
          : t('codex.tool.search', { query: pattern }),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'web_search': {
      const queries = Array.isArray(args.queries)
        ? args.queries.filter((query): query is string => typeof query === 'string')
        : []
      return {
        title: queries.length
          ? t('codex.tool.webSearch', { query: queries.join(' · ') })
          : t('codex.tool.webSearchAll'),
        toolKind: 'search',
        locations: [],
        content: [],
      }
    }
    case 'web_fetch': {
      const url = str(args.url)
      return {
        title: url ? t('codex.tool.openPage', { url }) : t('dsh.tool.fetch'),
        toolKind: 'fetch',
        locations: [],
        content: [],
      }
    }
    case 'subagent':
    case 'subagent_fork':
      return {
        title: str(args.description) ?? t('codex.tool.agent.spawnAgent'),
        toolKind: 'other',
        locations: [],
        content: [],
      }
    case 'ask_user_question': {
      const first = Array.isArray(args.questions) ? (args.questions[0] as unknown) : null
      const question =
        typeof first === 'object' && first !== null
          ? str((first as Record<string, unknown>).question)
          : null
      return {
        title: question ?? t('dsh.tool.ask'),
        toolKind: 'other',
        locations: [],
        content: [],
        ...(question ? { question } : {}),
      }
    }
    case 'exit_plan_mode':
      return { title: t('dsh.tool.plan'), toolKind: 'switch_mode', locations: [], content: [] }
  }
  const mcp = mcpTool(name)
  if (mcp) {
    return {
      title: t('codex.tool.mcp', mcp),
      toolKind: 'other',
      locations: [],
      content: [],
      rawInput: JSON.stringify(args, null, 2),
    }
  }
  return {
    title: name,
    toolKind: 'other',
    locations: [],
    content: [],
    ...(Object.keys(args).length ? { rawInput: JSON.stringify(args, null, 2) } : {}),
  }
}

function isFileChange(meta: unknown): meta is FileChangeMeta {
  if (typeof meta !== 'object' || meta === null) return false
  const value = meta as Record<string, unknown>
  return typeof value.path === 'string' && Array.isArray(value.diffs)
}

/** A result's text as the tool's output: a shell's printed text fenced, others as written. */
function resultContent(name: string, text: string): ToolContent[] {
  if (text === '') return []
  if (SHELL_TOOLS.has(name)) return [{ type: 'markdown', markdown: fenced(cut(toLf(text))) }]
  return [{ type: 'markdown', markdown: cut(toLf(text)) }]
}

/** A step's tokens in Kettu's totals: dsh's counts do not overlap. */
export function tokenTotals(usage: EventData['assistant/message']['usage']): TokenTotals | null {
  if (!usage) return null
  const cacheRead = usage.cacheReadTokens ?? null
  const cacheWrite = usage.cacheWriteTokens ?? null
  const input = usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    total: input + usage.outputTokens,
    input,
    output: usage.outputTokens,
    thought: usage.reasoningTokens ?? null,
    cacheRead,
    cacheWrite,
  }
}

function planItems(todos: readonly TodoItem[]): PlanItem[] {
  return todos.map((todo) => ({
    content: todo.content,
    priority: 'medium',
    status: todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
  }))
}

interface Call {
  name: string
  args: Record<string, unknown>
}

interface Job {
  id: string
  title: string
  command?: string
  status: BackgroundTaskView['status']
  startedAt: number
  endedAt: number | null
  summary: string | null
  /** Run in the background, or moved there, rather than within its call. */
  background: boolean
}

/** One dsh session's mapper: what Kettu shows of its events. */
export class SessionMapper {
  private readonly calls = new Map<string, Call>()
  private readonly jobs = new Map<string, Job>()
  private contextWindow: number | null = null
  private planId: string | null = null

  constructor(private readonly cwd: string) {}

  /** The call `callId` names, for an approval or question about it. */
  call(callId: string): Call | null {
    return this.calls.get(callId) ?? null
  }

  /** The latest call to `name` that has no result yet, which a question without an id answers. */
  openCall(name: string, ctx: MapperContext): string | null {
    let found: string | null = null
    for (const [callId, call] of this.calls) {
      if (call.name !== name) continue
      const entry = ctx.thread.byId[`t:${callId}`]
      if (entry?.kind === 'tool' && entry.status !== 'completed' && entry.status !== 'failed') {
        found = callId
      }
    }
    return found
  }

  /** Maps one event; null for one this mapper does not take. */
  event(event: SessionEvent, ctx: MapperContext): MapperOutput | null {
    const out = output()
    switch (event.type) {
      case 'assistant/message':
        this.message(ctx, out, event.data as EventData['assistant/message'])
        break
      case 'tool/call':
        this.toolCall(ctx, out, event.data as EventData['tool/call'])
        break
      case 'tool/result':
        this.toolResult(ctx, out, event.data as EventData['tool/result'])
        break
      case 'request/context': {
        const data = event.data as EventData['request/context']
        if (typeof data.contextWindow === 'number') this.contextWindow = data.contextWindow
        break
      }
      case 'todo/write':
        this.plan(ctx, out, (event.data as EventData['todo/write']).todos)
        break
      case 'turn/start':
        this.planId = null
        break
      case 'compaction/start':
        this.compaction(ctx, out, event.data as EventData['compaction/start'], 'in_progress')
        break
      case 'compaction/end': {
        const data = event.data as EventData['compaction/end']
        this.compaction(ctx, out, data, data.error ? 'failed' : 'completed')
        break
      }
      case 'llm/retry': {
        const data = event.data as EventData['llm/retry']
        addEntry(ctx, out, {
          kind: 'notice',
          id: ctx.nextId(),
          severity: 'warning',
          title: t('dsh.notice.retry', {
            retry: data.retry,
            max: data.maxRetries ?? '?',
          }),
          description: data.failure.message,
        })
        break
      }
      case 'job/registered':
      case 'job/settled':
        this.job(out, event.type, event.data, ctx.now)
        break
      default:
        return null
    }
    return out
  }

  private message(
    ctx: MapperContext,
    out: MapperOutput,
    data: EventData['assistant/message'],
  ): void {
    const { message } = data
    const thought = blockText(message.content, 'reasoning')
    if (thought) {
      // Both come in one event, so each gets an id of its own up front.
      const id = `m:${message.id}#thought`
      if (!ctx.thread.byId[id]) {
        addEntry(ctx, out, { kind: 'thought', id, markdown: thought, streaming: false })
      }
    }
    const text = blockText(message.content, 'text')
    if (text) {
      const id = `m:${message.id}`
      if (!ctx.thread.byId[id]) {
        addEntry(ctx, out, {
          kind: 'agent',
          id,
          markdown: text,
          attachments: [],
          streaming: false,
          ...(ctx.replaying ? {} : { at: ctx.now }),
        })
      }
    }
    const tokens = tokenTotals(data.usage)
    if (tokens) this.usage(ctx, out, tokens)
  }

  private usage(ctx: MapperContext, out: MapperOutput, step: TokenTotals): void {
    const previous = ctx.thread.session.usage
    out.patches.push({
      op: 'session.update',
      changes: {
        usage: {
          used: step.total,
          size: this.contextWindow ?? previous?.size ?? 0,
          cost: previous?.cost ?? null,
          tokens: previous?.tokens ?? null,
          ...(ctx.replaying || ctx.cancelling
            ? previous?.cache
              ? { cache: previous.cache }
              : {}
            : { cache: { lastRequestAt: ctx.now, ttl: previous?.cache?.ttl ?? null } }),
        },
      },
    })
    if (!ctx.replaying && !ctx.cancelling) out.effects.push({ kind: 'request' })
  }

  private toolCall(ctx: MapperContext, out: MapperOutput, data: EventData['tool/call']): void {
    const args = parseArgs(data.arguments)
    this.calls.set(data.callId, { name: data.name, args })
    if (hidden(data.name) || SUBAGENT_TOOLS.has(data.name)) return
    const id = `t:${data.callId}`
    if (ctx.thread.byId[id]) return
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      status: 'in_progress',
      permission: null,
      permissionResult: null,
      ...toolFacts(data.name, args, this.cwd),
    }
    addEntry(ctx, out, entry)
    toolEffects(out, data.callId, id, null, entry)
  }

  private toolResult(ctx: MapperContext, out: MapperOutput, data: EventData['tool/result']): void {
    const callId = data.message.toolCallId ?? (data.message.source as { callId?: string })?.callId
    if (!callId) return
    const call = this.calls.get(callId)
    if (!call) return
    const id = `t:${callId}`
    const text = data.message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    const failed = data.message.isError === true
    if (hidden(call.name)) {
      // A memory write that failed wrote nothing, so its call shows as a failed row.
      if (failed && isClaudeRowWhenFailed(call.name) && !ctx.thread.byId[id]) {
        this.failedCall(ctx, out, callId, call, data, text)
      }
      return
    }
    if (SUBAGENT_TOOLS.has(call.name)) {
      // No subagent started, so the call shows as a row with its reason.
      if (failed && !ctx.thread.byId[id]) this.failedCall(ctx, out, callId, call, data, text)
      return
    }
    const existing = ctx.thread.byId[id]
    if (existing?.kind !== 'tool') return
    if (SHELL_TOOLS.has(call.name)) this.moved(out, text)
    const content: ToolContent[] = []
    const change = isFileChange(data.meta) ? data.meta : null
    const diffs = change?.diffs ?? []
    if (failed) {
      content.push(...resultContent(call.name, data.error?.reason ?? text))
    } else if (change?.operation === 'update' && diffs.length === 0) {
      // An update without diffs left the file as it was.
    } else if (diffs.length > 0) {
      for (const diff of diffs) {
        content.push({
          type: 'diff',
          path: diff.path,
          oldText: diff.oldText,
          newText: diff.newText,
        })
      }
    } else if (call.name === 'write' || call.name === 'edit') {
      content.push(...existing.content)
    } else {
      content.push(...resultContent(call.name, text))
    }
    const after: ToolEntry = { ...existing, status: failed ? 'failed' : 'completed', content }
    out.patches.push({
      op: 'entry.update',
      id,
      changes: { status: after.status, content },
    })
    toolEffects(out, callId, id, existing.status, after)
  }

  private failedCall(
    ctx: MapperContext,
    out: MapperOutput,
    callId: string,
    call: Call,
    data: EventData['tool/result'],
    text: string,
  ): void {
    const entry: ToolEntry = {
      kind: 'tool',
      id: `t:${callId}`,
      status: 'failed',
      permission: null,
      permissionResult: null,
      ...toolFacts(call.name, call.args, this.cwd),
      content: resultContent(call.name, data.error?.reason ?? text),
    }
    addEntry(ctx, out, entry)
    toolEffects(out, callId, entry.id, null, entry)
  }

  private plan(ctx: MapperContext, out: MapperOutput, todos: readonly TodoItem[]): void {
    const items = planItems(todos)
    if (this.planId && ctx.thread.byId[this.planId]) {
      out.patches.push({ op: 'entry.update', id: this.planId, changes: { items } })
      return
    }
    this.planId = ctx.nextId()
    addEntry(ctx, out, { kind: 'plan', id: this.planId, items })
  }

  private compaction(
    ctx: MapperContext,
    out: MapperOutput,
    data: { compactionId: string },
    status: 'in_progress' | 'completed' | 'failed',
  ): void {
    const id = `c:${data.compactionId}`
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'compaction') {
      if (existing.status !== status)
        out.patches.push({ op: 'entry.update', id, changes: { status } })
      return
    }
    addEntry(ctx, out, { kind: 'compaction', id, status, summary: '' })
  }

  private job(out: MapperOutput, type: string, data: unknown, now: number): void {
    if (typeof data !== 'object' || data === null) return
    const value = data as Record<string, unknown>
    const id = str(value.jobId)
    if (!id) return
    const label = str(value.label) ?? id
    const call = value.toolCall as { callId?: unknown } | undefined
    const callId = typeof call?.callId === 'string' ? call.callId : null
    const startedAt = typeof value.startedAt === 'number' ? value.startedAt : now
    const previous = this.jobs.get(id)
    const job: Job = previous ?? {
      id,
      title: label,
      ...(value.kind === 'bash' ? { command: label } : {}),
      status: 'running',
      startedAt,
      endedAt: null,
      summary: null,
      background: callId !== null && this.calls.get(callId)?.args.run_in_background === true,
    }
    if (type === 'job/settled') {
      const status = str(value.status)
      job.status = status === 'completed' ? 'completed' : status === 'killed' ? 'stopped' : 'failed'
      job.endedAt = typeof value.finishedAt === 'number' ? value.finishedAt : now
      job.summary = str(value.detail)
    }
    this.jobs.set(id, job)
    if (job.background) out.effects.push({ kind: 'tasks', tasks: this.tasks() })
  }

  /** A command that ran past its wait goes on as a job, as its result says. */
  private moved(out: MapperOutput, text: string): void {
    const match = /moved to background job (\S+?)\]/.exec(text)
    const job = match ? this.jobs.get(match[1]!) : undefined
    if (!job || job.background) return
    job.background = true
    out.effects.push({ kind: 'tasks', tasks: this.tasks() })
  }

  /** The jobs that run beside the turn, which the session board lists. */
  private tasks(): BackgroundTaskView[] {
    return [...this.jobs.values()]
      .filter((job) => job.background)
      .map((job) => ({
        id: job.id,
        kind: job.command ? 'shell' : 'other',
        title: job.title,
        ...(job.command ? { command: job.command } : {}),
        status: job.status,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        summary: job.summary,
      }))
  }
}
