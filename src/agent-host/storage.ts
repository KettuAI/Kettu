// The host's JSON files: versioned, migrated at load, written atomically and debounced.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AgentAccount, AgentUpdate, PlanLimit } from '@shared/agent-host'
import { GITHUB_PULL_REQUEST_URL, type ProjectWorktreeSettings } from '@shared/git'
import {
  isAgentId,
  isUserContent,
  type AgentId,
  type PromptCache,
  type QueuedPrompt,
  type UserContent,
} from '@shared/thread'
import {
  isPermissionScope,
  isRunTrigger,
  isSchedule,
  isTimeLimit,
  isKeptRunSessions,
  DEFAULT_KEPT_RUN_SESSIONS,
  ROUTINE_ID,
  ROUTINE_NAME_CHARS,
  ROUTINE_OPTION_CHARS,
  ROUTINE_OPTION_LIMIT,
  PROMPT_CHARS,
  type Routine,
  type RoutineRef,
} from '@shared/routines'
import type { AgentInit } from './connection'
import { isVersion } from './versions'

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void

/** Upgrades data of version `n` to version `n + 1`. Pure, so it can be unit-tested. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>

export type MigrationResult =
  | { kind: 'ok'; data: Record<string, unknown>; from: number }
  | { kind: 'newer'; version: number }
  | { kind: 'invalid'; reason: string }

/** Runs the migrations from the file's version up to `current`. */
export function migrate(
  raw: unknown,
  current: number,
  migrations: Readonly<Record<number, Migration>>,
): MigrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'not a JSON object' }
  }
  const version = (raw as { version?: unknown }).version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'invalid', reason: 'missing or invalid version' }
  }
  if (version > current) return { kind: 'newer', version }
  let data = raw as Record<string, unknown>
  for (let v = version; v < current; v++) {
    const step = migrations[v]
    if (!step) return { kind: 'invalid', reason: `no migration from version ${v}` }
    data = { ...step(data), version: v + 1 }
  }
  return { kind: 'ok', data, from: version }
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Writes to `<file>.tmp`, flushes it to disk and renames it over the file. */
export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // On Windows a scanner or indexer can hold the target open for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= 4 || !RETRYABLE.has(code)) {
        await rm(tmp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

export type LoadStatus = 'missing' | 'ok' | 'migrated' | 'corrupt' | 'newer'

export interface JsonFileOptions<T> {
  file: string
  version: number
  migrations: Readonly<Record<number, Migration>>
  /** Returns the parsed data, or an error message when the data is not valid. */
  parse(data: Record<string, unknown>): T | string
  empty(): T
  log: LogFn
  debounceMs?: number
  /** Written without indentation, for a large file that is rewritten often. */
  compact?: boolean
  /** What is written for the data, when the file keeps it in another shape than `parse` gives. */
  serialize?(data: T): unknown
  now?: () => number
}

/** The file name a corrupt file is moved to, safe on every platform. */
export function corruptName(file: string, at: number): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-')
  return `${file}.corrupt-${stamp}.json`
}

export class JsonFile<T> {
  private pending: T | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The writes in turn; each settles to whether it reached the disk. */
  private writing: Promise<boolean> = Promise.resolve(true)
  /** A file from a newer version of the app is never overwritten. */
  readOnly = false
  status: LoadStatus = 'missing'
  backupPath: string | null = null

  constructor(private readonly options: JsonFileOptions<T>) {}

  get file(): string {
    return this.options.file
  }

  async load(): Promise<T> {
    const { file, log } = this.options
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.status = 'missing'
        return this.options.empty()
      }
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return this.recover('it is not valid JSON')
    }
    const migrated = migrate(raw, this.options.version, this.options.migrations)
    if (migrated.kind === 'newer') {
      this.readOnly = true
      this.status = 'newer'
      log(
        'warn',
        `${path.basename(file)} has version ${migrated.version}, newer than this app understands (${this.options.version}); it is left untouched and changes are not saved this run`,
      )
      return this.options.empty()
    }
    if (migrated.kind === 'invalid') return this.recover(migrated.reason)
    const parsed = this.options.parse(migrated.data)
    if (typeof parsed === 'string') return this.recover(parsed)
    this.status = migrated.from === this.options.version ? 'ok' : 'migrated'
    if (this.status === 'migrated') {
      log('info', `Migrated ${path.basename(file)} from version ${migrated.from}`)
      this.save(parsed)
    }
    return parsed
  }

  private async recover(reason: string): Promise<T> {
    const { file, log } = this.options
    const backup = corruptName(file, (this.options.now ?? Date.now)())
    await rename(file, backup)
    this.status = 'corrupt'
    this.backupPath = backup
    log(
      'error',
      `${path.basename(file)} could not be read (${reason}); it was moved to ${path.basename(backup)} and Kettu started from an empty state`,
    )
    return this.options.empty()
  }

  /** Schedules a write; changes within the debounce window share one write. */
  save(data: T): void {
    if (this.readOnly) return
    this.pending = data
    this.timer ??= setTimeout(() => {
      this.timer = null
      void this.writePending()
    }, this.options.debounceMs ?? 500)
  }

  private writePending(): Promise<boolean> {
    const data = this.pending
    if (data === null) return this.writing
    this.pending = null
    const { serialize, compact } = this.options
    const json = JSON.stringify(serialize ? serialize(data) : data, null, compact ? undefined : 2)
    const contents = `${json}\n`
    this.writing = this.writing
      .then(() => writeFileAtomic(this.options.file, contents))
      .then(
        () => true,
        (error: unknown) => {
          this.options.log(
            'error',
            `Could not write ${this.options.file}: ${(error as Error).message}`,
          )
          return false
        },
      )
    return this.writing
  }

  /** Writes what is pending now, and waits for writes in flight. */
  async flush(): Promise<void> {
    await this.flushWritten()
  }

  /** `flush`, resolving to whether the last write reached the disk. */
  flushWritten(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.writePending()
  }
}

// The files and their validators.

export interface ProjectRecord {
  path: string
  name: string
  addedAt: number
  lastOpenedAt: number
  worktree?: Partial<ProjectWorktreeSettings> // only what differs from the defaults
}

/**
 * The worktree Kettu made for a session. `removed`: Kettu removed the folder and kept the branch,
 * or removed both; a record that does not read keeps the session read-only as `branch`.
 */
export interface WorktreeRecord {
  path: string
  branch: string
  base: string
  baseOid: string
  removed?: 'worktree' | 'branch'
  pending?: true // its preparation has not finished, so a restart shows it as failed
}

export interface ProjectsFile {
  version: 1
  projects: ProjectRecord[]
}

/** How many opened pull requests a session keeps; the oldest go first. */
export const MAX_SESSION_PULL_REQUESTS = 20

export interface SessionRecord {
  id: string
  agentId: AgentId
  acpSessionId: string
  projectPath: string
  title: string | null
  titleSource?: 'agent' | 'written' // absent: the cut first line (or none)
  createdAt: number
  updatedAt: number
  lastViewedAt: number | null
  parentId: string | null
  origin: 'user' | 'subagent' | 'routine'
  routine?: RoutineRef // a routine's run, when origin is 'routine'
  description: string | null
  branch: string | null
  queue?: QueuedPrompt[] // prompts that were waiting when it was saved
  ultracode?: boolean // legacy override, read only when migrating an old thread
  customTitle?: string // the user's own title, which wins over the agent's
  cache?: PromptCache // the main thread's prompt cache as its last turn left it, for the sidebar
  model?: string // the model option as its last turn left it, which an estimate of the cache needs
  pinnedAt?: number // when the user pinned it, which orders the Pinned group
  archivedAt?: number // when the user archived it; off the sidebar while set
  startedBy?: string // the session whose agent started it through start_session
  configDir?: string // the configuration folder picked for its agent when it was created
  pullRequests?: string[] // the pull requests it opened, oldest first, by their github.com URL
  /** The agents that had the session before its current one took over, oldest first. */
  earlier?: EarlierAgent[]
  /** A takeover whose first turn has not gone to its agent yet. */
  carry?: PendingCarry
  /** The worktree it works in; absent when it works in its project's folder. */
  worktree?: WorktreeRecord
  /** A worktree its agent made for a subagent, which Kettu shows and never removes. */
  agentWorktree?: { path: string; branch: string | null }
}

/** What a session's new agent is to be given with its first turn, kept until that turn goes. */
export interface PendingCarry {
  /** The takeover entry; the conversation carried is the one before it. */
  entryId: string
  /** The first turn the agent has not seen: 1 for one that never had the session. */
  fromTurn: number
  summarize?: boolean
  /** The values chosen for it, set once its session opens. */
  values?: Record<string, string | boolean>
}

/** An agent that had a session before another took it over, and its own session for it. */
export interface EarlierAgent {
  agentId: AgentId
  /** Its own session id; empty once it no longer resumes, as in a fork. */
  acpSessionId: string
  configDir?: string
  /** The takeover entry that ended its turns, so it has seen every entry before it. */
  endedAt: string
}

export interface SessionsFile {
  version: 1
  sessions: SessionRecord[]
  emptySessionsRemovedAt?: number // when the one-time removal of sessions with no message ran
}

/**
 * What each agent last reported about its account and plan, shown until it reports again, and the
 * capabilities its last `initialize` gave with the version that gave them.
 */
export interface AgentsFile {
  version: 1
  /** `apiKey`: Kettu handed the agent's harness an API key, which only it keeps. */
  agents: Partial<
    Record<
      AgentId,
      { account: AgentAccount | null; limits: PlanLimit[]; init?: RememberedInit; apiKey?: true }
    >
  >
}

export interface RememberedInit {
  version: string
  capabilities: Partial<AgentInit['capabilities']>
}

/**
 * What the last update check found for each package agent: the newest adapter and the CLI it
 * carries. Whether that is an update follows from what is installed, so it is not stored.
 */
export interface AgentUpdatesFile {
  version: 1
  /**
   * `attemptedAt`: when a check last ran, found or failed; `checkedAt` and `latest`: the last one
   * that found something, or null. Files written before `attemptedAt` take `checkedAt` for it.
   */
  agents: Partial<
    Record<
      AgentId,
      {
        checkedAt: number | null
        attemptedAt: number
        latest: AgentUpdate | null
        /** The newest version of the user's own CLI on npm. */
        cli?: string
        /** The update whose notice the user dismissed, until a newer one is found. */
        skipped?: AgentUpdate
        /** The version of the user's CLI whose notice the user dismissed. */
        skippedCli?: string
      }
    >
  >
}

export interface RoutinesFile {
  version: 1
  routines: Routine[]
}

/** Reads a routine, or null when a field is missing or out of range. */
function routineOf(value: unknown): Routine | null {
  if (!isRecord(value)) return null
  const id = value.id
  const name = value.name
  const prompt = value.prompt
  const agentId = value.agentId
  const keptRunSessions =
    value.keptRunSessions === undefined ? DEFAULT_KEPT_RUN_SESSIONS : value.keptRunSessions
  if (
    typeof id !== 'string' ||
    !ROUTINE_ID.test(id) ||
    typeof name !== 'string' ||
    name.length > ROUTINE_NAME_CHARS ||
    typeof prompt !== 'string' ||
    prompt.length === 0 ||
    prompt.length > PROMPT_CHARS ||
    !isAgentId(agentId) ||
    !(value.projectPath === null || typeof value.projectPath === 'string') ||
    !Array.isArray(value.options) ||
    value.options.length > ROUTINE_OPTION_LIMIT ||
    !isRecord(value.trigger) ||
    value.trigger.kind !== 'schedule' ||
    !isSchedule(value.trigger.schedule) ||
    !isPermissionScope(value.scope) ||
    !isTimeLimit(value.timeLimitMinutes) ||
    !isKeptRunSessions(keptRunSessions) ||
    typeof value.enabled !== 'boolean' ||
    !isTime(value.createdAt) ||
    !isTime(value.updatedAt) ||
    !isTime(value.checkedThrough)
  ) {
    return null
  }
  const options: Routine['options'] = []
  for (const option of value.options) {
    if (
      !isRecord(option) ||
      typeof option.id !== 'string' ||
      option.id.length === 0 ||
      option.id.length > ROUTINE_OPTION_CHARS ||
      !(
        typeof option.value === 'boolean' ||
        (typeof option.value === 'string' && option.value.length <= ROUTINE_OPTION_CHARS)
      )
    ) {
      return null
    }
    options.push({ id: option.id, value: option.value })
  }
  return {
    id,
    name,
    prompt,
    agentId: agentId as Routine['agentId'],
    projectPath: value.projectPath as string | null,
    options,
    trigger: { kind: 'schedule', schedule: value.trigger.schedule },
    scope: value.scope,
    timeLimitMinutes: value.timeLimitMinutes,
    keptRunSessions,
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    checkedThrough: value.checkedThrough,
  }
}

/** A routine that does not parse fails the file, which is then moved aside. */
export function parseRoutinesFile(data: Record<string, unknown>): RoutinesFile | string {
  if (!Array.isArray(data.routines)) return 'routines is not a list'
  const routines: Routine[] = []
  for (const [index, item] of data.routines.entries()) {
    const routine = routineOf(item)
    if (!routine) return `routine ${index} is malformed`
    routines.push(routine)
  }
  return { version: 1, routines }
}

/** Messages no session took, kept for a window to take back; `sessionId` is null for New session. */
export interface ReturnedFile {
  version: 1
  messages: { sessionId: string | null; content: UserContent[]; at: number }[]
}

/** Agent processes, and what they left behind, not yet seen gone; the next host stops them. */
export interface AgentProcessesFile {
  version: 1
  /** `seenAt`: when each was last known to run. */
  processes: { pid: number; startedAt: number; seenAt?: number }[]
}

/**
 * The user's answers about the MCP servers each folder declares itself, by the folder's path key:
 * the servers they let start (`all`: every one, later ones too) and those they refused.
 */
export interface ProjectMcpFile {
  version: 1
  folders: Record<string, { all?: true; use: string[]; skip: string[] }>
}

export const PROJECTS_VERSION = 1
export const SESSIONS_VERSION = 1
export const AGENTS_VERSION = 1
export const RETURNED_VERSION = 1
export const PROJECT_MCP_VERSION = 1
export const AGENT_PROCESSES_VERSION = 1
export const AGENT_UPDATES_VERSION = 1
export const ROUTINES_VERSION = 1
// No older formats exist yet; each future version adds its step here, with a test.
export const ROUTINES_MIGRATIONS: Readonly<Record<number, Migration>> = {}
export const PROJECTS_MIGRATIONS: Readonly<Record<number, Migration>> = {}
export const SESSIONS_MIGRATIONS: Readonly<Record<number, Migration>> = {}
export const AGENTS_MIGRATIONS: Readonly<Record<number, Migration>> = {}
export const RETURNED_MIGRATIONS: Readonly<Record<number, Migration>> = {}
export const PROJECT_MCP_MIGRATIONS: Readonly<Record<number, Migration>> = {}
export const AGENT_PROCESSES_MIGRATIONS: Readonly<Record<number, Migration>> = {}
export const AGENT_UPDATES_MIGRATIONS: Readonly<Record<number, Migration>> = {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const isNullable =
  <V>(guard: (value: unknown) => value is V) =>
  (value: unknown): value is V | null =>
    value === null || guard(value)

export function parseProjectsFile(data: Record<string, unknown>): ProjectsFile | string {
  if (!Array.isArray(data.projects)) return 'projects is not a list'
  const projects: ProjectRecord[] = []
  for (const [index, item] of data.projects.entries()) {
    if (
      !isRecord(item) ||
      !isString(item.path) ||
      !isString(item.name) ||
      !isTime(item.addedAt) ||
      !isTime(item.lastOpenedAt)
    ) {
      return `project ${index} is malformed`
    }
    projects.push({
      path: item.path,
      name: item.name,
      addedAt: item.addedAt,
      lastOpenedAt: item.lastOpenedAt,
      ...projectWorktreeOf(item.worktree),
    })
  }
  return { version: 1, projects }
}

// A queue that does not parse is dropped rather than failing the whole index.
function queueOf(value: unknown): { queue?: QueuedPrompt[] } {
  if (!Array.isArray(value)) return {}
  const queue = value.filter(
    (item): item is QueuedPrompt =>
      isRecord(item) &&
      isString(item.id) &&
      isTime(item.at) &&
      Array.isArray(item.content) &&
      item.content.every(
        (c) =>
          isRecord(c) &&
          ((c.type === 'text' && isString(c.text)) || (c.type === 'ref' && isRecord(c.ref))),
      ),
  )
  return queue.length > 0 ? { queue: queue.map(withFrom) } : {}
}

/** A queued prompt another session's agent sent keeps whose it is, for its label. */
function withFrom(item: QueuedPrompt): QueuedPrompt {
  const { from, ...rest } = item as QueuedPrompt & { from?: unknown }
  return isRecord(from) && isString(from.sessionId) && isString(from.title)
    ? { ...rest, from: { sessionId: from.sessionId, title: from.title } }
    : rest
}

function cacheOf(value: unknown): { cache?: PromptCache } {
  if (!isRecord(value) || !isTime(value.lastRequestAt) || !isNullable(isTime)(value.ttl)) return {}
  return { cache: { lastRequestAt: value.lastRequestAt, ttl: value.ttl } }
}

function routineRefOf(value: unknown): { routine?: RoutineRef } {
  if (
    !isRecord(value) ||
    !isString(value.routineId) ||
    !isString(value.runId) ||
    !isRunTrigger(value.trigger) ||
    !isNullable(isTime)(value.scheduledFor)
  ) {
    return {}
  }
  return {
    routine: {
      routineId: value.routineId,
      runId: value.runId,
      trigger: value.trigger,
      scheduledFor: value.scheduledFor,
    },
  }
}

/** The earlier agents a session lists; one that does not read is dropped, not the session. */
function earlierOf(value: unknown): { earlier?: EarlierAgent[] } {
  if (!Array.isArray(value)) return {}
  const earlier = value.flatMap((item): EarlierAgent[] =>
    isRecord(item) &&
    isAgentId(item.agentId) &&
    isString(item.acpSessionId) &&
    isString(item.endedAt) &&
    item.endedAt !== ''
      ? [
          {
            agentId: item.agentId as AgentId,
            acpSessionId: item.acpSessionId,
            ...(isString(item.configDir) && item.configDir !== ''
              ? { configDir: item.configDir }
              : {}),
            endedAt: item.endedAt,
          },
        ]
      : [],
  )
  return earlier.length > 0 ? { earlier } : {}
}

function carryOf(value: unknown): { carry?: PendingCarry } {
  if (
    !isRecord(value) ||
    !isString(value.entryId) ||
    value.entryId === '' ||
    typeof value.fromTurn !== 'number' ||
    !Number.isInteger(value.fromTurn) ||
    value.fromTurn < 1
  ) {
    return {}
  }
  const values = isRecord(value.values)
    ? Object.fromEntries(
        Object.entries(value.values).filter(
          (entry): entry is [string, string | boolean] =>
            typeof entry[1] === 'string' || typeof entry[1] === 'boolean',
        ),
      )
    : null
  return {
    carry: {
      entryId: value.entryId,
      fromTurn: value.fromTurn,
      ...(value.summarize === true ? { summarize: true } : {}),
      ...(values && Object.keys(values).length > 0 ? { values } : {}),
    },
  }
}

export const MAX_WORKTREE_COPY_PATHS = 100
const MAX_BRANCH_TEMPLATE = 200
const MAX_SETUP_COMMAND = 8192
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** A project's worktree settings, key by key; one that does not read is dropped alone. */
function projectWorktreeOf(value: unknown): { worktree?: Partial<ProjectWorktreeSettings> } {
  if (!isRecord(value)) return {}
  const worktree: Partial<ProjectWorktreeSettings> = {}
  const { branchTemplate, copy, setup, waitForSetup } = value
  if (isString(branchTemplate) && branchTemplate.length <= MAX_BRANCH_TEMPLATE) {
    worktree.branchTemplate = branchTemplate
  }
  if (Array.isArray(copy)) {
    worktree.copy = copy
      .filter((item): item is string => isString(item) && item !== '' && item.length <= 1024)
      .slice(0, MAX_WORKTREE_COPY_PATHS)
  }
  if (setup === null || (isString(setup) && setup.length <= MAX_SETUP_COMMAND)) {
    worktree.setup = setup
  }
  if (typeof waitForSetup === 'boolean') worktree.waitForSetup = waitForSetup
  return Object.keys(worktree).length > 0 ? { worktree } : {}
}

// A worktree that does not read must never let the session fall back to its project's folder.
const UNREADABLE_WORKTREE: WorktreeRecord = {
  path: '',
  branch: '',
  base: '',
  baseOid: '',
  removed: 'branch',
}

function worktreeOf(value: unknown): { worktree?: WorktreeRecord } {
  if (value === undefined) return {}
  if (
    !isRecord(value) ||
    !isString(value.path) ||
    value.path === '' ||
    !isString(value.branch) ||
    value.branch === '' ||
    !isString(value.base) ||
    !isString(value.baseOid) ||
    !OBJECT_ID.test(value.baseOid) ||
    (value.removed !== undefined && value.removed !== 'worktree' && value.removed !== 'branch')
  ) {
    return { worktree: { ...UNREADABLE_WORKTREE } }
  }
  return {
    worktree: {
      path: value.path,
      branch: value.branch,
      base: value.base,
      baseOid: value.baseOid,
      ...(value.removed === undefined ? {} : { removed: value.removed }),
      ...(value.pending === true ? { pending: true as const } : {}),
    },
  }
}

function agentWorktreeOf(value: unknown): { agentWorktree?: SessionRecord['agentWorktree'] } {
  if (!isRecord(value) || !isString(value.path) || value.path === '') return {}
  return {
    agentWorktree: {
      path: value.path,
      branch: isString(value.branch) && value.branch !== '' ? value.branch : null,
    },
  }
}

export function parseSessionsFile(data: Record<string, unknown>): SessionsFile | string {
  if (!Array.isArray(data.sessions)) return 'sessions is not a list'
  const sessions: SessionRecord[] = []
  const nullableString = isNullable(isString)
  for (const [index, item] of data.sessions.entries()) {
    if (
      !isRecord(item) ||
      !isString(item.id) ||
      !isAgentId(item.agentId) ||
      !isString(item.acpSessionId) ||
      !isString(item.projectPath) ||
      !nullableString(item.title) ||
      !isTime(item.createdAt) ||
      !isTime(item.updatedAt) ||
      !isNullable(isTime)(item.lastViewedAt) ||
      !nullableString(item.parentId) ||
      (item.origin !== 'user' && item.origin !== 'subagent' && item.origin !== 'routine') ||
      !nullableString(item.description) ||
      !nullableString(item.branch)
    ) {
      return `session ${index} is malformed`
    }
    sessions.push({
      id: item.id,
      agentId: item.agentId as AgentId,
      acpSessionId: item.acpSessionId,
      projectPath: item.projectPath,
      title: item.title,
      ...(item.titleSource === 'agent' || item.titleSource === 'written'
        ? { titleSource: item.titleSource }
        : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastViewedAt: item.lastViewedAt,
      parentId: item.parentId,
      origin: item.origin,
      ...routineRefOf(item.routine),
      description: item.description,
      branch: item.branch,
      ...queueOf(item.queue),
      ...(typeof item.ultracode === 'boolean' ? { ultracode: item.ultracode } : {}),
      ...(isString(item.customTitle) ? { customTitle: item.customTitle } : {}),
      ...cacheOf(item.cache),
      ...(isString(item.model) ? { model: item.model } : {}),
      ...(isTime(item.pinnedAt) ? { pinnedAt: item.pinnedAt } : {}),
      ...(isTime(item.archivedAt) ? { archivedAt: item.archivedAt } : {}),
      ...(isString(item.startedBy) ? { startedBy: item.startedBy } : {}),
      ...(isString(item.configDir) && item.configDir !== '' ? { configDir: item.configDir } : {}),
      ...pullRequestsOf(item.pullRequests),
      ...earlierOf(item.earlier),
      ...carryOf(item.carry),
      ...worktreeOf(item.worktree),
      ...agentWorktreeOf(item.agentWorktree),
    })
  }
  return {
    version: 1,
    sessions,
    ...(isTime(data.emptySessionsRemovedAt)
      ? { emptySessionsRemovedAt: data.emptySessionsRemovedAt }
      : {}),
  }
}

// A message whose content does not parse is dropped rather than failing the whole file.
export function parseProjectMcpFile(data: Record<string, unknown>): ProjectMcpFile | string {
  if (!isRecord(data.folders)) return 'folders is not an object'
  const folders: ProjectMcpFile['folders'] = {}
  for (const [folder, value] of Object.entries(data.folders)) {
    if (!isRecord(value)) continue
    folders[folder] = {
      ...(value.all === true ? { all: true as const } : {}),
      use: Array.isArray(value.use) ? value.use.filter(isString) : [],
      skip: Array.isArray(value.skip) ? value.skip.filter(isString) : [],
    }
  }
  return { version: 1, folders }
}

export function parseReturnedFile(data: Record<string, unknown>): ReturnedFile | string {
  if (!Array.isArray(data.messages)) return 'messages is not a list'
  const nullableString = isNullable(isString)
  const messages = data.messages.filter(
    (item): item is ReturnedFile['messages'][number] =>
      isRecord(item) &&
      nullableString(item.sessionId) &&
      isTime(item.at) &&
      Array.isArray(item.content) &&
      item.content.every(isUserContent),
  )
  return { version: 1, messages }
}

// Not 'none': whether a signed-out agent is still signed out is known only once it runs.
const ACCOUNT_KINDS: ReadonlySet<unknown> = new Set(['account', 'api_key', 'external', 'gateway'])
const LIMIT_STATES: ReadonlySet<unknown> = new Set(['ok', 'warning', 'reached'])
const isNullableNumber = isNullable(
  (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value),
)

function accountOf(value: unknown): AgentAccount | null {
  if (!isRecord(value) || !ACCOUNT_KINDS.has(value.kind) || !isString(value.label)) return null
  return {
    kind: value.kind as AgentAccount['kind'],
    label: value.label,
    email: isString(value.email) ? value.email : null,
    ...(isString(value.tier) ? { tier: value.tier } : {}),
  }
}

function limitOf(value: unknown): PlanLimit | null {
  if (
    !isRecord(value) ||
    !isString(value.window) ||
    !isString(value.label) ||
    !isNullableNumber(value.usedPercent) ||
    !isNullableNumber(value.resetsAt) ||
    !LIMIT_STATES.has(value.state) ||
    !isTime(value.observedAt)
  ) {
    return null
  }
  return {
    window: value.window,
    label: value.label,
    usedPercent: value.usedPercent,
    resetsAt: value.resetsAt,
    state: value.state as PlanLimit['state'],
    observedAt: value.observedAt,
  }
}

// A cache of what the agents report: an entry that does not parse is dropped, not the file.
export function parseAgentsFile(data: Record<string, unknown>): AgentsFile | string {
  if (!isRecord(data.agents)) return 'agents is not an object'
  const agents: AgentsFile['agents'] = {}
  for (const id of Object.keys(data.agents).filter(isAgentId)) {
    const entry = data.agents[id]
    if (!isRecord(entry)) continue
    const limits = Array.isArray(entry.limits)
      ? entry.limits.map(limitOf).filter((l): l is PlanLimit => l !== null)
      : []
    const account = accountOf(entry.account)
    const init = initOf(entry.init)
    const apiKey = entry.apiKey === true
    if (account || limits.length > 0 || init || apiKey) {
      agents[id] = { account, limits, ...(init ? { init } : {}), ...(apiKey ? { apiKey } : {}) }
    }
  }
  return { version: 1, agents }
}

function initOf(value: unknown): RememberedInit | null {
  if (!isRecord(value) || !isVersion(value.version) || !isRecord(value.capabilities)) return null
  const capabilities: RememberedInit['capabilities'] = Object.fromEntries(
    Object.entries(value.capabilities).filter(([, on]) => typeof on === 'boolean'),
  )
  const prompt = value.capabilities.prompt
  if (
    isRecord(prompt) &&
    typeof prompt.image === 'boolean' &&
    typeof prompt.audio === 'boolean' &&
    typeof prompt.embeddedContext === 'boolean'
  ) {
    capabilities.prompt = {
      image: prompt.image,
      audio: prompt.audio,
      embeddedContext: prompt.embeddedContext,
    }
  }
  return { version: value.version, capabilities }
}

// A cache of the registry's answers: an entry that does not parse is dropped, not the file. Only
// versions pass, since an update's version names its install directory.
export function parseAgentUpdatesFile(data: Record<string, unknown>): AgentUpdatesFile | string {
  if (!isRecord(data.agents)) return 'agents is not an object'
  const agents: AgentUpdatesFile['agents'] = {}
  for (const id of Object.keys(data.agents).filter(isAgentId)) {
    const entry = data.agents[id]
    if (!isRecord(entry)) continue
    const latest = isRecord(entry.latest) ? entry.latest : null
    const found =
      latest &&
      isTime(entry.checkedAt) &&
      isVersion(latest.adapterVersion) &&
      (latest.cliVersion === null || isVersion(latest.cliVersion))
        ? { adapterVersion: latest.adapterVersion, cliVersion: latest.cliVersion }
        : null
    const checkedAt = found && isTime(entry.checkedAt) ? entry.checkedAt : null
    const attemptedAt = isTime(entry.attemptedAt) ? entry.attemptedAt : checkedAt
    const skippedEntry = isRecord(entry.skipped) ? entry.skipped : null
    const skipped =
      skippedEntry &&
      isVersion(skippedEntry.adapterVersion) &&
      (skippedEntry.cliVersion === null || isVersion(skippedEntry.cliVersion))
        ? {
            adapterVersion: skippedEntry.adapterVersion,
            cliVersion: skippedEntry.cliVersion,
          }
        : null
    if (attemptedAt === null) continue
    const cli = isVersion(entry.cli) ? entry.cli : null
    const skippedCli = isVersion(entry.skippedCli) ? entry.skippedCli : null
    agents[id] = {
      checkedAt,
      attemptedAt,
      latest: found,
      ...(cli ? { cli } : {}),
      ...(skipped ? { skipped } : {}),
      ...(skippedCli ? { skippedCli } : {}),
    }
  }
  return { version: 1, agents }
}

const MAX_AGENT_PROCESSES = 10_000

export function parseAgentProcessesFile(
  data: Record<string, unknown>,
): AgentProcessesFile | string {
  if (!Array.isArray(data.processes)) return 'processes is not a list'
  const processes: AgentProcessesFile['processes'] = []
  for (const entry of data.processes.slice(0, MAX_AGENT_PROCESSES)) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.pid) || (entry.pid as number) <= 1) continue
    if (typeof entry.startedAt !== 'number' || !Number.isFinite(entry.startedAt)) continue
    const { pid, startedAt, seenAt } = entry as { pid: number; startedAt: number; seenAt?: unknown }
    processes.push(
      typeof seenAt === 'number' && Number.isFinite(seenAt)
        ? { pid, startedAt, seenAt }
        : { pid, startedAt },
    )
  }
  return { version: 1, processes }
}

export function projectsFile(userDataPath: string, log: LogFn): JsonFile<ProjectsFile> {
  return new JsonFile<ProjectsFile>({
    file: path.join(userDataPath, 'state', 'projects.json'),
    version: PROJECTS_VERSION,
    migrations: PROJECTS_MIGRATIONS,
    parse: parseProjectsFile,
    empty: () => ({ version: 1, projects: [] }),
    log,
  })
}

/** A session's opened pull requests; an address that is not one is dropped, as are repeats. */
function pullRequestsOf(value: unknown): { pullRequests?: string[] } {
  if (!Array.isArray(value)) return {}
  const urls = [
    ...new Set(
      value.filter((url): url is string => isString(url) && GITHUB_PULL_REQUEST_URL.test(url)),
    ),
  ].slice(-MAX_SESSION_PULL_REQUESTS)
  return urls.length > 0 ? { pullRequests: urls } : {}
}

export function sessionsFile(userDataPath: string, log: LogFn): JsonFile<SessionsFile> {
  return new JsonFile<SessionsFile>({
    file: path.join(userDataPath, 'state', 'sessions.json'),
    version: SESSIONS_VERSION,
    migrations: SESSIONS_MIGRATIONS,
    parse: parseSessionsFile,
    empty: () => ({ version: 1, sessions: [] }),
    log,
    // Every change of any session rewrites the whole index: the changes of 2 s share one write.
    debounceMs: 2_000,
    compact: true,
  })
}

export function returnedFile(userDataPath: string, log: LogFn): JsonFile<ReturnedFile> {
  return new JsonFile<ReturnedFile>({
    file: path.join(userDataPath, 'state', 'returned.json'),
    version: RETURNED_VERSION,
    migrations: RETURNED_MIGRATIONS,
    parse: parseReturnedFile,
    empty: () => ({ version: 1, messages: [] }),
    log,
    // Written at once: a quit right after the message was kept must not lose it.
    debounceMs: 0,
  })
}

export function projectMcpFile(userDataPath: string, log: LogFn): JsonFile<ProjectMcpFile> {
  return new JsonFile<ProjectMcpFile>({
    file: path.join(userDataPath, 'state', 'project-mcp.json'),
    version: PROJECT_MCP_VERSION,
    migrations: PROJECT_MCP_MIGRATIONS,
    parse: parseProjectMcpFile,
    empty: () => ({ version: 1, folders: {} }),
    log,
    // Written at once: a refusal lost to a quit would start the server next time.
    debounceMs: 0,
  })
}

export function agentsFile(userDataPath: string, log: LogFn): JsonFile<AgentsFile> {
  return new JsonFile<AgentsFile>({
    file: path.join(userDataPath, 'state', 'agents.json'),
    version: AGENTS_VERSION,
    migrations: AGENTS_MIGRATIONS,
    parse: parseAgentsFile,
    empty: () => ({ version: 1, agents: {} }),
    log,
  })
}

export function agentProcessesFile(userDataPath: string, log: LogFn): JsonFile<AgentProcessesFile> {
  return new JsonFile<AgentProcessesFile>({
    file: path.join(userDataPath, 'state', 'agent-processes.json'),
    version: AGENT_PROCESSES_VERSION,
    migrations: AGENT_PROCESSES_MIGRATIONS,
    parse: parseAgentProcessesFile,
    empty: () => ({ version: 1, processes: [] }),
    log,
    // Written at once: a launch the file misses is a process no later host can stop.
    debounceMs: 0,
  })
}

export function routinesFile(userDataPath: string, log: LogFn): JsonFile<RoutinesFile> {
  return new JsonFile<RoutinesFile>({
    file: path.join(userDataPath, 'state', 'routines.json'),
    version: ROUTINES_VERSION,
    migrations: ROUTINES_MIGRATIONS,
    parse: parseRoutinesFile,
    empty: () => ({ version: 1, routines: [] }),
    log,
  })
}

export function agentUpdatesFile(userDataPath: string, log: LogFn): JsonFile<AgentUpdatesFile> {
  return new JsonFile<AgentUpdatesFile>({
    file: path.join(userDataPath, 'state', 'agent-updates.json'),
    version: AGENT_UPDATES_VERSION,
    migrations: AGENT_UPDATES_MIGRATIONS,
    parse: parseAgentUpdatesFile,
    empty: () => ({ version: 1, agents: {} }),
    log,
  })
}
