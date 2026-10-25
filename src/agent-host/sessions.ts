// Live sessions: the authoritative thread state, prompts, permissions, cancellation, the
// session lifecycle, sub-sessions, and the session index.

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import {
  REMOVED_WHILE_STARTING,
  type AttachmentBytes,
  type ContextBreakdown,
  type ImportableSession,
  type SessionAttention,
  type SessionSummary,
  type StartNotice,
} from '@shared/agent-host'
import { PROMPT_BYTES, promptShare } from '@shared/attachments'
import type { BusySession } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import {
  applyPatchInPlace,
  coalescePatches,
  entryMessageId,
  outOfCreditTurn,
  threadEntries,
  threadFromSnapshot,
  UnknownEntryError,
  type AgentId,
  type ConfigOption,
  type OlderPage,
  type Patch,
  type PatchBatch,
  type PermissionKind,
  type PlanEntry,
  type SessionSnapshot,
  type SessionStatus,
  type SessionView,
  type StopReason,
  type Attachment,
  type ThreadEntry,
  type ThreadState,
  type TokenTotals,
  type UserContent,
  ULTRACODE_OPTION_ID,
} from '@shared/thread'
import {
  AgentRequestError,
  type AgentConnection,
  type PermissionAnswer,
  type PermissionRequest,
  type SessionTarget,
} from './acp/connection'
import type { ForkPoint } from './acp/fork-point'
import { ReplayKeeper, writePatch, type ArtifactWrite } from './artifacts/entries'
import {
  addTokenTotals,
  isStopReason,
  mergeConfig,
  newTurnScope,
  SYNTHETIC_MODE_ID,
  promptBlocks,
  type MapperEffect,
  type MapperOutput,
  type ModelTokens,
  type PromptBlock,
  type SubagentState,
  type TurnScope,
} from './acp/mapper'
import { parseContextReport } from './acp/claude-reports'
import { isValueOf, startOrder, type AgentOptionsStore, type ReplacedValue } from './agent-options'
import {
  blockBytes,
  embedFile,
  linkBlock,
  resolvePath,
  sendAttachment,
  toArrayBuffer,
  type Attachments,
} from './attachments'
import { agentError, type AgentManager, type AgentRuntime } from './agents'
import { carryMode, lostValues, lostValuesNotice, type LostValue } from './config-notice'
import type { Diagnostics } from './diagnostics'
import { holdsNothing, mayBeEmpty } from './empty-sessions'
import { HostError, invalidParams, notFound } from './errors'
import { t } from './i18n'
import type { GitEventDraft, GitServiceApi } from './git/api'
import { pathKey, samePath } from './paths'
import { isOutOfCredit } from './out-of-credit'
import { watchSettings, type PreparedRecords, type WatchTarget } from './prepared'
import type { Projects } from './projects'
import type { CacheTtlReader } from './prompt-cache'
import {
  CONTEXT_REPORT,
  hasContextReport,
  hiddenRemoval,
  hiddenSessionMeta,
  removeHiddenSession,
  runReport,
} from './reports'
import type { ScratchFolders } from './scratch'
import type { JsonFile, ReturnedFile, SessionRecord, SessionsFile } from './storage'
import {
  attachmentBlobs,
  changesStored,
  pageStart,
  settled,
  splitLinks,
  storedSession,
  type PositionedEntry,
  type StoredBlob,
  type StoredThread,
  type ThreadPage,
  type ThreadWrite,
} from './threads/model'
import type { ThreadStore } from './threads/store'
import type { UsageRow } from './usage/model'
import { recordRows } from './usage/record'

export interface SessionTimings {
  /** Patches of a session are flushed at most this often. */
  flushMs: number
  /** How long the host waits for an agent to confirm `session/cancel` before ending the turn. */
  cancelFallbackMs: number
  /** A changed thread is stored at most this long after its change; a turn's end stores it at once. */
  checkpointMs: number
  /** An idle session lets its agent go this long after it left the front... */
  releaseHiddenMs: number
  /** ...or after this long idle in front... */
  releaseShownMs: number
  /** ...or this long after it was only opened to read, nothing sent, wherever it is. */
  releaseUnusedMs: number
  /** How long after a request the agent's transcript is read for its cache's lifetime. */
  cacheReadMs: number
  /** A prepared session is replaced this long after the last change to the agent's settings. */
  settingsDelayMs: number
}

export const SESSION_TIMINGS: SessionTimings = {
  flushMs: 16,
  cancelFallbackMs: 10_000,
  checkpointMs: 5_000,
  releaseHiddenMs: 60_000,
  releaseShownMs: 30 * 60_000,
  releaseUnusedMs: 60_000,
  cacheReadMs: 1_000,
  settingsDelayMs: 500,
}

export interface SessionEvents {
  patches(batch: PatchBatch, portIds: readonly string[]): void
  /** To every port, or to `portIds` alone for a prepared session. */
  summary(summary: SessionSummary, portIds?: readonly string[]): void
  removed(sessionId: string, portIds?: readonly string[]): void
  /** A message waits in the host for a window to take back; null for New session. */
  returned(sessionId: string | null): void
  attention(
    sessionId: string,
    kind: 'permission' | 'turn-ended' | 'error',
    title: string,
    body: string,
  ): void
  badge(count: number): void
}

/** The artifacts service, as the sessions pass it to their agents. */
export interface SessionMcp {
  /** What an attach of the session through `connection` passes in `mcpServers`. */
  servers(sessionId: string, record: SessionRecord, connection: AgentConnection): McpServer[]
  /** The session left memory, closed, released or deleted: its token ends. */
  detached(sessionId: string): void
  turnEnded(sessionId: string): void
}

export interface SessionManagerDeps {
  platform: Platform
  agents: AgentManager
  projects: Projects
  scratch: ScratchFolders
  file: JsonFile<SessionsFile>
  /** Messages no session took, kept until a window takes them back. */
  returned: JsonFile<ReturnedFile>
  /** Whether a port is still open, so a failed start knows whether its window can take its message. */
  portOpen(portId: string): boolean
  /** Where threads are stored; without it every session opens through its agent. */
  threads: ThreadStore | null
  diagnostics: Diagnostics
  git(): GitServiceApi | null
  events: SessionEvents
  /** Each agent's options for New session, kept from its new sessions and the user's choices. */
  options?: AgentOptionsStore
  /** Where each turn's usage is recorded; without it nothing is. */
  usage?: {
    record(rows: UsageRow[]): void
    /** Reads what is new in these agents' logs, when Usage on this computer is on. */
    syncAgents(agentIds: AgentId[]): Promise<void>
  }
  /** Reads how long a session's prompt cache lasts from the agent's own transcript. */
  cacheTtl?: CacheTtlReader
  /** The attachments drafts and queued prompts hold; without it a prompt carries none. */
  attachments?: Attachments
  /** The artifacts service; without it every attach passes no MCP servers. */
  mcp?: SessionMcp
  /** The prepared sessions not yet adopted or removed, kept for the host after a crash. */
  prepared?: PreparedRecords
  /** What to watch for changes to the agent's options in a folder; without it nothing is. */
  settingsTargets?: (agentId: AgentId, folder: string) => WatchTarget[]
  timings?: Partial<SessionTimings>
  now?: () => number
}

type Failure =
  | { action: 'create' }
  | { action: 'load' }
  | { action: 'resume' }
  | { action: 'prompt'; content: UserContent[]; entryId: string | null }

interface Turn {
  startedAt: number
  /** As the user wrote it, with the attachments as their records show them. */
  content: UserContent[]
  /** The user entry the turn started with, which shows how its attachments went. */
  entryId: string | null
  ended: boolean
  cancelRequested: boolean
  fallback: ReturnType<typeof setTimeout> | null
  /** The agent reported a request of the session's thread during the turn. */
  requested: boolean
}

/** What `sessions.prepare` asks for: the agent and where the session will work. */
interface PrepareParams {
  agentId: AgentId
  projectPath: string | null
  parentId?: string
}

/** A session opened for a window's New session, outside the index until its first message. */
interface Prepared {
  portId: string
  /** The agent, folder and parent it was asked for, so a request for the same one reuses it. */
  key: string
  params: PrepareParams
  openedAt: number
  notices: StartNotice[]
  /** Settles once its values are set; rejects as the prepare fails. */
  opening: Promise<void>
  /** Its scratch folder was made for it, so it goes with it while still empty. */
  scratch: boolean
  unwatch: (() => void) | null
}

/** A window's prepared sessions: the one New session shows, and the one opening in its place. */
interface PreparedSlot {
  current: Live | null
  next: Live | null
  /** The agent's settings changed since `current` opened, so a send waits for `next`. */
  stale: boolean
}

interface PendingRequest {
  requestId: string
  toolEntryId: string
  options: { id: string; name: string; kind: PermissionKind }[]
  answer(answer: PermissionAnswer): void
}

interface Live {
  id: string
  record: SessionRecord
  saved: boolean
  thread: ThreadState
  seq: number
  queue: Patch[]
  timer: ReturnType<typeof setTimeout> | null
  lastFlushAt: number
  counter: number
  scope: TurnScope
  replaying: boolean
  turn: Turn | null
  /** For a subagent: whether its own work is running, from its last state. */
  childRunning: boolean
  childStartedAt: number | null
  mentioned: boolean
  permissions: Map<string, PendingRequest>
  failure: Failure | null
  unread: boolean
  /** The current error was in front of the user, so the row no longer marks it. */
  errorSeen: boolean
  connection: AgentConnection | null
  target: SessionTarget
  opening: Promise<void> | null
  /** `session/resume` for a session brought back from its stored thread, shared by its callers. */
  attaching: Promise<AgentConnection> | null
  /** Set while the session's tree closes, so no late update brings a child back. */
  closing: boolean
  /** Set as it is deleted, or its project removed, so a start it interrupts fails `not_found`. */
  removing: boolean
  /** Each entry's position in the stored thread, which pages are read by. */
  positions: Map<string, number>
  nextPos: number
  /** Entries changed since the last checkpoint. */
  dirty: Set<string>
  /** The stored part of the session view changed since the last checkpoint. */
  sessionDirty: boolean
  /** The next checkpoint replaces the stored thread: after a replay, or a write that failed. */
  rewrite: boolean
  /** A replay failed partway, so the thread is not stored until one completes. */
  partial: boolean
  /** Bytes of sent attachments for the next checkpoint, by hash. */
  blobs: Map<string, StoredBlob>
  /** The thread's artifact entries while a replay rebuilds it, which the agent does not send. */
  keeper: ReplayKeeper | null
  checkpointTimer: ReturnType<typeof setTimeout> | null
  /** Something was sent or set since it went live; one only opened to read is let go sooner. */
  used: boolean
  /** A new session's first message, in its thread already, to send once the session has started. */
  first: { content: UserContent[]; entryId: string } | null
  /** The values New session chose, set once `session/new` answers, also after a sign-in. */
  startValues: Record<string, string | boolean>
  /** A turn the host ended after a Stop the agent did not confirm, until its prompt is answered. */
  unansweredCancel: Turn | null
  /** It started work that runs on after its tool call, which Claude Code reports no end of. */
  background: boolean
  /** Set while it is a prepared session, not yet in the index. */
  prepared: Prepared | null
  /** Since when nothing has needed its agent, and since when no port has shown it in front. */
  idleSince: number | null
  hiddenSince: number | null
  releaseTimer: ReturnType<typeof setTimeout> | null
}

const TITLE_LENGTH = 60
// Titles from `session/list`, kept for an import that follows; bounded like every cache here.
const LISTED_SESSIONS = 1_000

/** The first line of the first text, cut to 60 characters: the title until the agent sends one. */
export function fallbackTitle(content: readonly UserContent[]): string | null {
  for (const item of content) {
    if (item.type !== 'text') continue
    const line = item.text.trim().split('\n')[0]?.trim() ?? ''
    if (line === '') continue
    const chars = Array.from(line)
    return chars.length > TITLE_LENGTH ? chars.slice(0, TITLE_LENGTH).join('').trimEnd() : line
  }
  return null
}

/** The ids of the attachments a prompt's content names. */
function attachmentIds(content: readonly UserContent[]): string[] {
  return content.flatMap((item) =>
    item.type === 'ref' && item.ref.kind === 'attachment' ? [item.ref.attachment.id] : [],
  )
}

/** The attachments that sessions' queued prompts hold, which go with the sessions. */
function queuedAttachments(records: readonly SessionRecord[]): string[] {
  return records.flatMap((record) =>
    (record.queue ?? []).flatMap((item) =>
      item.content.flatMap((c) =>
        c.type === 'ref' && c.ref.kind === 'attachment' ? [c.ref.attachment.id] : [],
      ),
    ),
  )
}

function entryHolds(entry: ThreadEntry, text: string): boolean {
  if (entry.kind === 'agent') return entry.markdown.includes(text)
  if (entry.kind === 'user') {
    return entry.content.some((part) => part.type === 'text' && part.text.includes(text))
  }
  return false
}

/** Agents with OverBench's ultracode switch: Claude Code, and the fake agent that stands in for it. */
function hasUltracode(agentId: AgentId): boolean {
  return agentId === 'claude-code' || agentId === 'fake-agent'
}

/** `_meta` for session setup: Claude Code's adapter passes `claudeCode.options` to its SDK. */
function sessionMeta(record: SessionRecord): Record<string, unknown> | undefined {
  if (!hasUltracode(record.agentId) || record.ultracode === undefined) return undefined
  return { claudeCode: { options: { settings: { ultracode: record.ultracode } } } }
}

/** The agent's options with the ultracode switch at the end, for agents that have it. */
function withUltracode(
  record: Pick<SessionRecord, 'agentId' | 'ultracode'>,
  config: readonly ConfigOption[],
): ConfigOption[] {
  const rest = config.filter((option) => option.id !== ULTRACODE_OPTION_ID)
  if (!hasUltracode(record.agentId)) return rest
  return [
    ...rest,
    {
      id: ULTRACODE_OPTION_ID,
      name: 'Ultracode',
      description: t('session.ultracodeDescription'),
      category: 'other',
      type: 'boolean',
      value: record.ultracode === true,
      idleOnly: true,
    },
  ]
}

/** The values of a session's agent options; ultracode goes out with the session's `_meta`. */
function agentValues(config: readonly ConfigOption[]): Record<string, string | boolean> {
  return Object.fromEntries(
    config
      .filter((option) => option.id !== ULTRACODE_OPTION_ID)
      .map((option) => [option.id, option.value]),
  )
}

/** `config` with each option in `values` at that value when the option takes it. */
function chosenConfig(
  config: readonly ConfigOption[],
  values: Record<string, string | boolean>,
): ConfigOption[] {
  return config.map((option) => {
    const value = values[option.id]
    return value !== undefined && isValueOf(option, value) ? { ...option, value } : option
  })
}

const CONNECTED: ReadonlySet<SessionStatus> = new Set([
  'starting',
  'auth_required',
  'ready',
  'running',
  'awaiting_permission',
])

export class SessionManager {
  private readonly records = new Map<string, SessionRecord>()
  private readonly live = new Map<string, Live>()
  private readonly watchers = new Map<string, Set<string>>()
  // Port id to the session it shows in front.
  private readonly shown = new Map<string, string>()
  private readonly missing = new Set<string>()
  private readonly lastSummaries = new Map<string, string>()
  /** `/context` reports running, by session id. */
  private readonly contextRuns = new Map<string, Promise<ContextBreakdown | null>>()
  /** The last `seq` of sessions that are not live, so a reopened session continues it. */
  private readonly seqs = new Map<string, number>()
  private readonly listed = new Map<string, { title: string | null; updatedAt: string | null }>()
  /** Sessions being brought back from their stored threads, by id. */
  private readonly reviving = new Map<string, Promise<Live>>()
  /** Idle sessions being let go, by id. */
  private readonly releasing = new Map<string, Promise<void>>()
  /** Transcript reads waiting to run, by session id. */
  private readonly cacheReads = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly timings: SessionTimings
  private readonly now: () => number
  private requestCounter = 0
  private badgeCount = 0
  /** Set once the host shuts down: the last checkpoints are written and no more follow. */
  private stopped = false
  /** The sessions in the index at launch: the only ones `removeEmpty` may remove. */
  private readonly atLaunch = new Set<string>()
  /** When `removeEmpty` ran, kept in the index; null before that. */
  private emptySessionsRemovedAt: number | null = null
  /** Messages no session took, oldest first, until a window takes them back. */
  private returned: ReturnedFile['messages'] = []
  /** Each window's prepared sessions, by port. */
  private readonly preparedSlots = new Map<string, PreparedSlot>()
  private emptyRemoval: Promise<void> | null = null

  constructor(private readonly deps: SessionManagerDeps) {
    this.timings = { ...SESSION_TIMINGS, ...deps.timings }
    this.now = deps.now ?? Date.now
    deps.agents.hooks = {
      liveSessions: (agentId) => this.connectedCount(agentId),
      agentExited: (agentId) => this.agentExited(agentId),
      signedIn: (agentId) => this.agentSignedIn(agentId),
      optionsKnown: (agentId) => !deps.options || deps.options.known(agentId),
      optionsSeen: (agentId, config, folder) => {
        deps.options?.started(
          agentId,
          withUltracode({ agentId }, config),
          pathKey(folder, deps.platform),
        )
      },
      configChanged: (agentId) => this.configChanged(agentId),
    }
  }

  async load(): Promise<void> {
    const file = await this.deps.file.load()
    for (const record of file.sessions) {
      this.records.set(record.id, record)
      this.atLaunch.add(record.id)
    }
    this.emptySessionsRemovedAt = file.emptySessionsRemovedAt ?? null
    this.returned = (await this.deps.returned.load()).messages
  }

  async flush(): Promise<void> {
    await Promise.all([this.deps.file.flush(), this.deps.returned.flush()])
  }

  // Lookups.

  private findByAcp(agentId: AgentId, acpSessionId: string): SessionRecord | undefined {
    for (const live of this.live.values()) {
      if (live.record.agentId === agentId && live.record.acpSessionId === acpSessionId)
        return live.record
    }
    for (const record of this.records.values()) {
      if (record.agentId === agentId && record.acpSessionId === acpSessionId) return record
    }
    return undefined
  }

  private recordOf(sessionId: string): SessionRecord {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    if (!record) throw notFound(`No session ${sessionId}`)
    return record
  }

  has(sessionId: string): boolean {
    return this.live.has(sessionId) || this.records.has(sessionId)
  }

  /** The session's title, null for one without a title yet, undefined for one not in the index. */
  title(sessionId: string): string | null | undefined {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.records.get(sessionId)
    if (!record) return undefined
    return record.customTitle ?? (live ? live.thread.session.title : record.title)
  }

  /**
   * The session in memory attached through `connection` whose agent session is `id`, or the one
   * the agent's subagent `id` runs under.
   */
  sessionOf(connection: object, id: string): string | null {
    for (const live of this.live.values()) {
      if (live.connection !== connection || !live.connection) continue
      if (live.record.acpSessionId === live.connection.rootOf(id)) return live.id
    }
    return null
  }

  /** The session's running turn, for telling it from a later one; null between turns. */
  runningTurn(sessionId: string): object | null {
    const turn = this.live.get(sessionId)?.turn
    return turn && !turn.ended ? turn : null
  }

  private children(parentId: string): SessionRecord[] {
    const ids = new Set<string>()
    const out: SessionRecord[] = []
    for (const record of [
      ...this.records.values(),
      ...[...this.live.values()].map((l) => l.record),
    ]) {
      if (record.parentId === parentId && !ids.has(record.id)) {
        ids.add(record.id)
        out.push(record)
      }
    }
    return out
  }

  /** Every sub-session below `sessionId`, deepest first. */
  private descendants(sessionId: string, origin?: SessionRecord['origin']): SessionRecord[] {
    const out: SessionRecord[] = []
    const visit = (id: string): void => {
      for (const child of this.children(id)) {
        if (origin && child.origin !== origin) continue
        visit(child.id)
        out.push(child)
      }
    }
    visit(sessionId)
    return out
  }

  private connectedCount(agentId: AgentId): number {
    let count = 0
    for (const live of this.live.values()) {
      if (live.record.agentId === agentId && CONNECTED.has(live.thread.session.status)) count++
    }
    return count
  }

  // Summaries and patches.

  private persistedUnread(record: SessionRecord): boolean {
    return record.lastViewedAt !== null && record.updatedAt > record.lastViewedAt
  }

  summary(sessionId: string): SessionSummary {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.recordOf(sessionId)
    const session = live?.thread.session
    const status: SessionStatus = session?.status ?? 'closed'
    const permissionCount = live?.permissions.size ?? 0
    let attention: SessionAttention = 'none'
    if (permissionCount > 0) attention = 'permission'
    else if (status === 'failed' || (session?.error && status !== 'running' && !live?.errorSeen))
      attention = 'error'
    else if (live ? live.unread : this.persistedUnread(record)) attention = 'unread'
    const git = this.deps.git()
    const pr =
      record.branch && git
        ? (git.branchPullRequests(record.projectPath).get(record.branch) ?? null)
        : null
    return {
      id: record.id,
      agentId: record.agentId,
      projectPath: record.projectPath,
      scratch: this.deps.scratch.contains(record.projectPath),
      title: record.customTitle ?? (session ? session.title : record.title),
      status,
      attention,
      permissionCount,
      createdAt: record.createdAt,
      updatedAt: session?.updatedAt ?? record.updatedAt,
      parentId: record.parentId,
      origin: record.origin,
      description: record.description,
      missing: this.missing.has(record.id),
      branch: record.branch,
      pr: pr ? { number: pr.number, state: pr.state, url: pr.url } : null,
      cache: record.cache ?? null,
      model: record.model ?? null,
      pinnedAt: record.pinnedAt ?? null,
      archivedAt: record.archivedAt ?? null,
      ...(live?.prepared
        ? {
            prepared: {
              config: session?.config ?? [],
              notices: live.prepared.notices,
              openedAt: live.prepared.openedAt,
            },
          }
        : {}),
    }
  }

  list(projectPath?: string): SessionSummary[] {
    const ids = new Set<string>([...this.records.keys(), ...this.live.keys()])
    const key = projectPath === undefined ? null : pathKey(projectPath, this.deps.platform)
    const out: SessionSummary[] = []
    for (const id of ids) {
      // A prepared session is its window's alone until its first message.
      if (this.live.get(id)?.prepared) continue
      const summary = this.summary(id)
      if (key === null || pathKey(summary.projectPath, this.deps.platform) === key)
        out.push(summary)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The scratch folders sessions run in, live or indexed, so terminals may open there. */
  scratchFolders(): string[] {
    const { platform, scratch } = this.deps
    const folders = new Map<string, string>()
    const records = [
      ...this.records.values(),
      ...[...this.live.values()].filter((l) => !l.prepared).map((l) => l.record),
    ]
    for (const { projectPath } of records) {
      if (scratch.contains(projectPath)) folders.set(pathKey(projectPath, platform), projectPath)
    }
    return [...folders.values()]
  }

  /** Sends the summary to every port if it changed, after the session's pending patches. */
  private touch(sessionId: string): void {
    if (!this.has(sessionId)) return
    const summary = this.summary(sessionId)
    const json = JSON.stringify(summary)
    if (this.lastSummaries.get(sessionId) === json) return
    const live = this.live.get(sessionId)
    if (live) this.flushPatches(live)
    this.lastSummaries.set(sessionId, json)
    if (live?.prepared) this.deps.events.summary(summary, [live.prepared.portId])
    else this.deps.events.summary(summary)
  }

  private updateBadge(): void {
    let count = 0
    for (const live of this.live.values()) count += live.permissions.size
    if (count === this.badgeCount) return
    this.badgeCount = count
    this.deps.events.badge(count)
  }

  private emit(live: Live, patches: readonly Patch[]): void {
    for (const patch of patches) {
      if (patch.op === 'thread.reset') {
        const keeper = new ReplayKeeper(live.thread)
        live.keeper = keeper.empty ? null : keeper
      }
      const { keeper } = live
      if (keeper && patch.op === 'entry.add') {
        for (const entry of keeper.before(patch.entry)) this.apply(live, { op: 'entry.add', entry })
      }
      if (!this.apply(live, patch)) continue
      if (keeper && patch.op === 'entry.add') {
        for (const entry of keeper.after(patch.entry)) this.apply(live, { op: 'entry.add', entry })
      }
    }
    this.scheduleFlush(live)
    this.scheduleCheckpoint(live)
  }

  /** Applies one patch and queues it to send; false for one the thread could not take. */
  private apply(live: Live, patch: Patch): boolean {
    try {
      live.thread = applyPatchInPlace(live.thread, patch)
    } catch (error) {
      if (!(error instanceof UnknownEntryError)) throw error
      // A bug in the mapper, not in the agent: recorded, and the patch is not sent.
      this.deps.diagnostics.log('error', `Session ${live.id}: ${error.message}`)
      return false
    }
    this.track(live, patch)
    live.queue.push(patch)
    return true
  }

  /** A write to the artifacts service by the session, or by a subagent of it, goes in its thread. */
  artifactWritten(sessionId: string, write: ArtifactWrite): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.emit(live, [writePatch(live.thread, write, () => this.nextId(live, 'a'))])
  }

  /** A replay ended: the artifact entries it never came back to go at its end. */
  private restoreKept(live: Live): void {
    const { keeper } = live
    if (!keeper) return
    live.keeper = null
    this.emit(
      live,
      keeper.rest().map((entry) => ({ op: 'entry.add', entry })),
    )
  }

  /** Notes what a patch changed for the next checkpoint. */
  private track(live: Live, patch: Patch): void {
    switch (patch.op) {
      case 'entry.add':
        if (!live.positions.has(patch.entry.id)) live.positions.set(patch.entry.id, live.nextPos++)
        live.dirty.add(patch.entry.id)
        break
      case 'entry.appendText':
      case 'entry.update':
        live.dirty.add(patch.id)
        break
      case 'session.update':
        if (changesStored(patch.changes)) live.sessionDirty = true
        break
      case 'thread.reset':
        live.positions.clear()
        live.nextPos = 0
        live.dirty.clear()
        live.rewrite = true
        break
    }
  }

  private update(live: Live, changes: Partial<SessionView>): void {
    if (changes.error) live.errorSeen = this.inFront(live.id)
    this.emit(live, [{ op: 'session.update', changes }])
    if ('status' in changes) this.refreshRelease(live)
    // New session shows a prepared session through its summary, not its patches.
    if (live.prepared && ('config' in changes || 'status' in changes)) this.touch(live.id)
  }

  private scheduleFlush(live: Live): void {
    if (live.timer || live.queue.length === 0) return
    const wait = Math.max(0, live.lastFlushAt + this.timings.flushMs - this.now())
    live.timer = setTimeout(() => {
      live.timer = null
      this.flushPatches(live)
    }, wait)
  }

  /** Every flush is one batch with the next `seq`, whether or not a port watches. */
  private flushPatches(live: Live): void {
    if (live.timer) {
      clearTimeout(live.timer)
      live.timer = null
    }
    if (live.queue.length === 0) return
    const patches = coalescePatches(live.queue)
    live.queue = []
    live.seq++
    live.lastFlushAt = this.now()
    const ports = this.watchers.get(live.id)
    if (ports && ports.size > 0) {
      this.deps.events.patches({ sessionId: live.id, seq: live.seq, patches }, [...ports])
    }
  }

  private nextId(live: Live, prefix = 'e'): string {
    return `${prefix}:${++live.counter}`
  }

  // Checkpoints: each session's thread goes to the thread store, so it opens without its agent.

  private hasChanges(live: Live): boolean {
    return live.rewrite || live.sessionDirty || live.dirty.size > 0 || live.blobs.size > 0
  }

  private scheduleCheckpoint(live: Live): void {
    if (live.checkpointTimer || !this.deps.threads || this.stopped || live.replaying) return
    if (!live.saved || live.partial || !this.hasChanges(live)) return
    live.checkpointTimer = setTimeout(() => {
      live.checkpointTimer = null
      this.checkpoint(live)
    }, this.timings.checkpointMs)
  }

  /**
   * Writes what changed since the last checkpoint. The store answers in order, so a later read
   * sees it. A failed write is logged, and the next checkpoint writes the whole thread again.
   */
  private checkpoint(live: Live, { afterShutdown = false } = {}): void {
    if (live.checkpointTimer) {
      clearTimeout(live.checkpointTimer)
      live.checkpointTimer = null
    }
    const store = this.deps.threads
    if (!store || (this.stopped && !afterShutdown) || live.replaying || live.partial || !live.saved)
      return
    if (!live.record.acpSessionId || !this.hasChanges(live)) return
    const replace = live.rewrite
    const entries: PositionedEntry[] = []
    for (const id of replace ? live.thread.order : live.dirty) {
      const entry = live.thread.byId[id]
      const pos = live.positions.get(id)
      if (entry && pos !== undefined) entries.push({ pos, entry })
    }
    const blobs = [...live.blobs.values()]
    const change: ThreadWrite = {
      head: { agentId: live.record.agentId, acpSessionId: live.record.acpSessionId },
      entries,
      ...(replace || live.sessionDirty ? { session: storedSession(live.thread.session) } : {}),
      ...(replace ? { replace: true } : {}),
      ...(blobs.length > 0 ? { blobs } : {}),
    }
    live.dirty = new Set()
    live.sessionDirty = false
    live.rewrite = false
    live.blobs = new Map()
    store.write(live.id, change).catch((error: unknown) => {
      live.rewrite = true
      // Kept for the rewrite, which takes the whole thread but only the bytes it is handed.
      for (const blob of blobs) if (!live.blobs.has(blob.hash)) live.blobs.set(blob.hash, blob)
      this.deps.diagnostics.log(
        'warn',
        `Could not store the thread of session ${live.id}: ${(error as Error).message}`,
      )
    })
  }

  // Snapshots and pages: a session's view with the latest page of its thread, from memory while
  // it is live and from the thread store otherwise.

  /** The stored thread's page, or null when there is none for the session's current ACP session. */
  private async readPage(
    record: SessionRecord,
    read: (store: ThreadStore) => Promise<ThreadPage | null>,
  ): Promise<ThreadPage | null> {
    const store = this.deps.threads
    if (!store || !record.acpSessionId) return null
    let page: ThreadPage | null
    try {
      page = await read(store)
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not read the thread of session ${record.id}: ${(error as Error).message}`,
      )
      return null
    }
    if (!page || !this.isCurrent(record, page.head)) return null
    const split = splitLinks(page.entries)
    return split ? { ...page, entries: split } : page
  }

  private async readThread(record: SessionRecord): Promise<StoredThread | null> {
    const store = this.deps.threads
    if (!store || !record.acpSessionId) return null
    let thread: StoredThread | null
    try {
      thread = await store.load(record.id)
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not read the thread of session ${record.id}: ${(error as Error).message}`,
      )
      return null
    }
    return thread && this.isCurrent(record, thread.head) ? thread : null
  }

  /** A thread stored for another ACP session is out of date: the agent's history replaces it. */
  private isCurrent(record: SessionRecord, head: StoredThread['head']): boolean {
    return head.agentId === record.agentId && head.acpSessionId === record.acpSessionId
  }

  async snapshot(sessionId: string, from?: number): Promise<SessionSnapshot> {
    const live = this.live.get(sessionId)
    if (live) return this.liveSnapshot(live, from)
    const record = this.recordOf(sessionId)
    const page = await this.readPage(record, (store) =>
      from === undefined ? store.page(sessionId) : store.tail(sessionId, from),
    )
    // It went live, or away, while the page was read.
    if (this.live.has(sessionId) || !this.has(sessionId)) return this.snapshot(sessionId, from)
    return this.storedSnapshot(record, page)
  }

  private liveSnapshot(live: Live, from: number | undefined): SessionSnapshot {
    this.flushPatches(live)
    const { order, byId } = live.thread
    const start =
      from === undefined ? pageStart(order, byId, order.length) : this.indexAt(live, from)
    return {
      session: live.thread.session,
      entries: order.slice(start).map((id) => byId[id]!),
      seq: live.seq,
      older: start > 0 ? this.posAt(live, start) : null,
      plan: this.planBefore(live, start),
    }
  }

  /** The view of a session that is not live, with its stored page; empty without one. */
  private storedSnapshot(record: SessionRecord, page: ThreadPage | null): SessionSnapshot {
    const view = this.closedView(record)
    return {
      session: page
        ? {
            ...view,
            config: withUltracode(record, page.session.config),
            commands: page.session.commands,
            usage: page.session.usage,
          }
        : view,
      entries: page ? page.entries.map(settled) : [],
      seq: this.seqs.get(record.id) ?? 0,
      older: page?.older ?? null,
      plan: page?.plan ?? null,
    }
  }

  /** The index of the first entry at or after a position. */
  private indexAt(live: Live, pos: number): number {
    const { order } = live.thread
    let low = 0
    let high = order.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (live.positions.get(order[mid]!)! < pos) low = mid + 1
      else high = mid
    }
    return low
  }

  private posAt(live: Live, index: number): number {
    const id = live.thread.order[index]
    return id === undefined ? live.nextPos : live.positions.get(id)!
  }

  /** The latest plan, when it lies before the index `start`. */
  private planBefore(live: Live, start: number): PlanEntry | null {
    const { order, byId } = live.thread
    for (let i = order.length - 1; i >= 0; i--) {
      const entry = byId[order[i]!]
      if (entry?.kind === 'plan') return i < start ? entry : null
    }
    return null
  }

  /** The page before the position `before`, for a renderer scrolling back through the thread. */
  async page(sessionId: string, before: number): Promise<OlderPage> {
    const live = this.live.get(sessionId)
    if (live) {
      // Patches go out before the page, so the renderer has every change to the entries it holds.
      this.flushPatches(live)
      const { order, byId } = live.thread
      const end = this.indexAt(live, before)
      const start = pageStart(order, byId, end)
      return {
        entries: order.slice(start, end).map((id) => byId[id]!),
        older: start > 0 ? this.posAt(live, start) : null,
      }
    }
    const record = this.recordOf(sessionId)
    const page = await this.readPage(record, (store) => store.page(sessionId, before))
    if (this.live.has(sessionId) || !this.has(sessionId)) return this.page(sessionId, before)
    return page
      ? { entries: page.entries.map(settled), older: page.older }
      : { entries: [], older: null }
  }

  private closedView(record: SessionRecord): SessionView {
    return {
      id: record.id,
      agentId: record.agentId,
      projectPath: record.projectPath,
      acpSessionId: record.acpSessionId || null,
      status: 'closed',
      title: record.title,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      parentId: record.parentId,
      origin: record.origin,
      subagent:
        record.origin === 'subagent'
          ? {
              description: record.description,
              canCancel: false,
              stateKnown: false,
              stopReason: null,
            }
          : null,
      queue: record.queue ?? [],
      // A queue from before a close or a restart waits until the user resumes it.
      queuePaused: (record.queue?.length ?? 0) > 0,
    }
  }

  private makeLive(record: SessionRecord, saved: boolean, status: SessionStatus): Live {
    const view: SessionView = { ...this.closedView(record), status }
    const seq = this.seqs.get(record.id) ?? 0
    const target: SessionTarget = {
      context: () => ({
        thread: live.thread,
        replaying: live.replaying,
        cancelling: live.turn ? live.turn.cancelRequested : live.unansweredCancel !== null,
        scope: live.scope,
        now: this.now(),
        nextId: () => this.nextId(live),
        sessionIdFor: (acpSessionId) => this.findByAcp(record.agentId, acpSessionId)?.id ?? null,
      }),
      apply: (output) => this.applyOutput(live, output),
      requestPermission: (request, signal) => this.requestPermission(live, request, signal),
    }
    const live: Live = {
      id: record.id,
      record,
      saved,
      thread: threadFromSnapshot({ session: view, entries: [], seq }),
      seq,
      queue: [],
      timer: null,
      lastFlushAt: 0,
      counter: 0,
      scope: newTurnScope(),
      replaying: false,
      turn: null,
      childRunning: false,
      childStartedAt: null,
      mentioned: false,
      permissions: new Map(),
      failure: null,
      unread: this.persistedUnread(record),
      errorSeen: false,
      connection: null,
      target,
      opening: null,
      attaching: null,
      closing: false,
      removing: false,
      positions: new Map(),
      nextPos: 0,
      dirty: new Set(),
      sessionDirty: false,
      rewrite: false,
      partial: false,
      blobs: new Map(),
      keeper: null,
      checkpointTimer: null,
      used: false,
      first: null,
      startValues: {},
      unansweredCancel: null,
      background: false,
      prepared: null,
      idleSince: null,
      hiddenSince: this.inFront(record.id) ? null : this.now(),
      releaseTimer: null,
    }
    this.live.set(record.id, live)
    this.deps.agents.sessionsChanged(record.agentId)
    return live
  }

  private attach(live: Live, connection: AgentConnection): void {
    if (live.connection && live.connection !== connection) {
      live.connection.unregister(live.record.acpSessionId, live.target)
    }
    live.connection = connection
    connection.register(live.record.acpSessionId, live.target)
  }

  /** The artifacts service for an attach of the session, to an agent that takes MCP over HTTP. */
  private mcpServers(
    sessionId: string,
    record: SessionRecord,
    runtime: AgentRuntime | null | undefined,
  ): McpServer[] {
    if (!this.deps.mcp || !runtime?.init.capabilities.mcpHttp) return []
    return this.deps.mcp.servers(sessionId, record, runtime.connection)
  }

  private dropLive(live: Live): void {
    this.flushPatches(live)
    if (live.checkpointTimer) clearTimeout(live.checkpointTimer)
    if (live.releaseTimer) clearTimeout(live.releaseTimer)
    if (live.turn?.fallback) clearTimeout(live.turn.fallback)
    live.connection?.unregister(live.record.acpSessionId, live.target)
    this.deps.mcp?.detached(live.id)
    this.seqs.set(live.id, live.seq)
    this.live.delete(live.id)
    this.deps.agents.sessionsChanged(live.record.agentId)
  }

  private saveIndex(): void {
    // JsonFile serializes when it writes, so the latest records go out without copies here.
    this.deps.file.save({
      version: 1,
      sessions: [...this.records.values()],
      ...(this.emptySessionsRemovedAt === null
        ? {}
        : { emptySessionsRemovedAt: this.emptySessionsRemovedAt }),
    })
  }

  private persist(live: Live): void {
    if (!live.saved) return
    const session = live.thread.session
    live.record.title = session.title
    live.record.updatedAt = session.updatedAt
    if (session.queue.length > 0) live.record.queue = session.queue
    else delete live.record.queue
    // Until the stored thread is read, the view has neither, and the record keeps what it had.
    if (session.usage?.cache) live.record.cache = session.usage.cache
    const model = modelOf(session.config)
    if (model !== null) live.record.model = model
    this.records.set(live.id, live.record)
    this.saveIndex()
  }

  private save(live: Live): void {
    live.saved = true
    this.records.set(live.id, live.record)
    this.persist(live)
    this.scheduleCheckpoint(live)
  }

  // Mapper output.

  private applyOutput(live: Live, output: MapperOutput): void {
    if (live.closing) return
    if (output.patches.length > 0) this.emit(live, output.patches)
    for (const effect of output.effects) this.applyEffect(live, effect)
    this.touch(live.id)
  }

  private applyEffect(live: Live, effect: MapperEffect): void {
    const { agentId, projectPath } = live.record
    switch (effect.kind) {
      case 'limit':
        this.deps.agents.setLimit(agentId, effect.limit)
        break
      case 'title': {
        if (effect.title === null) {
          const fallback = this.firstUserText(live)
          if (fallback) this.update(live, { title: fallback })
        }
        this.persist(live)
        break
      }
      case 'ignored':
        this.deps.diagnostics.event(
          agentId,
          'ignored',
          `${effect.variant}: ${effect.detail} (session ${live.id})`,
        )
        break
      case 'tool': {
        const git = this.deps.git()
        if (!git) break
        if (effect.phase === 'started') git.toolCallStarted(projectPath, live.id, effect.toolCallId)
        else
          git.toolCallEnded(projectPath, live.id, effect.toolCallId, effect.toolKind, effect.output)
        break
      }
      case 'subagent':
        this.applySubagent(live, effect)
        break
      case 'background':
        live.background = true
        this.refreshRelease(live)
        break
      case 'request':
        // A turn's transcript is read as it ends; a request between turns has a read of its own.
        if (live.turn) live.turn.requested = true
        else {
          this.persist(live)
          this.scheduleCacheRead(live)
        }
        break
    }
  }

  private scheduleCacheRead(live: Live): void {
    if (!this.deps.cacheTtl || this.cacheReads.has(live.id)) return
    const timer = setTimeout(() => {
      this.cacheReads.delete(live.id)
      void this.readCacheTtl(live)
    }, this.timings.cacheReadMs)
    timer.unref?.()
    this.cacheReads.set(live.id, timer)
  }

  /** Keeps the lifetime already known when the transcript names none. */
  private async readCacheTtl(live: Live): Promise<void> {
    const { agentId, projectPath, acpSessionId } = live.record
    let ttl: number | null
    try {
      ttl = (await this.deps.cacheTtl?.(agentId, projectPath, acpSessionId)) ?? null
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Session ${live.id}: could not read the prompt cache: ${(error as Error).message}`,
      )
      return
    }
    if (ttl === null || live.closing || this.live.get(live.id) !== live) return
    const usage = live.thread.session.usage
    if (!usage?.cache || usage.cache.ttl === ttl) return
    this.update(live, { usage: { ...usage, cache: { ...usage.cache, ttl } } })
    this.persist(live)
    this.touch(live.id)
  }

  private firstUserText(live: Live): string | null {
    for (const id of live.thread.order) {
      const entry = live.thread.byId[id]
      if (entry?.kind === 'user') return fallbackTitle(entry.content)
    }
    return null
  }

  // Sub-sessions from the subagents RFD.

  private applySubagent(parent: Live, effect: Extract<MapperEffect, { kind: 'subagent' }>): void {
    const { agentId } = parent.record
    const now = this.now()
    let record = this.findByAcp(agentId, effect.acpSessionId)
    if (!record) {
      record = {
        id: randomUUID(),
        agentId,
        acpSessionId: effect.acpSessionId,
        projectPath: parent.record.projectPath,
        title: effect.title ?? null,
        createdAt: now,
        updatedAt: now,
        lastViewedAt: null,
        parentId: parent.id,
        origin: 'subagent',
        description: effect.description ?? null,
        branch: null,
        ...(parent.record.configDir ? { configDir: parent.record.configDir } : {}),
      }
    }
    let child = this.live.get(record.id)
    if (!child) {
      child = this.makeLive(record, false, 'ready')
      child.replaying = parent.replaying
      child.unread = false
      this.update(child, {
        subagent: {
          description: record.description,
          canCancel: false,
          stateKnown: true,
          stopReason: null,
        },
      })
    }
    if (parent.saved && !child.saved) this.save(child)
    if (parent.connection) this.attach(child, parent.connection)
    child.mentioned = true
    this.missing.delete(child.id)

    const entryId = `s:${child.id}`
    if (!parent.thread.byId[entryId]) {
      this.emit(parent, [
        { op: 'entry.add', entry: { kind: 'subagent', id: entryId, sessionId: child.id } },
      ])
    }

    const info = child.thread.session.subagent ?? {
      description: null,
      canCancel: false,
      stateKnown: true,
      stopReason: null,
    }
    const changes: Partial<SessionView> = {}
    const nextInfo = { ...info }
    if (effect.title !== undefined) changes.title = effect.title
    if (effect.description !== undefined) {
      nextInfo.description = effect.description
      child.record.description = effect.description
    }
    if (effect.canCancel !== undefined) nextInfo.canCancel = effect.canCancel
    if (effect.state) this.applySubagentState(child, effect.state, changes, nextInfo, now)
    changes.subagent = nextInfo
    this.update(child, changes)
    this.persist(child)
    this.touch(child.id)
  }

  private applySubagentState(
    child: Live,
    state: SubagentState,
    changes: Partial<SessionView>,
    info: NonNullable<SessionView['subagent']>,
    now: number,
  ): void {
    switch (state.kind) {
      case 'running':
      case 'requires_action':
        if (!child.childRunning) child.childStartedAt = now
        child.childRunning = true
        info.stateKnown = true
        changes.status =
          state.kind === 'requires_action' || child.permissions.size > 0
            ? 'awaiting_permission'
            : 'running'
        changes.error = null
        changes.updatedAt = now
        break
      case 'idle': {
        const startedAt = child.childStartedAt
        child.childRunning = false
        child.childStartedAt = null
        info.stateKnown = true
        info.stopReason = state.stopReason
        changes.updatedAt = now
        if (state.error) {
          changes.status = 'failed'
          changes.error = state.error
        } else {
          changes.status = child.permissions.size > 0 ? 'awaiting_permission' : 'ready'
          changes.error = null
        }
        // A replay reports work the totals already hold.
        if (state.tokens && !child.replaying) {
          const usage = child.thread.session.usage
          changes.usage = {
            used: usage?.used ?? 0,
            size: usage?.size ?? 0,
            cost: usage?.cost ?? null,
            tokens: addTokenTotals(usage?.tokens ?? null, state.tokens),
          }
        }
        if (startedAt !== null && isStopReason(state.stopReason) && !child.replaying) {
          this.closeOpenEntries(child)
          this.emit(child, [
            {
              op: 'entry.add',
              entry: {
                kind: 'turn_end',
                id: this.nextId(child),
                stopReason: state.stopReason,
                durationMs: now - startedAt,
              },
            },
          ])
        }
        if (!child.replaying && !this.inFront(child.id)) child.unread = true
        break
      }
      case 'unknown':
      case 'cleared':
        info.stateKnown = false
        break
    }
  }

  // Watching and showing. A renderer keeps a few recent sessions watched, so switching back is
  // instant; only the one it shows in front counts as seen.

  private inFront(sessionId: string): boolean {
    for (const shown of this.shown.values()) if (shown === sessionId) return true
    return false
  }

  watch(sessionId: string, portId: string): void {
    this.recordOf(sessionId) // rejects an unknown session
    let ports = this.watchers.get(sessionId)
    if (!ports) {
      ports = new Set()
      this.watchers.set(sessionId, ports)
    }
    ports.add(portId)
  }

  unwatch(sessionId: string, portId: string): void {
    const ports = this.watchers.get(sessionId)
    if (!ports?.delete(portId)) return
    if (ports.size === 0) this.watchers.delete(sessionId)
  }

  /** The session a port shows in front, or null for none; the one it leaves was seen until now. */
  show(sessionId: string | null, portId: string): void {
    const previous = this.shown.get(portId) ?? null
    if (sessionId === previous) return
    if (sessionId === null) this.shown.delete(portId)
    else this.shown.set(portId, this.recordOf(sessionId).id)
    if (previous !== null && this.has(previous)) this.markViewed(previous, this.recordOf(previous))
    if (sessionId !== null) this.markViewed(sessionId, this.recordOf(sessionId))
    for (const id of [previous, sessionId]) {
      const live = id === null ? undefined : this.live.get(id)
      if (!live) continue
      live.hiddenSince = this.inFront(live.id) ? null : this.now()
      this.refreshRelease(live)
    }
  }

  portClosed(portId: string): void {
    const slot = this.preparedSlots.get(portId)
    for (const live of [slot?.current, slot?.next]) if (live) void this.dropPrepared(live)
    this.shown.delete(portId)
    for (const [sessionId, ports] of this.watchers) {
      if (ports.delete(portId) && ports.size === 0) this.watchers.delete(sessionId)
    }
  }

  private markViewed(sessionId: string, record: SessionRecord): void {
    record.lastViewedAt = this.now()
    const live = this.live.get(sessionId)
    if (live) {
      live.unread = false
      live.errorSeen = true
    }
    if (this.records.has(sessionId)) this.saveIndex()
    this.touch(sessionId)
  }

  // Creating, opening and recovering.

  /** Without a `projectPath`, the session gets a scratch folder of its own. */
  async create(
    params: {
      agentId: AgentId
      projectPath: string | null
      parentId?: string
      options?: Record<string, string | boolean>
      prompt?: UserContent[]
      preparedId?: string
    },
    portId: string,
  ): Promise<SessionSummary> {
    const { agents, projects, scratch } = this.deps
    if (!agents.has(params.agentId)) throw invalidParams(`Unknown agent ${params.agentId}`)
    // Before a prepared session is taken over, so a refused prompt leaves it prepared.
    const prompt = params.prompt && this.hydrate(params.prompt)
    if (params.preparedId !== undefined) {
      const adopted = await this.adopt({
        agentId: params.agentId,
        preparedId: params.preparedId,
        prompt,
      })
      if (adopted) return adopted
    }
    if (params.projectPath === null && params.parentId !== undefined) {
      throw invalidParams('A sub-session belongs to the project of its parent')
    }
    const projectPath =
      params.projectPath === null
        ? await scratch.create()
        : await projects.resolveDirectory(params.projectPath)
    if (params.parentId !== undefined) {
      const parent = this.recordOf(params.parentId)
      if (!samePath(parent.projectPath, projectPath, this.deps.platform)) {
        throw invalidParams('A sub-session belongs to the project of its parent')
      }
    }
    if (!scratch.contains(projectPath)) await projects.add(projectPath)
    const now = this.now()
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: params.agentId,
      acpSessionId: '',
      projectPath,
      title: null,
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      parentId: params.parentId ?? null,
      origin: 'user',
      description: null,
      branch: null,
    }
    const { [ULTRACODE_OPTION_ID]: ultracode, ...options } = params.options ?? {}
    if (typeof ultracode === 'boolean' && hasUltracode(record.agentId)) record.ultracode = ultracode
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    live.used = true
    // The message shows at once and goes out as the session's first turn, so it never enters the
    // index without it.
    if (prompt) live.first = { content: prompt, entryId: this.addPrompt(live, prompt, now) }
    this.touch(live.id)
    try {
      live.startValues = options
      await this.startNew(live)
    } catch (error) {
      if (!(error instanceof HostError && error.code === 'auth_required')) {
        // Gone is dropped already; nothing left to show, so its message stays in its draft.
        const removed =
          error instanceof HostError &&
          error.code === 'not_found' &&
          (error.data as { reason?: unknown } | undefined)?.reason === REMOVED_WHILE_STARTING
        // The window that sent the message has gone, so the host keeps it for the next one.
        if (prompt && !removed && !this.deps.portOpen(portId)) {
          this.returned.push({ sessionId: null, content: prompt, at: this.now() })
          this.saveReturned()
          const ids = attachmentIds(prompt)
          if (ids.length > 0) this.deps.attachments?.held(ids)
          this.deps.events.returned(null)
        }
        // A session closed or deleted while it started is already dropped.
        if (this.live.get(live.id) === live) this.dropLive(live)
        this.forget(live.id)
        throw error
      }
    }
    return this.summary(live.id)
  }

  /** Removes and returns the messages kept for a session, oldest first; a taken one is gone. */
  takeReturned(sessionId: string | null): UserContent[][] {
    const taken = this.returned.filter((message) => message.sessionId === sessionId)
    if (taken.length === 0) return []
    this.returned = this.returned.filter((message) => message.sessionId !== sessionId)
    this.saveReturned()
    return taken.map((message) => message.content)
  }

  private saveReturned(): void {
    this.deps.returned.save({ version: 1, messages: this.returned })
  }

  // Prepared sessions: the session New session's first message will use, opened ahead of it so
  // the menu shows what the agent reports for it.

  /**
   * The window's prepared session for the agent and folder: the one it holds when it asks again
   * for the same, unless `replace`, else a new one, which replaces the window's last once it
   * answers. Resolves once `session/new` has answered and the start values are set.
   */
  async prepare(
    params: PrepareParams & { options?: Record<string, string | boolean>; replace?: boolean },
    portId: string,
  ): Promise<SessionSummary> {
    if (!this.deps.agents.has(params.agentId)) {
      throw invalidParams(`Unknown agent ${params.agentId}`)
    }
    const key = preparedKey(params)
    const slot = this.slotOf(portId)
    const held = slot.next ?? (slot.stale ? null : slot.current)
    if (!params.replace && held?.prepared?.key === key) {
      await held.prepared.opening
      if (params.options && held.prepared && held.connection) {
        await this.applyStartOptions(held, held.connection, params.options)
        const set = Object.keys(params.options)
        held.prepared.notices = held.prepared.notices.filter((n) => !set.includes(n.optionId))
        this.touch(held.id)
      }
      return this.summary(held.id)
    }
    const live = await this.openPrepared(params, portId, key)
    if (slot.next && slot.next !== live) void this.dropPrepared(slot.next)
    slot.next = live
    try {
      await live.prepared!.opening
    } catch (error) {
      if (slot.next === live) slot.next = null
      throw error
    }
    if (slot.next === live) {
      const previous = slot.current
      slot.current = live
      slot.next = null
      slot.stale = false
      if (previous && previous !== live) void this.dropPrepared(previous)
    }
    return this.summary(live.id)
  }

  /** Removes a prepared session that was not adopted; one already adopted or gone is left. */
  async discard(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId)
    if (live?.prepared) await this.dropPrepared(live)
  }

  private slotOf(portId: string): PreparedSlot {
    let slot = this.preparedSlots.get(portId)
    if (!slot) {
      slot = { current: null, next: null, stale: false }
      this.preparedSlots.set(portId, slot)
    }
    return slot
  }

  private async openPrepared(
    params: PrepareParams & { options?: Record<string, string | boolean> },
    portId: string,
    key: string,
  ): Promise<Live> {
    const { projects, scratch } = this.deps
    let projectPath: string
    if (params.parentId !== undefined) {
      projectPath = this.recordOf(params.parentId).projectPath
      if (
        params.projectPath !== null &&
        !samePath(params.projectPath, projectPath, this.deps.platform)
      ) {
        throw invalidParams('A sub-session belongs to the project of its parent')
      }
    } else {
      projectPath =
        params.projectPath === null
          ? await scratch.create()
          : await projects.resolveDirectory(params.projectPath)
    }
    const now = this.now()
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: params.agentId,
      acpSessionId: '',
      projectPath,
      title: null,
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      parentId: params.parentId ?? null,
      origin: 'user',
      description: null,
      branch: null,
    }
    const { [ULTRACODE_OPTION_ID]: ultracode, ...options } = params.options ?? {}
    if (typeof ultracode === 'boolean' && hasUltracode(record.agentId)) record.ultracode = ultracode
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    const prepared: Prepared = {
      portId,
      key,
      params: {
        agentId: params.agentId,
        projectPath: params.projectPath,
        ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
      },
      openedAt: now,
      notices: [],
      opening: Promise.resolve(),
      scratch: params.projectPath === null && params.parentId === undefined,
      unwatch: null,
    }
    live.prepared = prepared
    prepared.opening = this.runPrepare(live, options).catch(async (error: unknown) => {
      if (live.prepared === prepared) await this.dropPrepared(live)
      throw error
    })
    // A failure reaches the caller that waits; a replacement nobody waits for only logs it.
    prepared.opening.catch((error: unknown) => {
      if (error instanceof HostError && error.code === 'not_found') return
      this.deps.diagnostics.log(
        'warn',
        `Could not prepare a ${record.agentId} session: ${agentError(error).message}`,
      )
    })
    return live
  }

  /** `session/new` in the session's folder, then the remembered values and the window's picks. */
  private async runPrepare(live: Live, picks: Record<string, string | boolean>): Promise<void> {
    const { agentId } = live.record
    const gone = (): boolean => live.closing || this.live.get(live.id) !== live
    const runtime = await this.deps.agents.ensureReady(agentId)
    void this.removeLeftovers(runtime)
    if (gone()) throw removedWhileStarting()
    let setup
    try {
      setup = await runtime.connection.newSession(
        live.record.projectPath,
        sessionMeta(live.record),
        this.mcpServers(live.id, live.record, runtime),
      )
    } catch (error) {
      if (gone()) throw removedWhileStarting()
      const mapped = agentError(error)
      if (mapped.code === 'auth_required') this.deps.agents.authRequired(agentId)
      throw mapped
    }
    this.deps.prepared?.add({
      agentId,
      acpSessionId: setup.acpSessionId,
      cwd: live.record.projectPath,
    })
    if (gone()) {
      await this.removeUnlisted(live.id, runtime, setup.acpSessionId)
      this.deps.prepared?.remove(agentId, setup.acpSessionId)
      throw removedWhileStarting()
    }
    live.record.acpSessionId = setup.acpSessionId
    this.stampConfig(live.record)
    this.attach(live, runtime.connection)
    // The cache names values the session no longer lists, so it is read before it takes them.
    const cached = this.deps.options?.get(agentId)?.config ?? []
    const own = withUltracode({ agentId }, setup.config)
    const replaced =
      this.deps.options?.started(
        agentId,
        own,
        pathKey(live.record.projectPath, this.deps.platform),
      ) ?? []
    this.update(live, {
      acpSessionId: setup.acpSessionId,
      config: withUltracode(live.record, setup.config),
      error: null,
    })
    const wanted = { ...this.deps.options?.rememberedOf(agentId), ...picks }
    const config = await this.applyStartOptions(live, runtime.connection, wanted, {
      stop: () => gone() || runtime.connection.isClosed,
    })
    if (gone()) throw removedWhileStarting()
    if (live.prepared) {
      live.prepared.notices = [
        ...replaced.map((r) => replacedNotice(r, config, cached)),
        ...unmetValues(wanted, own, config, cached),
      ]
      this.watchPrepared(live)
    }
    this.update(live, { status: 'ready' })
    this.deps.agents.signedIn(agentId)
  }

  /** Replaces the prepared session once the agent's settings change on disk. */
  private watchPrepared(live: Live): void {
    const prepared = live.prepared
    const targets =
      prepared && this.deps.settingsTargets?.(live.record.agentId, live.record.projectPath)
    if (!prepared || !targets?.length) return
    prepared.unwatch = watchSettings(
      targets,
      () => {
        const slot = this.preparedSlots.get(prepared.portId)
        if (!slot || live.prepared !== prepared || slot.current !== live) return
        slot.stale = true
        this.prepare({ ...prepared.params, replace: true }, prepared.portId).catch(() => {})
      },
      this.timings.settingsDelayMs,
      (message) => this.deps.diagnostics.log('warn', message),
    )
  }

  /** Takes the prepared session off its window and removes it from its agent, leaving no trace. */
  private async dropPrepared(live: Live, { agentGone = false } = {}): Promise<void> {
    const prepared = live.prepared
    if (!prepared) return
    live.prepared = null
    prepared.unwatch?.()
    const slot = this.preparedSlots.get(prepared.portId)
    if (slot?.current === live) slot.current = null
    if (slot?.next === live) slot.next = null
    if (slot && !slot.current && !slot.next) this.preparedSlots.delete(prepared.portId)
    live.closing = true
    const { agentId, acpSessionId, projectPath } = live.record
    const connected = live.connection !== null && !!acpSessionId
    if (this.live.get(live.id) === live) this.dropLive(live)
    this.forget(live.id, [prepared.portId])
    const runtime = this.deps.agents.runtime(agentId)
    // An agent that exited took the session with it, but for one that stores it the record stays
    // for the next start to remove.
    if (connected && runtime && !agentGone) {
      await this.removeUnlisted(live.id, runtime, acpSessionId)
      this.deps.prepared?.remove(agentId, acpSessionId)
    }
    if (prepared.scratch) await this.deps.scratch.removeIfEmpty(projectPath)
  }

  /** The prepared sessions a host that stopped without removing them left in the agent. */
  private async removeLeftovers(runtime: AgentRuntime): Promise<void> {
    for (const left of this.deps.prepared?.takeLeftovers(runtime.agentId) ?? []) {
      await this.removeUnlisted(`left by an earlier run in ${left.cwd}`, runtime, left.acpSessionId)
      this.deps.prepared?.remove(left.agentId, left.acpSessionId)
    }
  }

  /**
   * The first send's session: the window's prepared one, with the values it was set to, or the
   * one opening in its place when the agent's settings changed. Null when none is ready to use,
   * so the caller creates the session afresh.
   */
  /** `prompt` is already hydrated. */
  private async adopt(params: {
    agentId: AgentId
    preparedId: string
    prompt: UserContent[] | undefined
  }): Promise<SessionSummary | null> {
    const asked = this.live.get(params.preparedId)
    if (!asked?.prepared || asked.record.agentId !== params.agentId) return null
    const { portId, key } = asked.prepared
    const slot = this.preparedSlots.get(portId)
    const live = slot?.stale && slot.next?.prepared?.key === key ? slot.next : asked
    try {
      await live.prepared?.opening
    } catch {
      return null
    }
    if (!live.prepared || this.live.get(live.id) !== live || !live.connection) return null
    if (live.thread.session.status !== 'ready') return null
    const prepared = live.prepared
    live.prepared = null
    prepared.unwatch?.()
    if (slot) {
      for (const other of [slot.current, slot.next]) {
        if (other && other !== live) void this.dropPrepared(other)
      }
      this.preparedSlots.delete(portId)
    }
    this.deps.prepared?.remove(live.record.agentId, live.record.acpSessionId)
    const { projectPath } = live.record
    if (!this.deps.scratch.contains(projectPath)) await this.deps.projects.add(projectPath)
    const now = this.now()
    Object.assign(live.record, { createdAt: now, updatedAt: now, lastViewedAt: now })
    live.used = true
    live.hiddenSince = this.inFront(live.id) ? null : now
    const { prompt } = params
    const entryId = prompt ? this.addPrompt(live, prompt, now) : null
    this.save(live)
    this.touch(live.id)
    if (prompt && entryId) this.startTurn(live, prompt, now, entryId)
    return this.summary(live.id)
  }

  /**
   * `session/new`, then the start values that differ from the new session's own; on
   * `auth_required` the session waits in that state and stays live. It enters the index once
   * `session/new` answers, so one closed while its values are set stays listed, closed. One
   * deleted, or whose project is removed, before or while it starts is not saved again, and the
   * start fails with `not_found`.
   */
  private async startNew(live: Live): Promise<void> {
    const gone = (): boolean => live.closing || this.live.get(live.id) !== live
    let runtime: AgentRuntime
    try {
      runtime = await this.deps.agents.ensureReady(live.record.agentId)
    } catch (error) {
      // Its failure, such as the agent's exit, no longer belongs to a session that went meanwhile.
      if (gone()) throw removedWhileStarting()
      throw this.failStart(live, error, { action: 'create' })
    }
    if (gone()) throw removedWhileStarting()
    let setup
    try {
      setup = await runtime.connection.newSession(
        live.record.projectPath,
        sessionMeta(live.record),
        this.mcpServers(live.id, live.record, runtime),
      )
    } catch (error) {
      // Its failure, such as the agent's exit, no longer belongs to a session that went meanwhile.
      if (gone()) throw removedWhileStarting()
      const failed = this.failStart(live, error, { action: 'create' })
      // The first message waits for the sign-in, which retries the start and then sends it.
      if (failed.code === 'auth_required' && live.first) this.signInNotice(live, failed)
      throw failed
    }
    if (gone()) {
      // It never reached the index, so the agent's new session goes the way a hidden one does.
      await this.removeUnlisted(live.id, runtime, setup.acpSessionId)
      throw removedWhileStarting()
    }
    if (this.stopped) {
      // The quit ran while `session/new` was pending: the message waits in its queue and the
      // session goes into the index and the thread store as the quit closes them.
      live.record.acpSessionId = setup.acpSessionId
      this.update(live, {
        acpSessionId: setup.acpSessionId,
        config: withUltracode(live.record, chosenConfig(setup.config, live.startValues)),
        status: 'closed',
      })
      this.save(live)
      this.holdFirst(live)
      this.checkpoint(live, { afterShutdown: true })
      return
    }
    live.record.acpSessionId = setup.acpSessionId
    this.stampConfig(live.record)
    this.attach(live, runtime.connection)
    live.failure = null
    const { agentId } = live.record
    // As the agent's defaults: ultracode off, whatever this session starts with.
    const own = withUltracode({ agentId }, setup.config)
    const replaced =
      this.deps.options?.started(
        agentId,
        own,
        pathKey(live.record.projectPath, this.deps.platform),
      ) ?? []
    // A remembered value that a later change outside OverBench replaced is not set again.
    for (const { option, wanted } of replaced) {
      if (live.startValues[option.id] === wanted) delete live.startValues[option.id]
    }
    this.update(live, {
      acpSessionId: setup.acpSessionId,
      config: withUltracode(live.record, setup.config),
      error: null,
    })
    this.save(live)
    const config = await this.applyStartOptions(live, runtime.connection, live.startValues, {
      stop: () => gone() || runtime.connection.isClosed,
    })
    if (gone()) {
      // Closing or deleting it already closed or deleted the agent's session; closing it kept the
      // first message in its paused queue.
      if (live.removing || !this.has(live.id)) throw removedWhileStarting()
      return
    }
    if (runtime.connection.isClosed) {
      // The agent went while the values were set, which leaves the session stored and closed. Its
      // values were not refused, only not set, so there is nothing to say.
      this.update(live, {
        config: withUltracode(live.record, chosenConfig(config, live.startValues)),
        status: 'closed',
      })
      this.persist(live)
      this.touch(live.id)
      const first = live.first
      live.first = null
      if (first) this.startTurn(live, first.content, this.now(), first.entryId)
      return
    }
    this.update(live, { status: 'ready' })
    this.deps.agents.signedIn(agentId)
    this.touch(live.id)
    const first = live.first
    live.first = null
    if (!first) return
    // The first message never goes out with a value the user did not choose.
    const wanted = Object.entries(live.startValues).flatMap(([id, value]): ConfigOption[] => {
      const option = config.find((o) => o.id === id) ?? own.find((o) => o.id === id)
      return option && id !== ULTRACODE_OPTION_ID ? [{ ...option, value }] : []
    })
    const notice = lostValuesNotice(lostValues(wanted, config), { subject: 'start', held: true })
    if (!notice) {
      this.startTurn(live, first.content, this.now(), first.entryId)
      return
    }
    this.emit(live, [
      { op: 'entry.add', entry: { kind: 'notice', id: this.nextId(live), ...notice } },
    ])
    this.update(live, {
      queue: [
        { id: randomUUID(), content: first.content, at: this.now() },
        ...live.thread.session.queue,
      ],
      queuePaused: true,
    })
    this.persist(live)
  }

  /**
   * A new session closed, or stopped by the quit, before its first message went out: the message
   * waits at the front of its paused queue, and the thread says so, as it does for a prompt held
   * when the mode was lost.
   */
  private holdFirst(live: Live): void {
    if (!live.saved || !live.first) return
    const { content } = live.first
    live.first = null
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'info',
          title: t('notice.closedBeforeSent.title'),
          description: t('notice.closedBeforeSent.description'),
        },
      },
    ])
    const queue = live.thread.session.queue
    this.update(live, {
      queue: [{ id: randomUUID(), content, at: this.now() }, ...queue],
      queuePaused: true,
    })
    this.persist(live)
  }

  /** The thread's notice that the agent asks to sign in, as a failed turn adds it. */
  private signInNotice(live: Live, error: HostError): void {
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'error',
          title: t('notice.signInNeeded', { agent: this.deps.agents.name(live.record.agentId) }),
          description: error.message,
        },
      },
    ])
  }

  /** Removes an agent's session that no thread or index entry holds, leaving no trace. */
  private async removeUnlisted(
    sessionId: string,
    runtime: AgentRuntime,
    acpSessionId: string,
  ): Promise<void> {
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `Could not remove the session of ${sessionId}: ${message}`)
    const removal = hiddenRemoval(runtime.agentId, runtime.init)
    if (removal) {
      await removeHiddenSession(runtime, acpSessionId, removal, log)
    } else if (runtime.init.capabilities.closeSession) {
      runtime.connection.unregister(acpSessionId)
      await runtime.connection.closeSession(acpSessionId).catch((error: unknown) => {
        log((error as Error).message)
      })
    }
  }

  /**
   * Sets the values New session chose, in `startOrder`, each against the options as they stand
   * after the one before. A value the session does not offer, or one the agent refuses, is
   * logged and left at the agent's value, so the start itself never fails on it. With `restore`
   * the values are ones a session already had, a fork's source's or its own as it attaches again:
   * they are not the user's latest choice, and the model is sent again while an option is missing,
   * since an agent can list an option only once a model is set. With `from`, the options are
   * worked on apart from the session's and returned, for the caller to report once all are set;
   * `stop` ends it before the next value.
   */
  private async applyStartOptions(
    live: Live,
    connection: AgentConnection,
    options: Record<string, string | boolean>,
    {
      restore = false,
      from,
      stop,
    }: { restore?: boolean; from?: ConfigOption[]; stop?: () => boolean } = {},
  ): Promise<ConfigOption[]> {
    const { agentId, acpSessionId } = live.record
    let held = from
    const current = (): ConfigOption[] => held ?? live.thread.session.config
    for (const id of startOrder(current(), Object.keys(options))) {
      if (stop?.()) break
      const value = options[id]
      const config = current()
      const option = config.find((o) => o.id === id)
      const offerMissing =
        restore &&
        option?.category === 'model' &&
        Object.keys(options).some((wanted) => !config.some((o) => o.id === wanted))
      if (value === undefined || (option?.value === value && !offerMissing)) continue
      if (!option || !isValueOf(option, value)) {
        this.deps.diagnostics.log(
          'warn',
          `${agentId} session ${live.id} does not offer ${id} = ${String(value)}; keeping the agent's value`,
        )
        continue
      }
      try {
        let next: ConfigOption[]
        if (id === SYNTHETIC_MODE_ID) {
          await connection.setMode(acpSessionId, value as string)
          next = config.map((o): ConfigOption => (o.id === id ? { ...o, value } : o))
        } else {
          next = mergeConfig(config, await connection.setConfigOption(acpSessionId, id, value))
        }
        // Gone meanwhile: what the agent answered no longer belongs to a session.
        if (stop?.()) break
        if (held) held = next
        else this.update(live, { config: withUltracode(live.record, next) })
        if (!restore) this.deps.options?.chose(agentId, option, value, next)
      } catch (error) {
        this.deps.diagnostics.log(
          'warn',
          `${agentId} session ${live.id} refused ${id} = ${String(value)}: ${agentError(error).message}`,
        )
      }
    }
    return current()
  }

  /** Records why a start failed; auth goes to `auth_required`, the rest to `failed`. */
  private failStart(live: Live, error: unknown, failure: Failure): HostError {
    const mapped = agentError(error)
    live.failure = failure
    if (mapped.code === 'auth_required') {
      this.deps.agents.authRequired(live.record.agentId)
      this.update(live, { status: 'auth_required', error: null })
    } else {
      this.update(live, { status: 'failed', error: { message: mapped.message } })
      // A session still being created is in front of the user, and create rejects instead.
      if (live.saved)
        this.deps.events.attention(live.id, 'error', this.titleOf(live), mapped.message)
    }
    this.touch(live.id)
    return mapped
  }

  /**
   * Opens a session: a live one from memory, another from its stored thread without starting its
   * agent, which attaches once the session is used. One with no stored thread, as an imported
   * session, loads its history from the agent and stays live. Agent-side failures leave the
   * session live in `failed` or `auth_required`, so the snapshot shows them with Retry.
   */
  async open(sessionId: string): Promise<SessionSnapshot> {
    const existing = this.live.get(sessionId)
    if (existing) {
      if (existing.opening) await existing.opening
      return this.snapshot(sessionId)
    }
    const record = this.recordOf(sessionId)
    const page = await this.readPage(record, (store) => store.page(sessionId))
    if (this.live.has(sessionId) || !this.has(sessionId)) return this.open(sessionId)
    if (page) return this.storedSnapshot(record, page)
    if (record.origin === 'subagent' && record.parentId) {
      // A subagent's thread comes back with its parent's load, which replays the children.
      await this.open(record.parentId)
      return this.snapshot(sessionId)
    }
    const live = this.makeLive(record, true, 'starting')
    await this.runOpening(live)
    return this.snapshot(sessionId)
  }

  private runOpening(live: Live): Promise<void> {
    if (live.opening) return live.opening
    const run = this.reconnect(live)
      .catch(() => {
        // reconnect() already moved the session to failed or auth_required.
      })
      .finally(() => {
        live.opening = null
        this.refreshRelease(live)
      })
    live.opening = run
    return run
  }

  /** `session/load`, replaying the history, or `session/resume` for an agent without it. */
  private async reconnect(live: Live): Promise<void> {
    this.update(live, { status: 'starting', error: null })
    this.touch(live.id)
    let runtime: AgentRuntime
    try {
      runtime = await this.deps.agents.ensureReady(live.record.agentId)
    } catch (error) {
      throw this.failStart(live, error, { action: 'load' })
    }
    const caps = runtime.init.capabilities
    const { connection } = runtime
    const { acpSessionId, projectPath } = live.record
    const useLoad = caps.loadSession
    if (!useLoad && !caps.resumeSession) {
      throw this.failStart(
        live,
        new HostError(
          'agent_unavailable',
          t('session.cannotLoad', { agent: this.deps.agents.name(live.record.agentId) }),
        ),
        { action: 'load' },
      )
    }
    this.attach(live, connection)
    const mcpServers = this.mcpServers(live.id, live.record, runtime)
    try {
      if (useLoad) {
        this.prepareReplay(live, connection)
        let setup
        try {
          setup = await connection.loadSession(
            acpSessionId,
            projectPath,
            sessionMeta(live.record),
            mcpServers,
          )
        } catch (error) {
          this.finishReplay(live, false)
          throw error
        }
        this.finishReplay(live, true)
        this.opened(live, setup.config)
      } else {
        const setup = await connection.resumeSession(
          acpSessionId,
          projectPath,
          sessionMeta(live.record),
          mcpServers,
        )
        this.opened(live, setup.config)
        if (live.thread.order.length === 0) {
          this.emit(live, [
            {
              op: 'entry.add',
              entry: {
                kind: 'notice',
                id: this.nextId(live),
                severity: 'info',
                title: t('notice.historyUnavailable.title'),
                description: t('notice.historyUnavailable.description', {
                  agent: this.deps.agents.name(live.record.agentId),
                }),
              },
            },
          ])
        }
        for (const child of this.descendants(live.id, 'subagent')) {
          const childLive = this.live.get(child.id)
          if (childLive) this.attach(childLive, connection)
        }
      }
    } catch (error) {
      throw this.failStart(live, error, { action: useLoad ? 'load' : 'resume' })
    }
    live.failure = null
    this.deps.agents.signedIn(live.record.agentId)
    this.update(live, { status: 'ready', error: null })
    this.touch(live.id)
    this.checkpoint(live)
  }

  /** Resets the parent's thread and every known subagent below it for a replay. */
  private prepareReplay(live: Live, connection: AgentConnection): void {
    live.replaying = true
    live.partial = false
    live.scope = newTurnScope()
    this.emit(live, [{ op: 'thread.reset' }])
    for (const record of this.descendants(live.id, 'subagent')) {
      const child =
        this.live.get(record.id) ?? this.makeLive(record, this.records.has(record.id), 'starting')
      child.replaying = true
      child.mentioned = false
      child.scope = newTurnScope()
      this.emit(child, [{ op: 'thread.reset' }])
      this.attach(child, connection)
    }
  }

  /**
   * After a replay, children it did not mention are marked missing. After a failed one,
   * every child goes back to the index, to come back with the next attempt.
   */
  private finishReplay(live: Live, ok: boolean): void {
    live.replaying = false
    live.partial = !ok
    this.restoreKept(live)
    for (const record of this.descendants(live.id, 'subagent')) {
      const child = this.live.get(record.id)
      if (!child) continue
      child.replaying = false
      this.restoreKept(child)
      if (ok && child.mentioned) {
        if (child.thread.session.status === 'starting') this.update(child, { status: 'ready' })
        this.touch(child.id)
        this.checkpoint(child)
        continue
      }
      if (ok) this.missing.add(child.id)
      this.dropLive(child)
      if (this.records.has(child.id)) this.touch(child.id)
      else this.forget(child.id)
    }
  }

  /** The agent's configuration folder changed: its prepared sessions belong to the old one. */
  private configChanged(agentId: AgentId): void {
    for (const live of [...this.live.values()]) {
      if (live.record.agentId === agentId && live.prepared) void this.dropPrepared(live)
    }
  }

  /**
   * The agent exited unexpectedly: a running turn ends with a notice, and every session it held
   * goes back to closed with its thread stored, to attach again when it is used. Nothing restarts
   * the agent, so a crash never brings back sessions no one is using.
   */
  private agentExited(agentId: AgentId): void {
    const name = this.deps.agents.name(agentId)
    const held: SessionRecord[] = []
    for (const live of [...this.live.values()]) {
      if (live.record.agentId !== agentId) continue
      // New session prepares another once it needs one.
      if (live.prepared) {
        void this.dropPrepared(live, { agentGone: true })
        continue
      }
      // A session takes its connection only once it has attached, so its turn was never sent.
      const attaching = live.connection === null
      live.connection = null
      // Its background work ended with its process.
      live.background = false
      const status = live.thread.session.status
      if (!CONNECTED.has(status) || status === 'starting' || status === 'auth_required') continue
      const turn = live.turn?.ended === false ? live.turn : null
      // Its attach fails with the exit and ends the turn as a failed attach does, so Retry sends
      // the prompt that never went out, and only once that attach has settled.
      if (turn && attaching) continue
      const cut = turn !== null && !turn.cancelRequested
      if (turn && !cut) {
        // The user had stopped it, so it ends stopped rather than cut short.
        this.endTurn(live, turn, 'cancelled', null)
      } else if (turn) {
        this.finishTurn(live, turn, null)
        this.emit(live, [
          {
            op: 'entry.add',
            entry: {
              kind: 'notice',
              id: this.nextId(live),
              severity: 'error',
              ...stoppedNotice(name),
            },
          },
        ])
      }
      this.clearPermissions(live, 'withdrawn')
      live.childRunning = false
      if (cut) {
        const now = this.now()
        this.update(live, { updatedAt: now })
        if (this.inFront(live.id)) live.record.lastViewedAt = now
        this.persist(live)
        this.deps.events.attention(
          live.id,
          'error',
          this.titleOf(live),
          t('notice.stopped.title', { agent: name }),
        )
      }
      held.push(live.record)
    }
    // With no connection, closing waits for nothing, so no request comes in between.
    this.closeAll(held, true).catch((error: unknown) => {
      this.deps.diagnostics.log(
        'warn',
        `Could not close sessions of ${agentId}: ${(error as Error).message}`,
      )
    })
    this.updateBadge()
  }

  private agentSignedIn(agentId: AgentId): void {
    for (const live of [...this.live.values()]) {
      if (live.record.agentId === agentId && live.thread.session.status === 'auth_required') {
        void this.retry(live.id).catch(() => {})
      }
    }
  }

  /**
   * Re-runs what failed: the sign-in retry, a resume, a load after a failed resume, or a turn the
   * model provider refused for want of credit.
   */
  async retry(sessionId: string): Promise<void> {
    let live = this.live.get(sessionId)
    if (!live) {
      const snapshot = await this.open(sessionId)
      // A turn refused for want of credit is sent again after a restart too, from its stored thread.
      if (
        this.recordOf(sessionId).origin === 'subagent' ||
        !outOfCreditTurn(threadFromSnapshot(snapshot))
      ) {
        return
      }
      live = await this.revive(sessionId)
    }
    if (live.opening) return live.opening
    // A subagent recovers with its parent; its own failures are the agent's to retry.
    if (live.record.origin === 'subagent') return
    const status = live.thread.session.status
    const unpaid = canSend(status) ? outOfCreditTurn(live.thread) : null
    if (unpaid) {
      // The same prompt again, under its own entry; the turn attaches the session if it has to.
      live.used = true
      this.startTurn(live, unpaid.prompt.content, this.now(), unpaid.prompt.id)
      return
    }
    const failure = live.failure
    if (status !== 'failed' && status !== 'auth_required') return
    if (this.deps.agents.status(live.record.agentId).state === 'failed') {
      await this.deps.agents.retry(live.record.agentId).catch(() => {})
      // A retry that came in meanwhile took the session: it sends what is left, once.
      const taken = live.thread.session.status
      if ((taken !== 'failed' && taken !== 'auth_required') || live.failure !== failure) return
    }
    switch (failure?.action) {
      case 'create':
        this.update(live, { status: 'starting', error: null })
        this.touch(live.id)
        await this.startNew(live).catch(() => {})
        return
      case 'prompt':
        // The turn attaches the session again if it has to.
        this.update(live, { status: 'ready', error: null })
        this.startTurn(live, failure.content, this.now(), failure.entryId)
        return
      case 'load':
      case 'resume':
        // "Reopen": a resume that failed falls back to replaying the history.
        await this.runOpening(live)
        return
      default:
        if (!live.record.acpSessionId) {
          this.update(live, { status: 'starting', error: null })
          this.touch(live.id)
          await this.startNew(live).catch(() => {})
        } else {
          await this.runOpening(live)
        }
    }
  }

  // Releasing: an idle session lets its agent go, so a Claude Code CLI runs only for the sessions
  // in use. Its thread is stored, and it attaches again with `session/resume` once used.

  /** Whether a session needs its agent now: work runs, waits for the user, or runs on unseen. */
  private holdsAgent(live: Live): boolean {
    const { status } = live.thread.session
    if (status !== 'ready' && status !== 'closed') return true
    if (live.turn || live.opening || live.attaching || live.background) return true
    if (live.permissions.size > 0 || this.contextRuns.has(live.id)) return true
    return this.descendants(live.id, 'subagent').some((record) => {
      const child = this.live.get(record.id)
      if (!child) return false
      const childStatus = child.thread.session.status
      return (
        child.childRunning ||
        child.background ||
        child.permissions.size > 0 ||
        childStatus === 'running' ||
        childStatus === 'awaiting_permission' ||
        childStatus === 'starting'
      )
    })
  }

  /** The session a subagent's work belongs to, which is released with its subagents. */
  private rootOf(live: Live): Live | null {
    let current = live
    while (current.record.origin === 'subagent' && current.record.parentId) {
      const parent = this.live.get(current.record.parentId)
      if (!parent) return null
      current = parent
    }
    return current
  }

  /** Arms the release of the session `from` belongs to, from when it became idle and hidden. */
  private refreshRelease(from: Live): void {
    const live = this.rootOf(from)
    if (!live) return
    if (live.releaseTimer) {
      clearTimeout(live.releaseTimer)
      live.releaseTimer = null
    }
    if (this.stopped || live.closing || !live.saved || live.record.origin !== 'user') return
    if (this.holdsAgent(live)) {
      live.idleSince = null
      return
    }
    const now = this.now()
    live.idleSince ??= now
    const { releaseHiddenMs, releaseShownMs, releaseUnusedMs } = this.timings
    const due = !live.used
      ? live.idleSince + releaseUnusedMs
      : this.inFront(live.id)
        ? live.idleSince + releaseShownMs
        : Math.max(live.idleSince, live.hiddenSince ?? now) + releaseHiddenMs
    live.releaseTimer = setTimeout(
      () => {
        live.releaseTimer = null
        if (this.live.get(live.id) !== live) return
        if (this.now() >= due && !live.closing && !this.holdsAgent(live)) this.release(live)
        else this.refreshRelease(live)
      },
      Math.max(0, due - now),
    )
  }

  /** Stores the session's thread, closes its agent's session and its subagents, and drops it. */
  private release(live: Live): void {
    if (this.releasing.has(live.id)) return
    this.deps.diagnostics.event(live.record.agentId, 'session released', live.id)
    const run = this.closeAll([...this.descendants(live.id, 'subagent'), live.record], true)
      .catch((error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `Could not release session ${live.id}: ${(error as Error).message}`,
        )
      })
      .finally(() => this.releasing.delete(live.id))
    this.releasing.set(live.id, run)
  }

  // Sessions that come back from their stored threads: live without their agent, in `closed`,
  // until a turn or a setting needs it.

  /** The live session, brought back from its stored thread when it is not live. */
  private async revive(sessionId: string): Promise<Live> {
    // A session being let go comes back once it has gone.
    await this.releasing.get(sessionId)
    const live = this.live.get(sessionId)
    if (live) return live
    let reviving = this.reviving.get(sessionId)
    if (!reviving) {
      reviving = this.runRevive(sessionId)
        .then((revived) => {
          this.refreshRelease(revived)
          return revived
        })
        .finally(() => this.reviving.delete(sessionId))
      this.reviving.set(sessionId, reviving)
    }
    return reviving
  }

  /**
   * Its subagents come back with it, so an update the agent sends about one adds to the thread it
   * has rather than starting it again.
   */
  private async runRevive(sessionId: string): Promise<Live> {
    const tree = [this.recordOf(sessionId), ...this.descendants(sessionId, 'subagent')]
    const threads = await Promise.all(
      tree.map((record) => (this.live.has(record.id) ? null : this.readThread(record))),
    )
    const existing = this.live.get(sessionId)
    if (existing) return existing
    const record = this.recordOf(sessionId)
    if (!threads[0]) {
      // Nothing stored, or nothing readable: the agent's own history, as on a first open.
      const live = this.makeLive(record, true, 'starting')
      await this.runOpening(live)
      return live
    }
    tree.forEach((item, i) => {
      const stored = threads[i]
      if (stored && !this.live.has(item.id) && this.records.has(item.id)) {
        this.fill(this.makeLive(item, true, 'closed'), stored)
      }
    })
    return this.live.get(sessionId)!
  }

  /** Puts a stored thread, settled, into a session that just went live. */
  private fill(live: Live, stored: StoredThread): void {
    const order: string[] = []
    const byId: Record<string, ThreadEntry> = {}
    let { entries } = stored
    const split = splitLinks(entries.map((item) => item.entry))
    if (split) {
      // New entries between stored ones: the thread is stored again whole, numbered afresh.
      entries = split.map((entry, pos) => ({ pos, entry }))
      live.rewrite = true
    }
    for (const { pos, entry } of entries) {
      const shown = settled(entry)
      if (shown !== entry) live.dirty.add(entry.id)
      order.push(entry.id)
      byId[entry.id] = shown
      live.positions.set(entry.id, pos)
      live.nextPos = Math.max(live.nextPos, pos + 1)
      live.counter = Math.max(live.counter, idNumber(entry.id))
    }
    const { config, commands, usage } = stored.session
    live.thread = {
      session: {
        ...live.thread.session,
        config: withUltracode(live.record, config),
        commands,
        usage,
      },
      order,
      byId,
    }
    this.scheduleCheckpoint(live)
  }

  /**
   * Attaches a session that came back from its stored thread to its agent, shared by every caller
   * until it settles. The session keeps its status; the caller sets the next one.
   */
  private connect(live: Live): Promise<AgentConnection> {
    if (live.connection) return Promise.resolve(live.connection)
    live.attaching ??= this.attachStored(live).finally(() => {
      live.attaching = null
      // A turn that ended while it attached, cancelled or held back, armed no release.
      this.refreshRelease(live)
    })
    return live.attaching
  }

  /**
   * `session/resume`, or a `session/load` whose replay is set aside for an agent without it. Then
   * the session's own values go out again, since not every agent opens a session at the values it
   * had, and only then does the session take its connection, so nothing else reaches the agent
   * first: a prompt waits for them, and a cancel ends a turn that was never sent.
   */
  private async attachStored(live: Live): Promise<AgentConnection> {
    const { record } = live
    const own = live.thread.session.config.filter((option) => option.id !== ULTRACODE_OPTION_ID)
    const runtime = await this.deps.agents.ensureReady(record.agentId)
    const caps = runtime.init.capabilities
    const { connection } = runtime
    // A released session is marked closed on the connection; what the agent sends before the
    // session attaches waits for it instead of being dropped.
    connection.reopen(record.acpSessionId)
    let config: ConfigOption[]
    if (caps.resumeSession) {
      const mcpServers = this.mcpServers(live.id, record, runtime)
      try {
        config = (
          await connection.resumeSession(
            record.acpSessionId,
            record.projectPath,
            sessionMeta(record),
            mcpServers,
          )
        ).config
      } catch (error) {
        if (!this.neverAnswered(live, error)) throw this.otherConfig(live, error)
        config = await this.renew(live, connection, mcpServers)
      }
    } else if (caps.loadSession) {
      const mcpServers = this.mcpServers(live.id, record, runtime)
      try {
        config = (await this.loadQuietly(live, connection, mcpServers)).config
      } catch (error) {
        throw this.otherConfig(live, error)
      }
    } else {
      throw new HostError(
        'agent_unavailable',
        t('session.cannotLoad', { agent: this.deps.agents.name(record.agentId) }),
      )
    }
    const gone = (): boolean => live.closing || this.live.get(live.id) !== live
    const wanted = carryMode(own, config)
    config = await this.applyStartOptions(live, connection, agentValues(wanted), {
      restore: true,
      from: config,
      stop: () => gone() || connection.isClosed,
    })
    if (gone()) {
      await this.closeUnseen(live, runtime)
      throw new HostError('busy', t('session.openFirst'))
    }
    if (connection.isClosed) throw new AgentRequestError('closed', 'The agent connection closed')
    this.attach(live, connection)
    this.opened(live, config)
    for (const child of this.descendants(live.id, 'subagent')) {
      const childLive = this.live.get(child.id)
      if (!childLive) continue
      this.attach(childLive, connection)
      if (childLive.thread.session.status === 'closed') {
        const info = childLive.thread.session.subagent
        this.update(childLive, {
          status: 'ready',
          ...(info ? { subagent: { ...info, stateKnown: false } } : {}),
        })
        this.touch(childLive.id)
      }
    }
    this.deps.agents.signedIn(record.agentId)
    // The mode decides what the agent may do unasked, so the session must not run in another
    // one unseen.
    const modes = wanted.filter((option) => option.category === 'mode')
    if (lostValues(modes, config).length > 0) this.modeLost(live, lostValues(wanted, config))
    return connection
  }

  /**
   * A session attached in another mode than its own: the thread says so, and a prompt that waited
   * for the attach is not sent. It goes back to the front of the queue, paused, so the user can
   * check the settings and resume it, and the session shows the error until its next turn.
   */
  private modeLost(live: Live, lost: LostValue[]): void {
    const turn = live.turn?.ended === false ? live.turn : null
    const notice = lostValuesNotice(lost, { subject: 'session', held: turn !== null })
    if (!notice) return
    this.emit(live, [
      { op: 'entry.add', entry: { kind: 'notice', id: this.nextId(live), ...notice } },
    ])
    if (!turn) return
    this.finishTurn(live, turn, null)
    const now = this.now()
    this.update(live, {
      status: 'ready',
      turnStartedAt: null,
      turnStartUsed: null,
      updatedAt: now,
      error: { message: notice.title },
      queue: [{ id: randomUUID(), content: turn.content, at: now }, ...live.thread.session.queue],
      queuePaused: true,
    })
    this.persist(live)
    this.touch(live.id)
    this.deps.events.attention(live.id, 'error', this.titleOf(live), notice.title)
    this.checkpoint(live)
  }

  /**
   * A session closed or deleted while it attached or started, before it took its connection: the
   * agent's session closes rather than stay open unseen, unless the session went live again
   * meanwhile and its own attach holds that session now.
   */
  private async closeUnseen(live: Live, runtime: AgentRuntime): Promise<void> {
    const next = this.live.get(live.id)
    if (next && next !== live && (next.attaching || next.connection)) return
    // Its token was made for this attach, which may have outlived the session's going.
    if (next !== live) this.deps.mcp?.detached(live.id)
    const { connection } = runtime
    const { acpSessionId } = live.record
    connection.unregister(acpSessionId)
    if (runtime.init.capabilities.closeSession && !connection.isClosed) {
      await connection.closeSession(acpSessionId).catch(() => {})
    }
  }

  /** A loaded or resumed session's options, which New session also learns from. */
  private opened(live: Live, config: ConfigOption[]): void {
    const { agentId } = live.record
    this.update(live, { config: withUltracode(live.record, config) })
    this.deps.options?.opened(agentId, withUltracode({ agentId }, config))
  }

  /** Attaches a closed session for something only its agent can do, such as a setting or a fork. */
  private async attachClosed(live: Live): Promise<AgentConnection> {
    const connection = await this.connect(live)
    if (live.thread.session.status === 'closed') {
      this.update(live, { status: 'ready' })
      this.touch(live.id)
    }
    return connection
  }

  /**
   * Claude Code and Codex keep no history for a session nothing was sent to, so they cannot resume
   * one: an agent that never answered loses nothing when the session starts over.
   */
  private neverAnswered(live: Live, error: unknown): boolean {
    if (!(error instanceof AgentRequestError) || !unknownSession(error)) return false
    return !live.thread.order.some((id) => {
      const kind = live.thread.byId[id]?.kind
      return kind === 'agent' || kind === 'thought' || kind === 'tool' || kind === 'turn_end'
    })
  }

  /**
   * An agent that does not have the session, while it runs with another configuration folder
   * than the session was started with, likely keeps it in that folder: the error names it.
   */
  private otherConfig(live: Live, error: unknown): unknown {
    if (!(error instanceof AgentRequestError) || !unknownSession(error)) return error
    const { agentId, configDir } = live.record
    const running = this.deps.agents.runningConfig(agentId)
    const started = configDir ?? this.deps.agents.environmentConfig(agentId)
    if (!running || !started || samePath(started, running.folder, this.deps.platform)) return error
    return new HostError('agent_error', t('session.otherConfigFolder', { path: started }), {
      code: error.code,
    })
  }

  /** Notes the configuration folder picked for the agent a session was just made in. */
  private stampConfig(record: SessionRecord): void {
    const chosen = this.deps.agents.runningConfig(record.agentId)?.chosen ?? null
    if (chosen) record.configDir = chosen
    else delete record.configDir
  }

  /** `session/new` in place of a session the agent does not have; the thread stays as it is. */
  private async renew(
    live: Live,
    connection: AgentConnection,
    mcpServers: McpServer[],
  ): Promise<ConfigOption[]> {
    const setup = await connection.newSession(
      live.record.projectPath,
      sessionMeta(live.record),
      mcpServers,
    )
    live.record.acpSessionId = setup.acpSessionId
    this.stampConfig(live.record)
    live.rewrite = true
    this.update(live, { acpSessionId: setup.acpSessionId })
    this.save(live)
    return setup.config
  }

  /** `session/load` with its replay going nowhere, since the thread is already here. */
  private async loadQuietly(
    live: Live,
    connection: AgentConnection,
    mcpServers: McpServer[],
  ): Promise<{ config: ConfigOption[] }> {
    const { record } = live
    const scratch = threadFromSnapshot({ session: live.thread.session, entries: [], seq: 0 })
    let counter = 0
    const quiet: SessionTarget = {
      context: () => ({
        thread: scratch,
        replaying: true,
        cancelling: false,
        scope: newTurnScope(),
        now: this.now(),
        nextId: () => `q:${++counter}`,
        sessionIdFor: () => null,
      }),
      apply: () => {},
      requestPermission: () => Promise.resolve('cancelled'),
    }
    connection.register(record.acpSessionId, quiet)
    try {
      return await connection.loadSession(
        record.acpSessionId,
        record.projectPath,
        sessionMeta(record),
        mcpServers,
      )
    } finally {
      connection.unregister(record.acpSessionId, quiet)
      // Updates after the replay wait for the session, which attaches once its values are set.
      connection.reopen(record.acpSessionId)
    }
  }

  // Prompt turns.

  private titleOf(live: Live): string {
    return (
      live.record.customTitle ??
      live.thread.session.title ??
      this.deps.agents.name(live.record.agentId)
    )
  }

  /**
   * What fills the session's context, from the agent's `/context` report. It runs in a fork,
   * deleted afterwards, so the session's own thread and history stay as they were. Null for an
   * agent without the report.
   */
  context(sessionId: string): Promise<ContextBreakdown | null> {
    const running = this.contextRuns.get(sessionId)
    if (running) return running
    const run = this.readContext(sessionId).finally(() => {
      this.contextRuns.delete(sessionId)
      const live = this.live.get(sessionId)
      if (live) this.refreshRelease(live)
    })
    this.contextRuns.set(sessionId, run)
    return run
  }

  private async readContext(sessionId: string): Promise<ContextBreakdown | null> {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.recordOf(sessionId)
    if (!hasContextReport(record.agentId) || record.origin === 'subagent') return null
    const status = live?.thread.session.status ?? 'closed'
    if (status !== 'ready' || !live?.connection) throw busyError(status)
    const runtime = await this.deps.agents.ensureReady(record.agentId)
    if (!runtime.init.capabilities.forkSession) return null
    const log = (message: string): void => this.deps.diagnostics.log('warn', message)
    let messages: string[]
    try {
      messages = await runReport(
        runtime,
        async () =>
          (
            await runtime.connection.forkSession(
              record.acpSessionId,
              record.projectPath,
              hiddenSessionMeta(record.agentId, sessionMeta(record)),
            )
          ).acpSessionId,
        CONTEXT_REPORT,
        log,
      )
    } catch (error) {
      throw agentError(error)
    }
    const now = this.now()
    const breakdown =
      messages.map((text) => parseContextReport(text, now)).findLast((report) => report !== null) ??
      null
    if (!breakdown)
      log(`${this.deps.agents.name(record.agentId)}: /context gave no report OverBench can read`)
    return breakdown
  }

  /** Sends a prompt; a session that is not attached attaches to its agent as the turn starts. */
  async prompt(sessionId: string, content: UserContent[]): Promise<void> {
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noPrompt'))
    }
    this.unarchive(sessionId)
    const hydrated = this.hydrate(content)
    const live = await this.revive(sessionId)
    if (!canSend(live.thread.session.status)) throw busyError(live.thread.session.status)
    this.sendPrompt(live, hydrated)
  }

  private sendPrompt(live: Live, content: UserContent[]): void {
    live.used = true
    const now = this.now()
    this.startTurn(live, content, now, this.addPrompt(live, content, now))
  }

  /** The user entry of a prompt, and the title it gives a session that has none; its entry id. */
  private addPrompt(live: Live, content: UserContent[], now: number): string {
    const entryId = this.nextId(live)
    this.emit(live, [{ op: 'entry.add', entry: { kind: 'user', id: entryId, content, at: now } }])
    if (live.thread.session.title === null) {
      const title = fallbackTitle(content)
      if (title) this.update(live, { title })
    }
    return entryId
  }

  // Attachments: the renderer names each by its record's id; the host fills in the rest from the
  // record, and at send time builds what goes to the agent from what it advertised.

  /** The content with each attachment as its record shows it; refuses one no longer held. */
  private hydrate(content: UserContent[]): UserContent[] {
    let bytes = 0
    const out = content.map((item): UserContent => {
      if (item.type === 'text') bytes += Buffer.byteLength(item.text, 'utf8')
      if (item.type !== 'ref' || item.ref.kind !== 'attachment') return item
      const store = this.deps.attachments
      if (!store) throw invalidParams('This host takes no attachments')
      const attachment = store.view(item.ref.attachment.id)
      bytes += promptShare(attachment)
      return { type: 'ref', ref: { kind: 'attachment', attachment } }
    })
    if (bytes > PROMPT_BYTES) throw invalidParams(t('session.promptTooLarge'))
    return out
  }

  /**
   * What goes to the agent for this content, how the thread shows it once sent, and the bytes
   * the thread store keeps for it. Each attachment goes as the agent's prompt capabilities allow.
   */
  private async resolveAttachments(
    live: Live,
    content: readonly UserContent[],
  ): Promise<{
    wire: PromptBlock[]
    shown: UserContent[]
    blobs: StoredBlob[]
    ids: string[]
  }> {
    const store = this.deps.attachments
    const prompt = this.deps.agents.status(live.record.agentId).capabilities.prompt
    const wire: PromptBlock[] = []
    const shown: UserContent[] = []
    const blobs: StoredBlob[] = []
    const ids: string[] = []
    for (const item of content) {
      if (item.type !== 'ref' || item.ref.kind !== 'attachment') {
        wire.push(...promptBlocks([item]))
        shown.push(item)
        continue
      }
      if (item.ref.attachment.sent) {
        // Sent before, as when the agent asked to sign in: again from what the thread keeps.
        wire.push(await this.resend(live, item.ref.attachment))
        shown.push(item)
        continue
      }
      if (!store) throw invalidParams('This host takes no attachments')
      const record = store.get(item.ref.attachment.id)
      const sent = await sendAttachment(store, record, prompt)
      ids.push(record.id)
      if (sent.blob) blobs.push(sent.blob)
      wire.push(sent.block)
      shown.push({
        type: 'ref',
        ref: { kind: 'attachment', attachment: { ...store.view(record.id), ...sent.changes } },
      })
    }
    // A text file is read again as it goes, so it may have grown since the prompt was counted.
    if (wire.reduce((sum, block) => sum + blockBytes(block), 0) > PROMPT_BYTES) {
      throw invalidParams(t('session.promptTooLarge'))
    }
    return { wire, shown, blobs, ids }
  }

  private async resend(live: Live, attachment: Attachment): Promise<PromptBlock> {
    const { uri, name, mimeType, size } = attachment
    if (attachment.sent === 'linked' && uri) return linkBlock(uri, name, mimeType, size)
    if (attachment.sent === 'embedded' && uri) {
      const prompt = this.deps.agents.status(live.record.agentId).capabilities.prompt
      const resolved = await resolvePath(fileURLToPath(uri), 'file', name)
      return (await embedFile(resolved.real, uri, name, mimeType, prompt, resolved.size)).block
    }
    const hash = attachment.blob
    const stored = hash ? await this.storedBlob(live.id, hash).catch(() => null) : null
    if (attachment.sent === 'image' && stored) {
      const data = Buffer.from(stored.data).toString('base64')
      return { type: 'image', mimeType: stored.mime, data, ...(uri ? { uri } : {}) }
    }
    throw notFound(t('session.attachmentGone', { name }))
  }

  /** Keeps the sent bytes for the thread store and lets the attachments' records go. */
  private commitAttachments(
    live: Live,
    resolved: { shown: UserContent[]; blobs: StoredBlob[]; ids: string[] },
  ): void {
    if (resolved.ids.length === 0) return
    for (const blob of resolved.blobs) live.blobs.set(blob.hash, blob)
    this.showSent(live, resolved.shown)
    this.scheduleCheckpoint(live)
    void this.deps.attachments?.release(resolved.ids)
  }

  /**
   * A message held back unsent, as when the session's mode was lost, still names the records
   * its sent copy used; once they go it opens what was sent instead.
   */
  private showSent(live: Live, shown: readonly UserContent[]): void {
    const sent = new Map<string, Attachment>()
    for (const item of shown) {
      if (item.type === 'ref' && item.ref.kind === 'attachment' && item.ref.attachment.sent) {
        sent.set(item.ref.attachment.id, item.ref.attachment)
      }
    }
    const patches: Patch[] = []
    for (const id of live.thread.order) {
      const entry = live.thread.byId[id]
      if (entry?.kind !== 'user') continue
      let changed = false
      const content = entry.content.map((item): UserContent => {
        if (item.type !== 'ref' || item.ref.kind !== 'attachment') return item
        const attachment = item.ref.attachment.sent ? undefined : sent.get(item.ref.attachment.id)
        if (!attachment) return item
        changed = true
        return { type: 'ref', ref: { kind: 'attachment', attachment } }
      })
      if (changed) patches.push({ op: 'entry.update', id, changes: { content } })
    }
    if (patches.length > 0) this.emit(live, patches)
  }

  async blob(sessionId: string, hash: string): Promise<AttachmentBytes> {
    this.recordOf(sessionId)
    const stored = await this.storedBlob(sessionId, hash)
    if (!stored) throw notFound(`Session ${sessionId} keeps no attachment ${hash}`)
    return { mimeType: stored.mime, bytes: toArrayBuffer(stored.data) }
  }

  /**
   * Whether an agent or user entry of the session's thread holds `text`: in memory first, since a
   * reply that is still streaming is not stored yet, then in the thread store.
   */
  async names(sessionId: string, text: string): Promise<boolean> {
    if (!this.records.has(sessionId)) return false
    const thread = this.live.get(sessionId)?.thread
    if (thread && Object.values(thread.byId).some((entry) => entryHolds(entry, text))) return true
    return (await this.deps.threads?.mentions(sessionId, text)) ?? false
  }

  /** A sent attachment's bytes: from memory until the thread store has them. */
  private async storedBlob(sessionId: string, hash: string): Promise<StoredBlob | null> {
    const live = this.live.get(sessionId)
    const pending = live?.blobs.get(hash)
    if (pending) return pending
    return (await this.deps.threads?.blob(sessionId, hash)) ?? null
  }

  // The queue: OverBench's own, for every agent, since ACP has none. One turn runs at a time,
  // and the oldest waiting prompt goes when a turn ends normally.

  /**
   * Queues a prompt behind the running turn, or sends it at once when the session is free and
   * nothing waits, or only a paused queue does. The composer always sends through here, so a
   * prompt sent before it heard that a turn started is queued, not refused.
   */
  async queue(sessionId: string, input: UserContent[]): Promise<{ itemId: string | null }> {
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noPrompt'))
    }
    this.unarchive(sessionId)
    const content = this.hydrate(input)
    const live = await this.revive(sessionId)
    const { status, queue, queuePaused } = live.thread.session
    if (canSend(status) && (queue.length === 0 || queuePaused)) {
      // At once: another prompt waiting on the same revive must see this turn running.
      this.sendPrompt(live, content)
      return { itemId: null }
    }
    if (!canSend(status) && status !== 'running' && status !== 'awaiting_permission') {
      throw busyError(status)
    }
    const item = { id: randomUUID(), content, at: this.now() }
    this.update(live, { queue: [...queue, item] })
    this.persist(live)
    this.touch(live.id)
    return { itemId: item.id }
  }

  async unqueue(sessionId: string, itemId: string): Promise<void> {
    const live = await this.revive(sessionId)
    const { queue } = live.thread.session
    if (!queue.some((item) => item.id === itemId)) throw notFound(`No queued prompt ${itemId}`)
    const rest = queue.filter((item) => item.id !== itemId)
    this.update(live, { queue: rest, ...(rest.length === 0 ? { queuePaused: false } : {}) })
    this.persist(live)
    this.touch(live.id)
  }

  /**
   * Sends a queued prompt into the running turn through `_session/steering`. When the agent
   * answers that no turn is running, the turn is ending: the prompt stays first in the queue.
   */
  async steer(sessionId: string, itemId: string): Promise<void> {
    const live = await this.revive(sessionId)
    const item = live.thread.session.queue.find((i) => i.id === itemId)
    if (!item) throw notFound(`No queued prompt ${itemId}`)
    if (!this.deps.agents.status(live.record.agentId).capabilities.steering) {
      throw new HostError(
        'restricted',
        t('session.cannotSteer', { agent: this.deps.agents.name(live.record.agentId) }),
      )
    }
    if (!live.turn || live.turn.ended || !live.connection) {
      throw new HostError('busy', t('session.noTurn'))
    }
    const resolved = await this.resolveAttachments(live, item.content)
    let outcome
    try {
      outcome = await live.connection.steer(live.record.acpSessionId, resolved.wire)
    } catch (error) {
      throw agentError(error)
    }
    const { queue } = live.thread.session
    if (outcome === 'promptRequired') {
      this.update(live, { queue: [item, ...queue.filter((i) => i.id !== itemId)] })
      this.persist(live)
      if (canSend(live.thread.session.status)) this.drainQueue(live)
      return
    }
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'user',
          id: this.nextId(live),
          content: resolved.shown,
          at: this.now(),
          steered: true,
        },
      },
    ])
    this.commitAttachments(live, resolved)
    this.update(live, { queue: queue.filter((i) => i.id !== itemId) })
    this.persist(live)
    this.touch(live.id)
  }

  async resumeQueue(sessionId: string): Promise<void> {
    const live = await this.revive(sessionId)
    this.update(live, { queuePaused: false })
    this.drainQueue(live)
    this.persist(live)
    this.touch(live.id)
  }

  /** Sends the oldest waiting prompt, when the session is free and the queue is not paused. */
  private drainQueue(live: Live): void {
    const { status, queue, queuePaused } = live.thread.session
    const [next, ...rest] = queue
    if (!next || queuePaused || !canSend(status)) return
    this.update(live, { queue: rest })
    this.sendPrompt(live, next.content)
  }

  private pauseQueue(live: Live): void {
    if (live.thread.session.queue.length > 0) this.update(live, { queuePaused: true })
  }

  private startTurn(
    live: Live,
    content: UserContent[],
    now: number,
    entryId: string | null = null,
  ): void {
    const turn: Turn = {
      startedAt: now,
      content,
      entryId,
      ended: false,
      cancelRequested: false,
      fallback: null,
      requested: false,
    }
    live.turn = turn
    live.scope = newTurnScope()
    live.failure = null
    this.update(live, {
      status: 'running',
      turnStartedAt: now,
      turnStartUsed: live.thread.session.usage?.used ?? null,
      error: null,
      updatedAt: now,
    })
    this.persist(live)
    this.touch(live.id)
    void this.runTurn(live, turn)
  }

  /**
   * `session/fork`: a new session that starts from this one's history, or from the reply that
   * `entryId` names up to the end of its turn. The agent keeps the history; the fork shows a copy
   * of this thread until it is replayed on a later open.
   */
  async fork(sessionId: string, entryId?: string): Promise<SessionSummary> {
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noFork'))
    }
    const source = await this.revive(sessionId)
    const status = source.thread.session.status
    if (status !== 'closed' && (status !== 'ready' || !source.connection)) {
      throw busyError(status)
    }
    const cut = entryId === undefined ? null : forkCut(source.thread, entryId)
    // Not every agent forks a session it does not have open, so a closed one attaches first.
    try {
      await this.attachClosed(source)
    } catch (error) {
      throw agentError(error)
    }
    const runtime = await this.deps.agents.ensureReady(source.record.agentId)
    if (!runtime.init.capabilities.forkSession) {
      throw new HostError(
        'agent_unavailable',
        t('session.cannotFork', { agent: this.deps.agents.name(source.record.agentId) }),
      )
    }
    if (cut && !runtime.init.capabilities.forkAtMessage) {
      throw new HostError(
        'agent_unavailable',
        t('session.cannotForkAt', { agent: this.deps.agents.name(source.record.agentId) }),
      )
    }
    // A closed session takes prompts while it attaches; a turn that started since then wins.
    if (source.thread.session.status !== 'ready') throw busyError(source.thread.session.status)
    // Subagent cards point at the source's sub-sessions, which the fork does not have.
    const entries = (cut?.entries ?? threadEntries(source.thread)).filter(
      (entry) => entry.kind !== 'subagent',
    )
    // Read now, so the reads go before a delete of the source that would take the bytes with it.
    const reading = Promise.all(
      [...attachmentBlobs(entries)].map((hash) =>
        this.storedBlob(source.id, hash).catch(() => null),
      ),
    )
    const forkId = randomUUID()
    let setup
    try {
      setup = await runtime.connection.forkSession(
        source.record.acpSessionId,
        source.record.projectPath,
        sessionMeta(source.record),
        cut?.point,
        this.mcpServers(forkId, source.record, runtime),
      )
    } catch (error) {
      this.deps.mcp?.detached(forkId)
      throw agentError(error)
    }
    const blobs = (await reading).filter((blob) => blob !== null)
    const now = this.now()
    const record: SessionRecord = {
      ...source.record,
      id: forkId,
      acpSessionId: setup.acpSessionId,
      title: source.thread.session.title,
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      branch: null,
    }
    // A queued prompt, the attachments it holds, and the source's pin or archive stay with it.
    delete record.queue
    delete record.pinnedAt
    delete record.archivedAt
    this.stampConfig(record)
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    live.used = true
    live.blobs = new Map(blobs.map((blob) => [blob.hash, blob]))
    for (const entry of entries) live.counter = Math.max(live.counter, idNumber(entry.id))
    this.emit(
      live,
      entries.map((entry) => ({ op: 'entry.add', entry })),
    )
    // Until its values are set, the fork shows and stores the source's, so one closed or stopped
    // meanwhile gets them from its next attach. It takes its connection only then, as an attach
    // does, so what the agent sends meanwhile waits rather than change them.
    this.update(live, {
      acpSessionId: setup.acpSessionId,
      config: withUltracode(record, source.thread.session.config),
      // Nothing records the context or the totals at an earlier reply.
      usage: cut ? null : source.thread.session.usage,
    })
    this.save(live)
    this.touch(live.id)
    // Not every agent carries the source's settings over to a fork, such as its model.
    const carried = source.thread.session.config.filter(
      (option) => option.id !== ULTRACODE_OPTION_ID,
    )
    const { connection } = runtime
    const gone = (): boolean => live.closing || this.live.get(live.id) !== live
    const config = await this.applyStartOptions(live, connection, agentValues(carried), {
      restore: true,
      from: mergeConfig(source.thread.session.config, setup.config),
      stop: () => gone() || connection.isClosed,
    })
    if (gone()) {
      await this.closeUnseen(live, runtime)
      // A closed fork stays listed.
      if (!live.removing && this.has(live.id)) return this.summary(live.id)
      throw removedWhileStarting()
    }
    if (connection.isClosed) {
      // The agent went while the values were set, which leaves the fork stored and closed. Its
      // values were not refused, only not set, so there is nothing to say.
      this.update(live, { status: 'closed' })
    } else {
      this.attach(live, connection)
      this.update(live, { config: withUltracode(record, config) })
      const notice = lostValuesNotice(lostValues(carried, config))
      if (notice) {
        this.emit(live, [
          { op: 'entry.add', entry: { kind: 'notice', id: this.nextId(live), ...notice } },
        ])
      }
      this.update(live, { status: 'ready' })
    }
    this.persist(live)
    this.touch(live.id)
    return this.summary(live.id)
  }

  private async runTurn(live: Live, turn: Turn): Promise<void> {
    let connection: AgentConnection
    try {
      connection = await this.connect(live)
    } catch (error) {
      if (!turn.ended) this.failConnect(live, turn, error)
      return
    }
    if (turn.ended) return
    try {
      const resolved = await this.resolveAttachments(live, turn.content)
      if (turn.ended) return
      if (resolved.ids.length > 0) {
        const entry = turn.entryId ? live.thread.byId[turn.entryId] : undefined
        if (entry?.kind === 'user') {
          this.emit(live, [
            { op: 'entry.update', id: entry.id, changes: { content: resolved.shown } },
          ])
        }
      }
      const sending = connection.prompt(live.record.acpSessionId, resolved.wire).finally(() => {
        if (live.unansweredCancel === turn) live.unansweredCancel = null
      })
      // Sent: the records go, and a retry after a failed sign-in sends what the thread shows.
      this.commitAttachments(live, resolved)
      turn.content = resolved.shown
      const result = await sending
      if (turn.ended) return
      this.deps.agents.signedIn(live.record.agentId)
      this.endTurn(live, turn, result.stopReason, result.tokens, result.models)
    } catch (error) {
      if (turn.ended) return
      this.failTurn(live, turn, error)
    }
  }

  /** Ends streaming on the turn's messages, closes open thoughts and stops unfinished tools. */
  private closeOpenEntries(live: Live): void {
    const now = this.now()
    const patches: Patch[] = []
    for (const id of live.thread.order) {
      const entry = live.thread.byId[id]
      if (
        entry?.kind === 'tool' &&
        (entry.status === 'pending' || entry.status === 'in_progress')
      ) {
        patches.push({ op: 'entry.update', id, changes: { status: 'cancelled' } })
      } else if ((entry?.kind === 'agent' || entry?.kind === 'thought') && entry.streaming) {
        const startedAt = live.scope.thoughts.get(id)
        patches.push({
          op: 'entry.update',
          id,
          changes:
            entry.kind === 'thought' && startedAt !== undefined
              ? { streaming: false, durationMs: Math.max(0, now - startedAt) }
              : { streaming: false },
        })
      }
    }
    live.scope.thoughts.clear()
    if (patches.length > 0) this.emit(live, patches)
  }

  /** Settles the turn; returns its `turn_end` entry's id when there is a stop reason. */
  private finishTurn(live: Live, turn: Turn, stopReason: StopReason | null): string | null {
    turn.ended = true
    if (turn.fallback) clearTimeout(turn.fallback)
    turn.fallback = null
    if (live.turn === turn) live.turn = null
    this.deps.mcp?.turnEnded(live.id)
    this.closeOpenEntries(live)
    this.clearPermissions(live, 'cancelled')
    if (!stopReason) return null
    const id = this.nextId(live)
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'turn_end',
          id,
          stopReason,
          durationMs: Math.max(0, this.now() - turn.startedAt),
        },
      },
    ])
    return id
  }

  private endTurn(
    live: Live,
    turn: Turn,
    stopReason: StopReason,
    tokens: TokenTotals | null,
    models: ModelTokens[] = [],
  ): void {
    const turnEntryId = this.finishTurn(live, turn, stopReason)
    const now = this.now()
    const changes: Partial<SessionView> = {
      status: 'ready',
      turnStartedAt: null,
      turnStartUsed: null,
      updatedAt: now,
    }
    const turnTokens = models.length > 0 ? sumModelTokens(models, tokens) : tokens
    if (turnTokens) {
      const usage = live.thread.session.usage
      // An agent that reports a turn's tokens only in its response made its last request just
      // before it. A cancelled turn can end long after its last request, as when a command ran.
      const cache =
        !turn.requested && stopReason !== 'cancelled'
          ? { lastRequestAt: now, ttl: usage?.cache?.ttl ?? null }
          : usage?.cache
      changes.usage = {
        used: usage?.used ?? 0,
        size: usage?.size ?? 0,
        cost: usage?.cost ?? null,
        tokens: addTokenTotals(usage?.tokens ?? null, turnTokens),
        ...(cache ? { cache } : {}),
      }
    }
    if (turnEntryId && this.deps.usage) {
      this.deps.usage.record(
        recordRows({
          sessionId: live.id,
          acpSessionId: live.record.acpSessionId,
          agentId: live.record.agentId,
          project: live.record.projectPath,
          turnEntryId,
          at: now,
          tokens,
          models,
          model: modelOf(live.thread.session.config),
        }),
      )
    }
    this.update(live, changes)
    if (live.thread.session.usage?.cache) this.scheduleCacheRead(live)
    const git = this.deps.git()
    if (git) {
      git.turnEnded(live.record.projectPath, live.id)
      live.record.branch = git.currentBranch(live.record.projectPath) ?? live.record.branch
    }
    if (this.inFront(live.id)) live.record.lastViewedAt = now
    else live.unread = true
    this.persist(live)
    this.touch(live.id)
    this.deps.events.attention(live.id, 'turn-ended', this.titleOf(live), turnEndText(stopReason))
    if (stopReason === 'end_turn') this.drainQueue(live)
    else this.pauseQueue(live)
    this.checkpoint(live)
  }

  private failTurn(live: Live, turn: Turn, error: unknown): void {
    const mapped = agentError(error)
    const closed = mapped.code === 'agent_unavailable'
    if (closed && turn.cancelRequested) {
      // The user had stopped it before the agent exited, so it ends stopped, as on the exit event.
      live.connection = null
      this.endTurn(live, turn, 'cancelled', null)
      return
    }
    this.finishTurn(live, turn, null)
    const now = this.now()
    const authRequired = mapped.code === 'auth_required'
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'error',
          ...(authRequired
            ? {
                title: t('notice.signInNeeded', {
                  agent: this.deps.agents.name(live.record.agentId),
                }),
                description: mapped.message,
              }
            : closed
              ? stoppedNotice(this.deps.agents.name(live.record.agentId))
              : isOutOfCredit(mapped)
                ? outOfCreditNotice(
                    this.deps.agents.name(live.record.agentId),
                    live.thread.session.config,
                    mapped.message,
                  )
                : { title: t('notice.turnFailed'), description: mapped.message }),
        },
      },
    ])
    if (authRequired) {
      live.failure = { action: 'prompt', content: turn.content, entryId: turn.entryId }
      this.deps.agents.authRequired(live.record.agentId)
      this.update(live, {
        status: 'auth_required',
        turnStartedAt: null,
        turnStartUsed: null,
        updatedAt: now,
      })
    } else if (closed) {
      // The agent's exit, which follows, closes the session; a send before it attaches anew.
      live.connection = null
      this.update(live, {
        status: 'ready',
        turnStartedAt: null,
        turnStartUsed: null,
        updatedAt: now,
      })
    } else {
      this.update(live, {
        status: 'ready',
        turnStartedAt: null,
        turnStartUsed: null,
        updatedAt: now,
        error: { message: mapped.message },
      })
    }
    this.pauseQueue(live)
    this.persist(live)
    this.touch(live.id)
    this.deps.events.attention(live.id, 'error', this.titleOf(live), mapped.message)
    this.checkpoint(live)
  }

  /** The session could not attach for the turn: it fails as a start does, and Retry sends again. */
  private failConnect(live: Live, turn: Turn, error: unknown): void {
    this.finishTurn(live, turn, null)
    this.update(live, { turnStartedAt: null, turnStartUsed: null })
    this.pauseQueue(live)
    this.failStart(live, error, {
      action: 'prompt',
      content: turn.content,
      entryId: turn.entryId,
    })
    this.persist(live)
    this.checkpoint(live)
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId)
    // Nothing runs in a session that is not live.
    if (!live) return void this.recordOf(sessionId)
    if (live.record.origin === 'subagent') {
      if (!live.thread.session.subagent?.canCancel) {
        throw new HostError('restricted', t('session.subagent.noCancel'))
      }
      this.clearPermissions(live, 'cancelled')
      await live.connection?.cancel(live.record.acpSessionId).catch((error: unknown) => {
        throw agentError(error)
      })
      this.touch(live.id)
      return
    }
    const turn = live.turn
    if (!turn || turn.ended || turn.cancelRequested) return
    turn.cancelRequested = true
    if (!live.connection) {
      // Still attaching: the prompt never reached the agent.
      this.endTurn(live, turn, 'cancelled', null)
      return
    }
    try {
      await live.connection.cancel(live.record.acpSessionId)
    } catch (error) {
      throw agentError(error)
    }
    // The protocol requires pending requests of a cancelled turn to be answered `cancelled`.
    this.clearPermissions(live, 'cancelled')
    if (live.thread.session.status === 'awaiting_permission')
      this.update(live, { status: 'running' })
    this.touch(live.id)
    turn.fallback = setTimeout(() => {
      if (turn.ended) return
      this.emit(live, [
        {
          op: 'entry.add',
          entry: {
            kind: 'notice',
            id: this.nextId(live),
            severity: 'warning',
            title: t('notice.cancelUnconfirmed.title', {
              agent: this.deps.agents.name(live.record.agentId),
            }),
            description: t('notice.cancelUnconfirmed.description', {
              seconds: String(Math.round(this.timings.cancelFallbackMs / 1000)),
            }),
          },
        },
      ])
      // The agent may still report the stopped prompt's usage long after the turn is over.
      live.unansweredCancel = turn
      this.endTurn(live, turn, 'cancelled', null)
    }, this.timings.cancelFallbackMs)
  }

  // Permissions.

  private requestPermission(
    live: Live,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionAnswer> {
    this.applyOutput(live, request.output)
    // The user already stopped this turn or closed the session: the request is moot.
    if (live.closing || live.turn?.cancelRequested) return Promise.resolve('cancelled')
    const requestId = `p${++this.requestCounter}`
    return new Promise<PermissionAnswer>((resolve, reject) => {
      const onAbort = (): void => {
        this.settlePermission(live, requestId, 'withdrawn')
        this.touch(live.id)
        reject(signal.reason)
      }
      const pending: PendingRequest = {
        requestId,
        toolEntryId: request.toolEntryId,
        options: request.options,
        answer: (answer) => {
          signal.removeEventListener('abort', onAbort)
          resolve(answer)
        },
      }
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      live.permissions.set(requestId, pending)
      this.emit(live, [
        {
          op: 'entry.update',
          id: request.toolEntryId,
          changes: { permission: { requestId, options: request.options }, permissionResult: null },
        },
      ])
      const status = live.thread.session.status
      if (status === 'running' || status === 'ready')
        this.update(live, { status: 'awaiting_permission' })
      this.touch(live.id)
      this.updateBadge()
      const tool = live.thread.byId[request.toolEntryId]
      this.deps.events.attention(
        live.id,
        'permission',
        this.titleOf(live),
        tool?.kind === 'tool' ? tool.title : t('attention.permission'),
      )
    })
  }

  /** Clears one request with its result and settles the session's status. */
  private settlePermission(
    live: Live,
    requestId: string,
    result: { optionId: string; kind: PermissionKind } | 'cancelled' | 'withdrawn',
  ): void {
    const pending = live.permissions.get(requestId)
    if (!pending) return
    live.permissions.delete(requestId)
    if (live.thread.byId[pending.toolEntryId]) {
      this.emit(live, [
        {
          op: 'entry.update',
          id: pending.toolEntryId,
          changes: { permission: null, permissionResult: result },
        },
      ])
    }
    if (live.permissions.size === 0 && live.thread.session.status === 'awaiting_permission') {
      this.update(live, { status: live.turn || live.childRunning ? 'running' : 'ready' })
    }
    this.updateBadge()
  }

  /** Settles every pending request; after an exit the answer goes nowhere, but frees the handler. */
  private clearPermissions(live: Live, result: 'cancelled' | 'withdrawn'): void {
    for (const [requestId, pending] of [...live.permissions]) {
      this.settlePermission(live, requestId, result)
      pending.answer('cancelled')
    }
  }

  respond(sessionId: string, requestId: string, optionId: string): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const pending = live?.permissions.get(requestId)
    if (!live || !pending) throw notFound(`No pending permission request ${requestId}`)
    const option = pending.options.find((o) => o.id === optionId)
    if (!option) throw invalidParams(`${optionId} is not an option of request ${requestId}`)
    this.settlePermission(live, requestId, { optionId, kind: option.kind })
    pending.answer({ optionId })
    this.touch(live.id)
  }

  // Config options.

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<void> {
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noConfig'))
    }
    const live = await this.revive(sessionId)
    const status = live.thread.session.status
    if (!live.connection && status !== 'closed') throw busyError(status)
    const option = live.thread.session.config.find((o) => o.id === optionId)
    if (!option) throw invalidParams(`No config option ${optionId}`)
    if (option.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') {
      throw invalidParams(
        `${option.name} takes a ${option.type === 'boolean' ? 'boolean' : 'string'}`,
      )
    }
    if (
      option.type === 'select' &&
      option.choices &&
      !option.choices.some((c) => c.value === value)
    ) {
      throw invalidParams(`${String(value)} is not a choice of ${option.name}`)
    }
    if (optionId === ULTRACODE_OPTION_ID) {
      await this.setUltracode(live, value as boolean)
      return
    }
    try {
      const connection = await this.attachClosed(live)
      live.used = true
      if (optionId === SYNTHETIC_MODE_ID) {
        await connection.setMode(live.record.acpSessionId, value as string)
        this.update(live, {
          config: live.thread.session.config.map((o): ConfigOption =>
            o.id === SYNTHETIC_MODE_ID ? { ...o, value } : o,
          ),
        })
      } else {
        const config = await connection.setConfigOption(live.record.acpSessionId, optionId, value)
        const next = mergeConfig(live.thread.session.config, config)
        this.update(live, { config: next })
        this.deps.options?.chose(live.record.agentId, option, value, next)
      }
      if (live.prepared) {
        // Chosen again, so whatever the notice said of it no longer holds.
        live.prepared.notices = live.prepared.notices.filter((n) => n.optionId !== optionId)
        this.touch(live.id)
      }
    } catch (error) {
      throw agentError(error)
    }
  }

  /**
   * Claude Code reads ultracode from its settings when its query starts, so a change goes out as
   * `session/resume` with new settings, which the adapter answers by restarting the query. That
   * would abort a turn, so it waits for none to run.
   */
  private async setUltracode(live: Live, on: boolean): Promise<void> {
    if (!live.connection && live.thread.session.status === 'closed') {
      // The setting goes out with the `session/resume` that attaches the session.
      live.record.ultracode = on
      this.update(live, { config: withUltracode(live.record, live.thread.session.config) })
      this.save(live)
      this.touch(live.id)
      return
    }
    if (live.turn || live.thread.session.status !== 'ready' || !live.connection) {
      throw new HostError('busy', t('session.ultracodeBetweenTurns'))
    }
    const before = live.record.ultracode
    live.record.ultracode = on
    this.update(live, {
      status: 'starting',
      config: withUltracode(live.record, live.thread.session.config),
    })
    this.touch(live.id)
    try {
      const setup = await live.connection.resumeSession(
        live.record.acpSessionId,
        live.record.projectPath,
        sessionMeta(live.record),
        this.mcpServers(live.id, live.record, this.deps.agents.runtime(live.record.agentId)),
      )
      this.update(live, {
        status: 'ready',
        config: withUltracode(live.record, mergeConfig(live.thread.session.config, setup.config)),
      })
      this.save(live)
      this.touch(live.id)
    } catch (error) {
      live.record.ultracode = before
      this.update(live, { config: withUltracode(live.record, live.thread.session.config) })
      throw this.failStart(live, error, { action: 'resume' })
    }
  }

  // Closing, deleting and importing.

  /** A title of the user's own, kept in the index only, since ACP has no rename. */
  rename(sessionId: string, title: string | null): void {
    const record = this.recordOf(sessionId)
    const value = title?.trim().replace(/\s+/g, ' ') || null
    if (value === null) delete record.customTitle
    else record.customTitle = value
    if (this.records.has(sessionId)) this.saveIndex()
    this.touch(sessionId)
  }

  pin(sessionId: string, pinned: boolean): void {
    const record = this.topLevel(sessionId)
    if (pinned === (record.pinnedAt !== undefined)) return
    if (pinned) record.pinnedAt = this.now()
    else delete record.pinnedAt
    this.saveRecord(sessionId)
  }

  /** Takes a top-level session and its sub-sessions off the list, closed; the index keeps them. */
  async archive(sessionId: string): Promise<void> {
    const record = this.topLevel(sessionId)
    if (record.archivedAt !== undefined) return
    await this.settled(sessionId)
    await this.closeAll([...this.descendants(sessionId), record], true)
    delete record.pinnedAt
    record.archivedAt = this.now()
    this.saveRecord(sessionId)
  }

  /** Brings back the archived session at the top of this one's tree, if it is archived. */
  unarchive(sessionId: string): void {
    let record = this.recordOf(sessionId)
    while (record.parentId !== null && this.has(record.parentId)) {
      record = this.recordOf(record.parentId)
    }
    if (record.archivedAt === undefined) return
    delete record.archivedAt
    this.saveRecord(record.id)
  }

  markUnread(sessionId: string, unread: boolean): void {
    const record = this.recordOf(sessionId)
    if (!unread) return this.markViewed(sessionId, record)
    // Earlier than any update, so it stays unread after a restart until it is shown.
    record.lastViewedAt = 0
    const live = this.live.get(sessionId)
    if (live) live.unread = true
    this.saveRecord(sessionId)
  }

  private topLevel(sessionId: string): SessionRecord {
    const record = this.recordOf(sessionId)
    if (record.parentId !== null) throw new HostError('restricted', t('session.topLevelOnly'))
    return record
  }

  private saveRecord(sessionId: string): void {
    if (this.records.has(sessionId)) this.saveIndex()
    this.touch(sessionId)
  }

  async close(sessionId: string): Promise<void> {
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.closesWithParent'))
    }
    await this.settled(sessionId)
    await this.closeAll([...this.descendants(sessionId), record], true)
  }

  /** Waits for a revive or a release of the session in progress. */
  private async settled(sessionId: string): Promise<void> {
    await this.reviving.get(sessionId)?.catch(() => {})
    await this.releasing.get(sessionId)
  }

  /**
   * Closes sessions in order; none of them takes updates once this starts. Those `kept` store
   * their threads first; the others are on their way out of the index.
   */
  private async closeAll(records: readonly SessionRecord[], kept: boolean): Promise<void> {
    for (const record of records) {
      const live = this.live.get(record.id)
      if (!live) continue
      live.closing = true
      if (!kept) live.removing = true
    }
    for (const record of records) await this.closeOne(record.id, kept)
  }

  private async closeOne(sessionId: string, kept: boolean): Promise<void> {
    const live = this.live.get(sessionId)
    if (!live) return
    const connection = live.connection
    if (live.turn && !live.turn.ended) {
      await connection?.cancel(live.record.acpSessionId).catch(() => {})
      this.finishTurn(live, live.turn, 'cancelled')
    }
    this.clearPermissions(live, 'cancelled')
    if (kept) this.holdFirst(live)
    const runtime = this.deps.agents.runtime(live.record.agentId)
    if (
      connection &&
      live.record.origin === 'user' &&
      live.record.acpSessionId &&
      runtime?.init.capabilities.closeSession
    ) {
      await connection.closeSession(live.record.acpSessionId).catch((error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `session/close failed for ${sessionId}: ${(error as Error).message}`,
        )
      })
    }
    if (kept) {
      // A renderer still showing it keeps it, closed.
      if (live.thread.session.status !== 'closed') {
        this.update(live, { status: 'closed', turnStartedAt: null, turnStartUsed: null })
      }
      this.checkpoint(live)
    }
    this.dropLive(live)
    this.updateBadge()
    // A session that never reached the index has nothing to come back to.
    if (live.saved) this.touch(sessionId)
    else this.forget(sessionId)
  }

  async delete(sessionId: string): Promise<void> {
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.deletedWithParent'))
    }
    await this.settled(sessionId)
    const all = [...this.descendants(sessionId), record]
    await this.closeAll(all, false)
    const deleting: { item: SessionRecord; acpSessionId: string; runtime: AgentRuntime }[] = []
    for (const item of all) {
      if (item.origin !== 'user' || !item.acpSessionId) continue
      try {
        const runtime = await this.deps.agents.ensureReady(item.agentId)
        if (runtime.init.capabilities.deleteSession) {
          deleting.push({ item, acpSessionId: item.acpSessionId, runtime })
        }
      } catch (error) {
        this.deleteFailed(item, error)
      }
    }
    // The agent deletes the session's log too, so what it holds is counted first.
    await this.deps.usage?.syncAgents([...new Set(deleting.map(({ item }) => item.agentId))])
    for (const { item, acpSessionId, runtime } of deleting) {
      try {
        await runtime.connection.deleteSession(acpSessionId)
      } catch (error) {
        this.deleteFailed(item, error)
      }
    }
    void this.deps.attachments?.release(queuedAttachments(all))
    for (const item of all) this.forget(item.id)
    this.saveIndex()
    this.removeThreads(all.map((item) => item.id))
  }

  private deleteFailed(item: SessionRecord, error: unknown): void {
    this.deps.diagnostics.log(
      'warn',
      `session/delete failed for ${item.id}: ${(error as Error).message}`,
    )
  }

  private removeThreads(sessionIds: string[]): void {
    if (sessionIds.length === 0) return
    this.deps.threads?.remove(sessionIds).catch((error: unknown) => {
      this.deps.diagnostics.log(
        'warn',
        `Could not remove stored threads: ${(error as Error).message}`,
      )
    })
  }

  private forget(sessionId: string, portIds?: readonly string[]): void {
    const known = this.records.delete(sessionId) || this.lastSummaries.has(sessionId)
    this.lastSummaries.delete(sessionId)
    this.missing.delete(sessionId)
    this.watchers.delete(sessionId)
    this.seqs.delete(sessionId)
    if (known) this.deps.events.removed(sessionId, portIds)
  }

  /** Clears the index; the agents keep their transcripts. */
  async removeAll(): Promise<void> {
    await Promise.allSettled([...this.reviving.values(), ...this.releasing.values()])
    await Promise.all([...this.live.values()].map((l) => this.dropPrepared(l)))
    const live = [...this.live.values()]
    await this.closeAll(
      live.filter((l) => l.record.origin === 'user').map((l) => l.record),
      false,
    )
    for (const item of live) if (this.live.has(item.id)) this.dropLive(item)
    const ids = new Set([...this.records.keys(), ...this.lastSummaries.keys()])
    for (const id of ids) this.forget(id)
    this.saveIndex()
    this.removeThreads([...ids])
  }

  /** Removes a project's sessions from the index, closing live ones first. */
  async removeProject(projectPath: string): Promise<void> {
    const key = pathKey(projectPath, this.deps.platform)
    await Promise.all(
      [...this.live.values()]
        .filter((l) => l.prepared && pathKey(l.record.projectPath, this.deps.platform) === key)
        .map((l) => this.dropPrepared(l)),
    )
    const inProject = this.list().filter((s) => pathKey(s.projectPath, this.deps.platform) === key)
    await Promise.all(inProject.map((summary) => this.settled(summary.id)))
    for (const summary of inProject) {
      const live = this.live.get(summary.id)
      if (!live) continue
      live.closing = true
      live.removing = true
    }
    for (const summary of inProject) {
      if (summary.origin === 'user') await this.closeOne(summary.id, false)
    }
    for (const summary of inProject) {
      const live = this.live.get(summary.id)
      if (live) this.dropLive(live)
      this.forget(summary.id)
    }
    this.saveIndex()
    this.removeThreads(inProject.map((summary) => summary.id))
  }

  /**
   * The one-time removal of the sessions New sub-session left with no message, before it opened
   * New session: `removeEmpty`, unless the index records that it ran. The renderer asks for it
   * once it has connected, with `keep`, the sessions that hold an unsent draft.
   */
  removeEmptyOnce(keep: readonly string[] = []): Promise<void> {
    // The run records itself before it removes the threads, so a caller meanwhile waits for it.
    if (!this.emptyRemoval && this.emptySessionsRemovedAt === null && !this.deps.file.readOnly) {
      this.emptyRemoval = this.removeEmpty(new Set(keep))
    }
    return this.emptyRemoval ?? Promise.resolve()
  }

  /**
   * Removes from the index, with their stored threads, the sessions that were in it at launch and
   * hold no message (`mayBeEmpty`, with a stored thread that `holdsNothing`), unless one is in
   * `keep`, in use, or has a sub-session that stays. One whose thread cannot be read stays. The
   * agents' own histories are left alone: the index does not say which sessions OverBench
   * created and which it imported.
   */
  private async removeEmpty(keep: ReadonlySet<string>): Promise<void> {
    const store = this.deps.threads
    if (!store) return
    const candidates = [...this.records.values()].filter(
      (record) => this.atLaunch.has(record.id) && mayBeEmpty(record),
    )
    const empty = new Set<string>()
    await Promise.all(
      candidates.map(async (record) => {
        try {
          const page = await store.page(record.id)
          if (page && this.isCurrent(record, page.head) && holdsNothing(page)) empty.add(record.id)
        } catch (error) {
          this.deps.diagnostics.log(
            'warn',
            `Could not read the thread of session ${record.id}, so it stays: ${(error as Error).message}`,
          )
        }
      }),
    )
    // Checked again after the reads, which a renderer may have used to show or use one.
    const decided = new Map<string, boolean>()
    const removable = (id: string): boolean => {
      const known = decided.get(id)
      if (known !== undefined) return known
      decided.set(id, false) // a loop of parents keeps them all
      const record = this.records.get(id)
      const yes =
        !!record &&
        empty.has(id) &&
        mayBeEmpty(record) &&
        !keep.has(id) &&
        !this.inUse(id) &&
        this.children(id).every((child) => removable(child.id))
      decided.set(id, yes)
      return yes
    }
    const removed = [...empty].filter(removable)
    const records = removed.map((id) => this.records.get(id)!)
    for (const id of removed) this.forget(id)
    this.emptySessionsRemovedAt = this.now()
    this.saveIndex()
    // While the index on disk still lists a session, its empty thread is what lets a later run
    // remove it, so the threads go only once the index is written.
    if (!(await this.deps.file.flushWritten())) {
      // Undone, so a later write in this run does not drop them with their threads still stored.
      for (const record of records) this.records.set(record.id, record)
      this.emptySessionsRemovedAt = null
      this.saveIndex()
      for (const record of records) this.touch(record.id)
      this.deps.diagnostics.log(
        'warn',
        `Could not write the index without ${removed.length} sessions that held no message; they stay listed and the next launch tries again`,
      )
      return
    }
    this.removeThreads(removed)
    this.deps.diagnostics.log(
      'info',
      `Removed ${removed.length} session${removed.length === 1 ? '' : 's'} that held no message; this runs once`,
    )
  }

  /** Live, shown or watched by a port, or being brought back or let go. */
  private inUse(sessionId: string): boolean {
    return (
      this.live.has(sessionId) ||
      this.inFront(sessionId) ||
      this.watchers.has(sessionId) ||
      this.reviving.has(sessionId) ||
      this.releasing.has(sessionId)
    )
  }

  async listImportable(
    agentId: AgentId,
    projectPath: string,
    cursor: string | null,
  ): Promise<{ sessions: ImportableSession[]; nextCursor: string | null }> {
    const canonical = await this.deps.projects.resolveDirectory(projectPath)
    const runtime = await this.deps.agents.ensureReady(agentId)
    if (!runtime.init.capabilities.listSessions) {
      throw new HostError(
        'agent_unavailable',
        t('session.cannotList', { agent: this.deps.agents.name(agentId) }),
      )
    }
    let page
    try {
      page = await runtime.connection.listSessions(canonical, cursor)
    } catch (error) {
      throw agentError(error)
    }
    for (const item of page.sessions) {
      const key = `${agentId}\n${item.acpSessionId}`
      this.listed.delete(key)
      this.listed.set(key, { title: item.title, updatedAt: item.updatedAt })
      if (this.listed.size > LISTED_SESSIONS) {
        this.listed.delete(this.listed.keys().next().value!)
      }
    }
    return {
      sessions: page.sessions.map((item) => ({
        acpSessionId: item.acpSessionId,
        title: item.title,
        updatedAt: item.updatedAt,
        imported: this.findByAcp(agentId, item.acpSessionId) !== undefined,
      })),
      nextCursor: page.nextCursor,
    }
  }

  async importSession(params: {
    agentId: AgentId
    projectPath: string
    acpSessionId: string
  }): Promise<SessionSummary> {
    if (!this.deps.agents.has(params.agentId))
      throw invalidParams(`Unknown agent ${params.agentId}`)
    const projectPath = await this.deps.projects.resolveDirectory(params.projectPath)
    const existing = this.findByAcp(params.agentId, params.acpSessionId)
    if (existing) return this.summary(existing.id)
    await this.deps.projects.add(projectPath)
    const listed = this.listed.get(`${params.agentId}\n${params.acpSessionId}`)
    const now = this.now()
    const updatedAt = listed?.updatedAt ? Date.parse(listed.updatedAt) : NaN
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: params.agentId,
      acpSessionId: params.acpSessionId,
      projectPath,
      title: listed?.title ?? null,
      createdAt: now,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
      lastViewedAt: now,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
    }
    this.stampConfig(record)
    this.records.set(record.id, record)
    this.saveIndex()
    this.touch(record.id)
    return this.summary(record.id)
  }

  // Git.

  gitEvents(sessionId: string, drafts: readonly GitEventDraft[]): void {
    const live = this.live.get(sessionId)
    if (!live) return
    const patches: Patch[] = drafts.map((draft) => ({
      op: 'entry.add',
      entry: { ...draft, id: this.nextId(live, 'g') } as ThreadEntry,
    }))
    this.emit(live, patches)
  }

  /** Pull requests changed for a project's branches: its rows may show a new badge. */
  pullRequestsChanged(projectPath: string): void {
    for (const summary of this.list(projectPath)) this.touch(summary.id)
  }

  // For main.

  busy(): BusySession[] {
    const out: BusySession[] = []
    for (const live of this.live.values()) {
      const status = live.thread.session.status
      if (status === 'running' || status === 'awaiting_permission') {
        out.push({
          sessionId: live.id,
          agentId: live.record.agentId,
          title: live.thread.session.title,
        })
      }
    }
    return out
  }

  summaries(): SessionSummary[] {
    return this.list()
  }

  /**
   * Before a clean exit: pending patches go out, every thread is stored as it stands, and turns
   * are left as they are, but a first message not sent yet waits in its queue. No checkpoint
   * follows.
   */
  shutdown(): void {
    for (const live of this.live.values()) {
      this.holdFirst(live)
      this.flushPatches(live)
      if (live.turn?.fallback) clearTimeout(live.turn.fallback)
      if (live.releaseTimer) clearTimeout(live.releaseTimer)
      this.checkpoint(live)
    }
    for (const timer of this.cacheReads.values()) clearTimeout(timer)
    this.stopped = true
  }
}

/** A new session or fork deleted, or its project removed, while it started. */
function removedWhileStarting(): HostError {
  return new HostError('not_found', t('session.removedWhileStarting'), {
    reason: REMOVED_WHILE_STARTING,
  })
}

/** Whether a session in this status takes a prompt: an attached one that is free, or one to attach. */
function canSend(status: SessionStatus): boolean {
  return status === 'ready' || status === 'closed'
}

/** JSON-RPC's code for a session the agent does not have. */
const RESOURCE_NOT_FOUND = -32002
const INTERNAL_ERROR = -32603
// codex-acp 2.2.2 passes Codex's own error on as an internal one, in `data.details`: Codex writes a
// thread's rollout on its first turn, so a new process cannot resume a thread never prompted.
const NO_ROLLOUT = 'no rollout found for thread id'

/** The agent does not have the session it was asked to resume. */
export function unknownSession(error: AgentRequestError): boolean {
  if (error.code === RESOURCE_NOT_FOUND) return true
  if (error.code !== INTERNAL_ERROR) return false
  const details = (error.data as { details?: unknown } | undefined)?.details
  return typeof details === 'string' && details.includes(NO_ROLLOUT)
}

/** The number in an entry id such as `e:12`, which the session's new ids count on from. */
function idNumber(id: string): number {
  return Number(/^\w+:(\d+)$/.exec(id)?.[1] ?? 0)
}

/**
 * A fork from a reply's agent message: the thread up to the end of its turn, and the fork point
 * that tells the agent where. Null in the latest turn, where the fork takes the whole session.
 */
export function forkCut(
  thread: Pick<ThreadState, 'order' | 'byId'>,
  entryId: string,
): { entries: ThreadEntry[]; point: ForkPoint } | null {
  const entry = thread.byId[entryId]
  if (entry?.kind !== 'agent') throw new HostError('invalid_params', t('session.noForkPoint'))
  const at = thread.order.indexOf(entryId)
  let end = at + 1
  while (end < thread.order.length) {
    const next = thread.byId[thread.order[end]!]
    if (next?.kind === 'user' && !next.steered) break
    end++
  }
  // Only the message that ends its reply, since Claude Code's adapter forks at the message itself.
  if (thread.order.slice(at + 1, end).some((id) => thread.byId[id]?.kind === 'agent')) {
    throw new HostError('invalid_params', t('session.noForkPoint'))
  }
  if (end === thread.order.length) return null
  const messageId = entryMessageId(entryId)
  if (messageId === null) throw new HostError('invalid_params', t('session.noForkPoint'))
  const entries = thread.order.slice(0, end).map((id) => thread.byId[id]!)
  // The adapters fall back to the text, the nth agent message with it, when the id is unknown.
  const occurrence = entries
    .slice(0, at + 1)
    .filter(
      (e) => e.kind === 'agent' && entryMessageId(e.id) !== null && e.markdown === entry.markdown,
    ).length
  return { entries, point: { messageId, text: entry.markdown, occurrence } }
}

function turnEndText(stopReason: StopReason): string {
  return t(`attention.turnEnd.${stopReason}`)
}

function busyError(status: SessionStatus): HostError {
  return new HostError('busy', t('session.busy', { status: t(`session.status.${status}`) }))
}

// Something for the user to do rather than a fault, so a warning; the composer offers Retry.
function outOfCreditNotice(
  agent: string,
  config: readonly ConfigOption[],
  message: string,
): {
  severity: 'warning'
  title: string
  description: string
  cause: 'out_of_credit'
  model?: string
} {
  const model = modelOf(config)
  const option = config.find((o) => o.category === 'model')
  const name = model && (option?.choices?.find((c) => c.value === model)?.name ?? model)
  return {
    severity: 'warning',
    title: name
      ? t('notice.outOfCredit.title', { model: name.slice(name.lastIndexOf('/') + 1) })
      : t('notice.outOfCredit.titleNoModel', { agent }),
    description: message,
    cause: 'out_of_credit',
    ...(model ? { model } : {}),
  }
}

// The exit event and the failed prompt race, so both say the same thing. The notice ends the cut
// turn, where the renderer offers to resume it.
function stoppedNotice(name: string): { title: string; cause: 'agent_stopped' } {
  return { title: t('notice.stopped.title', { agent: name }), cause: 'agent_stopped' }
}

/**
 * A turn's totals from its counts per model, which hold Claude Code's subagents where its
 * `usage` does not. Reasoning comes from `usage`, since only Codex reports it in both.
 */
function sumModelTokens(models: ModelTokens[], usage: TokenTotals | null): TokenTotals {
  let sum: TokenTotals | null = null
  for (const { tokens } of models) sum = addTokenTotals(sum, { ...tokens, thought: null })
  return { ...sum!, thought: usage?.thought ?? null }
}

/** The session's model option, for an agent that names no model per turn. */
function modelOf(config: readonly ConfigOption[]): string | null {
  const option = config.find((o) => o.category === 'model' && typeof o.value === 'string')
  return typeof option?.value === 'string' ? option.value : null
}

/** Which prepared session a request asks for: the agent, the folder and the parent. */
function preparedKey(params: PrepareParams): string {
  return JSON.stringify([params.agentId, params.projectPath, params.parentId ?? null])
}

/** What a user reads for a value: its name in the session's list, else in the cached one. */
function nameOf(
  option: ConfigOption,
  value: string | boolean,
  cached: readonly ConfigOption[],
): string | boolean {
  if (typeof value === 'boolean') return value
  const choice =
    option.choices?.find((c) => c.value === value) ??
    cached.find((o) => o.id === option.id)?.choices?.find((c) => c.value === value)
  return choice?.name ?? value
}

function replacedNotice(
  replaced: ReplacedValue,
  config: readonly ConfigOption[],
  cached: readonly ConfigOption[],
): StartNotice {
  const { option, wanted } = replaced
  const now = config.find((o) => o.id === option.id) ?? option
  return {
    reason: 'replaced',
    optionId: option.id,
    category: option.category,
    option: option.name,
    type: option.type,
    wanted: nameOf(option, wanted, cached),
    actual: nameOf(now, now.value, cached),
  }
}

/** The values a prepared session was meant to start with and does not hold, and why. */
function unmetValues(
  wanted: Record<string, string | boolean>,
  own: readonly ConfigOption[],
  config: readonly ConfigOption[],
  cached: readonly ConfigOption[],
): StartNotice[] {
  const out: StartNotice[] = []
  for (const [id, value] of Object.entries(wanted)) {
    if (id === ULTRACODE_OPTION_ID) continue
    const option = config.find((o) => o.id === id)
    if (option?.value === value) continue
    const known = option ?? own.find((o) => o.id === id) ?? cached.find((o) => o.id === id)
    if (!known) continue
    out.push({
      reason: option && isValueOf(option, value) ? 'refused' : 'not_offered',
      optionId: id,
      category: known.category,
      option: known.name,
      type: known.type,
      wanted: nameOf(known, value, cached),
      actual: option ? nameOf(option, option.value, cached) : null,
    })
  }
  return out
}
