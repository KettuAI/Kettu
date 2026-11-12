// What a protocol's mapper produces against Kettu's session model: patches, and effects the host
// acts on. Every protocol's mapper produces these, and the helpers here hold for each of them.

import type { PlanLimit } from '@shared/agent-host'
import type {
  BackgroundTaskView,
  ConfigOption,
  Patch,
  StopReason,
  ThreadEntry,
  ThreadState,
  TokenTotals,
  ToolContent,
  ToolEntry,
  ToolKind,
} from '@shared/thread'
import type { PromptResult } from './connection'

/** Per-turn bookkeeping the mapper needs to find "current" entries. */

/** A worktree an agent made on its own, as it reported it. */
export interface AgentWorktree {
  path: string
  branch: string | null
}
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
  /** The user stopped the turn and the agent has not answered its prompt yet. */
  readonly cancelling: boolean
  readonly scope: TurnScope
  readonly now: number
  /** The next `e:<n>` id of this session. */
  nextId(): string
  /** The Kettu id of a session of the same agent, by the agent's own id for it. */
  sessionIdFor(sessionId: string): string | null
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
      /** The agent's own id for the subagent's session. */
      sessionId: string
      // Omitted fields are unchanged; null clears, as the subagents RFD specifies.
      title?: string | null
      description?: string | null
      canCancel?: boolean
      state?: SubagentState
      /** A worktree the agent made for the subagent itself, which Kettu only shows. */
      worktree?: AgentWorktree
    }
  | { kind: 'limit'; limit: PlanLimit }
  // The plan accepts requests again, which ends a block a window showed.
  | { kind: 'limits-allowed' }
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
  // The commands and monitors the agent has running or has ended since, replacing the last list.
  | { kind: 'tasks'; tasks: BackgroundTaskView[] }
  // A turn the agent started between the host's own, as when such a command ended. A prompt that
  // crossed it joins it, and the prompt's answer ends both.
  | { kind: 'agentTurn'; phase: 'started' }
  | { kind: 'agentTurn'; phase: 'joined' }
  | { kind: 'agentTurn'; phase: 'ended'; result: PromptResult }
  | { kind: 'agentTurn'; phase: 'failed'; error: unknown }
  // The session's own thread sent a request to its model, which renews its prompt cache.
  | { kind: 'request' }
  // An image replayed by `session/load`, whose bytes the session keeps in its thread store.
  | {
      kind: 'replayImage'
      entryId: string
      attachmentId: string
      mimeType: string
      data: string // base64
    }

export interface MapperOutput {
  patches: Patch[]
  effects: MapperEffect[]
}

/** The id of the mode select Kettu makes from an agent's legacy `modes`. */
export const SYNTHETIC_MODE_ID = '__mode'

/** New options replace the old ones, keeping a legacy mode until the agent replaces it. */
export function mergeConfig(
  previous: readonly ConfigOption[],
  next: ConfigOption[],
): ConfigOption[] {
  const synthetic = previous.find((option) => option.id === SYNTHETIC_MODE_ID)
  return synthetic && !next.some((option) => option.category === 'mode')
    ? [synthetic, ...next]
    : next
}

/** The text of the thread's first user message, or null when it is not in memory. */
export function firstUserMessage(thread: ThreadState): string | null {
  for (const id of thread.order) {
    const entry = thread.byId[id]
    if (entry?.kind !== 'user') continue
    const text = entry.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
    return text === '' ? null : text
  }
  return null
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Whether a title is only the first user message again: the whole of it, whatever its spacing, or
 * the message cut and ending in an ellipsis. Adapters send the first message as the title just
 * before their own comes.
 */
export function repeatsFirstMessage(title: string, message: string | null): boolean {
  if (message === null) return false
  const said = collapse(message)
  if (said === '') return false
  const cut = collapse(title)
  if (said === cut) return true
  return cut.endsWith('…') && cut.length > 1 && said.startsWith(cut.slice(0, -1))
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

// Building blocks of every mapper.

export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
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

const DESCRIPTION_LIMIT = 200

/** What a command says it does, as one line: the `description` beside its input's `command`. */
export function commandDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const input = raw as Record<string, unknown>
  if (input.command === undefined) return undefined
  // Claude Code also accepts `command_description` since CLI 2.1.295, and forwards the key used.
  const description = input.description ?? input.command_description
  if (typeof description !== 'string') return undefined
  const line = [...description.replace(/\s+/g, ' ').trim()]
  if (line.length === 0) return undefined
  return line.length > DESCRIPTION_LIMIT
    ? `${line.slice(0, DESCRIPTION_LIMIT).join('').trimEnd()}…`
    : line.join('')
}

export function toolOutput(content: readonly ToolContent[]): string {
  return content
    .map((item) => (item.type === 'markdown' ? item.markdown : ''))
    .filter((text) => text !== '')
    .join('\n')
}

export function lastEntry(thread: ThreadState): ThreadEntry | undefined {
  const id = thread.order[thread.order.length - 1]
  return id === undefined ? undefined : thread.byId[id]
}

/** Closes thoughts that are still streaming once something else follows them. */
export function closeThoughts(ctx: MapperContext, out: MapperOutput, except?: string): void {
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

export function addEntry(ctx: MapperContext, out: MapperOutput, entry: ThreadEntry): void {
  closeThoughts(ctx, out, entry.id)
  out.patches.push({ op: 'entry.add', entry })
}

export function messageEntryId(
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

export function toolEffects(
  out: MapperOutput,
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

function windowLimit(window: string, info: Record<string, unknown>, now: number): PlanLimit {
  const utilization =
    typeof info.utilization === 'number' && Number.isFinite(info.utilization)
      ? info.utilization
      : null
  const resets =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null
  const status = info.status
  // A rejection names one window even when another limit, or a plain 429, refused the request.
  const reached = status === 'rejected' && (utilization === null || utilization >= 1)
  return {
    window,
    label: windowLabel(window),
    usedPercent:
      utilization === null ? null : Math.min(100, Math.max(0, Math.round(utilization * 1000) / 10)),
    // Seconds, as Claude Code sends; a value already in milliseconds is kept.
    resetsAt: resets === null ? null : resets < 1e12 ? resets * 1000 : resets,
    state: status === 'allowed_warning' ? 'warning' : reached ? 'reached' : 'ok',
    observedAt: now,
  }
}

/**
 * One Claude Code rate limit event, or `_claude/rateLimit` from `usage_update._meta`. Its
 * `status` is the whole plan's and `rateLimitType` only the window that stands for it;
 * `unifiedWindows` has each window's own reading, which wins. `utilization` is a fraction
 * (0.42 is 42%) and `resetsAt` in Unix seconds. `allowed` is false while the plan refuses
 * requests.
 */
export function mapRateLimits(
  value: unknown,
  now: number,
): { allowed: boolean; limits: PlanLimit[] } | null {
  if (typeof value !== 'object' || value === null) return null
  const info = value as Record<string, unknown>
  if (typeof info.status !== 'string') return null
  const limits: PlanLimit[] = []
  const windows = info.unifiedWindows
  if (typeof windows === 'object' && windows !== null) {
    for (const [window, reading] of Object.entries(windows as Record<string, unknown>)) {
      if (window === '' || typeof reading !== 'object' || reading === null) continue
      limits.push(windowLimit(window, reading as Record<string, unknown>, now))
    }
  }
  const window = info.rateLimitType
  if (typeof window === 'string' && window !== '' && !limits.some((l) => l.window === window)) {
    limits.push(windowLimit(window, info, now))
  }
  return { allowed: info.status !== 'rejected', limits }
}

/** What a rate limit event tells the agent's limits. */
export function rateLimitEffects(value: unknown, now: number): MapperEffect[] {
  const event = mapRateLimits(value, now)
  if (!event) return []
  const effects: MapperEffect[] = event.limits.map((limit) => ({ kind: 'limit', limit }))
  if (event.allowed) effects.push({ kind: 'limits-allowed' })
  return effects
}

/**
 * A window once the plan accepts requests again: a block it showed is over, unless its use
 * says it is full, as a per-model weekly window can be while another model answers.
 */
export function allowedLimit(limit: PlanLimit): PlanLimit {
  if (limit.state !== 'reached' || (limit.usedPercent !== null && limit.usedPercent >= 100)) {
    return limit
  }
  return { ...limit, state: 'ok' }
}

/**
 * A window read from the agent's report over the one known before. A warning the agent pushed
 * holds until its window resets, and so does a block, unless the read shows the window not full.
 */
export function mergeReadLimit(
  before: PlanLimit | undefined,
  read: PlanLimit,
  now: number,
): PlanLimit {
  if (read.state !== 'ok' || !before || before.state === 'ok') return read
  if ((before.resetsAt ?? 0) <= now) return read
  if (before.state === 'reached' && read.usedPercent !== null) return read
  return { ...read, state: before.state }
}
