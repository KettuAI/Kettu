// The ACP v1 mapper: turns ACP messages into patches against OverBench's session model.
// Together with connection.ts, the only code that knows ACP types. A v2 mapper would sit
// next to it and produce the same patches.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type {
  ConfigOption,
  ContentRef,
  EntryChanges,
  Patch,
  PendingPermission,
  PermissionKind,
  PlanItem,
  SlashCommand,
  StopReason,
  ThreadEntry,
  ThreadState,
  TokenTotals,
  ToolContent,
  ToolEntry,
  ToolKind,
  UserContent,
} from '@shared/thread'
import { ULTRACODE_OPTION_ID } from '@shared/thread'
import { t } from '../i18n'

/** Per-turn bookkeeping the mapper needs to find "current" entries. */
export interface TurnScope {
  planId: string | null
  /** Thought entries still streaming, with the time their first chunk arrived. */
  thoughts: Map<string, number>
}

export function newTurnScope(): TurnScope {
  return { planId: null, thoughts: new Map() }
}

export interface MapperContext {
  readonly thread: ThreadState
  /** True while `session/load` replays history into the thread. */
  readonly replaying: boolean
  readonly scope: TurnScope
  readonly now: number
  /** The next `e:<n>` id of this session. */
  nextId(): string
  /** The OverBench id of a session of the same agent, by its ACP id. */
  sessionIdFor(acpSessionId: string): string | null
}

export type SubagentState =
  | { kind: 'running' }
  | { kind: 'requires_action' }
  | {
      kind: 'idle'
      stopReason: string | null
      error: { message: string; detail?: string } | null
      tokens: TokenTotals | null
    }
  | { kind: 'unknown' }
  | { kind: 'cleared' }

export type MapperEffect =
  | {
      kind: 'subagent'
      acpSessionId: string
      // Omitted fields are unchanged; null clears, as the subagents RFD specifies.
      title?: string | null
      description?: string | null
      canCancel?: boolean
      state?: SubagentState
    }
  | { kind: 'limit'; limit: PlanLimit }
  | { kind: 'title'; title: string | null }
  | { kind: 'ignored'; variant: string; detail: string }
  | {
      kind: 'tool'
      phase: 'started' | 'ended'
      toolCallId: string
      entryId: string
      toolKind: ToolKind
      output: string
    }
  // Work the agent runs on after its tool call ended, such as a command in the background.
  | { kind: 'background' }

export interface MapperOutput {
  patches: Patch[]
  effects: MapperEffect[]
}

/** Every `sessionUpdate` the SDK's unstable v1 schema accepts; others never reach the SDK. */
export const KNOWN_UPDATES: ReadonlySet<string> = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
  'subagent_update',
  'session_message',
  'session_message_chunk',
])

export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

// Content blocks.

export function contentRef(block: acp.ContentBlock): ContentRef {
  switch (block.type) {
    case 'image':
      return { kind: 'image', mimeType: block.mimeType, data: block.data }
    case 'resource_link':
      return { kind: 'link', uri: block.uri, name: block.title || block.name }
    case 'audio':
      return { kind: 'unsupported', label: t('content.audio', { type: block.mimeType }) }
    case 'resource':
      return { kind: 'unsupported', label: t('content.resource', { uri: block.resource.uri }) }
    case 'text':
      return { kind: 'unsupported', label: t('content.text') }
    default:
      return { kind: 'unsupported', label: t('content.unknown') }
  }
}

export function userContent(block: acp.ContentBlock): UserContent {
  return block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'ref', ref: contentRef(block) }
}

/** Appends a block to user content, merging adjacent text. */
function appendUserContent(content: UserContent[], block: acp.ContentBlock): UserContent[] {
  const next = userContent(block)
  const last = content[content.length - 1]
  if (next.type === 'text' && last?.type === 'text') {
    return [...content.slice(0, -1), { type: 'text', text: last.text + next.text }]
  }
  return [...content, next]
}

function blocksText(blocks: readonly acp.ContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

export function toolContent(item: acp.ToolCallContent): ToolContent {
  switch (item.type) {
    case 'content':
      return item.content.type === 'text'
        ? { type: 'markdown', markdown: toLf(item.content.text) }
        : { type: 'ref', ref: contentRef(item.content) }
    case 'diff':
      return {
        type: 'diff',
        path: item.path,
        oldText: item.oldText == null ? null : toLf(item.oldText),
        newText: toLf(item.newText),
      }
    case 'terminal':
      // Cannot occur while the terminal capability is off; shown rather than dropped.
      return {
        type: 'ref',
        ref: { kind: 'unsupported', label: t('content.terminal', { id: item.terminalId }) },
      }
    default:
      return { type: 'ref', ref: { kind: 'unsupported', label: t('content.unknownTool') } }
  }
}

function toolLocations(locations: readonly acp.ToolCallLocation[]): ToolEntry['locations'] {
  return locations.map((location) =>
    location.line == null ? { path: location.path } : { path: location.path, line: location.line },
  )
}

const RAW_INPUT_LIMIT = 64 * 1024

/** The command or input of a tool call as text: a command when there is one, else JSON. */
export function rawInputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return toLf(raw)
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const command = (raw as Record<string, unknown>).command
    if (typeof command === 'string') return toLf(command)
    if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
      return command.join(' ')
    }
  }
  let json: string | undefined
  try {
    json = JSON.stringify(raw, null, 2)
  } catch {
    return undefined
  }
  if (json === undefined) return undefined
  return json.length > RAW_INPUT_LIMIT ? `${json.slice(0, RAW_INPUT_LIMIT)}\n…` : json
}

function toolOutput(content: readonly ToolContent[]): string {
  return content
    .map((item) => (item.type === 'markdown' ? item.markdown : ''))
    .filter((text) => text !== '')
    .join('\n')
}

const TOOL_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
])

function toolKind(kind: string | null | undefined): ToolKind {
  return kind && TOOL_KINDS.has(kind) ? (kind as ToolKind) : 'other'
}

// The mapper.

class Output implements MapperOutput {
  patches: Patch[] = []
  effects: MapperEffect[] = []
}

function lastEntry(thread: ThreadState): ThreadEntry | undefined {
  const id = thread.order[thread.order.length - 1]
  return id === undefined ? undefined : thread.byId[id]
}

/** Closes thoughts that are still streaming once something else follows them. */
function closeThoughts(ctx: MapperContext, out: Output, except?: string): void {
  for (const [id, startedAt] of ctx.scope.thoughts) {
    if (id === except) continue
    ctx.scope.thoughts.delete(id)
    if (ctx.thread.byId[id]) {
      out.patches.push({
        op: 'entry.update',
        id,
        changes: { streaming: false, durationMs: Math.max(0, ctx.now - startedAt) },
      })
    }
  }
}

function addEntry(ctx: MapperContext, out: Output, entry: ThreadEntry): void {
  closeThoughts(ctx, out, entry.id)
  out.patches.push({ op: 'entry.add', entry })
}

function messageEntryId(
  ctx: MapperContext,
  kind: 'agent' | 'thought' | 'user',
  messageId: string | null | undefined,
): string | null {
  if (!messageId) return null
  const id = `m:${messageId}`
  const existing = ctx.thread.byId[id]
  // An agent may reuse one message id for a message's thought and its text.
  if (existing && existing.kind !== kind) return `m:${messageId}#${kind}`
  return id
}

function mapMessageChunk(
  ctx: MapperContext,
  out: Output,
  kind: 'agent' | 'thought',
  chunk: acp.ContentChunk,
): void {
  const byId = messageEntryId(ctx, kind, chunk.messageId)
  const last = lastEntry(ctx.thread)
  const targetId = byId ?? (last?.kind === kind ? last.id : null)
  const existing = targetId ? ctx.thread.byId[targetId] : undefined
  const isText = chunk.content.type === 'text'
  const text = chunk.content.type === 'text' ? chunk.content.text : ''

  if (existing && existing.kind === kind) {
    if (isText) {
      if (text !== '') out.patches.push({ op: 'entry.appendText', id: existing.id, text })
    } else if (existing.kind === 'agent') {
      out.patches.push({
        op: 'entry.update',
        id: existing.id,
        changes: { attachments: [...existing.attachments, contentRef(chunk.content)] },
      })
    } else {
      out.effects.push({
        kind: 'ignored',
        variant: 'agent_thought_chunk',
        detail: `${chunk.content.type} content in a thought`,
      })
    }
    return
  }

  const id = targetId ?? ctx.nextId()
  const streaming = !ctx.replaying
  if (kind === 'agent') {
    addEntry(ctx, out, {
      kind: 'agent',
      id,
      markdown: text,
      attachments: isText ? [] : [contentRef(chunk.content)],
      streaming,
      ...(streaming ? { at: ctx.now } : {}),
    })
  } else {
    if (!isText) {
      out.effects.push({
        kind: 'ignored',
        variant: 'agent_thought_chunk',
        detail: `${chunk.content.type} content in a thought`,
      })
      return
    }
    addEntry(ctx, out, { kind: 'thought', id, markdown: text, streaming })
    if (streaming) ctx.scope.thoughts.set(id, ctx.now)
  }
}

function mapUserChunk(ctx: MapperContext, out: Output, chunk: acp.ContentChunk): void {
  // In a live turn the host already added the user entry when it sent the prompt.
  if (!ctx.replaying) return
  const byId = messageEntryId(ctx, 'user', chunk.messageId)
  const last = lastEntry(ctx.thread)
  const target = byId
    ? ctx.thread.byId[byId]
    : last?.kind === 'user' && !chunk.messageId
      ? last
      : undefined
  if (target?.kind === 'user') {
    out.patches.push({
      op: 'entry.update',
      id: target.id,
      changes: { content: appendUserContent(target.content, chunk.content) },
    })
    return
  }
  // Each replayed user message starts a turn, which scopes "current" plans.
  ctx.scope.planId = null
  addEntry(ctx, out, {
    kind: 'user',
    id: byId ?? ctx.nextId(),
    content: [userContent(chunk.content)],
  })
}

function toolEffects(
  out: Output,
  toolCallId: string,
  entryId: string,
  before: ToolEntry['status'] | null,
  after: ToolEntry,
): void {
  const active = (status: ToolEntry['status'] | null): boolean =>
    status !== null && status !== 'pending'
  const done = (status: ToolEntry['status'] | null): boolean =>
    status === 'completed' || status === 'failed' || status === 'cancelled'
  if (!active(before) && active(after.status)) {
    out.effects.push({
      kind: 'tool',
      phase: 'started',
      toolCallId,
      entryId,
      toolKind: after.toolKind,
      output: '',
    })
  }
  if (!done(before) && done(after.status)) {
    out.effects.push({
      kind: 'tool',
      phase: 'ended',
      toolCallId,
      entryId,
      toolKind: after.toolKind,
      output: toolOutput(after.content),
    })
  }
}

/**
 * Whether a tool call leaves work running once it ends: Claude Code's command with
 * `run_in_background`, or its Monitor tool, which watches in the background. Claude Code reports
 * when such work ends only to clients it renders terminals or AIR's async tasks for.
 */
function startsBackgroundWork(update: acp.ToolCallUpdate): boolean {
  const input = update.rawInput
  if (
    typeof input === 'object' &&
    input !== null &&
    (input as Record<string, unknown>).run_in_background === true &&
    typeof (input as Record<string, unknown>).command === 'string'
  ) {
    return true
  }
  const meta = update._meta as { claudeCode?: { toolName?: unknown } } | null | undefined
  return meta?.claudeCode?.toolName === 'Monitor'
}

/**
 * Applies a `tool_call` or `tool_call_update`: only the fields present change, and both
 * add the entry when it is new, since agents may announce a call twice or update it first.
 */
function mapToolCall(ctx: MapperContext, out: Output, update: acp.ToolCallUpdate): string {
  const id = `t:${update.toolCallId}`
  const existing = ctx.thread.byId[id]
  const changes: Partial<Omit<ToolEntry, 'kind' | 'id'>> = {}
  if (update.title != null) changes.title = update.title
  if (update.kind != null) changes.toolKind = toolKind(update.kind)
  if (update.status != null) changes.status = update.status
  if (update.content != null) changes.content = update.content.map(toolContent)
  if (update.locations != null) changes.locations = toolLocations(update.locations)
  const raw = rawInputText(update.rawInput)
  if (raw !== undefined) changes.rawInput = raw
  if (!ctx.replaying && startsBackgroundWork(update)) out.effects.push({ kind: 'background' })

  if (existing?.kind === 'tool') {
    if (Object.keys(changes).length > 0) {
      out.patches.push({ op: 'entry.update', id, changes: changes as EntryChanges })
    }
    toolEffects(out, update.toolCallId, id, existing.status, { ...existing, ...changes })
    return id
  }
  const entry: ToolEntry = {
    kind: 'tool',
    id,
    title: changes.title ?? t('content.toolCall'),
    toolKind: changes.toolKind ?? 'other',
    status: changes.status ?? 'pending',
    content: changes.content ?? [],
    locations: changes.locations ?? [],
    permission: null,
    permissionResult: null,
    ...(raw !== undefined ? { rawInput: raw } : {}),
  }
  addEntry(ctx, out, entry)
  toolEffects(out, update.toolCallId, id, null, entry)
  return id
}

function mapPlan(ctx: MapperContext, out: Output, plan: acp.Plan): void {
  const items: PlanItem[] = plan.entries.map((entry) => ({
    content: entry.content,
    priority: entry.priority,
    status: entry.status,
  }))
  const current = ctx.scope.planId ? ctx.thread.byId[ctx.scope.planId] : undefined
  if (current?.kind === 'plan') {
    out.patches.push({ op: 'entry.update', id: current.id, changes: { items } })
    return
  }
  const id = ctx.nextId()
  ctx.scope.planId = id
  addEntry(ctx, out, { kind: 'plan', id, items })
}

const CONFIG_CATEGORIES: ReadonlySet<string> = new Set([
  'mode',
  'model',
  'model_config',
  'thought_level',
])

export const SYNTHETIC_MODE_ID = '__mode'

function mapConfigOption(option: acp.SessionConfigOption): ConfigOption | null {
  const category =
    option.category && CONFIG_CATEGORIES.has(option.category)
      ? (option.category as ConfigOption['category'])
      : 'other'
  const base = {
    id: option.id,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
    category,
  }
  if (option.type === 'boolean') return { ...base, type: 'boolean', value: option.currentValue }
  if (option.type === 'select') {
    const choices: NonNullable<ConfigOption['choices']> = []
    for (const item of option.options) {
      if ('group' in item) {
        for (const choice of item.options) {
          choices.push({
            value: choice.value,
            name: choice.name,
            ...(choice.description ? { description: choice.description } : {}),
            group: item.name,
          })
        }
      } else {
        choices.push({
          value: item.value,
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
        })
      }
    }
    return { ...base, type: 'select', value: option.currentValue, choices }
  }
  return null
}

/**
 * Config options as OverBench shows them. Legacy `modes` become a synthetic `__mode`
 * select, unless a real option already covers the mode category.
 */
export function mapConfig(
  options: readonly acp.SessionConfigOption[] | null | undefined,
  modes: acp.SessionModeState | null | undefined,
): ConfigOption[] {
  const mapped = (options ?? []).map(mapConfigOption).filter((o): o is ConfigOption => o !== null)
  if (modes && modes.availableModes.length > 0 && !mapped.some((o) => o.category === 'mode')) {
    mapped.unshift({
      id: SYNTHETIC_MODE_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      value: modes.currentModeId,
      choices: modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    })
  }
  return mapped
}

/**
 * New options replace the old ones, keeping the synthetic mode when nothing replaces it and the
 * host's own ultracode switch, which the agent never sends.
 */
export function mergeConfig(
  previous: readonly ConfigOption[],
  next: ConfigOption[],
): ConfigOption[] {
  const synthetic = previous.find((option) => option.id === SYNTHETIC_MODE_ID)
  const ultracode = previous.find((option) => option.id === ULTRACODE_OPTION_ID)
  const merged =
    synthetic && !next.some((option) => option.category === 'mode') ? [synthetic, ...next] : next
  return ultracode && !merged.some((option) => option.id === ULTRACODE_OPTION_ID)
    ? [...merged, ultracode]
    : merged
}

function mapCommands(commands: readonly acp.AvailableCommand[]): SlashCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
  }))
}

function parseTime(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : fallback
}

/** Labels of the plan-limit windows Claude Code names. */
export const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  overage: 'Extra usage',
}

function windowLabel(window: string): string {
  if (WINDOW_LABELS[window]) return WINDOW_LABELS[window]
  const words = window
    .replace(/^seven_day_?/, 'weekly ')
    .replace(/_/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * One `_claude/rateLimit` value from `usage_update._meta`. Claude Code reports
 * `utilization` as a fraction (0.42 is 42%) and `resetsAt` in Unix seconds.
 */
export function mapRateLimit(value: unknown, now: number): PlanLimit | null {
  if (typeof value !== 'object' || value === null) return null
  const info = value as Record<string, unknown>
  const window = info.rateLimitType
  if (typeof window !== 'string' || window === '') return null
  const utilization =
    typeof info.utilization === 'number' && Number.isFinite(info.utilization)
      ? info.utilization
      : null
  const resets =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null
  const status = info.status
  return {
    window,
    label: windowLabel(window),
    usedPercent:
      utilization === null ? null : Math.min(100, Math.max(0, Math.round(utilization * 1000) / 10)),
    // Seconds, as Claude Code sends; a value already in milliseconds is kept.
    resetsAt: resets === null ? null : resets < 1e12 ? resets * 1000 : resets,
    state: status === 'allowed_warning' ? 'warning' : status === 'rejected' ? 'reached' : 'ok',
    observedAt: now,
  }
}

const ACCOUNT_KINDS: ReadonlySet<string> = new Set([
  'account',
  'api_key',
  'external',
  'gateway',
  'none',
])

/** The `_auth/status_update` extension: `{ authStatus: { kind, label, account?: { email } } }`. */
export function mapAuthStatus(params: unknown): AgentAccount | null {
  if (typeof params !== 'object' || params === null) return null
  const status = (params as { authStatus?: unknown }).authStatus
  if (typeof status !== 'object' || status === null) return null
  const { kind, label, account } = status as Record<string, unknown>
  if (typeof kind !== 'string' || !ACCOUNT_KINDS.has(kind) || typeof label !== 'string') return null
  const email =
    typeof account === 'object' &&
    account !== null &&
    typeof (account as { email?: unknown }).email === 'string'
      ? (account as { email: string }).email
      : null
  return { kind: kind as AgentAccount['kind'], label, email }
}

export function mapTokenTotals(usage: acp.Usage | null | undefined): TokenTotals | null {
  if (!usage) return null
  return {
    total: usage.totalTokens,
    input: usage.inputTokens,
    output: usage.outputTokens,
    thought: usage.thoughtTokens ?? null,
    cacheRead: usage.cachedReadTokens ?? null,
    cacheWrite: usage.cachedWriteTokens ?? null,
  }
}

/**
 * A session's totals with one more turn in them. The adapters report each turn's own counts, though
 * ACP's schema calls them totals. A count no turn has reported yet stays null.
 */
export function addTokenTotals(sum: TokenTotals | null, turn: TokenTotals): TokenTotals {
  if (!sum) return turn
  const add = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : a + b
  return {
    total: sum.total + turn.total,
    input: sum.input + turn.input,
    output: sum.output + turn.output,
    thought: add(sum.thought, turn.thought),
    cacheRead: add(sum.cacheRead, turn.cacheRead),
    cacheWrite: add(sum.cacheWrite, turn.cacheWrite),
  }
}

type CompactionStatus = Extract<ThreadEntry, { kind: 'compaction' }>['status']

const NOTICE_SEVERITIES: ReadonlySet<string> = new Set(['info', 'warning', 'error'])
const COMPACTION_STATUSES: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
  'failed',
  'cancelled',
])
const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
])

export function isStopReason(value: unknown): value is StopReason {
  return typeof value === 'string' && STOP_REASONS.has(value)
}

function mapCompaction(ctx: MapperContext, out: Output, update: acp.CompactionUpdate): void {
  const id = `c:${update.compactionId}`
  const existing = ctx.thread.byId[id]
  const known = COMPACTION_STATUSES.has(update.status)
  const summary = update.summary != null ? blocksText(update.summary) : null
  const errorText = update.status === 'failed' && update.error ? update.error : null
  const status = known ? (update.status as CompactionStatus) : null
  if (existing?.kind === 'compaction') {
    const changes: { status?: CompactionStatus; summary?: string } = {}
    if (status) changes.status = status
    if (summary !== null) changes.summary = summary
    else if (errorText && existing.summary === '') changes.summary = errorText
    if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
    return
  }
  // An unknown status on a new compaction is shown as in progress until a known one arrives.
  addEntry(ctx, out, {
    kind: 'compaction',
    id,
    status: status ?? 'in_progress',
    summary: summary ?? errorText ?? '',
  })
}

function mapSubagentState(state: acp.StateUpdate | null | undefined): SubagentState | undefined {
  if (state === undefined) return undefined
  if (state === null) return { kind: 'cleared' }
  switch (state.state) {
    case 'running':
      return { kind: 'running' }
    case 'requires_action':
      return { kind: 'requires_action' }
    case 'idle': {
      const idle = state as acp.IdleStateUpdate & { error?: acp.Error | null }
      const stopReason = typeof idle.stopReason === 'string' ? idle.stopReason : null
      const error =
        stopReason === 'error'
          ? {
              message: idle.error?.message ?? t('session.subagent.failed'),
              ...(idle.error?.data !== undefined
                ? { detail: JSON.stringify(idle.error.data) }
                : {}),
            }
          : null
      return { kind: 'idle', stopReason, error, tokens: mapTokenTotals(idle.usage) }
    }
    default:
      return { kind: 'unknown' }
  }
}

function mapSessionMessage(
  ctx: MapperContext,
  out: Output,
  update: {
    messageId: string
    senderSessionId?: string | null
    content?: acp.ContentBlock[] | null
  },
  chunk: acp.ContentBlock | null,
): void {
  const id = `sm:${update.messageId}`
  const existing = ctx.thread.byId[id]
  const sender = update.senderSessionId ? ctx.sessionIdFor(update.senderSessionId) : undefined
  if (existing?.kind === 'session_message') {
    const changes: { content?: UserContent[]; senderId?: string | null } = {}
    if (chunk) changes.content = appendUserContent(existing.content, chunk)
    else if (update.content !== undefined) changes.content = (update.content ?? []).map(userContent)
    if (sender !== undefined) changes.senderId = sender
    if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
    return
  }
  addEntry(ctx, out, {
    kind: 'session_message',
    id,
    senderId: sender ?? null,
    content: chunk ? [userContent(chunk)] : (update.content ?? []).map(userContent),
  })
}

/** Maps one `session/update`. Unknown variants are ignored and reported as an effect. */
export function mapSessionUpdate(update: acp.SessionUpdate, ctx: MapperContext): MapperOutput {
  const out = new Output()
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      mapUserChunk(ctx, out, update)
      break
    case 'agent_message_chunk':
      mapMessageChunk(ctx, out, 'agent', update)
      break
    case 'agent_thought_chunk':
      mapMessageChunk(ctx, out, 'thought', update)
      break
    case 'tool_call':
      mapToolCall(ctx, out, update)
      break
    case 'tool_call_update':
      mapToolCall(ctx, out, update)
      break
    case 'plan':
      mapPlan(ctx, out, update)
      break
    case 'available_commands_update':
      out.patches.push({
        op: 'session.update',
        changes: { commands: mapCommands(update.availableCommands) },
      })
      break
    case 'config_option_update':
      out.patches.push({
        op: 'session.update',
        changes: {
          config: mergeConfig(ctx.thread.session.config, mapConfig(update.configOptions, null)),
        },
      })
      break
    case 'current_mode_update': {
      const config = ctx.thread.session.config
      const target =
        config.find((option) => option.id === SYNTHETIC_MODE_ID) ??
        config.find((option) => option.category === 'mode' && option.type === 'select')
      if (!target) {
        out.effects.push({
          kind: 'ignored',
          variant: update.sessionUpdate,
          detail: 'no mode option',
        })
        break
      }
      out.patches.push({
        op: 'session.update',
        changes: {
          config: config.map((option) =>
            option === target ? { ...option, value: update.currentModeId } : option,
          ),
        },
      })
      break
    }
    case 'session_info_update': {
      const changes: { title?: string | null; updatedAt: number } = {
        updatedAt: parseTime(update.updatedAt, ctx.now),
      }
      if (update.title !== undefined) {
        changes.title = update.title
        out.effects.push({ kind: 'title', title: update.title })
      }
      out.patches.push({ op: 'session.update', changes })
      break
    }
    case 'usage_update': {
      const previous = ctx.thread.session.usage
      out.patches.push({
        op: 'session.update',
        changes: {
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost
              ? { amount: update.cost.amount, currency: update.cost.currency }
              : null,
            tokens: previous?.tokens ?? null,
          },
        },
      })
      const limit = mapRateLimit(update._meta?.['_claude/rateLimit'], ctx.now)
      if (limit) out.effects.push({ kind: 'limit', limit })
      break
    }
    case 'notice':
      addEntry(ctx, out, {
        kind: 'notice',
        id: ctx.nextId(),
        severity: NOTICE_SEVERITIES.has(update.severity) ? (update.severity as 'info') : 'info',
        title: update.title,
        ...(update.description ? { description: update.description } : {}),
      })
      break
    case 'compaction_update':
      mapCompaction(ctx, out, update)
      break
    case 'compaction_summary_chunk': {
      const id = `c:${update.compactionId}`
      const text = update.content.type === 'text' ? update.content.text : ''
      if (ctx.thread.byId[id]?.kind === 'compaction') {
        if (text !== '') out.patches.push({ op: 'entry.appendText', id, text })
      } else {
        addEntry(ctx, out, { kind: 'compaction', id, status: 'in_progress', summary: text })
      }
      break
    }
    case 'subagent_update': {
      const effect: Extract<MapperEffect, { kind: 'subagent' }> = {
        kind: 'subagent',
        acpSessionId: update.sessionId,
      }
      if (update.title !== undefined) effect.title = update.title
      if (update.description !== undefined) effect.description = update.description
      if (update.capabilities !== undefined) effect.canCancel = update.capabilities?.cancel != null
      const state = mapSubagentState(update.state)
      if (state) effect.state = state
      out.effects.push(effect)
      break
    }
    case 'session_message':
      mapSessionMessage(ctx, out, update, null)
      break
    case 'session_message_chunk':
      mapSessionMessage(
        ctx,
        out,
        { messageId: update.messageId, senderSessionId: update.senderSessionId },
        update.content,
      )
      break
    default:
      out.effects.push({
        kind: 'ignored',
        variant: (update as { sessionUpdate: string }).sessionUpdate,
        detail: 'not shown by OverBench',
      })
  }
  return out
}

/**
 * The tool entry a permission request belongs to, added first if the thread has not
 * seen that tool call.
 */
export function mapPermissionToolCall(
  toolCall: acp.ToolCallUpdate,
  ctx: MapperContext,
): { entryId: string; output: MapperOutput } {
  const out = new Output()
  const entryId = mapToolCall(ctx, out, toolCall)
  return { entryId, output: out }
}

export function mapPermissionOptions(
  options: readonly acp.PermissionOption[],
): PendingPermission['options'] {
  return options.map((option) => ({
    id: option.optionId,
    name: option.name,
    kind: option.kind as PermissionKind,
  }))
}

export function promptBlocks(content: readonly UserContent[]): acp.ContentBlock[] {
  return content.map((item): acp.ContentBlock => {
    if (item.type === 'text') return { type: 'text', text: item.text }
    const ref = item.ref
    switch (ref.kind) {
      case 'image':
        return { type: 'image', mimeType: ref.mimeType, data: ref.data }
      case 'link':
        return { type: 'resource_link', uri: ref.uri, name: ref.name }
      default:
        return { type: 'text', text: ref.label }
    }
  })
}
