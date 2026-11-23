// Turns the events of Cline's SDK into the patches and effects every protocol's mapper produces.
// Text and reasoning stream as chunks without a message id, so the mapper keeps the entry each
// goes to. The events of a subagent's own run come between its `spawn_agent` call's start and end
// and name no agent, so they are dropped: the call's row shows its task and what it returned.

import path from 'node:path'
import type { TokenTotals, ToolContent, ToolEntry, ToolKind } from '@shared/thread'
import { addSpeedSample, latestTime, timeRequest } from '@shared/output-speed'
import { fenced } from '../codex/mapper'
import { t } from '../i18n'
import { isRowWhenFailed, isRowlessCall } from '../plan-tool'
import {
  addEntry,
  closeThoughts,
  toLf,
  toolEffects,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import type { ClineEvent, ClineUsage } from './protocol'

/** Output a tool printed, its start cut once it grows past this. */
const OUTPUT_LIMIT = 64 * 1024

const SHELL_TOOL = 'run_commands'
const EDIT_TOOLS: ReadonlySet<string> = new Set(['editor', 'apply_patch'])
const SUBAGENT_TOOL = 'spawn_agent'
/** The runtime's own summary of the calls that failed in a step, which it sends as an error. */
const FAILED_CALLS = /^\d+ tool call\(s\) failed/
/** What Cline's runtime answers a call with once the user denied it. */
const USER_REJECTED = 'rejected by the user and not executed'

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

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function absolute(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file)
}

/** A file as a title names it: within the session's folder, by its path from there. */
function shown(cwd: string, file: string): string {
  const inside = path.relative(cwd, absolute(cwd, file))
  return inside === '' || inside.startsWith('..') || path.isAbsolute(inside) ? file : inside
}

/** The name Cline gives an MCP tool, `<server>__<tool>`, as its parts; null for its own tools. */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const at = name.indexOf('__')
  if (at <= 0 || at + 2 >= name.length) return null
  return { server: name.slice(0, at), tool: name.slice(at + 2) }
}

function hidden(name: string): boolean {
  const mcp = mcpTool(name)
  return mcp !== null && isRowlessCall(mcp.server, mcp.tool)
}

function rowWhenFailed(name: string): boolean {
  const mcp = mcpTool(name)
  return mcp !== null && isRowWhenFailed(mcp.server, mcp.tool)
}

/** The commands of a `run_commands` call, each as the line the shell runs. */
function commandLines(input: Record<string, unknown>): string[] {
  return list(input.commands).flatMap((item) => {
    if (typeof item === 'string') return [item]
    const command = str(record(item).command)
    if (!command) return []
    const args = list(record(item).args).filter((arg): arg is string => typeof arg === 'string')
    return [[command, ...args].join(' ')]
  })
}

interface PatchFile {
  path: string
  /** Null for a file the patch adds. */
  oldText: string | null
  newText: string
}

/**
 * The files an `apply_patch` payload changes, each hunk as the text it replaces and the text it
 * leaves. A file the patch deletes has no text to show and is left out.
 */
export function patchFiles(patch: string, cwd: string): PatchFile[] {
  const files: PatchFile[] = []
  let file: string | null = null
  let added = false
  let before: string[] = []
  let after: string[] = []
  const flush = (): void => {
    if (file !== null && (before.length > 0 || after.length > 0)) {
      files.push({
        path: absolute(cwd, file),
        oldText: added ? null : before.join('\n'),
        newText: after.join('\n'),
      })
    }
    before = []
    after = []
  }
  for (const line of toLf(patch).split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      flush()
      file = header[1] === 'Delete' ? null : header[2]!.trim()
      added = header[1] === 'Add'
      continue
    }
    if (line.startsWith('*** ')) {
      if (line.startsWith('*** End Patch')) flush()
      continue
    }
    if (file === null) continue
    if (line.startsWith('@@')) flush()
    else if (line.startsWith('+')) after.push(line.slice(1))
    else if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith(' ')) {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
  }
  flush()
  return files
}

type ToolFacts = Pick<ToolEntry, 'title' | 'toolKind' | 'locations' | 'content'> &
  Pick<Partial<ToolEntry>, 'rawInput' | 'description' | 'question'>

/** What the thread shows of a call before its result: its title, kind, files and input. */
export function toolFacts(name: string, raw: unknown, cwd: string): ToolFacts {
  const input = record(raw)
  const facts = (kind: ToolKind, title: string, files: string[] = []): ToolFacts => ({
    title,
    toolKind: kind,
    locations: files.map((file) => ({ path: absolute(cwd, file) })),
    content: [],
  })
  switch (name) {
    case 'read_files': {
      const files = list(input.files).flatMap((file) => str(record(file).path) ?? [])
      const title = files[0]
        ? t('codex.tool.readFile', { path: files.map((file) => shown(cwd, file)).join(', ') })
        : t('dsh.tool.read')
      return facts('read', title, files)
    }
    case 'search_codebase': {
      const queries = list(input.queries).filter((query): query is string => !!str(query))
      return facts(
        'search',
        queries.length > 0
          ? t('codex.tool.search', { query: queries.join(' · ') })
          : t('codex.tool.searchAll'),
      )
    }
    case SHELL_TOOL: {
      const command = toLf(commandLines(input).join('\n'))
      return {
        ...facts('execute', command || t('codex.tool.runCommand')),
        ...(command ? { rawInput: command } : {}),
      }
    }
    case 'fetch_web_content': {
      const urls = list(input.requests).flatMap((request) => str(record(request).url) ?? [])
      return facts(
        'fetch',
        urls[0] ? t('codex.tool.openPage', { url: urls.join(', ') }) : t('dsh.tool.fetch'),
      )
    }
    case 'web_search': {
      const query = str(input.query)
      return facts(
        'search',
        query ? t('codex.tool.webSearch', { query }) : t('codex.tool.webSearchAll'),
      )
    }
    case 'editor': {
      const file = str(input.path)
      const oldText = typeof input.old_text === 'string' ? input.old_text : null
      const newText = typeof input.new_text === 'string' ? input.new_text : ''
      const inserts = typeof input.insert_line === 'number' || str(input.insert_line) !== null
      // Without text to replace or a line to insert at, the call writes a new file.
      const creates = oldText === null && !inserts
      const entry = facts(
        'edit',
        file
          ? t(creates ? 'dsh.tool.write' : 'dsh.tool.editFile', { path: shown(cwd, file) })
          : t('dsh.tool.edit'),
        file ? [file] : [],
      )
      if (file) {
        entry.content = [
          {
            type: 'diff',
            path: absolute(cwd, file),
            oldText: creates ? null : (oldText ?? ''),
            newText,
          },
        ]
      }
      return entry
    }
    case 'apply_patch': {
      const files = patchFiles(typeof raw === 'string' ? raw : (str(input.input) ?? ''), cwd)
      const paths = [...new Set(files.map((file) => file.path))]
      const entry = facts(
        'edit',
        paths.length === 1
          ? t('dsh.tool.editFile', { path: shown(cwd, paths[0]!) })
          : t('codex.tool.editFiles'),
        paths,
      )
      entry.content = files.map((file) => ({ type: 'diff', ...file }))
      return entry
    }
    case SUBAGENT_TOOL: {
      const task = str(input.task)
      return {
        ...facts('other', t('codex.tool.agent.spawnAgent')),
        ...(task ? { description: task } : {}),
      }
    }
    case 'ask_question':
    case 'ask_followup_question': {
      const question = str(input.question)
      return { ...facts('other', question ?? t('dsh.tool.ask')), ...(question ? { question } : {}) }
    }
  }
  const mcp = mcpTool(name)
  const text = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : null
  return {
    ...facts('other', mcp ? t('codex.tool.mcp', mcp) : name),
    ...(text ? { rawInput: text } : {}),
  }
}

/** The text of one result of a tool that answers per query, or the error it gave. */
function resultText(item: unknown): string {
  const entry = record(item)
  const error = str(entry.error)
  if (error) return error
  const { result } = entry
  if (typeof result === 'string') return result
  // An image a read returned, or blocks of text.
  return list(result)
    .flatMap((block) => str(record(block).text) ?? [])
    .join('\n')
}

/** What a tool returned as text: its results in order, an MCP result's text, or the JSON. */
export function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(resultText)
      .filter((text) => text !== '')
      .join('\n')
  }
  const entry = record(value)
  if (typeof entry.result === 'string' || str(entry.error)) return resultText(entry)
  if (typeof entry.text === 'string') return entry.text
  const blocks = list(entry.content).flatMap((block) => str(record(block).text) ?? [])
  if (blocks.length > 0) return blocks.join('\n')
  return value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
}

/** A call's error as its words: the runtime wraps some as `{"error": "..."}`. */
function errorText(error: string): string {
  if (!error.startsWith('{')) return error
  try {
    const inner = (JSON.parse(error) as { error?: unknown }).error
    return typeof inner === 'string' ? inner : error
  } catch {
    return error
  }
}

/** Whether a tool's own answer says it failed, though the call returned. */
function reportsFailure(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value]
  return items.length > 0 && items.every((item) => record(item).success === false)
}

function resultContent(name: string, text: string): ToolContent[] {
  if (text === '') return []
  const body = cut(toLf(text))
  return [{ type: 'markdown', markdown: name === SHELL_TOOL ? fenced(body) : body }]
}

/**
 * A request's tokens in Kettu's totals. Cline's input holds what its cache served and took, except
 * from a provider of the user's own that counts it apart, whose input can then be under it.
 */
export function tokenTotals(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokenCount?: number
}): TokenTotals {
  const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const held = usage.inputTokens >= cached ? cached : 0
  return {
    total: usage.inputTokens + usage.outputTokens + cached - held,
    input: usage.inputTokens - held,
    output: usage.outputTokens,
    thought: usage.reasoningTokenCount ?? null,
    cacheRead: usage.cacheReadTokens ?? null,
    cacheWrite: usage.cacheWriteTokens ?? null,
  }
}

interface Call {
  name: string
  input: unknown
  /** What a command printed so far. */
  printed: string
}

/** One Cline session's mapper: what Kettu shows of its events. */
export class SessionMapper {
  private readonly calls = new Map<string, Call>()
  /** The `spawn_agent` calls that run, whose subagents' events are not the session's own. */
  private readonly spawns = new Set<string>()
  private contextWindow: number | null = null
  private textId: string | null = null
  private thoughtId: string | null = null
  /** The divider of the compaction that runs. */
  private compactionId: string | null = null
  /** When the request that is answering went out, and when its first output came. */
  private sentAt: number | null = null
  private firstOutputAt: number | null = null

  constructor(private readonly cwd: string) {}

  /** The context window of the session's model, when its provider's catalog names one. */
  window(size: number | null): void {
    this.contextWindow = size
  }

  /** A turn starts: nothing of the one before it streams on. */
  turn(): void {
    this.textId = null
    this.thoughtId = null
    this.spawns.clear()
  }

  /**
   * The row of a call that waits for the user's answer, which Cline asks for before it says the
   * call started. Null for a call that shows no row.
   */
  announce(toolCallId: string, name: string, input: unknown, ctx: MapperContext): MapperOutput {
    const out = output()
    this.calls.set(toolCallId, { name, input, printed: '' })
    const id = `t:${toolCallId}`
    if (ctx.thread.byId[id]) return out
    this.endText(ctx, out)
    addEntry(ctx, out, {
      kind: 'tool',
      id,
      status: 'pending',
      permission: null,
      permissionResult: null,
      ...toolFacts(name, input, this.cwd),
    })
    return out
  }

  /** The turn ended: a compaction it was stopped in did not happen. Null when none ran. */
  ended(ctx: MapperContext): MapperOutput | null {
    if (!this.compactionId) return null
    const out = output()
    this.endCompaction(ctx, out, 'cancelled')
    return out
  }

  /** Maps one event; null for one the thread shows nothing of. */
  event(event: ClineEvent, ctx: MapperContext): MapperOutput | null {
    if (this.spawns.size > 0 && !this.own(event)) return null
    const out = output()
    switch (event.type) {
      case 'iteration_start':
        this.sentAt = ctx.now
        this.firstOutputAt = null
        return out
      case 'content_start':
        this.firstOutputAt ??= ctx.now
        if (event.contentType === 'text') this.text(ctx, out, event.text ?? '')
        else if (event.contentType === 'reasoning') this.thought(ctx, out, event.reasoning ?? '')
        else if (event.contentType === 'tool') this.toolStart(ctx, out, event)
        return out
      case 'content_update':
        this.toolUpdate(ctx, out, event)
        return out
      case 'content_end':
        if (event.contentType === 'text') this.endText(ctx, out)
        else if (event.contentType === 'reasoning') this.endThought(ctx, out)
        else if (event.contentType === 'tool') this.toolEnd(ctx, out, event)
        else if (event.contentType === 'media') this.media(ctx, out, event)
        return out
      case 'usage':
        this.usage(ctx, out, event)
        return out
      case 'notice':
        this.notice(ctx, out, event)
        return out
      case 'error':
        // One it cannot go on from fails the turn, which says so itself, and the compaction it
        // came in the middle of; a failed call's own row says so too.
        if (!event.recoverable) this.endCompaction(ctx, out, 'failed')
        if (event.recoverable && !FAILED_CALLS.test(event.error.message)) {
          addEntry(ctx, out, {
            kind: 'notice',
            id: ctx.nextId(),
            severity: 'warning',
            title: event.error.message,
          })
        }
        return out
      default:
        return null
    }
  }

  /** Whether an event that arrives while a subagent runs is still the session's own. */
  private own(event: ClineEvent): boolean {
    if (event.type !== 'content_start' && event.type !== 'content_end') return false
    if (event.contentType !== 'tool' || !event.toolCallId) return false
    if (event.type === 'content_start' && event.toolName === SUBAGENT_TOOL) return true
    return this.calls.has(event.toolCallId)
  }

  private text(ctx: MapperContext, out: MapperOutput, text: string): void {
    if (text === '') return
    const existing = this.textId ? ctx.thread.byId[this.textId] : undefined
    if (existing?.kind === 'agent') {
      out.patches.push({ op: 'entry.appendText', id: existing.id, text })
      return
    }
    this.textId = ctx.nextId()
    addEntry(ctx, out, {
      kind: 'agent',
      id: this.textId,
      markdown: text,
      attachments: [],
      streaming: !ctx.replaying,
      ...(ctx.replaying ? {} : { at: ctx.now }),
    })
  }

  private endText(ctx: MapperContext, out: MapperOutput): void {
    const id = this.textId
    this.textId = null
    const entry = id ? ctx.thread.byId[id] : undefined
    if (entry?.kind === 'agent' && entry.streaming) {
      out.patches.push({ op: 'entry.update', id: entry.id, changes: { streaming: false } })
    }
  }

  private thought(ctx: MapperContext, out: MapperOutput, text: string): void {
    if (text === '') return
    const existing = this.thoughtId ? ctx.thread.byId[this.thoughtId] : undefined
    if (existing?.kind === 'thought' && existing.streaming) {
      out.patches.push({ op: 'entry.appendText', id: existing.id, text })
      return
    }
    this.thoughtId = ctx.nextId()
    addEntry(ctx, out, {
      kind: 'thought',
      id: this.thoughtId,
      markdown: text,
      streaming: !ctx.replaying,
    })
    if (!ctx.replaying) ctx.scope.thoughts.set(this.thoughtId, ctx.now)
  }

  private endThought(ctx: MapperContext, out: MapperOutput): void {
    this.thoughtId = null
    closeThoughts(ctx, out)
  }

  private toolStart(
    ctx: MapperContext,
    out: MapperOutput,
    event: Extract<ClineEvent, { type: 'content_start' }>,
  ): void {
    const { toolCallId, toolName } = event
    if (!toolCallId || !toolName) return
    const known = this.calls.get(toolCallId)
    this.calls.set(toolCallId, {
      name: toolName,
      input: event.input,
      printed: known?.printed ?? '',
    })
    if (toolName === SUBAGENT_TOOL) this.spawns.add(toolCallId)
    if (hidden(toolName)) return
    this.endText(ctx, out)
    const id = `t:${toolCallId}`
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'tool') {
      if (existing.status !== 'pending') return
      out.patches.push({ op: 'entry.update', id, changes: { status: 'in_progress' } })
      toolEffects(out, toolCallId, id, existing.status, { ...existing, status: 'in_progress' })
      return
    }
    const entry: ToolEntry = {
      kind: 'tool',
      id,
      status: 'in_progress',
      permission: null,
      permissionResult: null,
      ...toolFacts(toolName, event.input, this.cwd),
    }
    addEntry(ctx, out, entry)
    toolEffects(out, toolCallId, id, null, entry)
  }

  /** What a command prints while it runs. */
  private toolUpdate(
    ctx: MapperContext,
    out: MapperOutput,
    event: Extract<ClineEvent, { type: 'content_update' }>,
  ): void {
    const call = event.toolCallId ? this.calls.get(event.toolCallId) : undefined
    const chunk = str(record(event.update).chunk)
    if (!call || call.name !== SHELL_TOOL || !chunk) return
    call.printed += chunk
    const id = `t:${event.toolCallId}`
    if (ctx.thread.byId[id]?.kind !== 'tool') return
    out.patches.push({
      op: 'entry.update',
      id,
      changes: { content: resultContent(SHELL_TOOL, call.printed) },
    })
  }

  private toolEnd(
    ctx: MapperContext,
    out: MapperOutput,
    event: Extract<ClineEvent, { type: 'content_end' }>,
  ): void {
    const { toolCallId } = event
    if (!toolCallId) return
    const call = this.calls.get(toolCallId)
    if (!call) return
    this.spawns.delete(toolCallId)
    const failed = !!event.error || reportsFailure(event.output)
    const text = event.error ? errorText(event.error) : outputText(event.output)
    // The card's answer already says the user denied the call.
    const denied = failed && text.includes(USER_REJECTED)
    const id = `t:${toolCallId}`
    const existing = ctx.thread.byId[id]
    if (existing?.kind !== 'tool') {
      // A memory write that failed wrote nothing, so its call shows as a failed row.
      if (failed && rowWhenFailed(call.name)) {
        const entry: ToolEntry = {
          kind: 'tool',
          id,
          status: 'failed',
          permission: null,
          permissionResult: null,
          ...toolFacts(call.name, call.input, this.cwd),
          content: resultContent(call.name, text),
        }
        addEntry(ctx, out, entry)
        toolEffects(out, toolCallId, id, null, entry)
      }
      return
    }
    // An edit that went through shows its diff; one that failed shows why.
    const content = denied
      ? []
      : EDIT_TOOLS.has(call.name) && !failed
        ? existing.content
        : resultContent(call.name, text)
    const after: ToolEntry = { ...existing, status: failed ? 'failed' : 'completed', content }
    out.patches.push({ op: 'entry.update', id, changes: { status: after.status, content } })
    toolEffects(out, toolCallId, id, existing.status, after)
  }

  /** An image the model made, on the reply it belongs to. */
  private media(
    ctx: MapperContext,
    out: MapperOutput,
    event: Extract<ClineEvent, { type: 'content_end' }>,
  ): void {
    const media = event.media
    if (!media) return
    const data = media.source.type === 'base64' ? media.source.data : undefined
    if (media.modality !== 'image' || !data) {
      this.text(ctx, out, `[${media.modality}: ${media.mediaType}]`)
      return
    }
    const ref = { kind: 'image' as const, mimeType: media.mediaType, data }
    const existing = this.textId ? ctx.thread.byId[this.textId] : undefined
    if (existing?.kind === 'agent') {
      out.patches.push({
        op: 'entry.update',
        id: existing.id,
        changes: { attachments: [...existing.attachments, ref] },
      })
      return
    }
    this.textId = ctx.nextId()
    addEntry(ctx, out, {
      kind: 'agent',
      id: this.textId,
      markdown: '',
      attachments: [ref],
      streaming: !ctx.replaying,
      ...(ctx.replaying ? {} : { at: ctx.now }),
    })
  }

  private usage(ctx: MapperContext, out: MapperOutput, usage: ClineUsage): void {
    const { session } = ctx.thread
    const previous = session.usage
    const live = !ctx.replaying && !ctx.cancelling
    const cost = typeof usage.cost === 'number' ? usage.cost : null
    out.patches.push({
      op: 'session.update',
      changes: {
        usage: {
          used: usage.inputTokens + usage.outputTokens,
          size: this.contextWindow ?? previous?.size ?? 0,
          cost:
            cost === null
              ? (previous?.cost ?? null)
              : { amount: (previous?.cost?.amount ?? 0) + cost, currency: 'USD' },
          tokens: previous?.tokens ?? null,
          ...(live
            ? { cache: { lastRequestAt: ctx.now, ttl: previous?.cache?.ttl ?? null } }
            : previous?.cache
              ? { cache: previous.cache }
              : {}),
        },
      },
    })
    if (!live) return
    out.effects.push({
      kind: 'request',
      ...(usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined
        ? { cache: { read: usage.cacheReadTokens ?? 0, written: usage.cacheWriteTokens ?? 0 } }
        : {}),
    })
    const sample = timeRequest(
      usage.outputTokens + (usage.reasoningTokenCount ?? 0),
      latestTime(this.sentAt, session.turnStartedAt),
      this.firstOutputAt,
      ctx.now,
    )
    const speed = sample && addSpeedSample(session.speed, sample, session.turnStartedAt)
    if (speed) out.patches.push({ op: 'session.update', changes: { speed } })
  }

  private notice(
    ctx: MapperContext,
    out: MapperOutput,
    event: Extract<ClineEvent, { type: 'notice' }>,
  ): void {
    // A failed call's own row says so.
    if (event.reason === 'tool_execution_failed') return
    if (event.reason?.includes('compaction')) {
      this.compaction(ctx, out, event.metadata?.phase)
      return
    }
    addEntry(ctx, out, {
      kind: 'notice',
      id: ctx.nextId(),
      severity: event.noticeType === 'status' ? 'info' : 'warning',
      title: event.message,
    })
  }

  /**
   * A compaction is one divider: Cline says when it starts, before the request it makes room for,
   * and then that it is done or that it folded nothing. Its other notices show nothing.
   */
  private compaction(ctx: MapperContext, out: MapperOutput, phase: unknown): void {
    if (phase === 'completed') {
      this.endCompaction(ctx, out, 'completed', true)
    } else if (phase === 'skipped') {
      this.endCompaction(ctx, out, 'failed')
    } else if (phase === 'started') {
      this.endCompaction(ctx, out, 'cancelled')
      this.compactionId = ctx.nextId()
      addEntry(ctx, out, {
        kind: 'compaction',
        id: this.compactionId,
        status: 'in_progress',
        summary: '',
      })
    }
  }

  /** Ends the divider that runs; `always` adds one where Cline never said it started. */
  private endCompaction(
    ctx: MapperContext,
    out: MapperOutput,
    status: 'completed' | 'failed' | 'cancelled',
    always = false,
  ): void {
    const id = this.compactionId
    this.compactionId = null
    const running = id ? ctx.thread.byId[id] : undefined
    if (running?.kind === 'compaction') {
      out.patches.push({ op: 'entry.update', id: running.id, changes: { status } })
    } else if (always) {
      addEntry(ctx, out, { kind: 'compaction', id: ctx.nextId(), status, summary: '' })
    }
  }
}
