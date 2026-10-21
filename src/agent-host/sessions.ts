// Live sessions: the authoritative thread state, prompts, permissions, cancellation, the
// session lifecycle, sub-sessions, and the session index.

import { randomUUID } from 'node:crypto'
import type { ImportableSession, SessionAttention, SessionSummary } from '@shared/agent-host'
import type { BusySession } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import {
  applyPatchInPlace,
  coalescePatches,
  threadEntries,
  threadFromSnapshot,
  UnknownEntryError,
  type AgentId,
  type ConfigOption,
  type Patch,
  type PatchBatch,
  type PermissionKind,
  type SessionSnapshot,
  type SessionStatus,
  type SessionView,
  type StopReason,
  type ThreadEntry,
  type ThreadState,
  type TokenTotals,
  type UserContent,
} from '@shared/thread'
import type {
  AgentConnection,
  PermissionAnswer,
  PermissionRequest,
  SessionTarget,
} from './acp/connection'
import {
  isStopReason,
  mergeConfig,
  newTurnScope,
  SYNTHETIC_MODE_ID,
  type MapperEffect,
  type MapperOutput,
  type SubagentState,
  type TurnScope,
} from './acp/mapper'
import { agentError, type AgentManager, type AgentRuntime } from './agents'
import type { Diagnostics } from './diagnostics'
import { HostError, invalidParams, notFound } from './errors'
import type { GitEventDraft, GitServiceApi } from './git/api'
import { pathKey, samePath } from './paths'
import type { Projects } from './projects'
import type { JsonFile, SessionRecord, SessionsFile } from './storage'

export interface SessionTimings {
  /** Patches of a session are flushed at most this often. */
  flushMs: number
  /** How long the host waits for an agent to confirm `session/cancel` before ending the turn. */
  cancelFallbackMs: number
}

export const SESSION_TIMINGS: SessionTimings = { flushMs: 16, cancelFallbackMs: 10_000 }

export interface SessionEvents {
  patches(batch: PatchBatch, portIds: readonly string[]): void
  summary(summary: SessionSummary): void
  removed(sessionId: string): void
  attention(
    sessionId: string,
    kind: 'permission' | 'turn-ended' | 'error',
    title: string,
    body: string,
  ): void
  badge(count: number): void
}

export interface SessionManagerDeps {
  platform: Platform
  agents: AgentManager
  projects: Projects
  file: JsonFile<SessionsFile>
  diagnostics: Diagnostics
  git(): GitServiceApi | null
  events: SessionEvents
  timings?: Partial<SessionTimings>
  now?: () => number
}

type Failure =
  | { action: 'create' }
  | { action: 'load' }
  | { action: 'resume' }
  | { action: 'prompt'; content: UserContent[] }

interface Turn {
  startedAt: number
  content: UserContent[]
  ended: boolean
  cancelRequested: boolean
  fallback: ReturnType<typeof setTimeout> | null
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
  connection: AgentConnection | null
  target: SessionTarget
  opening: Promise<void> | null
  /** Set while the session's tree closes, so no late update brings a child back. */
  closing: boolean
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

const CONNECTED: ReadonlySet<SessionStatus> = new Set([
  'starting',
  'auth_required',
  'ready',
  'running',
  'awaiting_permission',
  'disconnected',
])

export class SessionManager {
  private readonly records = new Map<string, SessionRecord>()
  private readonly live = new Map<string, Live>()
  private readonly watchers = new Map<string, Set<string>>()
  private readonly missing = new Set<string>()
  private readonly lastSummaries = new Map<string, string>()
  /** The last `seq` of sessions that are not live, so a reopened session continues it. */
  private readonly seqs = new Map<string, number>()
  private readonly listed = new Map<string, { title: string | null; updatedAt: string | null }>()
  private readonly timings: SessionTimings
  private readonly now: () => number
  private requestCounter = 0
  private badgeCount = 0

  constructor(private readonly deps: SessionManagerDeps) {
    this.timings = { ...SESSION_TIMINGS, ...deps.timings }
    this.now = deps.now ?? Date.now
    deps.agents.hooks = {
      liveSessions: (agentId) => this.connectedCount(agentId),
      agentReady: (agentId) => this.agentReady(agentId),
      agentExited: (agentId) => this.agentExited(agentId),
      signedIn: (agentId) => this.agentSignedIn(agentId),
    }
  }

  async load(): Promise<void> {
    const file = await this.deps.file.load()
    for (const record of file.sessions) this.records.set(record.id, record)
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
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
    else if (status === 'failed' || (session?.error && status !== 'running')) attention = 'error'
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
      title: session ? session.title : record.title,
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
    }
  }

  list(projectPath?: string): SessionSummary[] {
    const ids = new Set<string>([...this.records.keys(), ...this.live.keys()])
    const key = projectPath === undefined ? null : pathKey(projectPath, this.deps.platform)
    const out: SessionSummary[] = []
    for (const id of ids) {
      const summary = this.summary(id)
      if (key === null || pathKey(summary.projectPath, this.deps.platform) === key)
        out.push(summary)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
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
    this.deps.events.summary(summary)
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
      try {
        live.thread = applyPatchInPlace(live.thread, patch)
      } catch (error) {
        if (!(error instanceof UnknownEntryError)) throw error
        // A bug in the mapper, not in the agent: recorded, and the patch is not sent.
        this.deps.diagnostics.log('error', `Session ${live.id}: ${error.message}`)
        continue
      }
      live.queue.push(patch)
    }
    this.scheduleFlush(live)
  }

  private update(live: Live, changes: Partial<SessionView>): void {
    this.emit(live, [{ op: 'session.update', changes }])
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

  snapshot(sessionId: string): SessionSnapshot {
    const live = this.live.get(sessionId)
    if (!live) {
      const record = this.recordOf(sessionId)
      return { session: this.closedView(record), entries: [], seq: this.seqs.get(sessionId) ?? 0 }
    }
    this.flushPatches(live)
    return { session: live.thread.session, entries: threadEntries(live.thread), seq: live.seq }
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
      connection: null,
      target,
      opening: null,
      closing: false,
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

  private dropLive(live: Live): void {
    this.flushPatches(live)
    if (live.turn?.fallback) clearTimeout(live.turn.fallback)
    live.connection?.unregister(live.record.acpSessionId, live.target)
    this.seqs.set(live.id, live.seq)
    this.live.delete(live.id)
    this.deps.agents.sessionsChanged(live.record.agentId)
  }

  private saveIndex(): void {
    // JsonFile serializes when it writes, so the latest records go out without copies here.
    this.deps.file.save({ version: 1, sessions: [...this.records.values()] })
  }

  private persist(live: Live): void {
    if (!live.saved) return
    const session = live.thread.session
    live.record.title = session.title
    live.record.updatedAt = session.updatedAt
    if (session.queue.length > 0) live.record.queue = session.queue
    else delete live.record.queue
    this.records.set(live.id, live.record)
    this.saveIndex()
  }

  private save(live: Live): void {
    live.saved = true
    this.records.set(live.id, live.record)
    this.persist(live)
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
    }
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
        if (state.tokens) {
          const usage = child.thread.session.usage
          changes.usage = {
            used: usage?.used ?? 0,
            size: usage?.size ?? 0,
            cost: usage?.cost ?? null,
            tokens: state.tokens,
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
        if (!child.replaying && !this.watched(child.id)) child.unread = true
        break
      }
      case 'unknown':
      case 'cleared':
        info.stateKnown = false
        break
    }
  }

  // Watching.

  private watched(sessionId: string): boolean {
    return (this.watchers.get(sessionId)?.size ?? 0) > 0
  }

  watch(sessionId: string, portId: string): void {
    const record = this.recordOf(sessionId)
    let ports = this.watchers.get(sessionId)
    if (!ports) {
      ports = new Set()
      this.watchers.set(sessionId, ports)
    }
    ports.add(portId)
    this.markViewed(sessionId, record)
  }

  unwatch(sessionId: string, portId: string): void {
    const ports = this.watchers.get(sessionId)
    if (!ports?.delete(portId)) return
    if (ports.size === 0) this.watchers.delete(sessionId)
    if (this.has(sessionId)) this.markViewed(sessionId, this.recordOf(sessionId))
  }

  portClosed(portId: string): void {
    for (const [sessionId, ports] of this.watchers) {
      if (ports.delete(portId) && ports.size === 0) this.watchers.delete(sessionId)
    }
  }

  private markViewed(sessionId: string, record: SessionRecord): void {
    record.lastViewedAt = this.now()
    const live = this.live.get(sessionId)
    if (live) live.unread = false
    if (this.records.has(sessionId)) this.saveIndex()
    this.touch(sessionId)
  }

  // Creating, opening and recovering.

  async create(params: {
    agentId: AgentId
    projectPath: string
    parentId?: string
  }): Promise<SessionSummary> {
    const { agents, projects } = this.deps
    if (!agents.has(params.agentId)) throw invalidParams(`Unknown agent ${params.agentId}`)
    const projectPath = await projects.resolveDirectory(params.projectPath)
    if (params.parentId !== undefined) {
      const parent = this.recordOf(params.parentId)
      if (!samePath(parent.projectPath, projectPath, this.deps.platform)) {
        throw invalidParams('A sub-session belongs to the project of its parent')
      }
    }
    await projects.add(projectPath)
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
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    this.touch(live.id)
    try {
      await this.startNew(live)
    } catch (error) {
      if (!(error instanceof HostError && error.code === 'auth_required')) {
        this.dropLive(live)
        this.forget(live.id)
        throw error
      }
    }
    return this.summary(live.id)
  }

  /** `session/new`; on `auth_required` the session waits in that state and stays live. */
  private async startNew(live: Live): Promise<void> {
    const runtime = await this.deps.agents.ensureReady(live.record.agentId)
    try {
      const setup = await runtime.connection.newSession(live.record.projectPath)
      live.record.acpSessionId = setup.acpSessionId
      this.attach(live, runtime.connection)
      live.failure = null
      this.update(live, {
        acpSessionId: setup.acpSessionId,
        config: setup.config,
        status: 'ready',
        error: null,
      })
      this.deps.agents.signedIn(live.record.agentId)
      this.save(live)
      this.touch(live.id)
    } catch (error) {
      throw this.failStart(live, error, { action: 'create' })
    }
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
   * Opens a session: live ones return at once; others load (replaying the history) or
   * resume. Agent-side failures leave the session live in `failed` or `auth_required`, so
   * the snapshot shows them with Retry.
   */
  async open(sessionId: string): Promise<SessionSnapshot> {
    const existing = this.live.get(sessionId)
    if (existing) {
      if (existing.opening) await existing.opening
      return this.snapshot(sessionId)
    }
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent' && record.parentId) {
      // A subagent's thread comes back with its parent's load, which replays the children.
      await this.open(record.parentId)
      return this.snapshot(sessionId)
    }
    const live = this.makeLive(record, true, 'starting')
    await this.runOpening(live, 'load')
    return this.snapshot(sessionId)
  }

  private runOpening(live: Live, mode: 'load' | 'resume'): Promise<void> {
    if (live.opening) return live.opening
    const run = this.reconnect(live, mode)
      .catch(() => {
        // reconnect() already moved the session to failed or auth_required.
      })
      .finally(() => {
        live.opening = null
      })
    live.opening = run
    return run
  }

  /** `session/load` (replaying) or `session/resume`, by what the agent supports. */
  private async reconnect(live: Live, mode: 'load' | 'resume'): Promise<void> {
    this.update(live, { status: 'starting', error: null })
    this.touch(live.id)
    let runtime: AgentRuntime
    try {
      runtime = await this.deps.agents.ensureReady(live.record.agentId)
    } catch (error) {
      throw this.failStart(live, error, { action: mode })
    }
    const caps = runtime.init.capabilities
    const { connection } = runtime
    const { acpSessionId, projectPath } = live.record
    const useLoad =
      (mode === 'load' && caps.loadSession) ||
      (mode === 'resume' && !caps.resumeSession && caps.loadSession)
    if (!useLoad && !caps.resumeSession) {
      throw this.failStart(
        live,
        new HostError(
          'agent_unavailable',
          `${this.deps.agents.name(live.record.agentId)} can neither load nor resume sessions`,
        ),
        { action: mode },
      )
    }
    this.attach(live, connection)
    try {
      if (useLoad) {
        this.prepareReplay(live, connection)
        let setup
        try {
          setup = await connection.loadSession(acpSessionId, projectPath)
        } catch (error) {
          this.finishReplay(live, false)
          throw error
        }
        this.finishReplay(live, true)
        this.update(live, { config: mergeConfig(live.thread.session.config, setup.config) })
      } else {
        const setup = await connection.resumeSession(acpSessionId, projectPath)
        this.update(live, { config: mergeConfig(live.thread.session.config, setup.config) })
        if (mode === 'load' && live.thread.order.length === 0) {
          this.emit(live, [
            {
              op: 'entry.add',
              entry: {
                kind: 'notice',
                id: this.nextId(live),
                severity: 'info',
                title: 'Earlier history is not available',
                description: `${this.deps.agents.name(live.record.agentId)} cannot replay sessions, so this one continues without its history.`,
              },
            },
          ])
        }
        for (const child of this.descendants(live.id, 'subagent')) {
          const childLive = this.live.get(child.id)
          if (!childLive) continue
          this.attach(childLive, connection)
          const info = childLive.thread.session.subagent
          if (childLive.thread.session.status === 'disconnected') {
            this.update(childLive, {
              status: 'ready',
              ...(info ? { subagent: { ...info, stateKnown: false } } : {}),
            })
            this.touch(childLive.id)
          }
        }
      }
    } catch (error) {
      throw this.failStart(live, error, { action: useLoad ? 'load' : 'resume' })
    }
    live.failure = null
    this.deps.agents.signedIn(live.record.agentId)
    this.update(live, { status: 'ready', error: null })
    this.touch(live.id)
  }

  /** Resets the parent's thread and every known subagent below it for a replay. */
  private prepareReplay(live: Live, connection: AgentConnection): void {
    live.replaying = true
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
    for (const record of this.descendants(live.id, 'subagent')) {
      const child = this.live.get(record.id)
      if (!child) continue
      child.replaying = false
      if (ok && child.mentioned) {
        if (child.thread.session.status === 'starting') this.update(child, { status: 'ready' })
        this.touch(child.id)
        continue
      }
      if (ok) this.missing.add(child.id)
      this.dropLive(child)
      if (this.records.has(child.id)) this.touch(child.id)
      else this.forget(child.id)
    }
  }

  /** The agent restarted: resume every session it dropped. */
  private agentReady(agentId: AgentId): void {
    for (const live of [...this.live.values()]) {
      if (live.record.agentId !== agentId || live.record.origin === 'subagent') continue
      if (live.thread.session.status !== 'disconnected') continue
      void this.runOpening(live, 'resume')
    }
  }

  /** The agent exited: its sessions keep their threads and become disconnected. */
  private agentExited(agentId: AgentId): void {
    const name = this.deps.agents.name(agentId)
    for (const live of this.live.values()) {
      if (live.record.agentId !== agentId) continue
      live.connection = null
      const status = live.thread.session.status
      if (!CONNECTED.has(status) || status === 'starting' || status === 'auth_required') continue
      const turn = live.turn
      const cut = turn !== null && !turn.ended
      if (turn && !turn.ended) {
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
      this.update(live, { status: 'disconnected', turnStartedAt: null })
      this.touch(live.id)
      if (cut) {
        this.deps.events.attention(
          live.id,
          'error',
          this.titleOf(live),
          `${name} stopped unexpectedly`,
        )
      }
    }
    this.updateBadge()
  }

  private agentSignedIn(agentId: AgentId): void {
    for (const live of [...this.live.values()]) {
      if (live.record.agentId === agentId && live.thread.session.status === 'auth_required') {
        void this.retry(live.id).catch(() => {})
      }
    }
  }

  /** Re-runs what failed: the sign-in retry, a resume, or a load after a failed resume. */
  async retry(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId)
    if (!live) {
      await this.open(sessionId)
      return
    }
    if (live.opening) return live.opening
    // A subagent recovers with its parent; its own failures are the agent's to retry.
    if (live.record.origin === 'subagent') return
    const status = live.thread.session.status
    const failure = live.failure
    if (status === 'disconnected') {
      // Restarting the agent resumes its disconnected sessions on its own.
      await this.deps.agents.retry(live.record.agentId).catch(() => {})
      if (live.opening) await live.opening
      else if (live.thread.session.status === 'disconnected') await this.runOpening(live, 'resume')
      return
    }
    if (status !== 'failed' && status !== 'auth_required') return
    if (this.deps.agents.status(live.record.agentId).state === 'failed') {
      await this.deps.agents.retry(live.record.agentId).catch(() => {})
    }
    switch (failure?.action) {
      case 'create':
        this.update(live, { status: 'starting', error: null })
        this.touch(live.id)
        await this.startNew(live).catch(() => {})
        return
      case 'prompt':
        this.update(live, { status: 'ready', error: null })
        await this.runTurnAgain(live, failure.content)
        return
      case 'load':
      case 'resume':
        // "Reopen": a resume that failed falls back to replaying the history.
        await this.runOpening(live, 'load')
        return
      default:
        if (!live.record.acpSessionId) {
          this.update(live, { status: 'starting', error: null })
          this.touch(live.id)
          await this.startNew(live).catch(() => {})
        } else {
          await this.runOpening(live, 'load')
        }
    }
  }

  // Prompt turns.

  private liveFor(sessionId: string): Live {
    const live = this.live.get(sessionId)
    if (!live) {
      this.recordOf(sessionId)
      throw new HostError('busy', 'Open the session first')
    }
    return live
  }

  private titleOf(live: Live): string {
    return live.thread.session.title ?? this.deps.agents.name(live.record.agentId)
  }

  async prompt(sessionId: string, content: UserContent[]): Promise<void> {
    const live = this.liveFor(sessionId)
    if (live.record.origin === 'subagent') {
      throw new HostError('restricted', 'A subagent session takes its instructions from its parent')
    }
    if (live.thread.session.status !== 'ready' || !live.connection) {
      throw new HostError('busy', `The session is ${live.thread.session.status.replace('_', ' ')}`)
    }
    this.sendPrompt(live, content)
  }

  private sendPrompt(live: Live, content: UserContent[]): void {
    const now = this.now()
    const patches: Patch[] = [
      { op: 'entry.add', entry: { kind: 'user', id: this.nextId(live), content, at: now } },
    ]
    this.emit(live, patches)
    if (live.thread.session.title === null) {
      const title = fallbackTitle(content)
      if (title) this.update(live, { title })
    }
    this.startTurn(live, content, now)
  }

  // The queue: OverBench's own, for every agent, since ACP has none. One turn runs at a time,
  // and the oldest waiting prompt goes when a turn ends normally.

  /**
   * Queues a prompt behind the running turn, or sends it at once when the session is free and
   * nothing waits, or only a paused queue does. The composer always sends through here, so a
   * prompt sent before it heard that a turn started is queued, not refused.
   */
  async queue(sessionId: string, content: UserContent[]): Promise<{ itemId: string | null }> {
    const live = this.liveFor(sessionId)
    if (live.record.origin === 'subagent') {
      throw new HostError('restricted', 'A subagent session takes its instructions from its parent')
    }
    const { status, queue, queuePaused } = live.thread.session
    if (status === 'ready' && (queue.length === 0 || queuePaused)) {
      await this.prompt(sessionId, content)
      return { itemId: null }
    }
    if (status !== 'ready' && status !== 'running' && status !== 'awaiting_permission') {
      throw new HostError('busy', `The session is ${status.replace('_', ' ')}`)
    }
    const item = { id: randomUUID(), content, at: this.now() }
    this.update(live, { queue: [...queue, item] })
    this.persist(live)
    this.touch(live.id)
    return { itemId: item.id }
  }

  unqueue(sessionId: string, itemId: string): void {
    const live = this.liveFor(sessionId)
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
    const live = this.liveFor(sessionId)
    const item = live.thread.session.queue.find((i) => i.id === itemId)
    if (!item) throw notFound(`No queued prompt ${itemId}`)
    if (!this.deps.agents.status(live.record.agentId).capabilities.steering) {
      throw new HostError(
        'restricted',
        `${this.deps.agents.name(live.record.agentId)} cannot take messages during a turn`,
      )
    }
    if (!live.turn || live.turn.ended || !live.connection) {
      throw new HostError('busy', 'No turn is running')
    }
    let outcome
    try {
      outcome = await live.connection.steer(live.record.acpSessionId, item.content)
    } catch (error) {
      throw agentError(error)
    }
    const { queue } = live.thread.session
    if (outcome === 'promptRequired') {
      this.update(live, { queue: [item, ...queue.filter((i) => i.id !== itemId)] })
      this.persist(live)
      if (live.thread.session.status === 'ready') this.drainQueue(live)
      return
    }
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'user',
          id: this.nextId(live),
          content: item.content,
          at: this.now(),
          steered: true,
        },
      },
    ])
    this.update(live, { queue: queue.filter((i) => i.id !== itemId) })
    this.persist(live)
    this.touch(live.id)
  }

  resumeQueue(sessionId: string): void {
    const live = this.liveFor(sessionId)
    this.update(live, { queuePaused: false })
    this.drainQueue(live)
    this.persist(live)
    this.touch(live.id)
  }

  /** Sends the oldest waiting prompt, when the session is free and the queue is not paused. */
  private drainQueue(live: Live): void {
    const { status, queue, queuePaused } = live.thread.session
    const [next, ...rest] = queue
    if (!next || queuePaused || status !== 'ready' || !live.connection) return
    this.update(live, { queue: rest })
    this.sendPrompt(live, next.content)
  }

  private pauseQueue(live: Live): void {
    if (live.thread.session.queue.length > 0) this.update(live, { queuePaused: true })
  }

  private startTurn(live: Live, content: UserContent[], now: number): void {
    const turn: Turn = {
      startedAt: now,
      content,
      ended: false,
      cancelRequested: false,
      fallback: null,
    }
    live.turn = turn
    live.scope = newTurnScope()
    live.failure = null
    this.update(live, { status: 'running', turnStartedAt: now, error: null, updatedAt: now })
    this.persist(live)
    this.touch(live.id)
    void this.runTurn(live, turn)
  }

  /**
   * `session/fork`: a new session that starts from this one's history. The agent keeps the
   * history; the fork shows a copy of this thread until it is replayed on a later open.
   */
  async fork(sessionId: string): Promise<SessionSummary> {
    const source = this.liveFor(sessionId)
    if (source.record.origin === 'subagent') {
      throw new HostError('restricted', 'A subagent session cannot be forked')
    }
    if (source.thread.session.status !== 'ready' || !source.connection) {
      throw new HostError(
        'busy',
        `The session is ${source.thread.session.status.replace('_', ' ')}`,
      )
    }
    const runtime = await this.deps.agents.ensureReady(source.record.agentId)
    if (!runtime.init.capabilities.forkSession) {
      throw new HostError(
        'agent_unavailable',
        `${this.deps.agents.name(source.record.agentId)} cannot fork sessions`,
      )
    }
    let setup
    try {
      setup = await runtime.connection.forkSession(
        source.record.acpSessionId,
        source.record.projectPath,
      )
    } catch (error) {
      throw agentError(error)
    }
    const now = this.now()
    const record: SessionRecord = {
      ...source.record,
      id: randomUUID(),
      acpSessionId: setup.acpSessionId,
      title: source.thread.session.title,
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      branch: null,
    }
    const live = this.makeLive(record, false, 'ready')
    live.unread = false
    // Subagent cards point at the source's sub-sessions, which the fork does not have.
    const entries = threadEntries(source.thread).filter((entry) => entry.kind !== 'subagent')
    for (const entry of entries) {
      const n = Number(/^\w+:(\d+)$/.exec(entry.id)?.[1] ?? 0)
      if (n > live.counter) live.counter = n
    }
    this.emit(
      live,
      entries.map((entry) => ({ op: 'entry.add', entry })),
    )
    this.attach(live, runtime.connection)
    this.update(live, {
      acpSessionId: setup.acpSessionId,
      config: mergeConfig(source.thread.session.config, setup.config),
      usage: source.thread.session.usage,
    })
    this.save(live)
    this.touch(live.id)
    return this.summary(live.id)
  }

  private async runTurnAgain(live: Live, content: UserContent[]): Promise<void> {
    if (!live.connection) {
      await this.runOpening(live, 'resume')
      if (live.thread.session.status !== 'ready') return
    }
    this.startTurn(live, content, this.now())
  }

  private async runTurn(live: Live, turn: Turn): Promise<void> {
    const connection = live.connection!
    try {
      const result = await connection.prompt(live.record.acpSessionId, turn.content)
      if (turn.ended) return
      this.deps.agents.signedIn(live.record.agentId)
      this.endTurn(live, turn, result.stopReason, result.tokens)
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

  private finishTurn(live: Live, turn: Turn, stopReason: StopReason | null): void {
    turn.ended = true
    if (turn.fallback) clearTimeout(turn.fallback)
    turn.fallback = null
    if (live.turn === turn) live.turn = null
    this.closeOpenEntries(live)
    this.clearPermissions(live, 'cancelled')
    if (stopReason) {
      this.emit(live, [
        {
          op: 'entry.add',
          entry: {
            kind: 'turn_end',
            id: this.nextId(live),
            stopReason,
            durationMs: Math.max(0, this.now() - turn.startedAt),
          },
        },
      ])
    }
  }

  private endTurn(
    live: Live,
    turn: Turn,
    stopReason: StopReason,
    tokens: TokenTotals | null,
  ): void {
    this.finishTurn(live, turn, stopReason)
    const now = this.now()
    const changes: Partial<SessionView> = { status: 'ready', turnStartedAt: null, updatedAt: now }
    if (tokens) {
      const usage = live.thread.session.usage
      changes.usage = {
        used: usage?.used ?? 0,
        size: usage?.size ?? 0,
        cost: usage?.cost ?? null,
        tokens,
      }
    }
    this.update(live, changes)
    const git = this.deps.git()
    if (git) {
      git.turnEnded(live.record.projectPath, live.id)
      live.record.branch = git.currentBranch(live.record.projectPath) ?? live.record.branch
    }
    if (this.watched(live.id)) live.record.lastViewedAt = now
    else live.unread = true
    this.persist(live)
    this.touch(live.id)
    this.deps.events.attention(live.id, 'turn-ended', this.titleOf(live), turnEndText(stopReason))
    if (stopReason === 'end_turn') this.drainQueue(live)
    else this.pauseQueue(live)
  }

  private failTurn(live: Live, turn: Turn, error: unknown): void {
    const mapped = agentError(error)
    this.finishTurn(live, turn, null)
    const now = this.now()
    const authRequired = mapped.code === 'auth_required'
    const closed = mapped.code === 'agent_unavailable'
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'error',
          ...(authRequired
            ? {
                title: `${this.deps.agents.name(live.record.agentId)} needs you to sign in`,
                description: mapped.message,
              }
            : closed
              ? stoppedNotice(this.deps.agents.name(live.record.agentId))
              : { title: 'The turn failed', description: mapped.message }),
        },
      },
    ])
    if (authRequired) {
      live.failure = { action: 'prompt', content: turn.content }
      this.deps.agents.authRequired(live.record.agentId)
      this.update(live, { status: 'auth_required', turnStartedAt: null, updatedAt: now })
    } else if (closed) {
      this.update(live, { status: 'disconnected', turnStartedAt: null, updatedAt: now })
    } else {
      this.update(live, {
        status: 'ready',
        turnStartedAt: null,
        updatedAt: now,
        error: { message: mapped.message },
      })
    }
    this.pauseQueue(live)
    this.persist(live)
    this.touch(live.id)
    this.deps.events.attention(live.id, 'error', this.titleOf(live), mapped.message)
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.liveFor(sessionId)
    if (live.record.origin === 'subagent') {
      if (!live.thread.session.subagent?.canCancel) {
        throw new HostError('restricted', 'The agent does not allow cancelling this subagent')
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
    try {
      await live.connection?.cancel(live.record.acpSessionId)
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
            title: `${this.deps.agents.name(live.record.agentId)} did not confirm the cancellation`,
            description: `OverBench ended the turn after ${Math.round(this.timings.cancelFallbackMs / 1000)} seconds. The agent may still be finishing work in the background.`,
          },
        },
      ])
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
        tool?.kind === 'tool' ? tool.title : 'The agent asks for permission',
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
    const live = this.liveFor(sessionId)
    if (live.record.origin === 'subagent') {
      throw new HostError('restricted', 'A subagent session cannot be configured')
    }
    if (!live.connection)
      throw new HostError('busy', `The session is ${live.thread.session.status}`)
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
    try {
      if (optionId === SYNTHETIC_MODE_ID) {
        await live.connection.setMode(live.record.acpSessionId, value as string)
        this.update(live, {
          config: live.thread.session.config.map((o): ConfigOption =>
            o.id === SYNTHETIC_MODE_ID ? { ...o, value } : o,
          ),
        })
      } else {
        const config = await live.connection.setConfigOption(
          live.record.acpSessionId,
          optionId,
          value,
        )
        this.update(live, { config: mergeConfig(live.thread.session.config, config) })
      }
    } catch (error) {
      throw agentError(error)
    }
  }

  // Closing, deleting and importing.

  async close(sessionId: string): Promise<void> {
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent') {
      throw new HostError('restricted', 'A subagent session closes with its parent')
    }
    await this.closeAll([...this.descendants(sessionId), record])
  }

  /** Closes sessions in order; none of them takes updates once this starts. */
  private async closeAll(records: readonly SessionRecord[]): Promise<void> {
    for (const record of records) {
      const live = this.live.get(record.id)
      if (live) live.closing = true
    }
    for (const record of records) await this.closeOne(record.id)
  }

  private async closeOne(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId)
    if (!live) return
    const connection = live.connection
    if (live.turn && !live.turn.ended) {
      await connection?.cancel(live.record.acpSessionId).catch(() => {})
      this.finishTurn(live, live.turn, 'cancelled')
    }
    this.clearPermissions(live, 'cancelled')
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
    this.dropLive(live)
    this.updateBadge()
    // A session that never reached the index has nothing to come back to.
    if (live.saved) this.touch(sessionId)
    else this.forget(sessionId)
  }

  async delete(sessionId: string): Promise<void> {
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent') {
      throw new HostError('restricted', 'A subagent session is deleted with its parent')
    }
    const all = [...this.descendants(sessionId), record]
    await this.closeAll(all)
    for (const item of all) {
      if (item.origin !== 'user' || !item.acpSessionId) continue
      try {
        const runtime = await this.deps.agents.ensureReady(item.agentId)
        if (runtime.init.capabilities.deleteSession)
          await runtime.connection.deleteSession(item.acpSessionId)
      } catch (error) {
        this.deps.diagnostics.log(
          'warn',
          `session/delete failed for ${item.id}: ${(error as Error).message}`,
        )
      }
    }
    for (const item of all) this.forget(item.id)
    this.saveIndex()
  }

  private forget(sessionId: string): void {
    const known = this.records.delete(sessionId) || this.lastSummaries.has(sessionId)
    this.lastSummaries.delete(sessionId)
    this.missing.delete(sessionId)
    this.watchers.delete(sessionId)
    this.seqs.delete(sessionId)
    if (known) this.deps.events.removed(sessionId)
  }

  /** Clears the index; the agents keep their transcripts. */
  async removeAll(): Promise<void> {
    const live = [...this.live.values()]
    await this.closeAll(live.filter((l) => l.record.origin === 'user').map((l) => l.record))
    for (const item of live) if (this.live.has(item.id)) this.dropLive(item)
    const ids = new Set([...this.records.keys(), ...this.lastSummaries.keys()])
    for (const id of ids) this.forget(id)
    this.saveIndex()
  }

  /** Removes a project's sessions from the index, closing live ones first. */
  async removeProject(projectPath: string): Promise<void> {
    const key = pathKey(projectPath, this.deps.platform)
    const inProject = this.list().filter((s) => pathKey(s.projectPath, this.deps.platform) === key)
    for (const summary of inProject) {
      const live = this.live.get(summary.id)
      if (live) live.closing = true
    }
    for (const summary of inProject) if (summary.origin === 'user') await this.closeOne(summary.id)
    for (const summary of inProject) {
      const live = this.live.get(summary.id)
      if (live) this.dropLive(live)
      this.forget(summary.id)
    }
    this.saveIndex()
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
        `${this.deps.agents.name(agentId)} cannot list its sessions`,
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

  /** Before a clean exit: pending patches go out and turns are left as they are. */
  shutdown(): void {
    for (const live of this.live.values()) {
      this.flushPatches(live)
      if (live.turn?.fallback) clearTimeout(live.turn.fallback)
    }
  }
}

function turnEndText(stopReason: StopReason): string {
  switch (stopReason) {
    case 'end_turn':
      return 'Finished'
    case 'cancelled':
      return 'Cancelled'
    case 'max_tokens':
      return 'Stopped at the token limit'
    case 'max_turn_requests':
      return 'Stopped at the request limit'
    case 'refusal':
      return 'The agent refused'
  }
}

// The exit event and the failed prompt race, so both say the same thing.
function stoppedNotice(name: string): { title: string; description: string } {
  return {
    title: `${name} stopped unexpectedly`,
    description:
      'The turn ended without an answer. OverBench reconnects the session when the agent restarts.',
  }
}
