// agy's sub-agents as Kettu's. agy 1.5.15 starts one with `invoke_subagent`, whose call ends at once
// and says nothing of the child over ACP, even to a client that declares `subagents`; the turn that
// started it stays open until the child reports back with `send_message`. agy keeps each child in
// its conversation store under the parent's session id, with its run status. A `session/load` of a
// running child on the parent's own process streams the child's updates from then on and asks a
// question it waits on again, tied to the child's session; of a finished child, it replays it. So
// Kettu reads the store while a session's turn starts or messages sub-agents and while its children
// run, shows each child it finds as a sub-agent, and loads it in the parent's process.

import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { SessionTarget } from '../connection'
import { addEntry, toLf, type MapperOutput, type SubagentState } from '../session-updates'
import { compareVersions } from '../versions'

export const AGY_SUBAGENTS_VERSION = '1.5.15'

// Where a `session/load` names the session whose process runs the one it opens, as the session
// router reads it.
export const PARENT_SESSION_META = 'sh.kettu/parent-session'

/** Whether Kettu follows agy's sub-agents: a version they were measured on. */
export function followsSubagents(version: string | null): boolean {
  return version !== null && compareVersions(version, AGY_SUBAGENTS_VERSION) >= 0
}

/** A child agy keeps in its store. */
export interface AgyChild {
  id: string
  parentId: string
  /** agy's run status, such as `CASCADE_RUN_STATUS_RUNNING`. */
  status: string
  killed: boolean
  /** The type it was started as, such as `self` or `teamwork`. */
  agent: string
  title: string
}

/** The children of `parentIds` in agy's store, in the order agy started them. */
export type AgyStore = (parentIds: readonly string[]) => Promise<AgyChild[]>

// agy's tools that start, message or stop sub-agents, after which its store is read.
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  'invoke_subagent',
  'send_message',
  'manage_subagents',
  'swarm',
  'run_workflow',
])
const RUNNING: ReadonlySet<string> = new Set([
  'CASCADE_RUN_STATUS_RUNNING',
  'CASCADE_RUN_STATUS_BUSY',
  'CASCADE_RUN_STATUS_CANCELING',
])
const IDLE = 'CASCADE_RUN_STATUS_IDLE'
/** The type agy gives a child started as a copy of its parent, which names nothing. */
const SELF = 'self'

/** How soon the store is read after such a call, and how often while the work runs. */
export const FIRST_READ_MS = 300
export const READ_MS = 1_000
/** How far below a session a replay looks for children of children. */
const REPLAY_DEPTH = 4
const DESCRIPTION_LIMIT = 200

/** agy's conversation store, under the home folder (1.5.15). */
export function agyStoreFile(home = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db')
}

/**
 * Reads agy's store as a read-only connection, which takes agy's write-ahead log as it is and never
 * writes the database. A lookup in a table of one row per conversation takes about a millisecond,
 * so it runs in the host; a store agy holds locked fails at once and is read again later.
 */
export function agyStore(file = agyStoreFile()): AgyStore {
  return async (parentIds) => {
    if (parentIds.length === 0) return []
    try {
      await stat(file)
    } catch {
      return []
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true, timeout: 0 })
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id, parent_conversation_id, status, killed, agent_name, title
           FROM conversation_summaries
           WHERE parent_conversation_id IN (${parentIds.map(() => '?').join(', ')})
           ORDER BY rowid`,
        )
        .all(...parentIds)
      return rows.flatMap((row): AgyChild[] => {
        const id = row.conversation_id
        const parentId = row.parent_conversation_id
        if (typeof id !== 'string' || typeof parentId !== 'string' || id === '') return []
        return [
          {
            id,
            parentId,
            status: typeof row.status === 'string' ? row.status : '',
            killed: row.killed === 1 || row.killed === 1n,
            agent: typeof row.agent_name === 'string' ? row.agent_name : '',
            title: typeof row.title === 'string' ? row.title : '',
          },
        ]
      })
    } finally {
      db.close()
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function oneLine(value: string): string {
  const line = [...value.replace(/\s+/g, ' ').trim()]
  return line.length > DESCRIPTION_LIMIT
    ? `${line.slice(0, DESCRIPTION_LIMIT).join('').trimEnd()}…`
    : line.join('')
}

/** The name agy gives the tool beside a call, which ACP has no field for. */
function toolName(update: acp.ToolCallUpdate): string | null {
  const name = (update as { name?: unknown }).name
  if (typeof name === 'string') return name
  return update.title?.startsWith('Run ') ? update.title.slice('Run '.length) : null
}

/** An `invoke_subagent` call: what the child is to do, which names and describes it. */
interface StartCall {
  toolCallId: string
  role: string | null
  prompt: string | null
  type: string | null
  /** The child it started, once the store showed one. */
  child: string | null
}

interface Known {
  parentId: string
  running: boolean
  /** Opened in the process that runs it now. */
  loaded: boolean
}

/** What the tracker needs of the connection. */
export interface SubagentHost {
  /** The thread of a session Kettu shows, or undefined. */
  target(sessionId: string): SessionTarget | undefined
  /** Whether Kettu's prompt in the session runs. */
  prompting(sessionId: string): boolean
  /**
   * Opens a child in its parent's process, which replays it and streams it from then on; `quiet`
   * leaves out the replay, of a child whose thread Kettu has.
   */
  load(childId: string, parentId: string, quiet: boolean): Promise<void>
  /** The sub-agents under a session all stopped running. */
  settled(sessionId: string): void
  log(level: 'info' | 'warn', message: string): void
}

/** Follows the sub-agents of one connection's agy sessions. */
export class AgySubagents {
  private readonly calls = new Map<string, StartCall[]>()
  private readonly known = new Map<string, Known>()
  /** Sessions whose running turn called one of the tools that start or message sub-agents. */
  private readonly watching = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private reading = false
  private failed = false
  private stopped = false

  constructor(
    private readonly store: AgyStore,
    private readonly host: SubagentHost,
  ) {}

  /**
   * Notes a session's update: a start of a sub-agent names and describes it, and in a running turn
   * the store is read soon; a replay's calls name the children the replay shows after it.
   */
  noted(sessionId: string, update: acp.SessionUpdate, replaying: boolean): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const name = toolName(update)
    if (name === null || !SUBAGENT_TOOLS.has(name)) return
    if (name === 'invoke_subagent') this.noteStart(sessionId, update)
    if (replaying || !this.host.prompting(sessionId)) return
    this.watching.add(sessionId)
    this.schedule(FIRST_READ_MS)
  }

  private noteStart(sessionId: string, update: acp.ToolCallUpdate): void {
    const calls = this.calls.get(sessionId) ?? []
    if (!this.calls.has(sessionId)) this.calls.set(sessionId, calls)
    const input = record(update.rawInput)
    const existing = calls.find((call) => call.toolCallId === update.toolCallId)
    const call = existing ?? {
      toolCallId: update.toolCallId,
      role: null,
      prompt: null,
      type: null,
      child: null,
    }
    if (!existing) calls.push(call)
    call.role = text(input?.Role) ?? call.role
    call.prompt = text(input?.Prompt) ?? call.prompt
    call.type = text(input?.TypeName) ?? call.type
  }

  /** The session's turn ended: the store is read once more for what it started late. */
  turnEnded(sessionId: string): void {
    if (this.watching.has(sessionId)) this.schedule(FIRST_READ_MS)
  }

  /** Whether a sub-agent under the session runs. */
  running(sessionId: string): boolean {
    for (const [id, known] of this.known) {
      if (known.running && this.rootOf(id) === sessionId) return true
    }
    return false
  }

  /**
   * After a session's replay: its children and theirs, as agy's store has them, each replayed in
   * the session's process. A child of an earlier process no longer runs.
   */
  async replay(sessionId: string): Promise<void> {
    let level = [sessionId]
    for (let depth = 0; depth < REPLAY_DEPTH && level.length > 0; depth++) {
      const rows = await this.read(level)
      if (!rows) return
      for (const row of rows) await this.see(row, true)
      level = rows.filter((row) => this.known.has(row.id)).map((row) => row.id)
    }
  }

  /** The session's process started again: the sub-agents below it are opened again as they run. */
  restarted(sessionId: string): void {
    for (const [id, known] of this.known) if (this.rootOf(id) === sessionId) known.loaded = false
  }

  /** Forgets a session and what is below it, as it closes or before it is replayed again. */
  forget(sessionId: string): void {
    this.calls.delete(sessionId)
    this.watching.delete(sessionId)
    for (const [id, known] of [...this.known]) {
      if (known.parentId === sessionId && this.known.delete(id)) this.forget(id)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private rootOf(sessionId: string): string {
    let id = sessionId
    for (let known = this.known.get(id); known; known = this.known.get(id)) id = known.parentId
    return id
  }

  private schedule(ms: number): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, ms)
    this.timer.unref?.()
  }

  /** The sessions whose children are read: those watched, and around each child that runs. */
  private parents(): string[] {
    const ids = new Set<string>()
    for (const id of this.watching) if (this.host.target(id)) ids.add(id)
    for (const [id, known] of this.known) {
      if (!known.running) continue
      if (this.host.target(known.parentId)) ids.add(known.parentId)
      if (this.host.target(id)) ids.add(id)
    }
    return [...ids]
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.reading) {
      this.schedule(READ_MS)
      return
    }
    const parents = this.parents()
    if (parents.length === 0) {
      this.watching.clear()
      return
    }
    // A turn that ended before this read started everything it started by now.
    const ended = [...this.watching].filter((id) => !this.host.prompting(id))
    this.reading = true
    try {
      const rows = await this.read(parents)
      if (rows !== null) {
        const seen = new Set(rows.map((row) => row.id))
        for (const row of rows) await this.see(row, false)
        // 若某个先前运行中的子智能体记录已从存储中消失，及时结束其运行态以免永久阻塞模式切换。
        const queried = new Set(parents)
        for (const [id, known] of this.known) {
          if (!known.running || !queried.has(known.parentId) || seen.has(id)) continue
          known.running = false
          this.host.target(known.parentId)?.apply(
            subagent(id, {
              state: { kind: 'idle', stopReason: 'cancelled', error: null, tokens: null },
            }),
          )
          const root = this.rootOf(id)
          if (!this.running(root)) this.host.settled(root)
        }
      }
    } finally {
      this.reading = false
    }
    for (const id of ended) if (!this.host.prompting(id)) this.watching.delete(id)
    if (this.parents().length > 0) this.schedule(READ_MS)
  }

  private async read(parents: readonly string[]): Promise<AgyChild[] | null> {
    try {
      const rows = await this.store(parents)
      this.failed = false
      return rows
    } catch (error) {
      // Logged once while it keeps failing, since it is read again every second.
      if (!this.failed) {
        this.host.log('warn', `Could not read agy's sub-agents: ${(error as Error).message}`)
      }
      this.failed = true
      return null
    }
  }

  /** The `invoke_subagent` call that started a child: the first open one of its type, or any. */
  private startOf(row: AgyChild): StartCall | null {
    const open = (this.calls.get(row.parentId) ?? []).filter((call) => call.child === null)
    const call = open.find((item) => item.type === row.agent) ?? open[0] ?? null
    if (call) call.child = row.id
    return call
  }

  /** Shows a child the store has, or the change of its run since it was shown. */
  private async see(row: AgyChild, replay: boolean): Promise<void> {
    const running = !row.killed && RUNNING.has(row.status)
    const known = this.known.get(row.id)
    if (known) {
      // 已跟踪的子智能体只要不再处于运行态（无论是 IDLE、killed 还是其他非空终态），都应解除运行标记。
      if (!running && row.status === '' && !row.killed) return
      if (known.running === running || replay) return
      known.running = running
      this.host
        .target(known.parentId)
        ?.apply(subagent(row.id, { state: running ? { kind: 'running' } : stopped(row) }))
      if (running && !known.loaded) await this.open(row, known, true)
      if (!running && !this.running(this.rootOf(row.id))) this.host.settled(this.rootOf(row.id))
      return
    }
    // A child agy has not given a status yet is read again.
    if (!running && row.status !== IDLE) return
    const parent = this.host.target(row.parentId)
    if (!parent) return
    const call = this.startOf(row)
    const runs = running && !replay
    const shown: Known = { parentId: row.parentId, running: runs, loaded: false }
    this.known.set(row.id, shown)
    const agent = row.agent !== '' && row.agent !== SELF ? row.agent : null
    const title = call?.role ?? text(row.title) ?? agent
    // What is not known is left out, so a child Kettu shows from before keeps its name.
    parent.apply(
      subagent(row.id, {
        ...(title !== null ? { title } : {}),
        ...(call?.prompt ? { description: oneLine(call.prompt) } : {}),
        canCancel: false,
        // A child that ran in an earlier process stopped with it.
        state: runs ? { kind: 'running' } : stopped(row, replay && running),
      }),
    )
    const child = this.host.target(row.id)
    if (!child) return
    // A child whose thread Kettu kept, as after its parent was let go, is not replayed into it.
    const kept = child.context().thread.order.length > 0
    if (call?.prompt && !kept) {
      child.apply(instruction(child, call.toolCallId, row.parentId, call.prompt))
    }
    await this.open(row, shown, kept)
  }

  private async open(row: AgyChild, known: Known, quiet: boolean): Promise<void> {
    if (!this.host.target(row.id)) return
    try {
      await this.host.load(row.id, row.parentId, quiet)
      known.loaded = true
    } catch (error) {
      this.host.log('warn', `Could not open agy's sub-agent ${row.id}: ${(error as Error).message}`)
    }
  }
}

function subagent(
  sessionId: string,
  changes: {
    title?: string | null
    description?: string | null
    canCancel?: boolean
    state?: SubagentState
  },
): MapperOutput {
  return { patches: [], effects: [{ kind: 'subagent', sessionId, ...changes }] }
}

function stopped(row: AgyChild, cut = false): SubagentState {
  return {
    kind: 'idle',
    stopReason: row.killed || cut ? 'cancelled' : 'end_turn',
    error: null,
    tokens: null,
  }
}

/** What the parent asked the child to do, at the top of the child's thread. */
function instruction(
  child: SessionTarget,
  toolCallId: string,
  parentId: string,
  prompt: string,
): MapperOutput {
  const ctx = child.context()
  const out: MapperOutput = { patches: [], effects: [] }
  const id = `sm:${toolCallId}`
  if (ctx.thread.byId[id]) return out
  addEntry(ctx, out, {
    kind: 'session_message',
    id,
    senderId: ctx.sessionIdFor(parentId),
    content: [{ type: 'text', text: toLf(prompt) }],
  })
  return out
}
