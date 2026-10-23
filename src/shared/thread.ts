// OverBench's own session and thread model, shared by the agent host and the renderer.
// It never imports ACP types; only the mapper in src/agent-host/acp/ does.

export type AgentId = 'claude-code' | 'codex' | 'opencode' | 'fake-agent'

export const AGENT_IDS: readonly AgentId[] = ['claude-code', 'codex', 'opencode', 'fake-agent']

export type SessionStatus =
  | 'starting' // agent starting, or session/new, load or resume in flight
  | 'auth_required'
  | 'ready'
  | 'running' // a prompt turn is in progress
  | 'awaiting_permission' // running, with at least one unanswered permission request
  | 'failed' // could not start or recover; needs user action
  | 'closed'

export interface SessionView {
  id: string // OverBench id; ACP ids are only unique per agent
  agentId: AgentId
  projectPath: string // canonical absolute path
  acpSessionId: string | null
  status: SessionStatus
  title: string | null
  config: ConfigOption[]
  commands: SlashCommand[]
  usage: SessionUsage | null
  error: { message: string; detail?: string } | null
  turnStartedAt: number | null
  turnStartUsed: number | null // usage.used when the running turn started, for what it adds
  createdAt: number
  updatedAt: number
  parentId: string | null // the parent session, for sub-sessions
  origin: 'user' | 'subagent'
  subagent: SubagentInfo | null // set when origin is 'subagent'
  queue: QueuedPrompt[] // prompts waiting for the running turn to end, oldest first
  queuePaused: boolean // after Stop, a failed turn or a restart, until the user resumes it
}

export interface QueuedPrompt {
  id: string
  content: UserContent[]
  at: number
}

export interface SessionUsage {
  used: number // tokens in the context window now
  size: number // the context window
  cost: { amount: number; currency: string } | null
  tokens: TokenTotals | null // session totals, when the agent reports them
}

export interface TokenTotals {
  total: number
  input: number
  output: number
  thought: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export interface SubagentInfo {
  description: string | null // the parent's description of the child's purpose
  canCancel: boolean // the child's `capabilities.cancel`
  stateKnown: boolean // false after an `unknown` state, until a known one arrives
  stopReason: string | null // from the last `idle` state
}

export interface ConfigOption {
  id: string
  name: string
  description?: string
  category: 'mode' | 'model' | 'model_config' | 'thought_level' | 'other'
  type: 'select' | 'boolean'
  value: string | boolean
  choices?: { value: string; name: string; description?: string; group?: string }[]
  idleOnly?: boolean // can change only while no turn runs
}

/** Claude Code's ultracode, an option OverBench adds since the adapter offers none. */
export const ULTRACODE_OPTION_ID = '__ultracode'

export interface SlashCommand {
  name: string
  description: string
  inputHint?: string
}

export type ThreadEntry =
  // `at`: when the message was sent or began, for live messages only; a replay carries no times.
  // `steered`: sent into a running turn rather than as a turn of its own.
  | { kind: 'user'; id: string; content: UserContent[]; at?: number; steered?: boolean }
  | {
      kind: 'agent'
      id: string
      markdown: string
      attachments: ContentRef[]
      streaming: boolean
      at?: number
    }
  | { kind: 'thought'; id: string; markdown: string; streaming: boolean; durationMs?: number }
  | ToolEntry
  | { kind: 'subagent'; id: string; sessionId: string } // a sub-session the agent started here
  | { kind: 'session_message'; id: string; senderId: string | null; content: UserContent[] }
  | { kind: 'plan'; id: string; items: PlanItem[] }
  | {
      kind: 'notice'
      id: string
      severity: 'info' | 'warning' | 'error'
      title: string
      description?: string
      cause?: 'agent_stopped' // the agent exited mid-turn, so the notice ends the turn
    }
  | {
      kind: 'compaction'
      id: string
      status: 'in_progress' | 'completed' | 'failed' | 'cancelled'
      summary: string
    }
  | { kind: 'turn_end'; id: string; stopReason: StopReason; durationMs: number }
  | GitEntry // OverBench's own observation of the repository, see the git design

export type GitEntry =
  | {
      kind: 'git'
      id: string
      event: 'commit'
      commits: { oid: string; subject: string }[]
      more: number
    }
  | { kind: 'git'; id: string; event: 'push'; upstream: string; count: number }
  | { kind: 'git'; id: string; event: 'branch'; branch: string }
  | { kind: 'git'; id: string; event: 'pull_request'; url: string }

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

export interface ToolEntry {
  kind: 'tool'
  id: string
  title: string
  toolKind: ToolKind
  // ACP has no cancelled status: the host sets it when a turn ends before the tool finished.
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  content: ToolContent[]
  locations: { path: string; line?: number }[]
  permission: PendingPermission | null
  permissionResult: { optionId: string; kind: PermissionKind } | 'cancelled' | 'withdrawn' | null
  rawInput?: string // the command or input as text, when the agent sent one
}

export type ToolContent =
  | { type: 'markdown'; markdown: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'ref'; ref: ContentRef }

export interface PendingPermission {
  requestId: string
  options: { id: string; name: string; kind: PermissionKind }[]
}

export type PermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
export type UserContent = { type: 'text'; text: string } | { type: 'ref'; ref: ContentRef }
export type ContentRef =
  | { kind: 'image'; mimeType: string; data: string }
  | { kind: 'link'; uri: string; name: string }
  | { kind: 'unsupported'; label: string }

export interface PlanItem {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Fields an `entry.update` may change; `kind` and `id` never change. */
export type EntryChanges = Partial<DistributiveOmit<ThreadEntry, 'kind' | 'id'>>

export type Patch =
  | { op: 'entry.add'; entry: ThreadEntry }
  | { op: 'entry.appendText'; id: string; text: string } // agent and thought markdown, compaction summary
  | { op: 'entry.update'; id: string; changes: EntryChanges }
  | { op: 'session.update'; changes: Partial<SessionView> }
  | { op: 'thread.reset' } // before a session/load replay

export interface PatchBatch {
  sessionId: string
  seq: number
  patches: Patch[]
}

export type PlanEntry = Extract<ThreadEntry, { kind: 'plan' }>

/** A session as it is shown: its view and the latest page of its thread. */
export interface SessionSnapshot {
  session: SessionView
  entries: ThreadEntry[]
  seq: number
  /** The cursor for the page before `entries`, or null when they start the thread. */
  older: number | null
  /** The latest plan when it lies before `entries`, for the plan pinned above the composer. */
  plan: PlanEntry | null
}

/** A page of older entries, read with the `older` cursor of the page after it. */
export interface OlderPage {
  entries: ThreadEntry[]
  older: number | null
}

/** A session's thread, normalized so one entry can change without touching the others. */
export interface ThreadState {
  session: SessionView
  order: string[]
  byId: Record<string, ThreadEntry>
}

/** Thrown for a patch that names an entry the thread does not have. */
export class UnknownEntryError extends Error {
  constructor(readonly entryId: string) {
    super(`Patch for unknown entry "${entryId}"`)
    this.name = 'UnknownEntryError'
  }
}

export function threadFromSnapshot(snapshot: Omit<SessionSnapshot, 'older' | 'plan'>): ThreadState {
  const byId: Record<string, ThreadEntry> = {}
  const order: string[] = []
  for (const entry of snapshot.entries) {
    if (!(entry.id in byId)) order.push(entry.id)
    byId[entry.id] = entry
  }
  return { session: snapshot.session, order, byId }
}

export function threadEntries(state: ThreadState): ThreadEntry[] {
  return state.order.map((id) => state.byId[id]!)
}

/** The id the agent gave a message, from its entry id (`m:<messageId>`); null when it gave none. */
export function entryMessageId(id: string): string | null {
  return id.startsWith('m:') ? id.slice(2).replace(/#(agent|thought|user)$/, '') : null
}

/** Puts older entries before the thread's own, skipping any it already has. */
export function prependEntries(state: ThreadState, entries: readonly ThreadEntry[]): ThreadState {
  const added = entries.filter((entry) => !(entry.id in state.byId))
  if (added.length === 0) return state
  const byId = { ...state.byId }
  for (const entry of added) byId[entry.id] = entry
  return {
    session: state.session,
    order: [...added.map((entry) => entry.id), ...state.order],
    byId,
  }
}

/**
 * Applies patches in order and returns a new state that shares every object the
 * patches did not change, so a component selecting one entry re-renders only for it.
 * With `partial`, the state holds only the latest pages of the thread, and a patch for an entry
 * it does not have changes one on an older page, which reads it as patched later.
 */
export function applyPatches(
  state: ThreadState,
  patches: readonly Patch[],
  { partial = false }: { partial?: boolean } = {},
): ThreadState {
  let { session, order, byId } = state
  let byIdCopied = false
  let orderCopied = false

  const writableById = (): Record<string, ThreadEntry> => {
    if (!byIdCopied) {
      byId = { ...byId }
      byIdCopied = true
    }
    return byId
  }
  const writableOrder = (): string[] => {
    if (!orderCopied) {
      order = [...order]
      orderCopied = true
    }
    return order
  }

  for (const patch of patches) {
    switch (patch.op) {
      case 'entry.add': {
        const exists = patch.entry.id in byId
        writableById()[patch.entry.id] = patch.entry
        if (!exists) writableOrder().push(patch.entry.id)
        break
      }
      case 'entry.appendText': {
        const entry = byId[patch.id]
        if (!entry) {
          if (partial) break
          throw new UnknownEntryError(patch.id)
        }
        writableById()[patch.id] = appendText(entry, patch.text)
        break
      }
      case 'entry.update': {
        const entry = byId[patch.id]
        if (!entry) {
          if (partial) break
          throw new UnknownEntryError(patch.id)
        }
        writableById()[patch.id] = { ...entry, ...patch.changes } as ThreadEntry
        break
      }
      case 'session.update':
        session = { ...session, ...patch.changes }
        break
      case 'thread.reset':
        byId = {}
        order = []
        byIdCopied = true
        orderCopied = true
        break
    }
  }

  if (session === state.session && order === state.order && byId === state.byId) return state
  return { session, order, byId }
}

/**
 * Applies one patch to a state the caller owns alone, writing into its `order` and `byId` instead
 * of copying them, which `applyPatches` does once per call and makes a replay of N entries cost
 * O(N^2). Changed entries are still new objects. For the agent host's own copy only: the renderer
 * relies on the structural sharing of `applyPatches` for its per-entry selectors.
 */
export function applyPatchInPlace(state: ThreadState, patch: Patch): ThreadState {
  switch (patch.op) {
    case 'entry.add':
      if (!(patch.entry.id in state.byId)) state.order.push(patch.entry.id)
      state.byId[patch.entry.id] = patch.entry
      return state
    case 'entry.appendText': {
      const entry = state.byId[patch.id]
      if (!entry) throw new UnknownEntryError(patch.id)
      state.byId[patch.id] = appendText(entry, patch.text)
      return state
    }
    case 'entry.update': {
      const entry = state.byId[patch.id]
      if (!entry) throw new UnknownEntryError(patch.id)
      state.byId[patch.id] = { ...entry, ...patch.changes } as ThreadEntry
      return state
    }
    case 'session.update':
      return { ...state, session: { ...state.session, ...patch.changes } }
    case 'thread.reset':
      return { session: state.session, order: [], byId: {} }
  }
}

function appendText(entry: ThreadEntry, text: string): ThreadEntry {
  switch (entry.kind) {
    case 'agent':
    case 'thought':
      return { ...entry, markdown: entry.markdown + text }
    case 'compaction':
      return { ...entry, summary: entry.summary + text }
    default:
      throw new Error(`entry.appendText does not apply to ${entry.kind} entries`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isContentRef(value: unknown): value is ContentRef {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'image':
      return typeof value.mimeType === 'string' && typeof value.data === 'string'
    case 'link':
      return typeof value.uri === 'string' && typeof value.name === 'string'
    case 'unsupported':
      return typeof value.label === 'string'
    default:
      return false
  }
}

function isUserContent(value: unknown): value is UserContent {
  if (!isRecord(value)) return false
  if (value.type === 'text') return typeof value.text === 'string'
  return value.type === 'ref' && isContentRef(value.ref)
}

function isToolContent(value: unknown): value is ToolContent {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'markdown':
      return typeof value.markdown === 'string'
    case 'diff':
      return (
        typeof value.path === 'string' &&
        typeof value.newText === 'string' &&
        (value.oldText === null || typeof value.oldText === 'string')
      )
    case 'ref':
      return isContentRef(value.ref)
    default:
      return false
  }
}

const isListOf = <T>(value: unknown, guard: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(guard)

/**
 * Whether a value has the shape of a thread entry: a known kind, an id, and the fields the
 * renderer reads without checking. Entries read back from disk pass through it.
 */
export function isThreadEntry(value: unknown): value is ThreadEntry {
  if (!isRecord(value) || typeof value.id !== 'string') return false
  switch (value.kind) {
    case 'user':
    case 'session_message':
      return isListOf(value.content, isUserContent)
    case 'agent':
      return (
        typeof value.markdown === 'string' &&
        isListOf(value.attachments, isContentRef) &&
        typeof value.streaming === 'boolean'
      )
    case 'thought':
      return typeof value.markdown === 'string' && typeof value.streaming === 'boolean'
    case 'tool':
      return (
        typeof value.title === 'string' &&
        typeof value.toolKind === 'string' &&
        typeof value.status === 'string' &&
        isListOf(value.content, isToolContent) &&
        isListOf(value.locations, isRecord) &&
        (value.permission == null ||
          (isRecord(value.permission) && isListOf(value.permission.options, isRecord)))
      )
    case 'subagent':
      return typeof value.sessionId === 'string'
    case 'plan':
      return isListOf(value.items, isRecord)
    case 'notice':
      return (
        typeof value.severity === 'string' &&
        typeof value.title === 'string' &&
        (value.cause === undefined || value.cause === 'agent_stopped')
      )
    case 'compaction':
      return typeof value.status === 'string' && typeof value.summary === 'string'
    case 'turn_end':
      return typeof value.stopReason === 'string' && typeof value.durationMs === 'number'
    case 'git':
      return value.event === 'commit'
        ? isListOf(value.commits, isRecord)
        : typeof value.event === 'string'
    default:
      return false
  }
}

/** Merges consecutive text appends to the same entry, as the host does before a flush. */
export function coalescePatches(patches: readonly Patch[]): Patch[] {
  const out: Patch[] = []
  for (const patch of patches) {
    const last = out[out.length - 1]
    if (
      patch.op === 'entry.appendText' &&
      last?.op === 'entry.appendText' &&
      last.id === patch.id
    ) {
      out[out.length - 1] = { op: 'entry.appendText', id: patch.id, text: last.text + patch.text }
    } else {
      out.push(patch)
    }
  }
  return out
}
