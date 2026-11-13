// Live sessions: the authoritative thread state, prompts, permissions, cancellation, the
// session lifecycle, sub-sessions, and the session index.

import type { DeviceAccessAnswer, DeviceAccessDecision } from '@shared/device-agent'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALREADY_ANSWERED,
  REMOVED_WHILE_STARTING,
  type AttachmentBytes,
  type ContextBreakdown,
  type ImportableSession,
  type OutlineEntry,
  type OutlineTitle,
  type ReturnedMessage,
  type SessionAttention,
  type SessionPullRequest,
  type SessionSummary,
  type StartNotice,
} from '@shared/agent-host'
import { LOCALES } from '@shared/locale'
import { PROMPT_BYTES, promptShare } from '@shared/attachments'
import { CONTEXT_REFRESH_MS } from '@shared/context'
import { firstLine, outlineText } from '@shared/outline'
import { originLabel, type BrowserOriginAnswer, type BrowserOriginDecision } from '@shared/browser'
import type {
  ComputerApp,
  ComputerAppAnswer,
  ComputerAppDecision,
  ComputerSetupOutcome,
  ComputerSetupStep,
} from '@shared/computer-use'
import type { AttentionRequest, BusyCounts, BusySession } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { PortDevice } from '@shared/remote/device'
import type { PermissionScope } from '@shared/routines'
import type { HostSettings } from '@shared/settings'
import {
  applyPatchInPlace,
  coalescePatches,
  entryMessageId,
  harnessOf,
  retryableTurn,
  threadEntries,
  threadFromSnapshot,
  UnknownEntryError,
  type AgentId,
  type ConfigOption,
  type FormValues,
  type FromDevice,
  type FromSession,
  type OlderPage,
  type Patch,
  type PatchBatch,
  type PendingElicitation,
  type PendingQuestion,
  type PermissionOption,
  type PlanEntry,
  type ProblemReportEntry,
  type ProblemReportOutcome,
  type PlanItem,
  type QuestionAnswer,
  type SessionSnapshot,
  type SessionStatus,
  type SessionView,
  type StopReason,
  type Attachment,
  type BrowserOriginEntry,
  type DeviceAccessEntry,
  type ComputerAppEntry,
  type ComputerSetupEntry,
  type ComputerUseView,
  type DeclaredMcpServer,
  type ProjectMcpDecision,
  type ProjectMcpEntry,
  type ThreadEntry,
  type ThreadState,
  type TokenTotals,
  type ToolEntry,
  type UserContent,
} from '@shared/thread'
import {
  agentEntryBefore,
  gitPatch,
  ReplayKeeper,
  startedPatch,
  writePatch,
  type ArtifactWrite,
} from './artifacts/entries'
import { allowOnceOption, changedFiles, replySummary, requestText } from './attention'
import { parseContextReport } from './acp/claude-reports'
import {
  isValueOf,
  startModeIn,
  startOrder,
  type AgentOptionsStore,
  type ReplacedValue,
} from './agent-options'
import {
  blockBytes,
  embedFile,
  linkBlock,
  pastedTextBlock,
  resolvePath,
  sendAttachment,
  toArrayBuffer,
  type Attachments,
} from './attachments'
import { agentError, type AgentManager, type AgentRuntime } from './agents'
import { OPTION_IDS as CLAUDE_OPTION_IDS } from './claude/config'
import { MODE_ID as CODEX_MODE_ID } from './codex/config'
import { CONFIG as DSH_CONFIG } from './dsh/options'
import { carryMode, lostValues, lostValuesNotice, type LostValue } from './config-notice'
import {
  AgentRequestError,
  promptBlocks,
  type AgentConnection,
  type ForkPoint,
  type McpServer,
  type ModelTokens,
  type PermissionAnswer,
  type PermissionRequest,
  type ProjectMcpGate,
  type PromptBlock,
  type SessionOptions,
  type SessionTarget,
} from './connection'
import type { Diagnostics } from './diagnostics'
import { answeredFields, checkedValues } from './elicitation'
import { holdsNothing, mayBeEmpty } from './empty-sessions'
import type { McpTransports } from './marketplace/servers'
import { questionsResult } from './question-answers'
import { HostError, invalidParams, notFound } from './errors'
import { t } from './i18n'
import {
  GITHUB_PULL_REQUEST_URL,
  githubReferenceOf,
  type SessionWorktree,
  type WorktreeFailure,
} from '@shared/git'
import type { GitEventDraft, GitServiceApi } from './git/api'
import { canonicalizePath, isInside, pathKey, samePath } from './paths'
import type { ProjectMcpAnswers } from './project-mcp'
import { REPORTS_PER_DAY, type ReportDraft } from './report-tool'
import { isOutOfCredit } from './out-of-credit'
import { planRevision } from './plan-revision'
import { watchSettings, type PreparedRecords, type WatchTarget } from './prepared'
import type { Projects } from './projects'
import type { CacheTtlReader } from './prompt-cache'
import { cutReply, type ToolSession } from './session-tools'
import type { RoutineSessionHooksRef, RoutineSessionStart } from './routines/hooks'
import { scopeAnswer } from './routines/scope'
import { CONTEXT_REPORT, runReport } from './reports'
import type { ScratchFolders } from './scratch'
import type { WorktreeInspection } from './worktrees/api'
import type { PrepareState, SetupLog, WorktreeManager } from './worktrees/manager'
import {
  carriedContext,
  threadTurns,
  type CarriedContext,
  type RenderedTurn,
} from './carried-context'
import {
  MAX_SESSION_PULL_REQUESTS,
  type EarlierAgent,
  type JsonFile,
  type PendingCarry,
  type ReturnedFile,
  type SessionRecord,
  type SessionsFile,
  type WorktreeRecord,
} from './storage'
import { SUMMARY_RETRY_MS, writeTitles } from './outline-titles'
import { listedTitle, titleMessageText, writeSessionTitle } from './session-titles'
import {
  addTokenTotals,
  firstUserMessage,
  isStopReason,
  mergeConfig,
  newTurnScope,
  SYNTHETIC_MODE_ID,
  type MapperEffect,
  type MapperOutput,
  type SubagentState,
  type TurnScope,
} from './session-updates'
import {
  changesStored,
  imageBlobs,
  opensTurn,
  pageStart,
  settled,
  splitLinks,
  storedBlobs,
  storedSession,
  withImageBytes,
  type ImageMode,
  type OutlineRow,
  type PositionedEntry,
  type StoredBlob,
  type StoredOutline,
  type StoredThread,
  type ThreadPage,
  type ThreadWrite,
} from './threads/model'
import { ThreadStoreError, type ThreadStore } from './threads/store'
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
  /** An agent that lists its titles is read once more this long after the first turn's end. */
  listedTitleRetryMs: number
  /** The free direct context reader's polling interval and activity coalescing window. */
  contextRefreshMs: number
  contextDebounceMs: number
}

/** The longest a thread's write waits after writes that failed. */
const MAX_RETRY_MS = 5 * 60_000

export const SESSION_TIMINGS: SessionTimings = {
  flushMs: 16,
  cancelFallbackMs: 10_000,
  checkpointMs: 5_000,
  releaseHiddenMs: 60_000,
  releaseShownMs: 30 * 60_000,
  releaseUnusedMs: 60_000,
  cacheReadMs: 1_000,
  settingsDelayMs: 500,
  listedTitleRetryMs: 10_000,
  contextRefreshMs: CONTEXT_REFRESH_MS,
  contextDebounceMs: 500,
}

export interface SessionEvents {
  patches(batch: PatchBatch, portIds: readonly string[]): void
  /** To every port, or to `portIds` alone for a prepared session. */
  summary(summary: SessionSummary, portIds?: readonly string[]): void
  removed(sessionId: string, portIds?: readonly string[]): void
  /** Sessions archived or deleted: what belongs to them outside this host, their terminals, ends. */
  ended(sessionIds: string[]): void
  /**
   * A message waits in the host for a window to take back; null for New session. To every port,
   * or to `portIds` alone, the one that sent it.
   */
  returned(sessionId: string | null, portIds?: readonly string[]): void
  /** Who shows the session in front changed, or a port began to watch it: `showing` are their ports. */
  viewers(sessionId: string, showing: readonly string[], to: readonly string[]): void
  /** `request`: what waits, for a permission, with the answers a notification may give itself. */
  attention(
    sessionId: string,
    kind: 'permission' | 'turn-ended' | 'error',
    title: string,
    body: string,
    request?: AttentionRequest,
  ): void
  badge(count: number): void
  /** What waits for the user now, by session, each change of it. */
  waiting(sessions: Record<string, string[]>): void
  /** The session was shown or marked read, so its turn was seen. */
  seen(sessionId: string): void
  busy(counts: BusyCounts): void
}

/** The artifacts service and the Marketplace's servers, as the sessions pass them to their agents. */
export interface SessionMcp {
  /** What an attach of the session through `connection` passes in `mcpServers`. */
  servers(sessionId: string, record: SessionRecord, connection: AgentConnection): McpServer[]
  /**
   * The Marketplace's servers an attach of the agent's session passes beside those, over the
   * transports it speaks, renamed where `taken` already has a name.
   */
  library(
    sessionId: string,
    record: SessionRecord,
    connection: AgentConnection,
    transports: McpTransports,
    taken: readonly string[],
  ): McpServer[]
  /** The session left memory, closed, released or deleted: its token ends. */
  detached(sessionId: string): void
  turnEnded(sessionId: string): void
}

export interface SessionManagerDeps {
  platform: Platform
  agents: AgentManager
  projects: Projects
  scratch: ScratchFolders
  /** Makes and prepares sessions' worktrees; without it no session gets one. */
  worktrees?: WorktreeManager
  file: JsonFile<SessionsFile>
  /** Messages no session took, kept until a window takes them back. */
  returned: JsonFile<ReturnedFile>
  /** The user's answers about each folder's own MCP servers; without them none start. */
  projectMcp?: ProjectMcpAnswers
  /** Whether a port is still open, so a failed start knows whether its window can take its message. */
  portOpen(portId: string): boolean
  /** The paired device an open port serves, null for a window's; without it every port is one. */
  portDevice?(portId: string): PortDevice | null
  /** Where threads are stored; without it every session opens through its agent. */
  threads: ThreadStore | null
  /** The empty folder the hidden sessions for the outline's titles run in. */
  reportsDir: string
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
  /** The Marketplace's skills an attach of the agent's session passes; without it none. */
  skills?: (agentId: AgentId) => Pick<SessionOptions, 'skillRoots' | 'localPlugins'>
  /** The prepared sessions not yet adopted or removed, kept for the host after a crash. */
  prepared?: PreparedRecords
  /** What to watch for changes to the agent's options in a folder; without it nothing is. */
  settingsTargets?: (agentId: AgentId, folder: string) => WatchTarget[]
  /** The host's settings, read as a turn starts for whether a title is to be written. */
  settings: () => HostSettings
  /** What a routine's run hears of its session; set once the routines manager exists. */
  routine?: RoutineSessionHooksRef
  timings?: Partial<SessionTimings>
  now?: () => number
}

type Failure =
  | { action: 'create' }
  | { action: 'load' }
  | { action: 'resume' }
  | { action: 'prompt'; content: UserContent[]; entryId: string | null }

/** The port that sent a turn and the paired device it served then, null for a window's. */
export interface TurnSender {
  portId: string
  device: PortDevice | null
}

interface Turn {
  startedAt: number
  /** As the user wrote it, with the attachments as their records show them. */
  content: UserContent[]
  /** The message as it came in, given back when the turn fails before the agent added anything. */
  written: UserContent[]
  /** The records the prompt was sent with, released as the turn ends unless it is given back. */
  attachments: string[]
  /** The user entry the turn started with, which shows how its attachments went. */
  entryId: string | null
  /** The window or device that sent the message, which a failed turn gives it back to. */
  portId: string | null
  ended: boolean
  cancelRequested: boolean
  fallback: ReturnType<typeof setTimeout> | null
  /** The agent reported a request of the session's thread during the turn. */
  requested: boolean
  /** The agent started it between the host's turns, with no message, and says when it ends. */
  byAgent: boolean
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
  options: PermissionOption[]
  questions?: PendingQuestion[]
  /** A plan to approve, whose answer names the mode it builds in. */
  plan: boolean
  elicitation?: PendingElicitation
  /** Raised while no turn ran, as a plan Codex proposes once its turn has ended. */
  outsideTurn: boolean
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
  /** Who answered the latest requests, by request id: a device, or null for a window. */
  answered: Map<string, FromDevice | null>
  /** Each waiting new origin's entry, by `originKey`. */
  origins: Map<string, string>
  /** Who answered the latest new origins, by entry id: a device, or null for a window. */
  originsAnswered: Map<string, FromDevice | null>
  /** Each first use of an app that waits for the user: its entry, by the request's id. */
  apps: Map<number, string>
  /** Who answered the latest first uses of apps, by entry id: a device, or null for a window. */
  appsAnswered: Map<string, FromDevice | null>
  /** Each setup a call waits on: its entry, by the request's id. */
  setups: Map<number, string>
  /** Who sent the latest turn: a window's or a device's port, and the device it serves. */
  sender: TurnSender | null
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
  /**
   * The next checkpoint replaces the stored thread: after a replay, or a write that failed after
   * which another had gone.
   */
  rewrite: boolean
  /** Checkpoints sent to the thread store, which the writes that fail compare. */
  writes: number
  /** Writes that failed in a row, and when the next may go; 0 while they succeed. */
  writeFailures: number
  retryAt: number
  /** The thread says the disk is full, until a write succeeds again. */
  fullNoticed: boolean
  /** A replay failed partway, so the thread is not stored until one completes. */
  partial: boolean
  /** Bytes of sent attachments for the next checkpoint, by hash. */
  blobs: Map<string, StoredBlob>
  /** The entries the host keeps while a replay rebuilds the thread, which the agent does not send. */
  keeper: ReplayKeeper | null
  checkpointTimer: ReturnType<typeof setTimeout> | null
  /** Something was sent or set since it went live; one only opened to read is let go sooner. */
  used: boolean
  /** A new session's first message, in its thread already, to send once the session has started. */
  first: {
    content: UserContent[]
    entryId: string
    from?: FromSession
    device?: FromDevice
    portId?: string
  } | null
  /** A first message that waits for its worktree's preparation, which sends it. */
  heldFirst: Live['first']
  /** Who queued each waiting prompt, by item id; apart from the queue, which every client sees. */
  queuedBy: Map<string, string>
  /** The message that gave the session its first title, for a written title, and its tries. */
  titlePrompt: UserContent[] | null
  titleWriting: boolean
  titleFailedAt: number | null
  /** The second read of an agent's listed title, while it may still be writing it. */
  listedTitleTimer: ReturnType<typeof setTimeout> | null
  /** The values New session chose, set once `session/new` answers, also after a sign-in. */
  startValues: Record<string, string | boolean>
  /** A turn the host ended after a Stop the agent did not confirm, until its prompt is answered. */
  unansweredCancel: Turn | null
  /** It started work that runs on after its tool call, which Claude Code reports no end of. */
  background: boolean
  /** The agent runs a turn of its own, which shows as the session's once no other turn runs. */
  agentTurn: boolean
  /** Set while it is a prepared session, not yet in the index. */
  prepared: Prepared | null
  /** A run's session: the mode it must start in, its scope, and its first turn's course. */
  routineMode: string | null
  routineScope: PermissionScope | null
  routineTurnStarted: boolean
  routineTurnEnded: boolean
  /** Since when nothing has needed its agent, and since when no port has shown it in front. */
  idleSince: number | null
  hiddenSince: number | null
  releaseTimer: ReturnType<typeof setTimeout> | null
  contextTimer: ReturnType<typeof setTimeout> | null
  contextDueAt: number
  contextDirty: boolean
  /** A read due though no port shows the session, as after its turn ended. */
  contextOwed: boolean
  contextRevision: number
  contextFailures: number
  contextReadAt: number
  /** The agent that asked for this session to be archived once its running turn ends. */
  archiveAfterTurn: string | null
  /** Send now stopped the running turn, so the queue's first prompt goes when the turn ends. */
  sendNext: boolean
}

const TITLE_LENGTH = 60
// Titles from `session/list`, kept for an import that follows; bounded like every cache here.
const LISTED_SESSIONS = 1_000
// Requests whose answerer a session remembers, so a late answer hears where it was answered.
const ANSWERS_KEPT = 50

/**
 * A new origin's request by who asks it, `owner` being '' for main and a device's port for a
 * desktop app's page, since each numbers its own requests.
 */
function originKey(owner: string, requestId: number): string {
  return `${owner}:${requestId}`
}

/** The requests that wait for the user: permissions, new sites, first uses of apps and setups. */
function waitingCount(live: Live): number {
  return live.permissions.size + live.origins.size + live.apps.size + live.setups.size
}

/** The ids of what waits: each permission's request id, and the entry id of the others. */
function waitingIds(live: Live): string[] {
  return [
    ...live.permissions.keys(),
    ...live.origins.values(),
    ...live.apps.values(),
    ...live.setups.values(),
  ]
}

/** A first use of an app that waits for the user, and the first answer a window or device gave. */
interface AppRequest {
  sessionId: string
  entryId: string
  answer: { decision: ComputerAppDecision; device: FromDevice | null } | null
}

/** A new origin that waits for the user, and the first answer a window or device gave it. */
interface OriginRequest {
  sessionId: string
  entryId: string
  owner: string
  requestId: number
  answer: { decision: BrowserOriginDecision; device: FromDevice | null } | null
}

/** The page an answer to a new origin goes to: main's for '', else a desktop app's port. */
export interface OriginTarget {
  owner: string
  requestId: number
}

/** The first line of the first text, cut to 60 characters: the title until the agent sends one. */
/**
 * The folder a session works in: its worktree's when it has one, else its project's. A worktree
 * that was removed or did not read is never swapped for the project's folder.
 */
export function workDir(record: Pick<SessionRecord, 'projectPath' | 'worktree'>): string {
  return record.worktree ? record.worktree.path : record.projectPath
}

async function isFolder(value: string): Promise<boolean> {
  if (value === '') return false
  try {
    return (await stat(value)).isDirectory()
  } catch {
    return false
  }
}

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

/** Whether the agent added no message, thought, tool call or plan after the user entry `entryId`. */
function agentAddedNothing(
  thread: Pick<ThreadState, 'order' | 'byId'>,
  entryId: string | null,
): boolean {
  const at = entryId ? thread.order.indexOf(entryId) : -1
  if (at < 0) return false
  return thread.order.slice(at + 1).every((id) => {
    const kind = thread.byId[id]?.kind
    return kind !== 'agent' && kind !== 'thought' && kind !== 'tool' && kind !== 'plan'
  })
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

function agentValues(config: readonly ConfigOption[]): Record<string, string | boolean> {
  return Object.fromEntries(config.map((option) => [option.id, option.value]))
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

/** A row's pull requests: the ones it opened, newest first, then its branch's if not among them. */
function sessionPullRequests(
  record: SessionRecord,
  branchUrl: string | null,
  git: GitServiceApi | null,
): SessionPullRequest[] {
  const urls = [...(record.pullRequests ?? [])].reverse()
  if (branchUrl && !urls.includes(branchUrl)) urls.push(branchUrl)
  return urls.flatMap((url) => {
    const ref = githubReferenceOf(url)
    if (ref?.kind !== 'pull') return []
    const known = git?.knownPullRequest(url) ?? null
    return [
      {
        url,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        state: known?.state ?? null,
        failing: known?.failing ?? false,
      },
    ]
  })
}

export class SessionManager {
  private readonly records = new Map<string, SessionRecord>()
  private readonly live = new Map<string, Live>()
  private readonly watchers = new Map<string, Set<string>>()
  // Port id to the sessions it shows in front, every pane of a split view in view.
  private readonly shown = new Map<string, Set<string>>()
  /** Each waiting new origin's session and entry, by `originKey`. */
  private readonly originRequests = new Map<string, OriginRequest>()
  /** Each device card's answer, by its entry id, which the waiting tool call takes. */
  private readonly deviceWaits = new Map<string, (answer: DeviceAccessAnswer) => void>()
  /** Each first use of an app that waits, by the computer use service's request id. */
  private readonly appRequests = new Map<number, AppRequest>()
  /** Each session's card holding its folder's own MCP servers while it waits, with the folder. */
  private readonly projectMcpCards = new Map<string, { entryId: string; folder: string }>()
  /** Each setup that waits, by the computer use service's request id, with who said Not now. */
  private readonly setupRequests = new Map<
    number,
    { sessionId: string; entryId: string; declinedBy: FromDevice | null }
  >()
  private readonly missing = new Set<string>()
  /** Worktrees being prepared or whose preparation failed, by path key. */
  private readonly preparing = new Map<string, Exclude<PrepareState, { state: 'ready' }>>()
  /** Worktrees whose folder was found gone, by path key, until they are made again. */
  private readonly missingWorktrees = new Set<string>()
  private readonly lastSummaries = new Map<string, string>()
  /** `/context` reports running, by session id. */
  private readonly contextRuns = new Map<string, Promise<ContextBreakdown | null>>()
  /** Sessions whose outline titles are being written, and when the last failed for others. */
  private readonly titling = new Set<string>()
  private readonly summaryFailedAt = new Map<string, number>()
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
  // A notification outlives the host that asked, so its answer must not fit the next run's ids.
  private readonly requestPrefix = `p${randomUUID().slice(0, 8)}-`
  private badgeCount = 0
  private waitingIds = '{}'
  private busyCounts: BusyCounts = { running: 0, waiting: 0 }
  /** Set once the host shuts down: the last checkpoints are written and no more follow. */
  private stopped = false
  /** The sessions in the index at launch: the only ones `removeEmpty` may remove. */
  private readonly atLaunch = new Set<string>()
  /** When `removeEmpty` ran, kept in the index; null before that. */
  private emptySessionsRemovedAt: number | null = null
  /**
   * Messages no session took, oldest first, until a window takes them back; one with a `portId`
   * is that port's while it is open, which no file keeps.
   */
  private returned: (ReturnedFile['messages'][number] & { portId?: string })[] = []
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
        deps.options?.started(agentId, config, pathKey(folder, deps.platform))
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
    await this.deps.projectMcp?.load()
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.deps.file.flush(),
      this.deps.returned.flush(),
      this.deps.projectMcp?.flush(),
    ])
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

  /** Whether a session lists the agent's own session as an earlier agent's, which it may take back. */
  private takenEarlier(agentId: AgentId, acpSessionId: string): boolean {
    const holds = (record: SessionRecord): boolean =>
      record.earlier?.some(
        (item) => item.agentId === agentId && item.acpSessionId === acpSessionId,
      ) === true
    for (const live of this.live.values()) if (holds(live.record)) return true
    for (const record of this.records.values()) if (holds(record)) return true
    return false
  }

  private recordOf(sessionId: string): SessionRecord {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    if (!record) throw notFound(`No session ${sessionId}`)
    return record
  }

  has(sessionId: string): boolean {
    return this.live.has(sessionId) || this.records.has(sessionId)
  }

  /** The titles of a project's sessions, which a fork's title is chosen to differ from. */
  private titlesIn(projectPath: string): Set<string> {
    const titles = new Set<string>()
    for (const id of new Set([...this.records.keys(), ...this.live.keys()])) {
      const record = this.live.get(id)?.record ?? this.records.get(id)
      if (record?.projectPath !== projectPath || record.origin === 'subagent') continue
      const title = this.title(id)
      if (title) titles.add(title)
    }
    return titles
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

  /** Whether the agent's session `id` is a subagent of a session attached through `connection`. */
  isSubagentCall(connection: object, id: string): boolean {
    for (const live of this.live.values()) {
      if (live.connection !== connection || !live.connection) continue
      const root = live.connection.rootOf(id)
      if (live.record.acpSessionId === root) return root !== id
    }
    return false
  }

  /** The session's running turn, for telling it from a later one; null between turns. */
  runningTurn(sessionId: string): object | null {
    const turn = this.live.get(sessionId)?.turn
    return turn && !turn.ended ? turn : null
  }

  /**
   * The session whose page a browser call drives: its own, or for a subagent the top-level
   * session it runs under, which has the page. Null for a session Kettu does not hold.
   */
  browserSession(sessionId: string): string | null {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    if (!record) return null
    return sessionWithPage(record, (id) => this.live.get(id)?.record ?? this.records.get(id)).id
  }

  /** Who sent the session's latest turn, which its browser calls go to; null for none in memory. */
  browserSender(sessionId: string): TurnSender | null {
    return this.live.get(sessionId)?.sender ?? null
  }

  /** The project of the session whose page a browser call drives, or null when it has none. */
  sessionProject(sessionId: string): string | null {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    return record?.projectPath ?? null
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
    const permissionCount = live ? waitingCount(live) : 0
    let attention: SessionAttention = 'none'
    if (permissionCount > 0) attention = 'permission'
    else if (status === 'failed' || (session?.error && status !== 'running' && !live?.errorSeen))
      attention = 'error'
    else if (live ? live.unread : this.persistedUnread(record)) attention = 'unread'
    const git = this.deps.git()
    const pr =
      record.branch && git
        ? (git.branchPullRequests(workDir(record)).get(record.branch) ??
          git.branchPullRequests(record.projectPath).get(record.branch) ??
          null)
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
      routine: record.routine ?? null,
      description: record.description,
      missing: this.missing.has(record.id),
      branch: record.branch,
      pr: pr ? { number: pr.number, state: pr.state, url: pr.url } : null,
      prs: sessionPullRequests(record, pr?.url ?? null, git),
      cache: record.cache ?? null,
      model: record.model ?? null,
      pinnedAt: record.pinnedAt ?? null,
      archivedAt: record.archivedAt ?? null,
      acpSessionId: record.acpSessionId || null,
      ...(record.worktree ? { worktree: this.worktreeSummary(record.worktree) } : {}),
      ...(record.agentWorktree ? { agentWorktree: { ...record.agentWorktree } } : {}),
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
      // A routine's runs are listed under their routine, never under their project.
      if (summary.origin === 'routine') continue
      if (key === null || pathKey(summary.projectPath, this.deps.platform) === key)
        out.push(summary)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * The folders sessions work in outside the projects, live or indexed: scratch folders and
   * worktrees, so files, git and terminals may open there.
   */
  sessionFolders(): string[] {
    const { platform, scratch } = this.deps
    const folders = new Map<string, string>()
    const records = [
      ...this.records.values(),
      ...[...this.live.values()].filter((l) => !l.prepared).map((l) => l.record),
    ]
    for (const record of records) {
      const { projectPath, worktree } = record
      if (scratch.contains(projectPath)) folders.set(pathKey(projectPath, platform), projectPath)
      if (worktree && worktree.path !== '' && worktree.removed === undefined) {
        folders.set(pathKey(worktree.path, platform), worktree.path)
      }
    }
    return [...folders.values()]
  }

  /** The project of the session worktree at `folder`, or null when no session works there. */
  worktreeProject(folder: string): string | null {
    const key = pathKey(folder, this.deps.platform)
    for (const { projectPath, worktree } of this.allRecords()) {
      if (worktree && worktree.path !== '' && pathKey(worktree.path, this.deps.platform) === key) {
        return projectPath
      }
    }
    return null
  }

  /** Whether a canonical folder is a worktree a session record names. */
  isSessionWorktree(canonical: string): boolean {
    const key = pathKey(canonical, this.deps.platform)
    for (const { worktree, agentWorktree } of this.allRecords()) {
      for (const folder of [worktree?.path, agentWorktree?.path]) {
        if (folder && pathKey(folder, this.deps.platform) === key) return true
      }
    }
    return false
  }

  private allRecords(): SessionRecord[] {
    return [...this.records.values(), ...[...this.live.values()].map((l) => l.record)]
  }

  /** The folder a session works in, for the tools that read its files; null when unknown. */
  sessionFolder(sessionId: string): string | null {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    return record ? workDir(record) : null
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
    this.updateBusy()
    if (live?.prepared) this.deps.events.summary(summary, [live.prepared.portId])
    else this.deps.events.summary(summary)
  }

  private updateBadge(): void {
    let count = 0
    const waiting: Record<string, string[]> = {}
    for (const live of this.live.values()) {
      count += waitingCount(live)
      const ids = waitingIds(live)
      if (ids.length > 0) waiting[live.id] = ids
    }
    // One request can end as another starts, which leaves the count as it was.
    const json = JSON.stringify(waiting)
    if (json !== this.waitingIds) {
      this.waitingIds = json
      this.deps.events.waiting(waiting)
    }
    if (count === this.badgeCount) return
    this.badgeCount = count
    this.deps.events.badge(count)
  }

  /** A session's status or pending requests show in its summary, so each change passes here. */
  private updateBusy(): void {
    let running = 0
    let waiting = 0
    for (const live of this.live.values()) {
      const status = live.thread.session.status
      if (status === 'running' || status === 'awaiting_permission') running++
      if (waitingCount(live) > 0) waiting++
    }
    if (running === this.busyCounts.running && waiting === this.busyCounts.waiting) return
    this.busyCounts = { running, waiting }
    this.deps.events.busy(this.busyCounts)
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

  /**
   * The plan an agent set through the plan tool: the turn's plan entry takes it, as an agent's own
   * todo list would, or a new entry goes in. False for a session that is not in memory.
   */
  planSet(sessionId: string, items: PlanItem[]): boolean {
    const live = this.live.get(sessionId)
    if (!live) return false
    const current = live.scope.planId ? live.thread.byId[live.scope.planId] : undefined
    if (current?.kind === 'plan') {
      this.emit(live, [{ op: 'entry.update', id: current.id, changes: { items } }])
      return true
    }
    const id = this.nextId(live)
    live.scope.planId = id
    this.emit(live, [{ op: 'entry.add', entry: { kind: 'plan', id, items } }])
    return true
  }

  /**
   * A problem report the agent drafted waits in its thread for the user to send. It does not mark
   * the session as waiting: the agent carries on, and nothing is sent until the user answers.
   */
  reportDrafted(sessionId: string, draft: ReportDraft): 'added' | 'none' | 'open' | 'daily' {
    const live = this.live.get(sessionId)
    if (!live) return 'none'
    const now = Date.now()
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    let today = 0
    for (const id of live.thread.order) {
      const entry = live.thread.byId[id]
      if (entry?.kind !== 'problem_report') continue
      if (entry.outcome === null) return 'open'
      if (entry.at >= midnight) today++
    }
    if (today >= REPORTS_PER_DAY) return 'daily'
    const entry: ProblemReportEntry = {
      kind: 'problem_report',
      id: this.nextId(live),
      ...draft,
      at: now,
      outcome: null,
      after: agentEntryBefore(live.thread),
    }
    this.emit(live, [{ op: 'entry.add', entry }])
    return 'added'
  }

  /** What became of a drafted problem report, from the window or device that answered it first. */
  answerReport(
    sessionId: string,
    entryId: string,
    outcome: ProblemReportOutcome,
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const entry = live?.thread.byId[entryId]
    if (!live || entry?.kind !== 'problem_report') throw notFound(`No report waits in ${entryId}`)
    if (entry.outcome !== null) {
      throw new HostError('not_found', `The report ${entryId} was already answered`, {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    const changes = { outcome, ...(device ? { device } : {}) }
    this.emit(live, [{ op: 'entry.update', id: entryId, changes }])
  }

  /** A write to the artifacts service by the session, or by a subagent of it, goes in its thread. */
  artifactWritten(sessionId: string, write: ArtifactWrite): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.emit(live, [writePatch(live.thread, write, () => this.nextId(live, 'a'))])
  }

  /**
   * An agent's page wants to open a new origin, which waits for the user in the session's thread
   * and marks the session as waiting, as a permission request does.
   */
  browserOriginAsked(sessionId: string, requestId: number, origin: string, owner = ''): void {
    const live = this.live.get(sessionId)
    const key = originKey(owner, requestId)
    if (!live || this.originRequests.has(key)) return
    const entry: BrowserOriginEntry = {
      kind: 'browser_origin',
      id: this.nextId(live),
      requestId,
      origin,
      decision: null,
      after: agentEntryBefore(live.thread),
    }
    live.origins.set(key, entry.id)
    this.originRequests.set(key, { sessionId, entryId: entry.id, owner, requestId, answer: null })
    this.emit(live, [{ op: 'entry.add', entry }])
    const status = live.thread.session.status
    if (status === 'running' || status === 'ready')
      this.update(live, { status: 'awaiting_permission' })
    this.touch(live.id)
    this.updateBadge()
    this.deps.events.attention(
      live.id,
      'permission',
      this.titleOf(live),
      t('attention.browserOrigin', { site: originLabel(origin) }),
      { id: entry.id },
    )
  }

  /**
   * The wait ended, so the thread's card takes the answer and the session waits no longer. It is
   * labelled with the device whose answer it is: the one that answered the card first, or the
   * desktop app whose own pane answered, `ownerDevice`.
   */
  browserOriginSettled(
    requestId: number,
    decision: BrowserOriginAnswer,
    owner = '',
    ownerDevice?: FromDevice,
  ): void {
    const key = originKey(owner, requestId)
    const waiting = this.originRequests.get(key)
    if (!waiting) return
    this.originRequests.delete(key)
    const live = this.live.get(waiting.sessionId)
    if (!live) return
    live.origins.delete(key)
    const device =
      decision === 'timeout'
        ? null
        : waiting.answer?.decision === decision
          ? waiting.answer.device
          : (ownerDevice ?? null)
    if (decision !== 'timeout') {
      live.originsAnswered.set(waiting.entryId, device)
      if (live.originsAnswered.size > ANSWERS_KEPT) {
        live.originsAnswered.delete(live.originsAnswered.keys().next().value!)
      }
    }
    const entry = live.thread.byId[waiting.entryId]
    if (entry?.kind === 'browser_origin') {
      this.emit(live, [
        {
          op: 'entry.update',
          id: waiting.entryId,
          changes: { decision, ...(device ? { device } : {}) },
        },
      ])
    }
    this.stopWaiting(live)
    this.touch(live.id)
    this.updateBadge()
  }

  /**
   * An agent wants a mobile device for the first time in this session: a card in the thread that
   * waits for the user, as a new site does, and settles with their answer or `timeout`.
   */
  deviceAccessAsked(
    sessionId: string,
    deviceId: string,
    deviceName: string,
    waitMs: number,
  ): Promise<DeviceAccessAnswer> {
    const live = this.live.get(sessionId)
    if (!live) return Promise.resolve('timeout')
    const entry: DeviceAccessEntry = {
      kind: 'device_access',
      id: this.nextId(live),
      deviceId,
      deviceName,
      decision: null,
      after: agentEntryBefore(live.thread),
    }
    const key = `device:${entry.id}`
    live.origins.set(key, entry.id)
    this.emit(live, [{ op: 'entry.add', entry }])
    const status = live.thread.session.status
    if (status === 'running' || status === 'ready')
      this.update(live, { status: 'awaiting_permission' })
    this.touch(live.id)
    this.updateBadge()
    this.deps.events.attention(
      live.id,
      'permission',
      this.titleOf(live),
      t('attention.deviceAccess', { device: deviceName }),
      { id: entry.id },
    )
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.settleDeviceAccess(sessionId, entry.id, 'timeout'),
        waitMs,
      )
      this.deviceWaits.set(entry.id, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
    })
  }

  /** A window's or a device's answer to a device card; the first one counts. */
  answerDeviceAccess(
    sessionId: string,
    entryId: string,
    decision: DeviceAccessDecision,
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const entry = live?.thread.byId[entryId]
    if (!live || entry?.kind !== 'device_access') throw notFound(`No device request in ${entryId}`)
    if (entry.decision !== null || !this.deviceWaits.has(entryId)) {
      throw new HostError('not_found', `The device request ${entryId} was already answered`, {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    this.settleDeviceAccess(sessionId, entryId, decision, device)
  }

  private settleDeviceAccess(
    sessionId: string,
    entryId: string,
    decision: DeviceAccessAnswer,
    device?: FromDevice,
  ): void {
    const resolve = this.deviceWaits.get(entryId)
    this.deviceWaits.delete(entryId)
    const live = this.live.get(sessionId)
    if (live) {
      live.origins.delete(`device:${entryId}`)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'device_access' && entry.decision === null) {
        this.emit(live, [
          { op: 'entry.update', id: entryId, changes: { decision, ...(device ? { device } : {}) } },
        ])
      }
      this.stopWaiting(live)
      this.touch(live.id)
      this.updateBadge()
    }
    resolve?.(decision)
  }

  /**
   * A window's or a device's answer to a new origin's card. The first one counts and goes to the
   * page that asked, whose wait then settles the card; a later one hears where the first was given.
   */
  answerOrigin(
    sessionId: string,
    entryId: string,
    decision: BrowserOriginDecision,
    device?: FromDevice,
  ): OriginTarget {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const key = live && [...live.origins].find(([, id]) => id === entryId)?.[0]
    const waiting = key === undefined ? undefined : this.originRequests.get(key)
    const first = waiting?.answer
    if (live && (first || live.originsAnswered.has(entryId))) {
      throw new HostError('not_found', `The new site of ${entryId} was already answered`, {
        reason: ALREADY_ANSWERED,
        device: first ? first.device : (live.originsAnswered.get(entryId) ?? null),
      })
    }
    if (!waiting) throw notFound(`No new site waits in ${entryId}`)
    waiting.answer = { decision, device: device ?? null }
    return { owner: waiting.owner, requestId: waiting.requestId }
  }

  /**
   * Why the session's running turn may not use the computer, or null when it may: only a turn the
   * user sent from one of this host's own windows may.
   */
  computerRefusal(sessionId: string): string | null {
    const live = this.live.get(sessionId)
    if (!live?.turn) return 'Computer use works only during a turn the user sent.'
    if (live.sender === null || live.sender.device !== null) {
      return (
        'Computer use works only for messages sent from the Kettu desktop app on the computer ' +
        'it uses, and this turn came from elsewhere. Ask the user to send it from there.'
      )
    }
    return null
  }

  /** The session took or released the computer, or moved to another app: its bar shows it. */
  computerUsing(sessionId: string, view: ComputerUseView | null): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.update(live, { computer: view })
  }

  /**
   * An agent wants to use an app for the first time in the session, which waits for the user in
   * its thread and marks the session as waiting, as a permission request does.
   */
  computerAppAsked(sessionId: string, requestId: number, app: ComputerApp): void {
    const live = this.live.get(sessionId)
    if (!live || this.appRequests.has(requestId)) return
    const entry: ComputerAppEntry = {
      kind: 'computer_app',
      id: this.nextId(live),
      requestId,
      appId: app.id,
      appName: app.name,
      decision: null,
      after: agentEntryBefore(live.thread),
    }
    live.apps.set(requestId, entry.id)
    this.appRequests.set(requestId, { sessionId, entryId: entry.id, answer: null })
    this.emit(live, [{ op: 'entry.add', entry }])
    const status = live.thread.session.status
    if (status === 'running' || status === 'ready')
      this.update(live, { status: 'awaiting_permission' })
    this.touch(live.id)
    this.updateBadge()
    this.deps.events.attention(
      live.id,
      'permission',
      this.titleOf(live),
      t('attention.computerApp', { app: app.name }),
      { id: entry.id },
    )
  }

  /** The wait ended, so the card takes the answer, labelled with the device that gave it. */
  computerAppSettled(requestId: number, decision: ComputerAppAnswer): void {
    const waiting = this.appRequests.get(requestId)
    if (!waiting) return
    this.appRequests.delete(requestId)
    const live = this.live.get(waiting.sessionId)
    if (!live) return
    live.apps.delete(requestId)
    const device =
      decision !== 'timeout' && waiting.answer?.decision === decision ? waiting.answer.device : null
    if (decision !== 'timeout') {
      live.appsAnswered.set(waiting.entryId, device)
      if (live.appsAnswered.size > ANSWERS_KEPT) {
        live.appsAnswered.delete(live.appsAnswered.keys().next().value!)
      }
    }
    const entry = live.thread.byId[waiting.entryId]
    if (entry?.kind === 'computer_app') {
      this.emit(live, [
        {
          op: 'entry.update',
          id: waiting.entryId,
          changes: { decision, ...(device ? { device } : {}) },
        },
      ])
    }
    this.stopWaiting(live)
    this.touch(live.id)
    this.updateBadge()
  }

  /**
   * A window's or a device's answer to a first use of an app. The first one counts and goes to the
   * call that asked, whose wait then settles the card; a later one hears where the first was given.
   */
  answerComputerApp(
    sessionId: string,
    entryId: string,
    decision: ComputerAppDecision,
    device?: FromDevice,
  ): number {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const requestId = live && [...live.apps].find(([, id]) => id === entryId)?.[0]
    const waiting = requestId === undefined ? undefined : this.appRequests.get(requestId)
    const first = waiting?.answer
    if (live && (first || live.appsAnswered.has(entryId))) {
      throw new HostError('not_found', `The app of ${entryId} was already answered`, {
        reason: ALREADY_ANSWERED,
        device: first ? first.device : (live.appsAnswered.get(entryId) ?? null),
      })
    }
    if (!waiting || requestId === undefined) throw notFound(`No app waits in ${entryId}`)
    waiting.answer = { decision, device: device ?? null }
    return requestId
  }

  /**
   * An agent's call found computer use off or a permission missing: the setup waits in its thread
   * and marks the session as waiting, as a permission request does.
   */
  computerSetupAsked(sessionId: string, requestId: number, steps: ComputerSetupStep[]): void {
    const live = this.live.get(sessionId)
    if (!live || this.setupRequests.has(requestId)) return
    const entry: ComputerSetupEntry = {
      kind: 'computer_setup',
      id: this.nextId(live),
      requestId,
      steps,
      done: [],
      outcome: null,
      after: agentEntryBefore(live.thread),
    }
    live.setups.set(requestId, entry.id)
    this.setupRequests.set(requestId, { sessionId, entryId: entry.id, declinedBy: null })
    this.emit(live, [{ op: 'entry.add', entry }])
    const status = live.thread.session.status
    if (status === 'running' || status === 'ready')
      this.update(live, { status: 'awaiting_permission' })
    this.touch(live.id)
    this.updateBadge()
    this.deps.events.attention(
      live.id,
      'permission',
      this.titleOf(live),
      t('attention.computerSetup'),
      { id: entry.id },
    )
  }

  /** Steps of a waiting setup were done: its card moves on to the next. */
  computerSetupDone(requestId: number, done: ComputerSetupStep[]): void {
    const waiting = this.setupRequests.get(requestId)
    const live = waiting && this.live.get(waiting.sessionId)
    if (!waiting || !live || live.thread.byId[waiting.entryId]?.kind !== 'computer_setup') return
    this.emit(live, [{ op: 'entry.update', id: waiting.entryId, changes: { done } }])
  }

  /** The setup ended: the card shows how, with the device that said Not now. */
  computerSetupSettled(requestId: number, outcome: ComputerSetupOutcome): void {
    const waiting = this.setupRequests.get(requestId)
    if (!waiting) return
    this.setupRequests.delete(requestId)
    const live = this.live.get(waiting.sessionId)
    if (!live) return
    live.setups.delete(requestId)
    const device = outcome === 'declined' ? waiting.declinedBy : null
    const entry = live.thread.byId[waiting.entryId]
    if (entry?.kind === 'computer_setup') {
      this.emit(live, [
        {
          op: 'entry.update',
          id: waiting.entryId,
          changes: { outcome, ...(device ? { device } : {}) },
        },
      ])
    }
    this.stopWaiting(live)
    this.touch(live.id)
    this.updateBadge()
  }

  /** Not now from a window or a device: the id of the setup the service is to end. */
  declineComputerSetup(sessionId: string, entryId: string, device?: FromDevice): number {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const requestId = live && [...live.setups].find(([, id]) => id === entryId)?.[0]
    const waiting = requestId === undefined ? undefined : this.setupRequests.get(requestId)
    if (!waiting || requestId === undefined) throw notFound(`No setup waits in ${entryId}`)
    waiting.declinedBy = device ?? null
    return requestId
  }

  /** The user pressed Stop using: the thread says the turn no longer uses the computer. */
  computerStopped(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'info',
          title: t('notice.computerStopped.title'),
          description: t('notice.computerStopped.description'),
          after: agentEntryBefore(live.thread),
        },
      },
    ])
  }

  /** A replay ended: the kept entries it never came back to go at its end. */
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
    const wait = Math.max(this.timings.checkpointMs, live.retryAt - this.now())
    live.checkpointTimer = setTimeout(() => {
      live.checkpointTimer = null
      this.checkpoint(live)
    }, wait)
  }

  /**
   * Writes what changed since the last checkpoint. The store answers in order, so a later read
   * sees it. After a write that failed, the next waits, longer after each failure, unless it is
   * the last before the session leaves memory (`final`).
   */
  private checkpoint(live: Live, options: { afterShutdown?: boolean; final?: boolean } = {}): void {
    const afterShutdown = options.afterShutdown ?? false
    const final = options.final ?? afterShutdown
    if (live.checkpointTimer) {
      clearTimeout(live.checkpointTimer)
      live.checkpointTimer = null
    }
    const store = this.deps.threads
    if (!store || (this.stopped && !afterShutdown) || live.replaying || live.partial || !live.saved)
      return
    if (!live.record.acpSessionId || !this.hasChanges(live)) return
    if (!final && live.retryAt > this.now()) {
      this.scheduleCheckpoint(live)
      return
    }
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
    const write = ++live.writes
    store.write(live.id, change).then(
      () => {
        live.writeFailures = 0
        live.retryAt = 0
        live.fullNoticed = false
      },
      (error: unknown) => this.writeFailed(live, change, write, error),
    )
  }

  /**
   * A write changes nothing when it fails, so the next one takes its entries again, or the whole
   * thread when another write went after it, which may have stored entries placed by its.
   */
  private writeFailed(live: Live, change: ThreadWrite, write: number, error: unknown): void {
    const code = error instanceof ThreadStoreError ? error.code : null
    if (change.replace || write !== live.writes || code === 'conflict' || code === 'corrupt') {
      live.rewrite = true
    } else {
      for (const { entry } of change.entries) live.dirty.add(entry.id)
      if (change.session) live.sessionDirty = true
    }
    // Kept for the next write, which takes only the bytes it is handed.
    for (const blob of change.blobs ?? []) {
      if (!live.blobs.has(blob.hash)) live.blobs.set(blob.hash, blob)
    }
    live.writeFailures++
    const wait = Math.min(this.timings.checkpointMs * 2 ** live.writeFailures, MAX_RETRY_MS)
    live.retryAt = this.now() + wait
    this.deps.diagnostics.log(
      'warn',
      `Could not store the thread of session ${live.id}; trying again in ${Math.round(wait / 1000)} s: ${(error as Error).message}`,
    )
    if (this.live.get(live.id) !== live) return
    if (code === 'full' && !live.fullNoticed) {
      live.fullNoticed = true
      const title = t('notice.diskFull.title')
      this.emit(live, [
        {
          op: 'entry.add',
          entry: {
            kind: 'notice',
            id: this.nextId(live),
            severity: 'error',
            title,
            description: t('notice.diskFull.description'),
            after: agentEntryBefore(live.thread),
          },
        },
      ])
      this.deps.events.attention(live.id, 'error', this.titleOf(live), title)
    }
    this.scheduleCheckpoint(live)
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
    return {
      ...page,
      ...(split ? { entries: split } : {}),
      session: {
        ...page.session,
        config: this.deps.agents.restoreConfig(record.agentId, page.session.config, record),
      },
    }
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

  /** `images`: `inline` for a client that reads only the bytes of the images the thread holds. */
  async snapshot(
    sessionId: string,
    from?: number,
    images: ImageMode = 'refs',
  ): Promise<SessionSnapshot> {
    const live = this.live.get(sessionId)
    if (live) return this.withBytes(live, images, () => this.liveSnapshot(live, from))
    const record = this.recordOf(sessionId)
    const page = await this.readPage(record, (store) =>
      from === undefined
        ? store.page(sessionId, null, null, images)
        : store.tail(sessionId, from, images),
    )
    // It went live, or away, while the page was read.
    if (this.live.has(sessionId) || !this.has(sessionId)) {
      return this.snapshot(sessionId, from, images)
    }
    return this.storedSnapshot(record, page)
  }

  /**
   * What `take` reads of a live session: as it is, or with the bytes of the stored images it
   * holds, which are read first, so `take` still reads it at once, in step with its patches.
   */
  private async withBytes<T extends { entries: ThreadEntry[] }>(
    live: Live,
    images: ImageMode,
    take: () => T,
  ): Promise<T> {
    if (images === 'refs') return take()
    const bytes = new Map<string, string | null>()
    for (;;) {
      const missing = [...imageBlobs(take().entries)].filter((hash) => !bytes.has(hash))
      if (missing.length === 0) break
      await Promise.all(
        missing.map(async (hash) => {
          const blob = await this.storedBlob(live.id, hash).catch(() => null)
          bytes.set(hash, blob ? Buffer.from(blob.data).toString('base64') : null)
        }),
      )
    }
    const taken = take()
    return { ...taken, entries: taken.entries.map((entry) => withImageBytes(entry, bytes)) }
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
            config: page.session.config,
            commands: page.session.commands,
            usage: page.session.usage,
            ...storedContext(page.session.context),
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

  /**
   * The page before the position `before`, for a renderer scrolling back through the thread; with
   * `from`, everything back to the start of the turn holding that position, for a jump.
   */
  async page(
    sessionId: string,
    before: number,
    from?: number,
    images: ImageMode = 'refs',
  ): Promise<OlderPage> {
    const live = this.live.get(sessionId)
    if (live) {
      return this.withBytes(live, images, () => {
        // Patches go out before the page, so the renderer has every change to the entries it holds.
        this.flushPatches(live)
        const { order, byId } = live.thread
        const end = this.indexAt(live, before)
        let start = from === undefined ? pageStart(order, byId, end) : this.indexAt(live, from)
        if (from !== undefined) {
          start = Math.min(start, end)
          while (start > 0 && !opensTurn(byId[order[start]!]!, byId[order[start - 1]!]!)) start--
        }
        return {
          entries: order.slice(start, end).map((id) => byId[id]!),
          older: start > 0 ? this.posAt(live, start) : null,
        }
      })
    }
    const record = this.recordOf(sessionId)
    const page = await this.readPage(record, (store) =>
      store.page(sessionId, before, from ?? null, images),
    )
    if (this.live.has(sessionId) || !this.has(sessionId)) {
      return this.page(sessionId, before, from, images)
    }
    return page
      ? { entries: page.entries.map(settled), older: page.older }
      : { entries: [], older: null }
  }

  // The message outline.

  /** The session's user messages, oldest first, each with its first line and stored title. */
  async outline(sessionId: string): Promise<{ entries: OutlineEntry[] }> {
    const { rows } = await this.outlineRows(sessionId)
    return { entries: rows.map((row) => ({ ...row, text: firstLine(row.text) })) }
  }

  /**
   * The user messages with their text and titles, and the session's model: from memory while it
   * is live, with the titles stored, and from the thread store otherwise.
   */
  private async outlineRows(
    sessionId: string,
  ): Promise<{ rows: OutlineRow[]; model: string | null }> {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.recordOf(sessionId)
    // The store gets the pending entries first, so it holds the thread titles are kept with.
    if (live) this.checkpoint(live)
    const stored = await this.readOutline(record)
    const current = this.live.get(sessionId)
    if (!current) {
      return stored
        ? { rows: stored.entries, model: modelOf(stored.session.config) }
        : { rows: [], model: null }
    }
    const titles = new Map(stored?.entries.map((row) => [row.pos, row.title]))
    const rows: OutlineRow[] = []
    for (const id of current.thread.order) {
      const entry = current.thread.byId[id]
      const pos = current.positions.get(id)
      if (entry?.kind !== 'user' || entry.from || pos === undefined) continue
      rows.push({
        pos,
        entryId: id,
        text: outlineText(entry.content),
        title: titles.get(pos) ?? null,
      })
    }
    return { rows, model: modelOf(current.thread.session.config) }
  }

  private async readOutline(record: SessionRecord): Promise<StoredOutline | null> {
    const store = this.deps.threads
    if (!store || !record.acpSessionId) return null
    try {
      const outline = await store.outline(record.id)
      return outline && this.isCurrent(record, outline.head) ? outline : null
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not read the outline of session ${record.id}: ${(error as Error).message}`,
      )
      return null
    }
  }

  /**
   * Has the agent title the session's untitled messages and stores the titles. One runs at a time
   * for a session, and none for 5 minutes after one failed; either way the answer is empty.
   */
  async outlineTitles(sessionId: string): Promise<{ titles: OutlineTitle[] }> {
    const record = this.recordOf(sessionId)
    const failedAt = this.summaryFailedAt.get(sessionId)
    if (
      record.origin === 'subagent' ||
      this.titling.has(sessionId) ||
      (failedAt !== undefined && this.now() - failedAt < SUMMARY_RETRY_MS)
    ) {
      return { titles: [] }
    }
    this.titling.add(sessionId)
    try {
      const { rows, model } = await this.outlineRows(sessionId)
      const untitled = rows.filter((row) => row.title === null && row.text.trim() !== '')
      if (untitled.length === 0) return { titles: [] }
      const runtime = await this.deps.agents.ensureReady(record.agentId)
      await mkdir(this.deps.reportsDir, { recursive: true })
      const titles = await writeTitles(runtime, {
        dir: this.deps.reportsDir,
        sessionModel: model,
        messages: untitled,
        log: (message) => this.deps.diagnostics.log('warn', message),
      })
      this.summaryFailedAt.delete(sessionId)
      await this.deps.threads?.setOutlineTitles(sessionId, titles).catch((error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `Could not store the outline titles of session ${sessionId}: ${(error as Error).message}`,
        )
      })
      return { titles }
    } catch (error) {
      this.summaryFailedAt.set(sessionId, this.now())
      this.deps.diagnostics.log(
        'warn',
        `${this.deps.agents.name(record.agentId)}: could not title the outline of session ${sessionId}: ${(error as Error).message}`,
      )
      return { titles: [] }
    } finally {
      this.titling.delete(sessionId)
    }
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
      routine: record.routine ?? null,
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
      send: (text) => this.sendForUser(live, text),
      startMode: () => startModeIn(this.deps.settings(), record.agentId) ?? null,
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
      answered: new Map(),
      origins: new Map(),
      originsAnswered: new Map(),
      apps: new Map(),
      appsAnswered: new Map(),
      setups: new Map(),
      sender: null,
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
      writes: 0,
      writeFailures: 0,
      retryAt: 0,
      fullNoticed: false,
      partial: false,
      blobs: new Map(),
      keeper: null,
      checkpointTimer: null,
      used: false,
      first: null,
      heldFirst: null,
      queuedBy: new Map(),
      titlePrompt: null,
      titleWriting: false,
      titleFailedAt: null,
      listedTitleTimer: null,
      startValues: {},
      unansweredCancel: null,
      background: false,
      agentTurn: false,
      prepared: null,
      routineMode: null,
      routineScope: null,
      routineTurnStarted: false,
      routineTurnEnded: false,
      idleSince: null,
      hiddenSince: this.inFront(record.id) ? null : this.now(),
      releaseTimer: null,
      contextTimer: null,
      contextDueAt: 0,
      contextDirty: false,
      contextOwed: false,
      contextRevision: 0,
      contextFailures: 0,
      contextReadAt: 0,
      archiveAfterTurn: null,
      sendNext: false,
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
    // An agent that reports background tasks says so with a list, empty until it has any.
    if (
      reportsTasks(connection) &&
      live.record.origin !== 'subagent' &&
      live.thread.session.background === undefined
    ) {
      this.update(live, { background: [] })
    }
  }

  /**
   * What an attach of the session hands its agent: the Marketplace's skills, and the MCP servers,
   * the artifacts service to an agent that takes MCP over HTTP while Kettu's server is on for it,
   * then the Marketplace's servers meant for its agent.
   */
  private attachOptions(
    sessionId: string,
    record: SessionRecord,
    runtime: AgentRuntime | null | undefined,
  ): SessionOptions {
    const skills = this.deps.skills?.(record.agentId) ?? {}
    const projectMcp = this.projectMcpGate(sessionId)
    return {
      mcpServers: this.mcpServers(sessionId, record, runtime),
      ...skills,
      ...(projectMcp ? { projectMcp } : {}),
    }
  }

  /** Lets the user answer, in the session's thread, for the MCP servers its folder declares. */
  private projectMcpGate(sessionId: string): ProjectMcpGate | undefined {
    const answers = this.deps.projectMcp
    if (!answers) return undefined
    return {
      hold: async (cwd, servers) => {
        const folder = await this.folderKey(cwd)
        const unanswered = servers.filter((server) => answers.allowed(folder, server.name) === null)
        if (unanswered.length > 0) this.askProjectMcp(sessionId, folder, unanswered)
        return answers.held(
          folder,
          servers.map((server) => server.name),
        )
      },
      held: async (cwd, names) => answers.held(await this.folderKey(cwd), names),
    }
  }

  /**
   * The key the user's answers about a folder's MCP servers are kept by: a session's worktree
   * shares its project's, as switching branches in the project's folder would.
   */
  private async folderKey(folder: string): Promise<string> {
    const platform = this.deps.platform
    let canonical: string
    try {
      canonical = await canonicalizePath(folder, platform, realpath)
    } catch {
      canonical = folder
    }
    return pathKey(this.worktreeProject(canonical) ?? canonical, platform)
  }

  /**
   * The session's folder declares MCP servers nobody answered for: one card asks the user, taking
   * up the servers a later start of the session finds too.
   */
  private askProjectMcp(sessionId: string, folder: string, servers: DeclaredMcpServer[]): void {
    const live = this.live.get(sessionId)
    if (!live) return
    const card = this.projectMcpCards.get(sessionId)
    const open = card ? live.thread.byId[card.entryId] : undefined
    if (card?.folder === folder && open?.kind === 'project_mcp' && open.decision === null) {
      const known = new Set(open.servers.map((server) => server.name))
      const added = servers.filter((server) => !known.has(server.name))
      if (added.length > 0) {
        const changes = { servers: [...open.servers, ...added] }
        this.emit(live, [{ op: 'entry.update', id: card.entryId, changes }])
      }
      return
    }
    const entry: ProjectMcpEntry = {
      kind: 'project_mcp',
      id: this.nextId(live),
      servers,
      decision: null,
      after: agentEntryBefore(live.thread),
    }
    this.projectMcpCards.set(sessionId, { entryId: entry.id, folder })
    this.emit(live, [{ op: 'entry.add', entry }])
  }

  /**
   * A window's or a device's answer to a card holding its folder's own MCP servers. The first one
   * counts: it is kept for the folder and settles every card of the folder it answers in full.
   */
  answerProjectMcp(
    sessionId: string,
    entryId: string,
    decision: ProjectMcpDecision,
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const entry = live?.thread.byId[entryId]
    if (!live || entry?.kind !== 'project_mcp') throw notFound(`No MCP servers wait in ${entryId}`)
    if (entry.decision !== null) {
      throw new HostError('not_found', `The MCP servers of ${entryId} were already answered`, {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    const card = this.projectMcpCards.get(sessionId)
    const answers = this.deps.projectMcp
    if (card?.entryId !== entryId || !answers) throw notFound(`No MCP servers wait in ${entryId}`)
    answers.answer(
      card.folder,
      entry.servers.map((server) => server.name),
      decision,
    )
    for (const [id, other] of [...this.projectMcpCards]) {
      if (other.folder !== card.folder) continue
      const otherLive = this.live.get(id)
      const waiting = otherLive?.thread.byId[other.entryId]
      if (!otherLive || waiting?.kind !== 'project_mcp' || waiting.decision !== null) {
        this.projectMcpCards.delete(id)
        continue
      }
      if (waiting.servers.some((server) => answers.allowed(card.folder, server.name) === null)) {
        continue
      }
      this.projectMcpCards.delete(id)
      const changes = { decision, ...(device ? { device } : {}) }
      this.emit(otherLive, [{ op: 'entry.update', id: other.entryId, changes }])
    }
  }

  private mcpServers(
    sessionId: string,
    record: SessionRecord,
    runtime: AgentRuntime | null | undefined,
  ): McpServer[] {
    if (!this.deps.mcp || !runtime) return []
    const transports = runtime.init.capabilities
    const own =
      transports.mcpHttp && runtime.kettu
        ? this.deps.mcp.servers(sessionId, record, runtime.connection)
        : []
    const library = this.deps.mcp.library(
      sessionId,
      record,
      runtime.connection,
      transports,
      own.map((server) => server.name),
    )
    return [...own, ...library]
  }

  private dropLive(live: Live): void {
    // A card still waiting goes unanswered; the session's next start asks again.
    const card = this.projectMcpCards.get(live.id)
    const waiting = card ? live.thread.byId[card.entryId] : undefined
    if (card && waiting?.kind === 'project_mcp' && waiting.decision === null) {
      this.emit(live, [{ op: 'entry.update', id: card.entryId, changes: { decision: 'timeout' } }])
    }
    this.projectMcpCards.delete(live.id)
    this.flushPatches(live)
    if (live.checkpointTimer) clearTimeout(live.checkpointTimer)
    if (live.releaseTimer) clearTimeout(live.releaseTimer)
    if (live.contextTimer) clearTimeout(live.contextTimer)
    this.contextRuns.delete(live.id)
    if (live.listedTitleTimer) clearTimeout(live.listedTitleTimer)
    if (live.turn?.fallback) clearTimeout(live.turn.fallback)
    live.connection?.unregister(live.record.acpSessionId, live.target)
    this.deps.mcp?.detached(live.id)
    this.seqs.set(live.id, live.seq)
    this.live.delete(live.id)
    this.updateBusy()
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
    if (
      !live.replaying &&
      output.patches.some(
        (patch) =>
          (patch.op === 'session.update' &&
            ('usage' in patch.changes || 'config' in patch.changes)) ||
          (patch.op === 'entry.add' &&
            ['agent', 'tool', 'compaction'].includes(patch.entry.kind)) ||
          (patch.op === 'entry.update' &&
            ['tool', 'compaction'].includes(live.thread.byId[patch.id]?.kind ?? '')),
      )
    ) {
      live.contextRevision++
      this.refreshContext(live, this.timings.contextDebounceMs)
    }
    this.touch(live.id)
  }

  private applyEffect(live: Live, effect: MapperEffect): void {
    const { agentId } = live.record
    const folder = workDir(live.record)
    switch (effect.kind) {
      case 'limit':
        this.deps.agents.setLimit(agentId, effect.limit)
        break
      case 'limits-allowed':
        this.deps.agents.allowLimits(agentId)
        break
      case 'title': {
        if (effect.title === null) {
          delete live.record.titleSource
          const fallback = this.firstUserText(live)
          if (fallback) this.update(live, { title: fallback })
        } else {
          live.record.titleSource = 'agent'
        }
        live.titlePrompt = null
        this.persist(live)
        break
      }
      case 'ignored':
        this.deps.diagnostics.ignored(agentId, live.id, `${effect.variant}: ${effect.detail}`)
        break
      case 'tool': {
        const git = this.deps.git()
        if (!git) break
        if (effect.phase === 'started') git.toolCallStarted(folder, live.id, effect.toolCallId)
        else git.toolCallEnded(folder, live.id, effect.toolCallId, effect.toolKind, effect.output)
        break
      }
      case 'subagent':
        this.applySubagent(live, effect)
        break
      case 'background':
        live.background = true
        this.refreshRelease(live)
        break
      case 'tasks':
        this.update(live, { background: effect.tasks })
        break
      case 'agentTurn':
        this.agentTurn(live, effect)
        break
      case 'request':
        this.refreshContext(live, this.timings.contextDebounceMs)
        // A turn's transcript is read as it ends; a request between turns has a read of its own.
        if (live.turn) live.turn.requested = true
        else {
          this.persist(live)
          this.scheduleCacheRead(live)
        }
        break
      case 'replayImage': {
        // A replayed image has no file the host may read, so its bytes come with the replay and
        // stay in the thread store, where a later open finds them.
        const data = Buffer.from(effect.data, 'base64')
        const hash = createHash('sha256').update(data).digest('hex')
        live.blobs.set(hash, { hash, mime: effect.mimeType, data: new Uint8Array(data) })
        const entry = live.thread.byId[effect.entryId]
        if (entry?.kind !== 'user') break
        let changed = false
        const content = entry.content.map((item): UserContent => {
          if (
            item.type !== 'ref' ||
            item.ref.kind !== 'attachment' ||
            item.ref.attachment.id !== effect.attachmentId
          ) {
            return item
          }
          changed = true
          return {
            type: 'ref',
            ref: { kind: 'attachment', attachment: { ...item.ref.attachment, blob: hash } },
          }
        })
        if (changed) this.emit(live, [{ op: 'entry.update', id: entry.id, changes: { content } }])
        break
      }
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
    const { agentId, acpSessionId } = live.record
    let ttl: number | null
    try {
      ttl = (await this.deps.cacheTtl?.(agentId, workDir(live.record), acpSessionId)) ?? null
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
    let record = this.findByAcp(agentId, effect.sessionId)
    if (!record) {
      record = {
        id: randomUUID(),
        agentId,
        acpSessionId: effect.sessionId,
        projectPath: parent.record.projectPath,
        ...(parent.record.worktree ? { worktree: { ...parent.record.worktree } } : {}),
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
    // The path is the agent's word: only one inside the folder it works in is kept.
    if (
      effect.worktree &&
      isInside(effect.worktree.path, workDir(parent.record), this.deps.platform)
    ) {
      child.record.agentWorktree = { ...effect.worktree }
    }
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
                after: agentEntryBefore(child.thread),
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
    for (const shown of this.shown.values()) if (shown.has(sessionId)) return true
    return false
  }

  watch(sessionId: string, portId: string): void {
    const { id } = this.recordOf(sessionId) // rejects an unknown session
    let ports = this.watchers.get(sessionId)
    if (!ports) {
      ports = new Set()
      this.watchers.set(sessionId, ports)
    }
    ports.add(portId)
    this.tellViewers(id, [portId])
    const live = this.live.get(id)
    if (live) this.refreshContext(live)
  }

  /** The ports that show the session in front now. */
  showing(sessionId: string): string[] {
    const ports: string[] = []
    for (const [portId, shown] of this.shown) if (shown.has(sessionId)) ports.push(portId)
    return ports
  }

  /** Tells the ports that watch a session, or `to`, who has it in front. */
  private tellViewers(sessionId: string, to?: readonly string[]): void {
    const showing = this.showing(sessionId)
    const ports = to ?? [...new Set([...(this.watchers.get(sessionId) ?? []), ...showing])]
    if (ports.length > 0) this.deps.events.viewers(sessionId, showing, ports)
  }

  unwatch(sessionId: string, portId: string): void {
    const ports = this.watchers.get(sessionId)
    if (!ports?.delete(portId)) return
    if (ports.size === 0) this.watchers.delete(sessionId)
  }

  /**
   * The sessions a port shows in front, one per pane in view: each one entering or leaving was
   * seen until now. An id the host does not know is skipped, since a session can go between the
   * renderer's call and this answer.
   */
  show(sessionIds: readonly string[], portId: string): void {
    const previous = this.shown.get(portId)
    const next = new Set<string>()
    for (const id of sessionIds) {
      if (this.records.has(id)) next.add(this.recordOf(id).id)
    }
    if (previous && previous.size === next.size && [...next].every((id) => previous.has(id))) return
    if (next.size === 0) this.shown.delete(portId)
    else this.shown.set(portId, next)
    const changed = new Set([...(previous ?? []), ...next])
    for (const id of changed) {
      if (!this.has(id)) continue
      const record = this.recordOf(id)
      if (previous?.has(id) && next.has(id)) continue
      this.tellViewers(id)
      this.markViewed(id, record)
      const live = this.live.get(id)
      if (!live) continue
      live.hiddenSince = this.inFront(live.id) ? null : this.now()
      if (this.inFront(live.id)) this.refreshContext(live)
      this.refreshRelease(live)
    }
  }

  portClosed(portId: string): void {
    const slot = this.preparedSlots.get(portId)
    for (const live of [slot?.current, slot?.next]) if (live) void this.dropPrepared(live)
    const shown = this.shown.get(portId)
    this.shown.delete(portId)
    for (const [sessionId, ports] of this.watchers) {
      if (ports.delete(portId) && ports.size === 0) this.watchers.delete(sessionId)
    }
    for (const sessionId of shown ?? []) if (this.has(sessionId)) this.tellViewers(sessionId)
    // What was given back to the port goes to whichever window or device asks next.
    const orphaned = new Set<string | null>()
    for (const message of this.returned) {
      if (message.portId !== portId) continue
      delete message.portId
      orphaned.add(message.sessionId)
    }
    for (const sessionId of orphaned) this.deps.events.returned(sessionId)
    for (const live of this.live.values()) {
      for (const [itemId, queuedBy] of live.queuedBy) {
        if (queuedBy === portId) live.queuedBy.delete(itemId)
      }
    }
    // A desktop app's page asked these; with its port gone no answer can come.
    const prefix = `${portId}:`
    for (const key of [...this.originRequests.keys()]) {
      if (key.startsWith(prefix)) {
        this.browserOriginSettled(Number(key.slice(prefix.length)), 'timeout', portId)
      }
    }
  }

  private markViewed(sessionId: string, record: SessionRecord): void {
    this.deps.events.seen(sessionId)
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
  /**
   * Without a `projectPath`, the session gets a scratch folder of its own. `portId` is the window
   * that sent the first message, whose draft a failed start hands it back to; the session tools
   * start sessions with no window and none.
   */
  async create(
    params: {
      agentId: AgentId
      projectPath: string | null
      parentId?: string
      options?: Record<string, string | boolean>
      prompt?: UserContent[]
      preparedId?: string
      /** The session whose agent started it through the session tools. */
      startedBy?: string
      /** Whose prompt the first message is, when another session's agent sends it. */
      from?: FromSession
      /** The paired device that sent the first message. */
      device?: FromDevice
      /** Its title, when another session's agent starts it; the prompt's first line otherwise. */
      title?: string
      /** A new worktree to work in, cut from `base`; a sub-session takes its parent's instead. */
      worktree?: { base: string; branch?: string }
    },
    portId?: string,
  ): Promise<SessionSummary> {
    const { agents, projects, scratch } = this.deps
    if (!agents.has(params.agentId)) throw invalidParams(`Unknown agent ${params.agentId}`)
    agents.assertEnabled(params.agentId)
    // Before a prepared session is taken over, so a refused prompt leaves it prepared.
    const prompt = params.prompt && this.hydrate(params.prompt)
    // A prepared session's agent already works in the project's folder, so a worktree starts anew.
    if (params.preparedId !== undefined && params.worktree === undefined) {
      const adopted = await this.adopt({
        agentId: params.agentId,
        preparedId: params.preparedId,
        prompt,
        device: params.device,
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
    let worktree: WorktreeRecord | undefined
    let newWorktree = false
    if (params.parentId !== undefined) {
      const inherited = this.recordOf(params.parentId).worktree
      if (inherited) worktree = { ...inherited }
    } else if (params.worktree !== undefined) {
      const manager = this.deps.worktrees
      if (!manager || scratch.contains(projectPath)) {
        throw invalidParams('A worktree needs a project in a Git repository')
      }
      worktree = await manager.create(projectPath, {
        base: params.worktree.base,
        ...(params.worktree.branch === undefined ? {} : { branch: params.worktree.branch }),
        text: (prompt && fallbackTitle(prompt)) ?? '',
      })
      newWorktree = true
    }
    const now = this.now()
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: params.agentId,
      acpSessionId: '',
      projectPath,
      ...(worktree ? { worktree } : {}),
      title: params.title ?? null,
      ...(params.title === undefined ? {} : { titleSource: 'agent' as const }),
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      parentId: params.parentId ?? null,
      origin: 'user',
      description: null,
      branch: null,
    }
    if (params.startedBy !== undefined) record.startedBy = params.startedBy
    const options = params.options ?? {}
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    live.used = true
    // The message shows at once and goes out as the session's first turn, so it never enters the
    // index without it.
    if (prompt) {
      live.first = {
        content: prompt,
        entryId: this.addPrompt(live, prompt, now, params.from, params.device),
        ...(params.from ? { from: params.from } : {}),
        ...(params.device ? { device: params.device } : {}),
        ...(portId === undefined ? {} : { portId }),
      }
    }
    this.touch(live.id)
    if (newWorktree && worktree) this.prepareWorktree(projectPath, worktree)
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
        if (prompt && portId !== undefined && !removed && !this.deps.portOpen(portId)) {
          this.returned.push({ sessionId: null, content: prompt, at: this.now() })
          this.saveReturned()
          const ids = attachmentIds(prompt)
          if (ids.length > 0) this.deps.attachments?.held(ids)
          this.deps.events.returned(null)
        }
        // A session closed or deleted while it started is already dropped.
        if (this.live.get(live.id) === live) this.dropLive(live)
        this.forget(live.id)
        if (newWorktree && worktree) {
          this.deps.worktrees?.stop(worktree.path)
          void this.discardWorktree(projectPath, worktree)
        }
        throw error
      }
    }
    return this.summary(live.id)
  }

  /**
   * A routine's run's session: created as `sessions.create` creates one, but top-level with
   * `origin: 'routine'`, in the routine's folder, in the mode its scope names, with the
   * routine's prompt as its first message.
   */
  async createRun(params: RoutineSessionStart): Promise<SessionSummary> {
    const { agents, projects, scratch } = this.deps
    if (!agents.has(params.agentId)) throw invalidParams(`Unknown agent ${params.agentId}`)
    agents.assertEnabled(params.agentId)
    const projectPath = await projects.resolveDirectory(params.projectPath)
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
      parentId: null,
      origin: 'routine',
      routine: params.routine,
      description: null,
      branch: null,
    }
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    live.used = true
    live.routineMode = params.mode
    live.routineScope = params.scope
    const content: UserContent[] = [{ type: 'text', text: params.prompt }]
    live.first = { content, entryId: this.addPrompt(live, content, now) }
    this.touch(live.id)
    // The run knows its session before anything goes out, so a permission request has somewhere
    // to go from its first moment.
    this.deps.routine?.current?.sessionCreated(live.id, params.routine)
    try {
      live.startValues = params.options
      await this.startNew(live)
    } catch (error) {
      if (this.live.get(live.id) === live) {
        this.dropLive(live)
        this.forget(live.id)
      }
      throw error
    }
    return this.summary(live.id)
  }

  /**
   * Removes and returns the messages kept for a session, or for every one when `sessionId` is
   * undefined, oldest first, but those held for another port; a taken one is gone.
   */
  takeReturned(sessionId?: string | null, portId?: string): ReturnedMessage[] {
    const taken = (message: (typeof this.returned)[number]) =>
      (sessionId === undefined || message.sessionId === sessionId) &&
      (message.portId === undefined || message.portId === portId)
    const messages = this.returned.filter(taken)
    if (messages.length === 0) return []
    this.returned = this.returned.filter((message) => !taken(message))
    this.saveReturned()
    return messages.map(({ sessionId, content }) => ({ sessionId, content }))
  }

  private saveReturned(): void {
    const messages = this.returned.map(({ sessionId, content, at }) => ({ sessionId, content, at }))
    this.deps.returned.save({ version: 1, messages })
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
    this.deps.agents.assertEnabled(params.agentId)
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
    const options = params.options ?? {}
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
        workDir(live.record),
        this.attachOptions(live.id, live.record, runtime),
      )
    } catch (error) {
      if (gone()) throw removedWhileStarting()
      const mapped = agentError(error)
      if (mapped.code === 'auth_required') this.deps.agents.authRequired(agentId)
      throw mapped
    }
    this.deps.prepared?.add({
      agentId,
      acpSessionId: setup.sessionId,
      cwd: workDir(live.record),
    })
    if (gone()) {
      await this.removeUnlisted(live.id, runtime, setup.sessionId)
      this.deps.prepared?.remove(agentId, setup.sessionId)
      throw removedWhileStarting()
    }
    live.record.acpSessionId = setup.sessionId
    this.stampConfig(live.record)
    this.attach(live, runtime.connection)
    // The cache names values the session no longer lists, so it is read before it takes them.
    const cached = this.deps.options?.get(agentId)?.config ?? []
    const own = setup.config
    const replaced =
      this.deps.options?.started(
        agentId,
        own,
        pathKey(live.record.projectPath, this.deps.platform),
      ) ?? []
    this.update(live, {
      acpSessionId: setup.sessionId,
      config: setup.config,
      error: null,
    })
    const wanted = {
      ...this.startModeOf(agentId),
      ...this.deps.options?.rememberedOf(agentId),
      ...picks,
    }
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
      prepared && this.deps.settingsTargets?.(live.record.agentId, workDir(live.record))
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
    device?: FromDevice
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
    const entryId = prompt ? this.addPrompt(live, prompt, now, undefined, params.device) : null
    this.save(live)
    this.touch(live.id)
    if (prompt && entryId) this.startTurn(live, prompt, now, entryId, portId)
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
        await this.cwdOf(live),
        this.attachOptions(live.id, live.record, runtime),
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
      await this.removeUnlisted(live.id, runtime, setup.sessionId)
      throw removedWhileStarting()
    }
    if (this.stopped) {
      // The quit ran while `session/new` was pending: the message waits in its queue and the
      // session goes into the index and the thread store as the quit closes them.
      live.record.acpSessionId = setup.sessionId
      this.update(live, {
        acpSessionId: setup.sessionId,
        config: chosenConfig(setup.config, live.startValues),
        status: 'closed',
      })
      this.save(live)
      this.holdFirst(live)
      this.checkpoint(live, { afterShutdown: true })
      return
    }
    live.record.acpSessionId = setup.sessionId
    this.stampConfig(live.record)
    this.attach(live, runtime.connection)
    live.failure = null
    const { agentId } = live.record
    const own = setup.config
    const replaced =
      this.deps.options?.started(
        agentId,
        own,
        pathKey(live.record.projectPath, this.deps.platform),
      ) ?? []
    // A remembered value that a later change outside Kettu replaced is not set again.
    for (const { option, wanted } of replaced) {
      if (live.startValues[option.id] === wanted) delete live.startValues[option.id]
    }
    this.update(live, {
      acpSessionId: setup.sessionId,
      config: setup.config,
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
        config: chosenConfig(config, live.startValues),
        status: 'closed',
      })
      this.persist(live)
      this.touch(live.id)
      const first = live.first
      live.first = null
      if (first) this.startTurn(live, first.content, this.now(), first.entryId, first.portId)
      return
    }
    // A run starts in the strictest mode that still asks, before anything is sent.
    if (live.record.origin === 'routine') await this.applyRoutineMode(live, runtime.connection)
    this.update(live, { status: 'ready' })
    this.deps.agents.signedIn(agentId)
    this.touch(live.id)
    const first = live.first
    live.first = null
    if (!first) return
    if (this.waitsForWorktree(live)) {
      live.heldFirst = first
      return
    }
    // The first message never goes out with a value the user did not choose.
    const wanted = Object.entries(live.startValues).flatMap(([id, value]): ConfigOption[] => {
      const option = config.find((o) => o.id === id) ?? own.find((o) => o.id === id)
      return option ? [{ ...option, value }] : []
    })
    const notice = lostValuesNotice(lostValues(wanted, config), { subject: 'start', held: true })
    if (!notice) {
      this.startTurn(live, first.content, this.now(), first.entryId, first.portId)
      return
    }
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          ...notice,
          after: agentEntryBefore(live.thread),
        },
      },
    ])
    this.update(live, {
      queue: [
        {
          id: randomUUID(),
          content: first.content,
          at: this.now(),
          ...(first.from ? { from: first.from } : {}),
          ...(first.device ? { device: first.device } : {}),
        },
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
    const { content, from } = live.first
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
          after: agentEntryBefore(live.thread),
        },
      },
    ])
    const queue = live.thread.session.queue
    this.update(live, {
      queue: [{ id: randomUUID(), content, at: this.now(), ...(from ? { from } : {}) }, ...queue],
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
          after: agentEntryBefore(live.thread),
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
    if (runtime.connection.hiddenSessions) {
      await runtime.connection.removeHidden(acpSessionId, log)
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
        else this.update(live, { config: next })
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

  /**
   * A run's session starts in the mode its level names; one that cannot be set fails the run
   * before anything is sent, so it never starts in a broader mode than its scope.
   */
  private async applyRoutineMode(live: Live, connection: AgentConnection): Promise<void> {
    const wanted = live.routineMode
    if (wanted === null) return
    const option = live.thread.session.config.find(
      (candidate) => candidate.category === 'mode' && candidate.type === 'select',
    )
    // An agent that offers no modes has no broader one to choose, and its own rules ask.
    if (!option) return
    const choice = option.choices?.find((candidate) => candidate.value === wanted)
    if (!choice) {
      throw new HostError(
        'restricted',
        t('routines.noScopeMode', { agent: this.deps.agents.name(live.record.agentId) }),
      )
    }
    if (option.value === wanted) return
    try {
      let config: ConfigOption[]
      if (option.id === SYNTHETIC_MODE_ID) {
        await connection.setMode(live.record.acpSessionId, wanted)
        config = live.thread.session.config.map((current) =>
          current.id === option.id ? { ...current, value: wanted } : current,
        )
      } else {
        config = mergeConfig(
          live.thread.session.config,
          await connection.setConfigOption(live.record.acpSessionId, option.id, wanted),
        )
      }
      this.update(live, { config })
      this.save(live)
    } catch {
      throw new HostError(
        'restricted',
        t('routines.modeFailed', { agent: this.deps.agents.name(live.record.agentId) }),
      )
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
   * Opens a session: a live one from memory, another from its stored thread without starting its
   * agent, which attaches once the session is used. One with no stored thread, as an imported
   * session, loads its history from the agent and stays live. Agent-side failures leave the
   * session live in `failed` or `auth_required`, so the snapshot shows them with Retry.
   */
  async open(sessionId: string, images: ImageMode = 'refs'): Promise<SessionSnapshot> {
    const existing = this.live.get(sessionId)
    if (existing) {
      if (existing.opening) await existing.opening
      return this.snapshot(sessionId, undefined, images)
    }
    const record = this.recordOf(sessionId)
    const page = await this.readPage(record, (store) => store.page(sessionId, null, null, images))
    if (this.live.has(sessionId) || !this.has(sessionId)) return this.open(sessionId, images)
    if (page) return this.storedSnapshot(record, page)
    if (record.origin === 'subagent' && record.parentId) {
      // A subagent's thread comes back with its parent's load, which replays the children.
      await this.open(record.parentId)
      return this.snapshot(sessionId, undefined, images)
    }
    const live = this.makeLive(record, true, 'starting')
    await this.runOpening(live)
    return this.snapshot(sessionId, undefined, images)
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
    const { acpSessionId } = live.record
    let projectPath: string
    try {
      projectPath = await this.cwdOf(live)
    } catch (error) {
      throw this.failStart(live, error, { action: 'load' })
    }
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
    const attach = this.attachOptions(live.id, live.record, runtime)
    try {
      if (useLoad) {
        this.prepareReplay(live, connection)
        let setup
        try {
          setup = await connection.loadSession(acpSessionId, projectPath, attach)
        } catch (error) {
          this.finishReplay(live, false)
          throw error
        }
        this.finishReplay(live, true)
        this.opened(live, setup.config)
      } else {
        const setup = await connection.resumeSession(acpSessionId, projectPath, attach)
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
                after: agentEntryBefore(live.thread),
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

  /** The agent's start mode changed: its prepared sessions started in the old one. */
  startModeChanged(agentId: AgentId): void {
    this.configChanged(agentId)
  }

  /**
   * The Marketplace's servers, their keys or its skills changed: the prepared sessions of each agent
   * for which `changed` holds started with the old ones. Open sessions keep theirs.
   */
  libraryChanged(changed: (agentId: AgentId) => boolean): void {
    const agentIds = new Set([...this.live.values()].map((live) => live.record.agentId))
    for (const agentId of agentIds) if (changed(agentId)) this.configChanged(agentId)
  }

  /**
   * The mode option set to the start mode the settings name for the agent, for a session the
   * agent starts or the window prepares; nothing when there is none, so the agent's own stays.
   */
  private startModeOf(agentId: AgentId): Record<string, string> {
    const mode = startModeIn(this.deps.settings(), agentId)
    const optionId = modeOptionId(agentId)
    return mode === undefined || optionId === null ? {} : { [optionId]: mode }
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
      this.endBackground(live)
      live.agentTurn = false
      const status = live.thread.session.status
      if (!CONNECTED.has(status) || status === 'starting' || status === 'auth_required') continue
      const turn = live.turn?.ended === false ? live.turn : null
      // Its attach fails with the exit and ends the turn as a failed attach does, so Retry sends
      // the prompt that never went out, and only once that attach has settled.
      if (turn && attaching) continue
      const cut = turn !== null && !turn.cancelRequested
      if (turn && !cut) {
        // The user had stopped it, so it ends stopped rather than cut short. The session closes
        // with its agent, so a prompt Send now chose waits first in the paused queue.
        live.sendNext = false
        this.endTurn(live, turn, 'cancelled', null)
      } else if (turn) {
        const givenBack = agentAddedNothing(live.thread, turn.entryId)
        if (givenBack) turn.attachments = []
        this.finishTurn(live, turn, null)
        this.emit(live, [
          {
            op: 'entry.add',
            entry: {
              kind: 'notice',
              id: this.nextId(live),
              severity: 'error',
              ...stoppedNotice(name),
              after: agentEntryBefore(live.thread),
            },
          },
        ])
        if (givenBack) this.giveBack(live, turn)
      }
      this.clearPermissions(live, 'withdrawn')
      live.childRunning = false
      if (cut) {
        const now = this.now()
        this.update(live, { updatedAt: now })
        if (this.inFront(live.id)) live.record.lastViewedAt = now
        this.persist(live)
        const stopped: { message: string } = { message: t('notice.stopped.title', { agent: name }) }
        const routineTurn = turn
          ? this.reportRun(live, { stopReason: null, error: stopped, usage: null, turn })
          : false
        if (!routineTurn) {
          this.deps.events.attention(live.id, 'error', this.titleOf(live), stopped.message)
        }
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
   * Re-runs what failed: the sign-in retry, a resume, a load after a failed resume, or the latest
   * turn of a message, failed or refused by the model provider for want of credit.
   */
  async retry(sessionId: string, portId?: string): Promise<void> {
    this.assertRegistered(sessionId)
    let live = this.live.get(sessionId)
    if (!live) {
      const snapshot = await this.open(sessionId)
      // A failed turn is sent again after a restart too, from its stored thread.
      if (
        this.recordOf(sessionId).origin === 'subagent' ||
        !retryableTurn(threadFromSnapshot(snapshot))
      ) {
        return
      }
      live = await this.revive(sessionId)
    }
    if (live.opening) return live.opening
    // A subagent recovers with its parent; its own failures are the agent's to retry.
    if (live.record.origin === 'subagent') return
    const status = live.thread.session.status
    const failed = canSend(status) ? retryableTurn(live.thread) : null
    if (failed) {
      // The same prompt again, under its own entry; the turn attaches the session if it has to.
      live.used = true
      this.startTurn(live, failed.prompt.content, this.now(), failed.prompt.id, portId)
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
        this.startTurn(live, failure.content, this.now(), failure.entryId, portId)
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
    if (waitingCount(live) > 0 || this.contextRuns.has(live.id)) return true
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
    if (this.stopped || live.closing || !live.saved || live.record.origin === 'subagent') return
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
    const { config, commands, usage, context } = stored.session
    live.thread = {
      session: {
        ...live.thread.session,
        config: this.deps.agents.restoreConfig(live.record.agentId, config, live.record),
        commands,
        usage,
        ...storedContext(context),
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
    const own = live.thread.session.config
    const runtime = await this.deps.agents.ensureReady(record.agentId)
    const caps = runtime.init.capabilities
    const { connection } = runtime
    // A takeover's agent opens its own session at the values chosen for it, not the session's.
    const carry = record.carry
    // A released session is marked closed on the connection; what the agent sends before the
    // session attaches waits for it instead of being dropped.
    if (record.acpSessionId !== '') connection.reopen(record.acpSessionId)
    let config: ConfigOption[]
    if (record.acpSessionId === '') {
      // An agent taking the session over that never had it.
      config = await this.renew(live, connection, this.attachOptions(live.id, record, runtime))
      this.deps.options?.started(
        record.agentId,
        config,
        pathKey(record.projectPath, this.deps.platform),
      )
    } else if (caps.resumeSession) {
      const attach = this.attachOptions(live.id, record, runtime)
      try {
        config = (
          await connection.resumeSession(record.acpSessionId, await this.cwdOf(live), attach)
        ).config
      } catch (error) {
        if (carry) {
          // The session it had is gone, so it starts over with the whole conversation.
          carry.fromTurn = 1
          config = await this.renew(live, connection, attach)
          this.deps.options?.started(
            record.agentId,
            config,
            pathKey(record.projectPath, this.deps.platform),
          )
        } else {
          if (!this.neverAnswered(live, error)) throw this.otherConfig(live, error)
          config = await this.renew(live, connection, attach)
        }
      }
    } else if (caps.loadSession) {
      const attach = this.attachOptions(live.id, record, runtime)
      try {
        config = (await this.loadQuietly(live, connection, attach)).config
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
    const wanted = carry
      ? this.takeoverValues(record.agentId, config, carry)
      : carryMode(own, config)
    config = await this.applyStartOptions(live, connection, agentValues(wanted), {
      restore: !carry,
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
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          ...notice,
          after: agentEntryBefore(live.thread),
        },
      },
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

  /**
   * The options a takeover's agent starts with, as a new session's would: its start mode, its
   * remembered values, then what was chosen with the switch.
   */
  private takeoverValues(
    agentId: AgentId,
    config: readonly ConfigOption[],
    carry: PendingCarry,
  ): ConfigOption[] {
    const values = {
      ...this.startModeOf(agentId),
      ...this.deps.options?.rememberedOf(agentId),
      ...carry.values,
    }
    return config.flatMap((option): ConfigOption[] => {
      const value = values[option.id]
      return value !== undefined && isValueOf(option, value) ? [{ ...option, value }] : [option]
    })
  }

  /** A loaded or resumed session's options, which New session also learns from. */
  private opened(live: Live, config: ConfigOption[]): void {
    const { agentId } = live.record
    this.update(live, { config })
    this.deps.options?.opened(agentId, config)
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
    attach: SessionOptions,
  ): Promise<ConfigOption[]> {
    const setup = await connection.newSession(await this.cwdOf(live), attach)
    live.record.acpSessionId = setup.sessionId
    this.stampConfig(live.record)
    live.rewrite = true
    this.update(live, { acpSessionId: setup.sessionId })
    this.save(live)
    return setup.config
  }

  /** `session/load` with its replay going nowhere, since the thread is already here. */
  private async loadQuietly(
    live: Live,
    connection: AgentConnection,
    attach: SessionOptions,
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
      send: () => {},
      startMode: () => null,
    }
    connection.register(record.acpSessionId, quiet)
    try {
      return await connection.loadSession(record.acpSessionId, workDir(record), attach)
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
   * What fills the session's context, from the agent's connection when it reads it, else from the
   * agent's `/context` report. That runs in a fork, deleted afterwards, so the session's own thread
   * and history stay as they were. Null for an agent without either. A session whose turn runs is
   * read when its connection answers directly, and a report waits for the turn to end. A session
   * no turn runs in is read without attaching it: the fork starts from its transcript on disk, and
   * the agent's idle stop ends it again.
   */
  context(sessionId: string, force = false): Promise<ContextBreakdown | null> {
    const running = this.contextRuns.get(sessionId)
    if (running) return running
    const live = this.live.get(sessionId)
    const report = live?.thread.session.context
    if (
      live &&
      !force &&
      report?.breakdown &&
      !report.error &&
      !live.contextDirty &&
      this.now() - live.contextReadAt < this.timings.contextRefreshMs
    ) {
      return Promise.resolve(report.breakdown)
    }
    if (live) {
      if (live.contextTimer) clearTimeout(live.contextTimer)
      live.contextTimer = null
      live.contextDirty = false
      live.contextOwed = false
      live.contextReadAt = this.now()
    }
    const run = this.readContext(sessionId)
      .catch((error: unknown) => {
        if (live && this.contextCurrent(live)) {
          live.contextFailures++
          const previous = live.thread.session.context
          this.update(live, {
            context: {
              key: previous?.key ?? '',
              breakdown: previous?.breakdown ?? null,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
        throw error
      })
      .finally(() => {
        if (this.contextRuns.get(sessionId) === run) this.contextRuns.delete(sessionId)
        if (live && this.contextCurrent(live)) {
          const active = this.contextActive(live)
          const retry = live.contextFailures > 0 && live.contextFailures <= 3
          if (this.contextWanted(live) && (live.contextDirty || active || retry)) {
            const delay = live.contextDirty
              ? this.timings.contextDebounceMs
              : this.timings.contextRefreshMs * Math.min(8, 2 ** live.contextFailures)
            this.scheduleContext(live, delay)
          }
          this.refreshRelease(live)
        }
      })
    this.contextRuns.set(sessionId, run)
    return run
  }

  private async readContext(sessionId: string): Promise<ContextBreakdown | null> {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.recordOf(sessionId)
    if (!this.deps.agents.hasContext(record.agentId) || record.origin === 'subagent') return null
    const status = live?.thread.session.status ?? 'closed'
    // A starting session has no query to read yet. A running one can be read when its connection
    // answers directly, as Claude Code's does; a report in a fork waits for the turn to end.
    if (status === 'starting') throw busyError(status)
    const revision = live?.contextRevision
    if (live && this.contextCurrent(live)) {
      const previous = live.thread.session.context
      this.update(live, {
        context: {
          key: previous?.key ?? '',
          breakdown: previous?.breakdown ?? null,
          loading: true,
          error: previous?.error ?? null,
        },
      })
    }
    const runtime = await this.deps.agents.ensureReady(record.agentId)
    if (live && !this.contextCurrent(live)) return null
    const { connection } = runtime
    const running = status === 'running' || status === 'awaiting_permission'
    if (running && !connection.readContext) throw busyError(status)
    let breakdown: ContextBreakdown | null
    if (connection.readContext) {
      try {
        breakdown = await connection.readContext(record.acpSessionId, workDir(record), {})
      } catch (error) {
        throw agentError(error)
      }
    } else {
      const agent = this.deps.agents.name(record.agentId)
      if (!runtime.init.capabilities.forkSession) {
        throw new HostError('agent_unavailable', t('session.cannotFork', { agent }))
      }
      const log = (message: string): void => this.deps.diagnostics.log('warn', message)
      let messages: string[]
      try {
        messages = await runReport(
          runtime,
          async () =>
            (
              await connection.forkSession(record.acpSessionId, workDir(record), {
                hidden: 'context',
              })
            ).sessionId,
          CONTEXT_REPORT,
          log,
        )
      } catch (error) {
        throw agentError(error)
      }
      const now = this.now()
      breakdown =
        messages
          .map((text) => parseContextReport(text, now))
          .findLast((report) => report !== null) ?? null
      if (!breakdown) {
        log(`${agent}: /context gave no report Kettu can read`)
        throw new HostError(
          'agent_error',
          t('agent.unreadableReport', { agent, command: CONTEXT_REPORT.command }),
        )
      }
    }
    this.applyContextUsage(live, breakdown, revision)
    return breakdown
  }

  private assertRegistered(sessionId: string): void {
    const { agentId } = this.recordOf(sessionId)
    if (!this.deps.agents.has(agentId)) throw new HostError('agent_unavailable', t('agent.removed'))
    this.deps.agents.assertEnabled(agentId)
  }

  /**
   * Keeps the session's usage in step with a breakdown: some connections report the context only
   * in the breakdown, and a running turn updates it before the agent's next usage event arrives.
   */
  private applyContextUsage(
    live: Live | undefined,
    breakdown: ContextBreakdown,
    revision?: number,
  ): void {
    if (!live || breakdown.size <= 0 || !this.contextCurrent(live)) return
    live.contextFailures = 0
    const usage = live.thread.session.usage
    const changes: Partial<SessionView> = {
      context: {
        key: `${breakdown.used}/${breakdown.size}`,
        breakdown,
        loading: false,
        error: null,
      },
    }
    // A usage event newer than the read must not be replaced by the older snapshot's count.
    if (
      live.contextRevision === revision &&
      (usage?.used !== breakdown.used || usage.size !== breakdown.size)
    ) {
      changes.usage = {
        used: breakdown.used,
        size: breakdown.size,
        cost: usage?.cost ?? null,
        tokens: usage?.tokens ?? null,
        ...(usage?.cache ? { cache: usage.cache } : {}),
      }
    }
    this.update(live, changes)
  }

  /** Sends a prompt; a session that is not attached attaches to its agent as the turn starts. */
  async prompt(
    sessionId: string,
    content: UserContent[],
    portId?: string,
    device?: FromDevice,
  ): Promise<void> {
    this.assertRegistered(sessionId)
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noPrompt'))
    }
    this.refuseIfCannotSend(sessionId)
    const hydrated = this.hydrate(content)
    const live = await this.revive(sessionId)
    if (!canSend(live.thread.session.status) || this.waitsForWorktree(live)) {
      throw busyError(live.thread.session.status)
    }
    this.sendPrompt(live, hydrated, undefined, portId, device)
  }

  private sendPrompt(
    live: Live,
    content: UserContent[],
    from?: FromSession,
    portId?: string,
    device?: FromDevice,
  ): void {
    live.used = true
    const now = this.now()
    this.startTurn(live, content, now, this.addPrompt(live, content, now, from, device), portId)
  }

  /**
   * Hands the session to another agent between turns and sends `content` as its first turn: the
   * current agent lets its own session go, and the new one starts a session of its own, or resumes
   * the one it had, given the conversation it has not seen.
   */
  async switchAgent(
    params: {
      sessionId: string
      agentId: AgentId
      content: UserContent[]
      options?: Record<string, string | boolean>
      summarize?: boolean
    },
    portId?: string,
    device?: FromDevice,
  ): Promise<void> {
    const { sessionId, agentId } = params
    // Not the current agent's checks: a session whose agent was removed or turned off goes on so.
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noPrompt'))
    }
    this.refuseIfCannotSend(sessionId)
    if (!this.deps.agents.has(agentId)) throw invalidParams(`Unknown agent ${agentId}`)
    this.deps.agents.assertEnabled(agentId)
    const hydrated = this.hydrate(params.content)
    const live = await this.revive(sessionId)
    const { status } = live.thread.session
    if (!canSend(status) || live.turn || waitingCount(live) > 0) throw busyError(status)
    if (live.record.agentId !== agentId || live.record.carry) {
      await this.handOver(live, agentId, params.options ?? {}, params.summarize === true)
    }
    this.sendPrompt(live, hydrated, undefined, portId, device)
  }

  /**
   * The session's agent becomes `agentId`: its subagents and its own session close, the thread
   * marks the takeover, and what the new agent is to be given waits for its first turn.
   */
  private async handOver(
    live: Live,
    agentId: AgentId,
    values: Record<string, string | boolean>,
    summarize: boolean,
  ): Promise<void> {
    const { record } = live
    const from = record.agentId
    await this.closeAll(this.descendants(live.id, 'subagent'), true)
    await this.letGo(live)
    // A takeover whose turn never went keeps its line in the thread, now for this agent.
    const pending = record.carry
    const entryId = pending?.entryId ?? this.nextId(live)
    const earlier: EarlierAgent[] = [...(record.earlier ?? [])]
    // An agent taken back whose turn never went is listed still, with what it saw.
    const listed = earlier.some(
      (item) => item.agentId === from && item.acpSessionId === record.acpSessionId,
    )
    if (record.acpSessionId !== '' && !listed) {
      earlier.push({
        agentId: from,
        acpSessionId: record.acpSessionId,
        ...(record.configDir ? { configDir: record.configDir } : {}),
        endedAt: entryId,
      })
    }
    // Its own session again, when it had the session before; it saw every turn up to then.
    const back = earlier.findLast((item) => item.agentId === agentId && item.acpSessionId !== '')
    let fromTurn = 1
    if (back) {
      fromTurn = turnsBefore(live.thread, back.endedAt) + 1
      record.acpSessionId = back.acpSessionId
      if (back.configDir) record.configDir = back.configDir
      else delete record.configDir
    } else {
      record.acpSessionId = ''
      delete record.configDir
    }
    record.agentId = agentId
    if (earlier.length > 0) record.earlier = earlier
    record.carry = {
      entryId,
      fromTurn,
      ...(summarize ? { summarize: true } : {}),
      ...(Object.keys(values).length > 0 ? { values } : {}),
    }
    // As a fork does: a title of its own, so one the new agent gives its session does not replace it.
    const title = record.customTitle ?? live.thread.session.title
    if (title !== null && record.customTitle === undefined) record.customTitle = title
    delete record.cache
    delete record.model
    const usage = live.thread.session.usage
    const cached = this.deps.options?.get(agentId)?.config ?? []
    this.emit(live, [
      pending && live.thread.byId[entryId]?.kind === 'takeover'
        ? { op: 'entry.update', id: entryId, changes: { agentId, summarize } }
        : {
            op: 'entry.add',
            entry: {
              kind: 'takeover',
              id: entryId,
              agentId,
              turns: 0,
              omitted: 0,
              carried: '',
              ...(summarize ? { summarize: true } : {}),
              after: agentEntryBefore(live.thread),
            },
          },
    ])
    this.update(live, {
      agentId,
      acpSessionId: record.acpSessionId,
      config: chosenConfig(cached, values),
      commands: [],
      // The totals stay the session's; the context is the new agent's, unknown until it reports.
      usage: usage ? { ...usage, used: 0, size: 0, cache: undefined } : null,
      context: undefined,
      // The new agent says whether it reports background tasks once it attaches.
      background: undefined,
      status: 'closed',
      error: null,
    })
    this.save(live)
    this.touch(live.id)
    this.deps.agents.sessionsChanged(from)
    this.deps.agents.sessionsChanged(agentId)
    this.deps.diagnostics.event(agentId, 'session taken over', `${live.id} from ${from}`)
  }

  /** Closes the agent's own session of a live session that stays, as a release would. */
  private async letGo(live: Live): Promise<void> {
    const { connection } = live
    const { agentId, acpSessionId } = live.record
    if (live.contextTimer) clearTimeout(live.contextTimer)
    live.contextTimer = null
    this.contextRuns.delete(live.id)
    this.endBackground(live)
    live.agentTurn = false
    if (!connection) return
    connection.unregister(acpSessionId, live.target)
    live.connection = null
    this.deps.mcp?.detached(live.id)
    const runtime = this.deps.agents.runtime(agentId)
    if (acpSessionId && runtime?.init.capabilities.closeSession && !connection.isClosed) {
      await connection.closeSession(acpSessionId).catch((error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `session/close failed for ${live.id}: ${(error as Error).message}`,
        )
      })
    }
  }

  /** What the session's new agent is given with its first turn, from the thread before it took over. */
  private carriedFor(live: Live, carry: PendingCarry): CarriedContext | null {
    const { order, byId } = live.thread
    const end = order.indexOf(carry.entryId)
    const entries = (end < 0 ? order : order.slice(0, end)).flatMap((id) => {
      const entry = byId[id]
      return entry ? [entry] : []
    })
    return carriedContext(entries, {
      firstAgent: this.firstAgentOf(live.record),
      agentName: (id) => this.deps.agents.name(id),
      fromTurn: carry.fromTurn,
      summarize: carry.summarize === true,
    })
  }

  /**
   * The first turn of a takeover's agent: the conversation it missed goes into its history where
   * its agent takes one, else in front of the prompt, and the takeover's line says what went.
   */
  private async withCarried(
    live: Live,
    connection: AgentConnection,
    carry: PendingCarry,
    wire: PromptBlock[],
  ): Promise<PromptBlock[]> {
    const { record } = live
    const carried = this.carriedFor(live, carry)
    let out = wire
    if (carried) {
      let injected = false
      if (connection.injectHistory) {
        injected = await connection
          .injectHistory(record.acpSessionId, carried.messages)
          .catch((error: unknown) => {
            this.deps.diagnostics.log(
              'warn',
              `Could not add the earlier conversation to ${live.id}: ${agentError(error).message}`,
            )
            return false
          })
      }
      if (!injected) out = [{ type: 'text', text: `${carried.text}\n\n` }, ...wire]
      this.emit(live, [
        {
          op: 'entry.update',
          id: carry.entryId,
          changes: { turns: carried.turns, omitted: carried.omitted, carried: carried.text },
        },
      ])
    }
    delete record.carry
    // The session it had is its current one now, no longer an earlier agent's to take back.
    record.earlier = record.earlier?.map((item) =>
      item.agentId === record.agentId && item.acpSessionId === record.acpSessionId
        ? { ...item, acpSessionId: '' }
        : item,
    )
    this.save(live)
    return out
  }

  /** The agent that had the session before any takeover. */
  private firstAgentOf(record: SessionRecord): AgentId {
    return record.earlier?.[0]?.agentId ?? record.agentId
  }

  /** The session's turns as the history tool reads them, numbered over the whole thread. */
  async historyTurns(sessionId: string): Promise<RenderedTurn[]> {
    const live = await this.revive(sessionId)
    return threadTurns(threadEntries(live.thread), this.firstAgentOf(live.record), (id) =>
      this.deps.agents.name(id),
    )
  }

  /** The user entry of a prompt, and the title it gives a session that has none; its entry id. */
  private addPrompt(
    live: Live,
    content: UserContent[],
    now: number,
    from?: FromSession,
    device?: FromDevice,
  ): string {
    const entryId = this.nextId(live)
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'user',
          id: entryId,
          content,
          at: now,
          ...(from ? { from } : {}),
          ...(device ? { device } : {}),
        },
      },
    ])
    if (live.thread.session.title === null) {
      const title = fallbackTitle(content)
      if (title) {
        this.update(live, { title })
        // The message a written title comes from, which the turn that starts now sends.
        if (live.record.titleSource === undefined) live.titlePrompt = content
      }
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
    /** The content with the bytes of the images the thread store keeps, for a composer. */
    written: UserContent[]
    blobs: StoredBlob[]
    ids: string[]
  }> {
    const store = this.deps.attachments
    const prompt = this.deps.agents.status(live.record.agentId).capabilities.prompt
    const wire: PromptBlock[] = []
    const shown: UserContent[] = []
    const written: UserContent[] = []
    const blobs: StoredBlob[] = []
    const ids: string[] = []
    // A pasted text sent as text follows the message's text after a blank line.
    const attach = (block: PromptBlock) => {
      const last = wire.at(-1)
      if (block.type === 'text' && last?.type === 'text') {
        wire[wire.length - 1] = { ...last, text: `${last.text}\n\n${block.text}` }
      } else {
        wire.push(block)
      }
    }
    for (const item of content) {
      if (item.type === 'ref' && item.ref.kind === 'image' && 'blob' in item.ref) {
        // An image the thread store keeps, as a message of a session that came back from it.
        const { blob, mimeType } = item.ref
        const stored = await this.storedBlob(live.id, blob).catch(() => null)
        if (!stored) throw notFound(t('session.attachmentGone', { name: mimeType }))
        const data = Buffer.from(stored.data).toString('base64')
        wire.push({ type: 'image', mimeType: stored.mime, data })
        shown.push(item)
        written.push({ type: 'ref', ref: { kind: 'image', mimeType, data } })
        continue
      }
      written.push(item)
      if (item.type !== 'ref' || item.ref.kind !== 'attachment') {
        wire.push(...promptBlocks([item]))
        shown.push(item)
        continue
      }
      if (item.ref.attachment.sent) {
        // Sent before, as when the agent asked to sign in: again from what the thread keeps.
        attach(await this.resend(live, item.ref.attachment))
        shown.push(item)
        continue
      }
      if (!store) throw invalidParams('This host takes no attachments')
      const record = store.get(item.ref.attachment.id)
      const sent = await sendAttachment(store, record, prompt)
      ids.push(record.id)
      if (sent.blob) blobs.push(sent.blob)
      attach(sent.block)
      shown.push({
        type: 'ref',
        ref: { kind: 'attachment', attachment: { ...store.view(record.id), ...sent.changes } },
      })
    }
    // A text file is read again as it goes, so it may have grown since the prompt was counted.
    if (wire.reduce((sum, block) => sum + blockBytes(block), 0) > PROMPT_BYTES) {
      throw invalidParams(t('session.promptTooLarge'))
    }
    return { wire, shown, written, blobs, ids }
  }

  private async resend(live: Live, attachment: Attachment): Promise<PromptBlock> {
    const { uri, name, mimeType, size } = attachment
    if (attachment.type === 'text') {
      const stored = attachment.blob
        ? await this.storedBlob(live.id, attachment.blob).catch(() => null)
        : null
      if (!stored) throw notFound(t('session.attachmentGone', { name }))
      const text = Buffer.from(stored.data).toString('utf8')
      return pastedTextBlock(text, attachment.sent === 'embedded' ? uri : null, stored.mime)
    }
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

  /** Keeps the sent bytes for the thread store. */
  private commitAttachments(
    live: Live,
    resolved: { shown: UserContent[]; blobs: StoredBlob[]; ids: string[] },
  ): void {
    if (resolved.ids.length === 0) return
    for (const blob of resolved.blobs) live.blobs.set(blob.hash, blob)
    this.showSent(live, resolved.shown)
    this.scheduleCheckpoint(live)
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

  // The queue: Kettu's own, for every agent, since ACP has none. One turn runs at a time,
  // and the oldest waiting prompt goes when a turn ends normally.

  /**
   * Queues a prompt behind the running turn, or sends it at once when the session is free and
   * nothing waits, or only a paused queue does. The composer always sends through here, so a
   * prompt sent before it heard that a turn started is queued, not refused.
   */
  async queue(
    sessionId: string,
    input: UserContent[],
    portId?: string,
    device?: FromDevice,
  ): Promise<{ itemId: string | null }> {
    this.assertRegistered(sessionId)
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noPrompt'))
    }
    this.refuseIfCannotSend(sessionId)
    const content = this.hydrate(input)
    const live = await this.revive(sessionId)
    const { status, queue, queuePaused } = live.thread.session
    if (canSend(status) && (queue.length === 0 || queuePaused) && !this.waitsForWorktree(live)) {
      // At once: another prompt waiting on the same revive must see this turn running.
      this.sendPrompt(live, content, undefined, portId, device)
      return { itemId: null }
    }
    if (!canSend(status) && status !== 'running' && status !== 'awaiting_permission') {
      throw busyError(status)
    }
    const item = { id: randomUUID(), content, at: this.now(), ...(device ? { device } : {}) }
    if (portId !== undefined) live.queuedBy.set(item.id, portId)
    this.update(live, { queue: [...queue, item] })
    this.persist(live)
    this.touch(live.id)
    return { itemId: item.id }
  }

  async unqueue(sessionId: string, itemId: string): Promise<void> {
    const live = await this.revive(sessionId)
    const { queue } = live.thread.session
    if (!queue.some((item) => item.id === itemId)) throw notFound(`No queued prompt ${itemId}`)
    live.queuedBy.delete(itemId)
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
    this.assertRegistered(sessionId)
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
          ...(item.device ? { device: item.device } : {}),
        },
      },
    ])
    this.commitAttachments(live, resolved)
    if (resolved.ids.length > 0) void this.deps.attachments?.release(resolved.ids)
    live.queuedBy.delete(itemId)
    this.update(live, { queue: queue.filter((i) => i.id !== itemId) })
    this.persist(live)
    this.touch(live.id)
  }

  /**
   * Sends a queued prompt now: into the running turn where the agent steers; otherwise as the next
   * turn, by moving it to the front of the queue and stopping this one.
   */
  async sendNow(sessionId: string, itemId: string): Promise<void> {
    this.assertRegistered(sessionId)
    const live = await this.revive(sessionId)
    if (this.deps.agents.status(live.record.agentId).capabilities.steering) {
      return this.steer(sessionId, itemId)
    }
    const { queue } = live.thread.session
    const item = queue.find((i) => i.id === itemId)
    if (!item) throw notFound(`No queued prompt ${itemId}`)
    if (!live.turn || live.turn.ended) throw new HostError('busy', t('session.noTurn'))
    this.update(live, { queue: [item, ...queue.filter((i) => i.id !== itemId)] })
    this.persist(live)
    live.sendNext = true
    try {
      await this.cancel(sessionId)
    } catch (error) {
      // The stop did not go out, so the turn's end pauses the queue as before.
      live.sendNext = false
      throw error
    }
  }

  async resumeQueue(sessionId: string): Promise<void> {
    this.assertRegistered(sessionId)
    this.refuseIfCannotSend(sessionId)
    const live = await this.revive(sessionId)
    this.update(live, { queuePaused: false })
    this.drainQueue(live)
    this.persist(live)
    this.touch(live.id)
  }

  /**
   * Sends the oldest waiting prompt when the session is free and the queue is not paused, or even
   * when it is, for the prompt Send now chose.
   */
  private drainQueue(live: Live, chosen = false): void {
    if (
      !this.deps.agents.has(live.record.agentId) ||
      this.deps.agents.isDisabled(live.record.agentId)
    ) {
      return
    }
    const { status, queue, queuePaused } = live.thread.session
    const [next, ...rest] = queue
    if (!next || (queuePaused && !chosen) || !canSend(status) || this.waitsForWorktree(live)) return
    this.update(live, { queue: rest, ...(rest.length === 0 ? { queuePaused: false } : {}) })
    const queuedBy = live.queuedBy.get(next.id)
    live.queuedBy.delete(next.id)
    this.sendPrompt(live, next.content, next.from, queuedBy, next.device)
  }

  private pauseQueue(live: Live): void {
    if (live.thread.session.queue.length > 0) this.update(live, { queuePaused: true })
  }

  private startTurn(
    live: Live,
    content: UserContent[],
    now: number,
    entryId: string | null = null,
    portId: string | null = null,
  ): void {
    const turn = this.openTurn(live, now, content, entryId, portId, false)
    if (live.record.origin === 'routine' && !live.routineTurnStarted) {
      live.routineTurnStarted = true
      this.deps.routine?.current?.turnStarted(live.id)
    }
    this.maybeWriteTitle(live)
    void this.runTurn(live, turn)
  }

  private openTurn(
    live: Live,
    now: number,
    content: UserContent[],
    entryId: string | null,
    portId: string | null,
    byAgent: boolean,
  ): Turn {
    const turn: Turn = {
      startedAt: now,
      content,
      written: content,
      attachments: [],
      entryId,
      portId,
      ended: false,
      cancelRequested: false,
      fallback: null,
      requested: false,
      byAgent,
    }
    live.turn = turn
    live.sender =
      portId === null ? null : { portId, device: this.deps.portDevice?.(portId) ?? null }
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
    return turn
  }

  /**
   * A turn the agent started between the host's, as when a command it ran in the background
   * ended. It runs as any turn does, with no message, and ends when the agent says it has.
   */
  private agentTurn(live: Live, effect: Extract<MapperEffect, { kind: 'agentTurn' }>): void {
    if (effect.phase === 'started' || effect.phase === 'joined') {
      // A prompt that crossed it joins it, and its turn ends the two as one.
      live.agentTurn = effect.phase === 'started'
      this.followAgentTurn(live)
      return
    }
    live.agentTurn = false
    if (live.unansweredCancel?.byAgent) live.unansweredCancel = null
    const turn = live.turn
    if (!turn?.byAgent || turn.ended) return
    if (effect.phase === 'failed') {
      this.failTurn(live, turn, effect.error)
      return
    }
    const { stopReason, tokens, models } = effect.result
    this.endTurn(live, turn, stopReason, tokens, models)
  }

  /**
   * Shows the agent's own turn once no other runs: it can start just as the host's turn ends,
   * before the host has heard that turn's answer.
   */
  private followAgentTurn(live: Live): void {
    if (!live.agentTurn || live.turn || live.closing) return
    this.openTurn(live, this.now(), [], null, null, true)
  }

  /**
   * Starts a written title for the message that gave the session its first title, when a turn of
   * it starts: once, and again on a later turn only after the last try failed 5 minutes ago.
   */
  private maybeWriteTitle(live: Live): void {
    const message = live.titlePrompt
    if (!message || live.titleWriting) return
    if (!this.deps.settings().sessionTitles) return
    if (live.record.origin !== 'user' || live.record.titleSource !== undefined) return
    if (live.record.customTitle !== undefined) return
    if (titleMessageText(message).trim() === '') return
    if (live.titleFailedAt !== null && this.now() - live.titleFailedAt < SUMMARY_RETRY_MS) {
      return
    }
    live.titleWriting = true
    void this.writeTitle(live, message)
  }

  /** Asks the agent's hidden session for a title and applies it, unless another came meanwhile. */
  private async writeTitle(live: Live, message: UserContent[]): Promise<void> {
    const { agentId } = live.record
    const name = this.deps.agents.name(agentId)
    try {
      const runtime = await this.deps.agents.ensureReady(agentId)
      // Only an agent that titles none has Kettu pay for one.
      if (runtime.init.capabilities.ownTitles !== null) {
        live.titlePrompt = null
        return
      }
      // The reports folder holds every hidden session, made once for the first of them.
      await mkdir(this.deps.reportsDir, { recursive: true })
      const title = await writeSessionTitle(runtime, {
        dir: this.deps.reportsDir,
        sessionModel: modelOf(live.thread.session.config),
        message,
        log: (line) => this.deps.diagnostics.log('warn', line),
      })
      this.applyWrittenTitle(live, title)
    } catch (error) {
      live.titleFailedAt = this.now()
      this.deps.diagnostics.log(
        'warn',
        `${name}: could not title session ${live.id}: ${(error as Error).message}`,
      )
    } finally {
      live.titleWriting = false
    }
  }

  /** A title a hidden session wrote, under the user's and over the cut first line. */
  private applyWrittenTitle(live: Live, title: string): void {
    const current = this.live.get(live.id)
    const record = current?.record ?? this.records.get(live.id)
    if (!record || record.titleSource !== undefined) return
    record.titleSource = 'written'
    if (current) {
      current.titlePrompt = null
      this.update(current, { title })
      this.persist(current)
      this.touch(current.id)
      return
    }
    record.title = title
    this.saveRecord(live.id)
  }

  /**
   * `session/fork`: a new session that starts from this one's history, or from the reply that
   * `entryId` names up to the end of its turn. The agent keeps the history; the fork shows a copy
   * of this thread until it is replayed on a later open. While a turn runs, the fork ends at the
   * reply before it, or at the one named, and the turn goes on in this session.
   */
  /**
   * A fork of a session in a worktree gets a worktree of its own, cut from the source's branch,
   * unless `worktree` is `same`: two sessions changing one folder would overwrite each other.
   */
  async fork(
    sessionId: string,
    entryId?: string,
    worktree: 'new' | 'same' = 'new',
  ): Promise<SessionSummary> {
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noFork'))
    }
    const source = await this.revive(sessionId)
    const status = source.thread.session.status
    const turnRuns = status === 'running' || status === 'awaiting_permission'
    if (status !== 'closed' && !turnRuns && (status !== 'ready' || !source.connection)) {
      throw busyError(status)
    }
    const at = entryId ?? (turnRuns ? replyBeforeTurn(source.thread) : undefined)
    const cut = at === undefined ? null : forkCut(source.thread, at)
    // Nothing before the running turn, or a reply of it, has no end to cut at yet.
    if (turnRuns && cut === null) throw busyError(status)
    // A reply of an agent that had the session before goes to that agent, as a takeover would.
    const writer =
      at === undefined
        ? source.record.agentId
        : writerOf(source.thread, at, this.firstAgentOf(source.record))
    if (cut && writer !== source.record.agentId)
      return this.forkToEarlier(source, cut.entries, writer)
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
      // Without a reply to name, the session menu's fork cannot say where a running turn starts.
      if (entryId === undefined) throw busyError(status)
      throw new HostError(
        'agent_unavailable',
        t('session.cannotForkAt', { agent: this.deps.agents.name(source.record.agentId) }),
      )
    }
    // A closed session takes prompts while it attaches; a turn that started since then wins,
    // unless the fork ends at a reply, which that turn does not change.
    const after = source.thread.session.status
    if (after !== 'ready' && !(cut && (after === 'running' || after === 'awaiting_permission'))) {
      throw busyError(after)
    }
    // Subagent cards point at the source's sub-sessions, which the fork does not have.
    const entries = (cut?.entries ?? threadEntries(source.thread)).filter(
      (entry) => entry.kind !== 'subagent',
    )
    // Read now, so the reads go before a delete of the source that would take the bytes with it.
    const reading = Promise.all(
      [...storedBlobs(entries)].map((hash) => this.storedBlob(source.id, hash).catch(() => null)),
    )
    const forkId = randomUUID()
    const own = await this.forkWorktree(source.record, worktree)
    let setup
    try {
      setup = await runtime.connection.forkSession(
        source.record.acpSessionId,
        own?.path ?? workDir(source.record),
        this.attachOptions(forkId, source.record, runtime),
        cut?.point,
      )
    } catch (error) {
      this.deps.mcp?.detached(forkId)
      if (own) void this.discardWorktree(source.record.projectPath, own)
      throw agentError(error)
    }
    const blobs = (await reading).filter((blob) => blob !== null)
    const now = this.now()
    const sourceTitle = source.record.customTitle ?? source.thread.session.title
    const title =
      sourceTitle === null
        ? null
        : forkTitle(forkBase(sourceTitle), this.titlesIn(source.record.projectPath))
    const record: SessionRecord = {
      ...source.record,
      origin: 'user',
      id: forkId,
      acpSessionId: setup.sessionId,
      title,
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      branch: null,
      ...(own ? { worktree: own } : {}),
    }
    // A queued prompt, the attachments it holds, and the source's pin or archive stay with it.
    delete record.queue
    delete record.pinnedAt
    delete record.archivedAt
    delete record.routine
    // A title of its own, so one the agent reports from the copied history does not replace it.
    if (title === null) delete record.customTitle
    else record.customTitle = title
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
      acpSessionId: setup.sessionId,
      config: source.thread.session.config,
      // Nothing records the context or the totals at an earlier reply.
      usage: cut ? null : source.thread.session.usage,
    })
    this.save(live)
    this.touch(live.id)
    if (own) this.prepareWorktree(record.projectPath, own)
    // Not every agent carries the source's settings over to a fork, such as its model.
    const carried = source.thread.session.config
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
      this.update(live, { config })
      const notice = lostValuesNotice(lostValues(carried, config))
      if (notice) {
        this.emit(live, [
          {
            op: 'entry.add',
            entry: {
              kind: 'notice',
              id: this.nextId(live),
              ...notice,
              after: agentEntryBefore(live.thread),
            },
          },
        ])
      }
      this.update(live, { status: 'ready' })
    }
    this.persist(live)
    this.touch(live.id)
    return this.summary(live.id)
  }

  /**
   * A fork that an earlier agent of the source takes on: no fork of its own session, which ended
   * before the reply's turn did, but a session of its own given the conversation up to the reply.
   */
  private async forkToEarlier(
    source: Live,
    entries: ThreadEntry[],
    agentId: AgentId,
  ): Promise<SessionSummary> {
    this.deps.agents.assertEnabled(agentId)
    const kept = entries.filter((entry) => entry.kind !== 'subagent')
    const blobs = (
      await Promise.all(
        [...storedBlobs(kept)].map((hash) => this.storedBlob(source.id, hash).catch(() => null)),
      )
    ).filter((blob) => blob !== null)
    const now = this.now()
    const sourceTitle = source.record.customTitle ?? source.thread.session.title
    const title =
      sourceTitle === null
        ? null
        : forkTitle(forkBase(sourceTitle), this.titlesIn(source.record.projectPath))
    const ids = new Set(kept.map((entry) => entry.id))
    const record: SessionRecord = {
      ...source.record,
      origin: 'user',
      id: randomUUID(),
      agentId,
      acpSessionId: '',
      title,
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      branch: null,
    }
    for (const key of [
      'queue',
      'pinnedAt',
      'archivedAt',
      'routine',
      'configDir',
      'cache',
      'model',
    ] as const) {
      delete record[key]
    }
    if (title === null) delete record.customTitle
    else record.customTitle = title
    // The takeovers it keeps, none of whose sessions it resumes: they belong to the source.
    const earlier = (source.record.earlier ?? [])
      .filter((item) => ids.has(item.endedAt))
      .map((item) => ({ ...item, acpSessionId: '' }))
    if (earlier.length > 0) record.earlier = earlier
    else delete record.earlier
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    live.used = true
    live.blobs = new Map(blobs.map((blob) => [blob.hash, blob]))
    for (const entry of kept) live.counter = Math.max(live.counter, idNumber(entry.id))
    const entryId = this.nextId(live)
    record.carry = { entryId, fromTurn: 1 }
    this.emit(
      live,
      kept.map((entry): Patch => ({ op: 'entry.add', entry })),
    )
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'takeover',
          id: entryId,
          agentId,
          turns: 0,
          omitted: 0,
          carried: '',
          after: agentEntryBefore(live.thread),
        },
      },
    ])
    this.update(live, {
      agentId,
      acpSessionId: '',
      config: this.deps.options?.get(agentId)?.config ?? [],
      usage: null,
      status: 'closed',
    })
    this.save(live)
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
      // A message given back goes to a composer, which sends an image with its bytes.
      turn.written = resolved.written
      if (resolved.ids.length > 0) {
        const entry = turn.entryId ? live.thread.byId[turn.entryId] : undefined
        if (entry?.kind === 'user') {
          this.emit(live, [
            { op: 'entry.update', id: entry.id, changes: { content: resolved.shown } },
          ])
        }
      }
      const carry = live.record.carry
      const wire = carry
        ? await this.withCarried(live, connection, carry, resolved.wire)
        : resolved.wire
      if (turn.ended) return
      const sending = connection.prompt(live.record.acpSessionId, wire).finally(() => {
        if (live.unansweredCancel === turn) live.unansweredCancel = null
      })
      this.refreshContext(live)
      // Sent: a retry after a failed sign-in sends what the thread shows, and the records stay
      // until the turn ends, in case its message is given back.
      this.commitAttachments(live, resolved)
      turn.attachments = resolved.ids
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
    live.sendNext = false
    if (turn.attachments.length > 0) void this.deps.attachments?.release(turn.attachments)
    turn.attachments = []
    this.deps.mcp?.turnEnded(live.id)
    this.deps.diagnostics.turnEnded(live.record.agentId, [live.id, live.record.acpSessionId])
    this.closeOpenEntries(live)
    this.clearPermissions(live, 'cancelled')
    const byAgent = live.archiveAfterTurn
    if (byAgent !== null) {
      live.archiveAfterTurn = null
      // After the turn's own entries, so the notice and the close come once it has ended. A
      // session being closed or deleted already is left as the user asked.
      if (!live.closing) {
        // The archive would cancel the next prompt's turn, so it waits for Resume, as after Stop.
        this.pauseQueue(live)
        queueMicrotask(() => {
          void this.archiveByAgent(live.id, byAgent).catch((error: unknown) => {
            this.deps.diagnostics.log(
              'warn',
              `Could not archive session ${live.id}: ${(error as Error).message}`,
            )
          })
        })
      }
    }
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
          after: agentEntryBefore(live.thread),
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
    // The prompt Send now chose goes next, whether the stop landed or the turn finished first.
    const chosen = live.sendNext && (stopReason === 'cancelled' || stopReason === 'end_turn')
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
      git.turnEnded(workDir(live.record), live.id)
      live.record.branch = git.currentBranch(workDir(live.record)) ?? live.record.branch
    }
    if (this.inFront(live.id)) live.record.lastViewedAt = now
    else live.unread = true
    this.persist(live)
    this.touch(live.id)
    const routineTurn = this.reportRun(live, {
      stopReason,
      error: null,
      usage: turnTokens ?? null,
      turn,
    })
    // A run's end notifies as the routine's, once, so its session sends nothing here.
    if (!routineTurn) {
      const reply = stopReason === 'end_turn' ? replySummary(live.thread) : null
      const changed = stopReason === 'end_turn' ? changedFiles(live.thread) : 0
      const text = reply ?? turnEndText(stopReason)
      this.deps.events.attention(
        live.id,
        'turn-ended',
        stopReason === 'end_turn'
          ? t('attention.done', { title: this.titleOf(live) })
          : this.titleOf(live),
        changed > 0 ? t('attention.withChanges', { text, count: changed }) : text,
      )
    }
    if (stopReason === 'end_turn' || chosen) this.drainQueue(live, chosen)
    else this.pauseQueue(live)
    this.followAgentTurn(live)
    // An agent that lists its titles sends none in the thread: the turn's end reads the session's.
    this.maybeReadListedTitle(live, this.userMessages(live) === 1)
    this.checkpoint(live)
    this.refreshContext(live, 0, true)
  }

  /**
   * Coalesces activity reads; a change during a read is followed by another read. Only a session a
   * port shows is read as it changes; any other is read once its turn ends (`owed`), and again
   * when a port shows it.
   */
  private refreshContext(live: Live, delay = 0, owed = false): void {
    if (!this.contextCurrent(live) || !live.connection?.readContext) return
    live.contextDirty = true
    if (owed) live.contextOwed = true
    if (!this.contextWanted(live) || this.contextRuns.has(live.id)) return
    this.scheduleContext(live, delay)
  }

  private contextWanted(live: Live): boolean {
    return live.contextOwed || this.inFront(live.id)
  }

  private contextCurrent(live: Live): boolean {
    return (
      !this.stopped &&
      !live.closing &&
      this.live.get(live.id) === live &&
      live.record.origin !== 'subagent'
    )
  }

  private contextActive(live: Live): boolean {
    const status = live.thread.session.status
    return status === 'running' || status === 'awaiting_permission'
  }

  private scheduleContext(live: Live, delay: number): void {
    if (!this.contextCurrent(live) || !live.connection?.readContext) return
    const due = this.now() + delay
    if (live.contextTimer && live.contextDueAt <= due) return
    if (live.contextTimer) clearTimeout(live.contextTimer)
    live.contextDueAt = due
    live.contextTimer = setTimeout(() => {
      live.contextTimer = null
      if (!this.contextCurrent(live) || !live.connection?.readContext) return
      void this.context(live.id, true).catch((error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `${live.id}: the context could not be read: ${(error as Error).message}`,
        )
      })
    }, delay)
    live.contextTimer.unref?.()
  }

  /** The messages the thread holds, which says whether the turn that ended was the first one. */
  private userMessages(live: Live): number {
    let count = 0
    for (const id of live.thread.order) {
      if (live.thread.byId[id]?.kind === 'user') count++
    }
    return count
  }

  /** Reads the title an agent lists for the session, unless it has a title of its own already. */
  private maybeReadListedTitle(live: Live, afterFirstTurn: boolean): void {
    if (this.live.get(live.id) !== live || live.record.titleSource !== undefined) return
    const runtime = this.deps.agents.runtime(live.record.agentId)
    if (!runtime || runtime.init.capabilities.ownTitles !== 'listed') return
    if (!runtime.init.capabilities.listSessions) return
    void this.readListedTitle(live, afterFirstTurn)
  }

  private async readListedTitle(live: Live, retry: boolean): Promise<void> {
    const { agentId, acpSessionId } = live.record
    const projectPath = workDir(live.record)
    const connection = live.connection
    if (!connection) return
    let title: string | null
    try {
      const listed = await connection.listSessions(projectPath, null)
      title = listedTitle(
        listed.sessions.find((item) => item.sessionId === acpSessionId)?.title ?? null,
        firstUserMessage(live.thread),
      )
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `${this.deps.agents.name(agentId)}: could not read the title of session ${live.id}: ${(error as Error).message}`,
      )
      return
    }
    if (this.live.get(live.id) !== live || live.record.titleSource !== undefined) return
    if (title !== null) {
      live.record.titleSource = 'agent'
      live.titlePrompt = null
      this.update(live, { title })
      this.persist(live)
      this.touch(live.id)
      return
    }
    if (!retry) return
    // OpenCode may still be writing it: one more read, while the session stays live.
    live.listedTitleTimer = setTimeout(() => {
      live.listedTitleTimer = null
      this.maybeReadListedTitle(live, false)
    }, this.timings.listedTitleRetryMs)
    live.listedTitleTimer.unref?.()
  }

  /**
   * Reports the first turn of a run's session to the routines manager; true when it was one, so
   * the session sends no ordinary turn notification for it.
   */
  private reportRun(
    live: Live,
    result: {
      stopReason: StopReason | null
      error: { message: string; detail?: string } | null
      usage: TokenTotals | null
      turn: Turn | null
    },
  ): boolean {
    const hooks = this.deps.routine?.current
    if (!hooks || live.record.origin !== 'routine' || live.routineTurnEnded) return false
    live.routineTurnEnded = true
    // A plain object, not an Error: a run's record is written as JSON.
    const error = result.error
      ? {
          message: result.error.message,
          ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
        }
      : null
    hooks.turnEnded(live.id, {
      stopReason: result.stopReason,
      error,
      output: result.turn ? this.turnAnswer(live, result.turn) : null,
      usage: result.usage,
      changedFiles: result.turn ? this.turnChanges(live, result.turn) : [],
    })
    return true
  }

  /** The entries of a turn, after the user entry that opened it. */
  private turnEntries(live: Live, turn: Turn): ThreadEntry[] {
    const order = live.thread.order
    const at = turn.entryId ? order.indexOf(turn.entryId) : -1
    const entries: ThreadEntry[] = []
    for (const id of order.slice(at + 1)) {
      const entry = live.thread.byId[id]
      if (entry) entries.push(entry)
    }
    return entries
  }

  /** The turn's answer: its agent messages, joined as the thread folds them. */
  private turnAnswer(live: Live, turn: Turn): string | null {
    const parts = this.turnEntries(live, turn).flatMap((entry) =>
      entry.kind === 'agent' && entry.markdown.trim() !== '' ? [entry.markdown] : [],
    )
    return parts.length > 0 ? parts.join('\n\n') : null
  }

  /** The paths a turn's edits touched, relative to the project when they lie inside it. */
  private turnChanges(live: Live, turn: Turn): string[] {
    const api = this.deps.platform === 'win32' ? path.win32 : path.posix
    const root = workDir(live.record)
    const paths = new Set<string>()
    for (const entry of this.turnEntries(live, turn)) {
      if (
        entry.kind !== 'tool' ||
        (entry.toolKind !== 'edit' && entry.toolKind !== 'delete' && entry.toolKind !== 'move')
      ) {
        continue
      }
      for (const location of entry.locations) {
        const relative = api.relative(root, location.path)
        paths.add(relative.startsWith('..') ? location.path : relative)
      }
    }
    return [...paths]
  }

  private failTurn(live: Live, turn: Turn, error: unknown): void {
    const mapped = agentError(error)
    const closed = mapped.code === 'agent_unavailable'
    if (closed && turn.cancelRequested) {
      // The user had stopped it before the agent exited, so it ends stopped, as on the exit event,
      // and a prompt Send now chose waits first in the paused queue.
      live.connection = null
      live.sendNext = false
      this.endTurn(live, turn, 'cancelled', null)
      return
    }
    const authRequired = mapped.code === 'auth_required'
    // Sign-in and credit have Retry, which sends the message again.
    const givenBack =
      !authRequired &&
      !isOutOfCredit(mapped) &&
      !turn.cancelRequested &&
      agentAddedNothing(live.thread, turn.entryId)
    if (givenBack) turn.attachments = []
    this.finishTurn(live, turn, null)
    const now = this.now()
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
                : {
                    title: t('notice.turnFailed'),
                    description: mapped.message,
                    // A turn of a message has Retry, which sends it again; the agent's own has none.
                    ...(turn.byAgent ? {} : { cause: 'turn_failed' as const }),
                  }),
          after: agentEntryBefore(live.thread),
        },
      },
    ])
    if (authRequired) {
      // A turn the agent started has no message to send again; Retry reopens the session.
      live.failure = turn.byAgent
        ? null
        : { action: 'prompt', content: turn.content, entryId: turn.entryId }
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
    if (givenBack) this.giveBack(live, turn)
    const routineTurn = this.reportRun(live, {
      stopReason: null,
      error: mapped,
      usage: null,
      turn,
    })
    if (!routineTurn) {
      this.deps.events.attention(live.id, 'error', this.titleOf(live), mapped.message)
    }
    this.followAgentTurn(live)
    this.checkpoint(live)
    this.refreshContext(live, 0, true)
  }

  /**
   * Keeps a failed turn's message for its session's composer, with the attachments whose records
   * the host still holds; a retried message's were released when it first went.
   */
  private giveBack(live: Live, turn: Turn): void {
    const held = new Set(this.deps.attachments?.held(attachmentIds(turn.written)) ?? [])
    const content = turn.written.filter(
      (item) =>
        item.type !== 'ref' || item.ref.kind !== 'attachment' || held.has(item.ref.attachment.id),
    )
    // The sender takes it back while it is there; once it has gone, whoever asks next.
    const sender = turn.portId !== null && this.deps.portOpen(turn.portId) ? turn.portId : null
    this.returned.push({
      sessionId: live.id,
      content,
      at: this.now(),
      ...(sender === null ? {} : { portId: sender }),
    })
    this.saveReturned()
    this.deps.events.returned(live.id, sender === null ? undefined : [sender])
  }

  /** The session could not attach for the turn: it fails as a start does, and Retry sends again. */
  private failConnect(live: Live, turn: Turn, error: unknown): void {
    this.finishTurn(live, turn, null)
    this.update(live, { turnStartedAt: null, turnStartUsed: null })
    this.pauseQueue(live)
    const failure = this.failStart(live, error, {
      action: 'prompt',
      content: turn.content,
      entryId: turn.entryId,
    })
    this.reportRun(live, { stopReason: null, error: failure, usage: null, turn })
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
            after: agentEntryBefore(live.thread),
          },
        },
      ])
      // The agent may still report the stopped prompt's usage long after the turn is over.
      live.unansweredCancel = turn
      this.endTurn(live, turn, 'cancelled', null)
    }, this.timings.cancelFallbackMs)
  }

  /** The agent's background work ended with its process: its tasks are gone from the list. */
  private endBackground(live: Live): void {
    live.background = false
    if (live.thread.session.background?.length) this.update(live, { background: [] })
  }

  /** The live session, with its connection, when the agent lists `taskId` as a background task. */
  private backgroundTask(
    sessionId: string,
    taskId: string,
  ): { live: Live; connection: TaskConnection; running: boolean } {
    const live = this.live.get(sessionId)
    if (!live?.connection) throw new HostError('busy', t('session.openFirst'))
    const { connection } = live
    const tasks = live.thread.session.background
    if (!reportsTasks(connection) || tasks === undefined) {
      throw new HostError(
        'restricted',
        t('session.noBackgroundTasks', { agent: this.deps.agents.name(live.record.agentId) }),
      )
    }
    const task = tasks.find((item) => item.id === taskId)
    if (!task) throw new HostError('not_found', t('session.noBackgroundTask'))
    return { live, connection, running: task.status === 'running' }
  }

  /** Stops a background task the session lists as running. */
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const { live, connection, running } = this.backgroundTask(sessionId, taskId)
    if (!running) throw new HostError('conflict', t('session.backgroundTaskEnded'))
    try {
      await connection.stopTask(live.record.acpSessionId, taskId)
    } catch (error) {
      throw agentError(error)
    }
  }

  /** The end of the output of a background task the session lists, running or ended. */
  async taskOutput(
    sessionId: string,
    taskId: string,
  ): Promise<{ output: string; truncated: boolean }> {
    const { live, connection } = this.backgroundTask(sessionId, taskId)
    try {
      return await connection.taskOutput(live.record.acpSessionId, taskId)
    } catch (error) {
      throw agentError(error)
    }
  }

  // Permissions.

  /** The `allow_once` option the run's scope allows, or null when the request waits. */
  private routineAnswer(
    live: Live,
    scope: PermissionScope,
    request: PermissionRequest,
  ): string | null {
    // A plan and an MCP server's request are the user's to answer, whatever the scope.
    if (request.plan !== undefined || request.elicitation) return null
    const entry = live.thread.byId[request.toolEntryId]
    if (entry?.kind !== 'tool') return null
    return scopeAnswer(
      scope,
      live.record.projectPath,
      {
        toolKind: entry.toolKind,
        locations: entry.locations.map((location) => location.path),
        options: request.options,
      },
      this.deps.platform,
    )
  }

  private requestPermission(
    live: Live,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionAnswer> {
    this.applyOutput(live, request.output)
    // The user already stopped this turn or closed the session: the request is moot.
    if (live.closing || live.turn?.cancelRequested) return Promise.resolve('cancelled')
    // A run answers inside its scope while its first turn works; anything else waits for the user.
    if (live.routineScope && live.record.origin === 'routine' && !live.routineTurnEnded) {
      const optionId = this.routineAnswer(live, live.routineScope, request)
      if (optionId !== null) {
        this.emit(live, [
          {
            op: 'entry.update',
            id: request.toolEntryId,
            changes: {
              permission: null,
              permissionResult: { optionId, kind: 'allow_once', by: 'routine' },
            },
          },
        ])
        this.touch(live.id)
        return Promise.resolve({ optionId })
      }
    }
    const requestId = `${this.requestPrefix}${++this.requestCounter}`
    const { elicitation } = request
    const plan = request.plan === undefined ? null : planRevision(live.thread, request.toolEntryId)
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
        ...(request.questions ? { questions: request.questions } : {}),
        plan: plan !== null,
        ...(elicitation ? { elicitation } : {}),
        outsideTurn: live.turn === null,
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
          changes: {
            permission: {
              requestId,
              options: request.options,
              ...(request.questions ? { questions: request.questions } : {}),
              ...(plan ? { plan: { markdown: request.plan!, previous: plan.previous } } : {}),
              ...(elicitation ? { elicitation } : {}),
            },
            permissionResult: null,
            ...(plan ? { planVersion: plan.version } : {}),
            ...(elicitation
              ? {
                  elicitation: {
                    server: elicitation.server,
                    kind: elicitation.kind,
                    ...(elicitation.kind === 'url' ? { url: elicitation.url } : {}),
                  },
                }
              : {}),
          },
        },
      ])
      const status = live.thread.session.status
      if (status === 'running' || status === 'ready')
        this.update(live, { status: 'awaiting_permission' })
      this.touch(live.id)
      this.updateBadge()
      const entry = live.thread.byId[request.toolEntryId]
      const tool = entry?.kind === 'tool' ? entry : undefined
      if (live.record.origin === 'routine' && !live.routineTurnEnded) {
        this.deps.routine?.current?.waiting(
          live.id,
          true,
          tool ? tool.title : t('attention.permission'),
        )
      } else {
        const optionId = allowOnceOption(tool, request.options)
        const allow = request.options.find((option) => option.id === optionId)
        const deny = request.options.find((option) => option.kind === 'reject_once')
        this.deps.events.attention(
          live.id,
          'permission',
          this.titleOf(live),
          requestText(tool, workDir(live.record)),
          {
            id: requestId,
            ...(allow ? { allow: { optionId: allow.id, name: allow.name } } : {}),
            ...(allow && deny ? { deny: { optionId: deny.id, name: deny.name } } : {}),
          },
        )
      }
    })
  }

  /** Clears one request with its result and settles the session's status. */
  private settlePermission(
    live: Live,
    requestId: string,
    result: NonNullable<ToolEntry['permissionResult']>,
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
    this.stopWaiting(live)
    if (live.permissions.size === 0 && live.record.origin === 'routine') {
      this.deps.routine?.current?.waiting(live.id, false)
    }
    this.updateBadge()
  }

  /** Settles every pending request; after an exit the answer goes nowhere, but frees the handler. */
  private clearPermissions(live: Live, result: 'cancelled' | 'withdrawn'): void {
    for (const [requestId, pending] of [...live.permissions]) {
      this.settlePermission(live, requestId, result)
      pending.answer('cancelled')
    }
    // A new origin still waiting dies with the session's page: its card says it went unanswered.
    for (const [requestId, entryId] of [...live.origins]) {
      if (requestId.startsWith('device:')) {
        this.settleDeviceAccess(live.id, entryId, 'timeout')
        continue
      }
      live.origins.delete(requestId)
      this.originRequests.delete(requestId)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'browser_origin' && entry.decision === null) {
        this.emit(live, [{ op: 'entry.update', id: entryId, changes: { decision: 'timeout' } }])
      }
    }
    // So does a first use of an app: the call that asked has no agent left to answer.
    for (const [requestId, entryId] of [...live.apps]) {
      live.apps.delete(requestId)
      this.appRequests.delete(requestId)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'computer_app' && entry.decision === null) {
        this.emit(live, [{ op: 'entry.update', id: entryId, changes: { decision: 'timeout' } }])
      }
    }
    // And a setup: its call has no agent left to go on for.
    for (const [requestId, entryId] of [...live.setups]) {
      live.setups.delete(requestId)
      this.setupRequests.delete(requestId)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'computer_setup' && entry.outcome === null) {
        this.emit(live, [{ op: 'entry.update', id: entryId, changes: { outcome: 'timeout' } }])
      }
    }
    this.stopWaiting(live)
    this.updateBadge()
  }

  /** Once no request or new site waits for the user, the session goes back to its turn or rests. */
  private stopWaiting(live: Live): void {
    if (waitingCount(live) > 0) return
    if (live.thread.session.status !== 'awaiting_permission') return
    this.update(live, { status: live.turn || live.childRunning ? 'running' : 'ready' })
  }

  respond(
    sessionId: string,
    requestId: string,
    answer:
      { optionId: string; note?: string } | { answers: QuestionAnswer[] } | { values: FormValues },
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const pending = live?.permissions.get(requestId)
    if (live && !pending && live.answered.has(requestId)) {
      throw new HostError('not_found', `Request ${requestId} was already answered`, {
        reason: ALREADY_ANSWERED,
        device: live.answered.get(requestId) ?? null,
      })
    }
    if (!live || !pending) throw notFound(`No pending permission request ${requestId}`)
    let result: Exclude<NonNullable<ToolEntry['permissionResult']>, string>
    let given: PermissionAnswer
    const form = pending.elicitation?.kind === 'form' ? pending.elicitation : null
    if ('answers' in answer) {
      if (!pending.questions) throw invalidParams(`Request ${requestId} asks no questions`)
      result = questionsResult(pending.questions, answer.answers, device)
      given = answer
    } else if ('values' in answer) {
      const submit = pending.options.find((o) => o.kind === 'allow_once')
      if (!form || !submit) throw invalidParams(`Request ${requestId} holds no form`)
      const values = checkedValues(form.fields, answer.values)
      result = {
        optionId: submit.id,
        kind: submit.kind,
        fields: answeredFields(form.fields, values),
        ...(device ? { device } : {}),
      }
      given = { values }
    } else {
      const { optionId } = answer
      const option = pending.options.find((o) => o.id === optionId)
      if (!option) throw invalidParams(`${optionId} is not an option of request ${requestId}`)
      if (answer.note !== undefined && !option.note) {
        throw invalidParams(`${optionId} of request ${requestId} takes no note`)
      }
      // A form is submitted with its values, which an option alone does not carry.
      if (form && (option.kind === 'allow_once' || option.kind === 'allow_always')) {
        throw invalidParams(`Request ${requestId} takes the form's values`)
      }
      const note = answer.note?.trim() || undefined
      const tool = live.thread.byId[pending.toolEntryId]
      // A question's answer is what the card shows once answered, and a plan's the mode it builds
      // in; a permission's kind says enough.
      const answered = tool?.kind === 'tool' && tool.question !== undefined
      const named = pending.plan || (answered && option.kind !== 'reject_once')
      result = {
        optionId,
        kind: option.kind,
        ...(named ? { name: option.name } : {}),
        ...(note ? { note } : {}),
        ...(device ? { device } : {}),
      }
      given = note ? { optionId, note } : { optionId }
    }
    this.settlePermission(live, requestId, result)
    live.answered.set(requestId, device ?? null)
    if (live.answered.size > ANSWERS_KEPT) {
      live.answered.delete(live.answered.keys().next().value!)
    }
    pending.answer(given)
    if (pending.outsideTurn) this.afterAnswer(live)
    this.touch(live.id)
  }

  /**
   * After a request no turn waited on is answered, the queue goes on as after a turn, once the
   * agent had the chance to start one with the answer.
   */
  private afterAnswer(live: Live): void {
    setTimeout(() => {
      if (this.live.get(live.id) !== live || live.turn || live.closing) return
      this.drainQueue(live)
    }, 0)
  }

  /**
   * A message the agent's connection sends as the user's own, such as the note that sends a plan
   * back: at once when the session can start a turn, ahead of a waiting queue since it is the
   * answer the user just gave; behind the queue while a turn runs.
   */
  private sendForUser(live: Live, text: string): void {
    if (this.live.get(live.id) !== live || live.closing) return
    const content: UserContent[] = [{ type: 'text', text }]
    const { status, queue } = live.thread.session
    if (canSend(status)) {
      this.sendPrompt(live, content)
      return
    }
    if (status !== 'running' && status !== 'awaiting_permission') {
      this.deps.diagnostics.log('warn', `Session ${live.id} could not take a message: ${status}`)
      return
    }
    this.update(live, { queue: [...queue, { id: randomUUID(), content, at: this.now() }] })
    this.persist(live)
    this.touch(live.id)
  }

  // Config options.

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<void> {
    this.assertRegistered(sessionId)
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noConfig'))
    }
    const live = await this.revive(sessionId)
    const status = live.thread.session.status
    if (!live.connection && status !== 'closed') throw busyError(status)
    const option = live.thread.session.config.find((o) => o.id === optionId)
    if (!option) throw invalidParams(`No config option ${optionId}`)
    if (!isValueOf(option, value)) {
      throw invalidParams(`${String(value)} is not a choice of ${option.name}`)
    }
    if (option.idleOnly && (live.turn || (status !== 'ready' && status !== 'closed'))) {
      throw new HostError('busy', t('session.configBetweenTurns', { option: option.name }))
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
    const all = [...this.descendants(sessionId), record]
    await this.closeAll(all, true)
    delete record.pinnedAt
    record.archivedAt = this.now()
    this.saveRecord(sessionId)
    this.deps.events.ended(all.map((item) => item.id))
  }

  // The session tools: what the artifacts service calls, under the caller's id.

  /** A session the tools list: its record and live view, narrowed. */
  private toolSession(record: SessionRecord): ToolSession {
    const live = this.live.get(record.id)
    return {
      id: record.id,
      title: record.customTitle ?? live?.thread.session.title ?? record.title,
      agentId: record.agentId,
      status: live?.thread.session.status ?? 'closed',
      updatedAt: live?.thread.session.updatedAt ?? record.updatedAt,
      createdAt: record.createdAt,
      parentId: record.parentId,
      startedBy: record.startedBy ?? null,
      archived: this.isArchived(record),
      projectPath: record.projectPath,
    }
  }

  /** Archived itself, or below a parent that is: a sub-session leaves with its tree. */
  private isArchived(record: SessionRecord): boolean {
    let current: SessionRecord | undefined = record
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      if (current.archivedAt !== undefined) return true
      seen.add(current.id)
      current =
        current.parentId === null
          ? undefined
          : (this.live.get(current.parentId)?.record ?? this.records.get(current.parentId))
    }
    return false
  }

  /** The session as a tool sees it; null for one no session list shows. */
  sessionInfo(sessionId: string): ToolSession | null {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    if (!record || record.origin === 'subagent' || this.live.get(sessionId)?.prepared) return null
    return this.toolSession(record)
  }

  /** The project's sessions and their sub-sessions, as the tools list them, newest first. */
  toolSessions(projectPath: string): ToolSession[] {
    const key = pathKey(projectPath, this.deps.platform)
    const ids = new Set<string>([...this.records.keys(), ...this.live.keys()])
    const out: ToolSession[] = []
    for (const id of ids) {
      const info = this.sessionInfo(id)
      if (!info || pathKey(info.projectPath, this.deps.platform) !== key) continue
      out.push(info)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The sessions in the index or in memory that the given session's agent started. */
  startedBy(callerId: string): ToolSession[] {
    const seen = new Map<string, SessionRecord>()
    for (const record of this.records.values()) seen.set(record.id, record)
    for (const live of this.live.values()) seen.set(live.id, live.record)
    const out: ToolSession[] = []
    for (const record of seen.values()) {
      if (record.startedBy === callerId) out.push(this.toolSession(record))
    }
    return out
  }

  /** The latest agent message of a session's thread, from memory or the stored one. */
  async lastReply(sessionId: string): Promise<string | null> {
    const live = this.live.get(sessionId)
    if (live) {
      this.flushPatches(live)
      const { order, byId } = live.thread
      for (let i = order.length - 1; i >= 0; i--) {
        const entry = byId[order[i]!]
        if (entry?.kind === 'agent' && entry.markdown.trim() !== '') return cutReply(entry.markdown)
      }
      return null
    }
    const record = this.recordOf(sessionId)
    const stored = await this.readThread(record)
    if (!stored) return null
    for (let i = stored.entries.length - 1; i >= 0; i--) {
      const entry = stored.entries[i]!.entry
      if (entry.kind === 'agent' && entry.markdown.trim() !== '') return cutReply(entry.markdown)
    }
    return null
  }

  /** A session's agent's display name, for the notice an archive leaves. */
  agentName(sessionId: string): string {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    return record ? this.deps.agents.name(record.agentId) : ''
  }

  /** The session's title as another thread's label shows it, "Untitled session" when it has none. */
  toolName(sessionId: string): string {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    if (!record) return t('session.untitled')
    return (
      record.customTitle ??
      this.live.get(sessionId)?.thread.session.title ??
      record.title ??
      t('session.untitled')
    )
  }

  /** Sets a session's agent title, which a title the user gave still wins over. */
  renameByAgent(sessionId: string, title: string): void {
    const record = this.recordOf(sessionId)
    if (record.customTitle !== undefined) return
    record.titleSource = 'agent'
    const live = this.live.get(sessionId)
    if (live) {
      live.titlePrompt = null
      this.update(live, { title })
      this.persist(live)
      return
    }
    record.title = title
    this.saveRecord(sessionId)
  }

  /** Archives the session when its running turn ends, however it ends; at once when none runs. */
  archiveWhenIdle(sessionId: string, byAgent: string): void {
    const live = this.live.get(sessionId)
    if (live?.turn && !live.turn.ended) {
      live.archiveAfterTurn = byAgent
      return
    }
    void this.archiveByAgent(sessionId, byAgent).catch((error: unknown) => {
      this.deps.diagnostics.log(
        'warn',
        `Could not archive session ${sessionId}: ${(error as Error).message}`,
      )
    })
  }

  /** Archives a session at once, as the session menu's Archive does; a sub-session, on its own. */
  async archiveByAgent(sessionId: string, byAgent: string): Promise<void> {
    const record = this.recordOf(sessionId)
    // A session that is not in memory gets its stored thread back, so the notice stays with it.
    if (!this.live.has(sessionId) && this.deps.threads) {
      const stored = await this.readThread(record).catch(() => null)
      if (stored) await this.revive(sessionId)
    }
    this.archiveNotice(sessionId, byAgent)
    if (record.parentId === null) {
      await this.archive(sessionId)
      return
    }
    await this.settled(sessionId)
    const all = [...this.descendants(sessionId), record]
    await this.closeAll(all, true)
    delete record.pinnedAt
    record.archivedAt = this.now()
    this.saveRecord(sessionId)
    this.deps.events.ended(all.map((item) => item.id))
  }

  /** The info notice an archived session's thread gets, "Claude Code archived this session". */
  private archiveNotice(sessionId: string, byAgent: string): void {
    const live = this.live.get(sessionId)
    if (!live) return
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'info',
          title: t('notice.archivedByAgent', { agent: byAgent }),
          after: agentEntryBefore(live.thread),
        },
      },
    ])
  }

  /**
   * Starts a sub-session of the caller with its first prompt, as New sub-session would: the
   * caller's project and parent, and with the caller's agent its model and level. The mode is the
   * start mode, never the caller's, which may give full access.
   */
  async startFromTool(
    callerId: string,
    params: { prompt: string; title?: string; agentId?: AgentId },
  ): Promise<string> {
    const caller = this.recordOf(callerId)
    const agentId = params.agentId ?? caller.agentId
    const from = { sessionId: callerId, title: this.toolName(callerId) }
    const options: Record<string, string | boolean> = {}
    if (agentId === caller.agentId) {
      const live = this.live.get(callerId)
      const config = live?.thread.session.config ?? []
      for (const option of config) {
        if (option.category !== 'model' && option.category !== 'thought_level') continue
        options[option.id] = option.value
      }
    } else {
      Object.assign(options, this.deps.options?.rememberedOf(agentId) ?? {})
    }
    Object.assign(options, this.startModeOf(agentId))
    const summary = await this.create({
      agentId,
      projectPath: caller.projectPath,
      parentId: callerId,
      options,
      prompt: [{ type: 'text', text: params.prompt }],
      startedBy: callerId,
      from,
      ...(params.title === undefined ? {} : { title: params.title }),
    })
    const live = this.live.get(callerId)
    if (live) {
      this.emit(live, [startedPatch(live.thread, summary.id, () => this.nextId(live))])
      live.used = true
    }
    return summary.id
  }

  /**
   * Prompts a session the caller started, or queues the prompt while that session works.
   * Unlike a message from the user, this brings an archived session back.
   */
  async sendFromTool(
    sessionId: string,
    text: string,
    from: FromSession,
  ): Promise<'sent' | 'queued'> {
    const content: UserContent[] = [{ type: 'text', text }]
    this.unarchive(sessionId)
    const live = await this.revive(sessionId)
    const { status, queue, queuePaused } = live.thread.session
    if (canSend(status) && (queue.length === 0 || queuePaused)) {
      this.sendPrompt(live, content, from)
      return 'sent'
    }
    if (!canSend(status) && status !== 'running' && status !== 'awaiting_permission') {
      throw busyError(status)
    }
    const item = { id: randomUUID(), content, at: this.now(), from }
    this.update(live, { queue: [...queue, item] })
    this.persist(live)
    this.touch(live.id)
    return 'queued'
  }

  /** A message from the user does not bring an archived session back; restoring it does. */
  private refuseIfCannotSend(sessionId: string): void {
    const record = this.recordOf(sessionId)
    if (this.isArchived(record)) throw new HostError('restricted', t('session.archived'))
    if (record.worktree?.removed === 'branch') {
      throw new HostError('restricted', t('session.worktreeGone'))
    }
  }

  // Worktrees.

  private worktreeSummary(worktree: NonNullable<SessionRecord['worktree']>): SessionWorktree {
    const { path, branch, base, baseOid } = worktree
    const key = pathKey(path, this.deps.platform)
    const preparing = this.preparing.get(key)
    let state: SessionWorktree['state'] = 'ready'
    if (worktree.removed === 'branch') state = 'gone'
    else if (worktree.removed === 'worktree') state = 'removed'
    else if (preparing) state = preparing.state
    else if (worktree.pending) state = 'setup-failed'
    else if (this.missingWorktrees.has(key)) state = 'missing'
    const failure: WorktreeFailure | undefined =
      preparing?.state === 'setup-failed'
        ? preparing.failure
        : state === 'setup-failed'
          ? { stage: 'setup', exitCode: null, message: t('session.worktreeInterrupted') }
          : undefined
    return { path, branch, base, baseOid, state, ...(failure ? { failure } : {}) }
  }

  /** Whether the session's first message, and what follows it, waits for its worktree. */
  private waitsForWorktree(live: Live): boolean {
    const { worktree } = live.record
    if (!worktree || worktree.removed !== undefined) return false
    const key = pathKey(worktree.path, this.deps.platform)
    if (!this.preparing.has(key) && !worktree.pending) return false
    return this.deps.worktrees?.settings(live.record.projectPath).waitForSetup ?? true
  }

  /**
   * The folder to start or resume the session's agent in. A worktree Kettu removed, or one whose
   * folder went away, is made again from its branch first; one whose branch is gone is refused.
   */
  private async cwdOf(live: Live): Promise<string> {
    const { worktree } = live.record
    if (!worktree) return live.record.projectPath
    if (worktree.removed === 'branch') {
      throw new HostError('restricted', t('session.worktreeGone'))
    }
    const key = pathKey(worktree.path, this.deps.platform)
    const there = await isFolder(worktree.path)
    if (worktree.removed === undefined && there) {
      this.missingWorktrees.delete(key)
      return worktree.path
    }
    const manager = this.deps.worktrees
    if (!manager) throw new HostError('restricted', t('session.worktreeGone'))
    try {
      await manager.recreate(live.record.projectPath, worktree)
    } catch (error) {
      if (error instanceof HostError && error.code === 'not_found') {
        this.markWorktree(worktree.path, (record) => {
          record.removed = 'branch'
        })
        throw new HostError('restricted', t('session.worktreeGone'))
      }
      throw error
    }
    this.missingWorktrees.delete(key)
    this.markWorktree(worktree.path, (record) => {
      delete record.removed
    })
    return worktree.path
  }

  /** A new worktree for a fork of a session in one, cut from the source's branch; null to share. */
  private async forkWorktree(
    source: SessionRecord,
    mode: 'new' | 'same',
  ): Promise<WorktreeRecord | null> {
    const { worktree } = source
    if (!worktree || mode === 'same') return null
    if (worktree.removed === 'branch') throw new HostError('restricted', t('session.worktreeGone'))
    const manager = this.deps.worktrees
    if (!manager) throw new HostError('restricted', t('session.worktreeGone'))
    return manager.create(source.projectPath, {
      base: `refs/heads/${worktree.branch}`,
      text: source.customTitle ?? source.title ?? '',
    })
  }

  /** Removes a worktree made for a session that never came to be, when nothing is in it yet. */
  private async discardWorktree(projectPath: string, worktree: WorktreeRecord): Promise<void> {
    const manager = this.deps.worktrees
    if (!manager) return
    try {
      const state = await manager.inspect(projectPath, worktree)
      if (state.uncommitted > 0 || state.head !== worktree.baseOid) return
      await manager.remove(projectPath, worktree, { branch: 'delete', expected: state })
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not remove the unused worktree ${worktree.path}: ${(error as Error).message}`,
      )
    }
  }

  /** Changes every session record that names the worktree, then saves and announces them. */
  private markWorktree(
    path: string,
    change: (worktree: NonNullable<SessionRecord['worktree']>) => void,
  ): void {
    const key = pathKey(path, this.deps.platform)
    const changed = new Set<string>()
    for (const record of this.allRecords()) {
      if (record.worktree && pathKey(record.worktree.path, this.deps.platform) === key) {
        change(record.worktree)
        changed.add(record.id)
      }
    }
    for (const id of changed) {
      const live = this.live.get(id)
      if (live) this.persist(live)
      else this.saveIndex()
      this.touch(id)
    }
  }

  /** The sessions working in a worktree, by path, live or indexed. */
  worktreeUsers(path: string): SessionRecord[] {
    const key = pathKey(path, this.deps.platform)
    const seen = new Set<string>()
    return this.allRecords().filter((record) => {
      if (seen.has(record.id) || !record.worktree) return false
      seen.add(record.id)
      return pathKey(record.worktree.path, this.deps.platform) === key
    })
  }

  /**
   * Copies the project's local files into the worktree and runs its setup command, then sends the
   * first messages that waited for it. Failure leaves them waiting for a retry or a skip.
   */
  private prepareWorktree(
    projectPath: string,
    worktree: NonNullable<SessionRecord['worktree']>,
  ): void {
    const manager = this.deps.worktrees
    if (!manager) return
    const key = pathKey(worktree.path, this.deps.platform)
    this.markWorktree(worktree.path, (record) => {
      record.pending = true
    })
    void manager.prepare(projectPath, worktree, (next) => {
      if (next.state === 'ready') this.preparing.delete(key)
      else this.preparing.set(key, next)
      if (next.state === 'ready') {
        this.markWorktree(worktree.path, (record) => {
          delete record.pending
        })
        this.releaseWorktreeWaiters(worktree.path)
        return
      }
      for (const record of this.worktreeUsers(worktree.path)) this.touch(record.id)
    })
  }

  /** Sends what waited for the worktree: each session's first message, then its queue. */
  private releaseWorktreeWaiters(path: string): void {
    for (const record of this.worktreeUsers(path)) {
      const live = this.live.get(record.id)
      if (!live) continue
      const first = live.heldFirst
      live.heldFirst = null
      if (first && canSend(live.thread.session.status)) {
        this.startTurn(live, first.content, this.now(), first.entryId, first.portId)
      } else {
        this.drainQueue(live)
      }
      this.touch(live.id)
    }
  }

  /**
   * What removing the session's worktree would lose, and the other sessions that work in it and
   * are not archived, which keep it in use.
   */
  async inspectWorktree(sessionId: string): Promise<WorktreeInspection & { others: string[] }> {
    const record = this.recordOf(sessionId)
    const { worktree } = record
    const manager = this.deps.worktrees
    if (!worktree || worktree.path === '' || !manager) {
      throw notFound('This session has no worktree')
    }
    const state = await manager.inspect(record.projectPath, worktree)
    const others = this.worktreeUsers(worktree.path)
      .filter(
        (user) => user.id !== sessionId && user.origin !== 'subagent' && !this.isArchived(user),
      )
      .filter((user) => this.topOf(user).id !== this.topOf(record).id)
      .map((user) => user.id)
    return { ...state, others }
  }

  /**
   * Removes the session's worktree, and its branch when asked and safe, once its sessions' agents
   * have stopped. `expected` is what the user was shown: anything changed since stops it.
   */
  async removeWorktree(
    sessionId: string,
    branch: 'keep' | 'delete',
    expected: WorktreeInspection,
  ): Promise<SessionSummary> {
    const record = this.recordOf(sessionId)
    const { worktree } = record
    const manager = this.deps.worktrees
    if (!worktree || worktree.path === '' || worktree.removed !== undefined || !manager) {
      throw notFound('This session has no worktree to remove')
    }
    const users = this.worktreeUsers(worktree.path)
    await this.closeAll(
      users.filter((user) => this.live.has(user.id)),
      true,
    )
    manager.stop(worktree.path)
    const result = await manager.remove(record.projectPath, worktree, { branch, expected })
    const key = pathKey(worktree.path, this.deps.platform)
    this.preparing.delete(key)
    this.missingWorktrees.delete(key)
    this.markWorktree(worktree.path, (item) => {
      item.removed = result.branchDeleted ? 'branch' : 'worktree'
      delete item.pending
    })
    return this.summary(sessionId)
  }

  /** The top-level session of a sub-session's tree. */
  private topOf(record: SessionRecord): SessionRecord {
    let top = record
    while (top.parentId !== null) {
      const parent = this.live.get(top.parentId)?.record ?? this.records.get(top.parentId)
      if (!parent) break
      top = parent
    }
    return top
  }

  /** Runs a failed or interrupted preparation again. */
  retryWorktreeSetup(sessionId: string): void {
    const record = this.recordOf(sessionId)
    const { worktree } = record
    if (!worktree || worktree.removed !== undefined) throw notFound('This session has no worktree')
    if (this.deps.worktrees?.isPreparing(worktree.path)) return
    this.prepareWorktree(record.projectPath, worktree)
  }

  /** Goes on without the setup command: what waited for it is sent now. */
  skipWorktreeSetup(sessionId: string): void {
    const record = this.recordOf(sessionId)
    const { worktree } = record
    if (!worktree || worktree.removed !== undefined) throw notFound('This session has no worktree')
    this.deps.worktrees?.stop(worktree.path)
    this.preparing.delete(pathKey(worktree.path, this.deps.platform))
    this.markWorktree(worktree.path, (item) => {
      delete item.pending
    })
    this.releaseWorktreeWaiters(worktree.path)
  }

  /** The setup command's output in the session's worktree, whole or from an offset. */
  worktreeSetupLog(sessionId: string, from?: number): SetupLog {
    const { worktree } = this.recordOf(sessionId)
    const log = worktree ? this.deps.worktrees?.setupLog(worktree.path, from) : undefined
    return log ?? { log: '', start: 0, end: 0 }
  }

  /** Marks worktrees whose folders are gone, so their sessions say so; run at load. */
  async checkWorktrees(): Promise<void> {
    const seen = new Set<string>()
    for (const record of this.allRecords()) {
      const { worktree } = record
      if (!worktree || worktree.path === '' || worktree.removed !== undefined) continue
      const key = pathKey(worktree.path, this.deps.platform)
      if (seen.has(key)) continue
      seen.add(key)
      if (await isFolder(worktree.path)) continue
      this.missingWorktrees.add(key)
      await this.deps.worktrees?.prune(record.projectPath).catch(() => {})
      for (const user of this.worktreeUsers(worktree.path)) this.touch(user.id)
    }
  }

  /** Brings back the archived session at the top of this one's tree, or the session itself. */
  unarchive(sessionId: string): void {
    let record = this.recordOf(sessionId)
    if (record.archivedAt !== undefined) {
      delete record.archivedAt
      this.saveRecord(record.id)
      return
    }
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

  /** Closes the live sessions of removed and turned-off agents, keeping their index and transcript. */
  async agentsRemoved(agentIds: readonly AgentId[]): Promise<void> {
    const records = [...this.records.values()].filter((record) => agentIds.includes(record.agentId))
    await Promise.all(records.map((record) => this.settled(record.id)))
    for (const live of [...this.live.values()]) {
      if (agentIds.includes(live.record.agentId) && live.prepared) {
        await this.dropPrepared(live, { agentGone: true })
      }
    }
    await this.closeAll(records, true)
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
    const stopped = live.turn && !live.turn.ended ? live.turn : null
    if (stopped) {
      await connection?.cancel(live.record.acpSessionId).catch(() => {})
      this.finishTurn(live, stopped, 'cancelled')
      this.reportRun(live, { stopReason: 'cancelled', error: null, usage: null, turn: stopped })
    }
    this.clearPermissions(live, 'cancelled')
    if (kept) this.holdFirst(live)
    const runtime = this.deps.agents.runtime(live.record.agentId)
    if (
      connection &&
      live.record.origin !== 'subagent' &&
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
      this.checkpoint(live, { final: true })
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
    this.deps.events.ended(all.map((item) => item.id))
    const deleting: {
      item: SessionRecord
      agentId: AgentId
      acpSessionId: string
      runtime: AgentRuntime
    }[] = []
    for (const item of all) {
      if (item.origin === 'subagent') continue
      // Every agent that had the session keeps a session of its own for it.
      const owned = [
        { agentId: item.agentId, acpSessionId: item.acpSessionId },
        ...(item.earlier ?? []),
      ].filter((owner) => owner.acpSessionId !== '')
      for (const { agentId, acpSessionId } of owned) {
        if (!this.deps.agents.has(agentId)) continue
        try {
          const runtime = await this.deps.agents.ensureReady(agentId)
          if (runtime.init.capabilities.deleteSession) {
            deleting.push({ item, agentId, acpSessionId, runtime })
          }
        } catch (error) {
          this.deleteFailed(item, error)
        }
      }
    }
    // The agent deletes the session's log too, so what it holds is counted first.
    await this.deps.usage?.syncAgents([...new Set(deleting.map(({ agentId }) => agentId))])
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
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    const known = this.records.delete(sessionId) || this.lastSummaries.has(sessionId)
    this.lastSummaries.delete(sessionId)
    this.missing.delete(sessionId)
    this.watchers.delete(sessionId)
    this.seqs.delete(sessionId)
    if (record?.origin === 'routine') this.deps.routine?.current?.sessionGone(sessionId)
    if (known) this.deps.events.removed(sessionId, portIds)
  }

  /** Clears the index; the agents keep their transcripts. */
  async removeAll(): Promise<void> {
    await Promise.allSettled([...this.reviving.values(), ...this.releasing.values()])
    await Promise.all([...this.live.values()].map((l) => this.dropPrepared(l)))
    const live = [...this.live.values()]
    await this.closeAll(
      live.filter((l) => l.record.origin !== 'subagent').map((l) => l.record),
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
   * agents' own histories are left alone: the index does not say which sessions Kettu
   * created and which it imported.
   */
  private async removeEmpty(keep: ReadonlySet<string>): Promise<void> {
    const store = this.deps.threads
    if (!store) return
    const candidates = [...this.records.values()].filter(
      (record) => record.origin !== 'routine' && this.atLaunch.has(record.id) && mayBeEmpty(record),
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
      const key = `${agentId}\n${item.sessionId}`
      this.listed.delete(key)
      this.listed.set(key, { title: item.title, updatedAt: item.updatedAt })
      if (this.listed.size > LISTED_SESSIONS) {
        this.listed.delete(this.listed.keys().next().value!)
      }
    }
    return {
      sessions: page.sessions.map((item) => ({
        acpSessionId: item.sessionId,
        title: item.title,
        updatedAt: item.updatedAt,
        imported:
          this.findByAcp(agentId, item.sessionId) !== undefined ||
          this.takenEarlier(agentId, item.sessionId),
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
    this.deps.agents.assertEnabled(params.agentId)
    const projectPath = await this.deps.projects.resolveDirectory(params.projectPath)
    const existing = this.findByAcp(params.agentId, params.acpSessionId)
    if (existing) return this.summary(existing.id)
    if (this.takenEarlier(params.agentId, params.acpSessionId)) {
      throw new HostError('busy', t('session.alreadyInSession'))
    }
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
      ...(listed?.title ? { titleSource: 'agent' as const } : {}),
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
    this.emit(
      live,
      drafts.map((draft) => gitPatch(live.thread, draft, () => this.nextId(live, 'g'))),
    )
    const opened = drafts.flatMap((draft) =>
      draft.event === 'pull_request' && GITHUB_PULL_REQUEST_URL.test(draft.url) ? [draft.url] : [],
    )
    const known = live.record.pullRequests ?? []
    const added = opened.filter((url) => !known.includes(url))
    if (added.length > 0) {
      live.record.pullRequests = [...known, ...added].slice(-MAX_SESSION_PULL_REQUESTS)
      this.persist(live)
      this.touch(live.id)
    }
  }

  /** Pull requests changed for a project's branches: its rows may show a new badge. */
  pullRequestsChanged(projectPath: string): void {
    for (const summary of this.list(projectPath)) this.touch(summary.id)
  }

  /** A pull request was read for the first time or changed: the rows that show it refresh. */
  pullRequestLoaded(url: string): void {
    const git = this.deps.git()
    for (const id of new Set([...this.records.keys(), ...this.live.keys()])) {
      const record = this.live.get(id)?.record ?? this.records.get(id)
      if (!record) continue
      const ofBranch =
        record.branch && git
          ? git.branchPullRequests(record.projectPath).get(record.branch)?.url === url
          : false
      if (ofBranch || record.pullRequests?.includes(url)) this.touch(id)
    }
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
          turnStartedAt: live.thread.session.turnStartedAt,
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
      if (live.contextTimer) clearTimeout(live.contextTimer)
      this.checkpoint(live, { final: true })
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

/** A connection to an agent that reports background tasks and can stop and read them. */
type TaskConnection = AgentConnection & Required<Pick<AgentConnection, 'stopTask' | 'taskOutput'>>

function reportsTasks(connection: AgentConnection): connection is TaskConnection {
  return connection.stopTask !== undefined && connection.taskOutput !== undefined
}

/** JSON-RPC's code for a session the agent does not have. */
const RESOURCE_NOT_FOUND = -32002

/** The agent does not have the session it was asked to resume. */
export function unknownSession(error: AgentRequestError): boolean {
  return error.code === RESOURCE_NOT_FOUND
}

/** A breakdown stored with the session as its context report, until a read replaces it. */
function storedContext(breakdown: ContextBreakdown | null): Pick<SessionView, 'context'> {
  if (!breakdown) return {}
  const key = `${breakdown.used}/${breakdown.size}`
  return { context: { key, breakdown, loading: false, error: null } }
}

/** The number in an entry id such as `e:12`, which the session's new ids count on from. */
function idNumber(id: string): number {
  return Number(/^\w+:(\d+)$/.exec(id)?.[1] ?? 0)
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A title without the fork suffix the host adds, in any language it writes in. */
export function forkBase(title: string): string {
  const titleMark = '\u0001'
  const numberMark = '\u0002'
  for (const lng of LOCALES) {
    for (const marked of [
      t('session.forkTitle', { lng, title: titleMark }),
      t('session.forkTitleNumbered', { lng, title: titleMark, n: numberMark }),
    ]) {
      const pattern = escapeRegExp(marked).replace(titleMark, '(.+)').replace(numberMark, '\\d+')
      const match = new RegExp(`^${pattern}$`, 's').exec(title)
      if (match) return match[1]!
    }
  }
  return title
}

/** A fork's title: the first one in a project adds "(fork)", the later ones number it. */
export function forkTitle(base: string, taken: ReadonlySet<string>): string {
  const first = t('session.forkTitle', { title: base })
  if (!taken.has(first)) return first
  for (let n = 1; ; n++) {
    const numbered = t('session.forkTitleNumbered', { title: base, n })
    if (!taken.has(numbered)) return numbered
  }
}

/** The last agent message before the turn in progress, or undefined when it is the first turn. */
/** The agent that had the session when `entryId` was written, by the takeovers before it. */
export function writerOf(
  thread: Pick<ThreadState, 'order' | 'byId'>,
  entryId: string,
  firstAgent: AgentId,
): AgentId {
  let agentId = firstAgent
  for (const id of thread.order) {
    if (id === entryId) break
    const entry = thread.byId[id]
    if (entry?.kind === 'takeover') agentId = entry.agentId
  }
  return agentId
}

/** The turns the thread holds before `entryId`, counted by the user's own messages. */
export function turnsBefore(thread: Pick<ThreadState, 'order' | 'byId'>, entryId: string): number {
  let turns = 0
  for (const id of thread.order) {
    if (id === entryId) break
    const entry = thread.byId[id]
    if (entry?.kind === 'user' && !entry.steered) turns++
  }
  return turns
}

export function replyBeforeTurn(thread: Pick<ThreadState, 'order' | 'byId'>): string | undefined {
  let i = thread.order.length - 1
  while (i >= 0) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'user' && !entry.steered) break
    i--
  }
  for (i--; i >= 0; i--) {
    if (thread.byId[thread.order[i]!]?.kind === 'agent') return thread.order[i]
  }
  return undefined
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

/** The id of the permission mode option of a Claude Code or Codex agent; null for any other. */
function modeOptionId(agentId: AgentId): string | null {
  switch (harnessOf(agentId)) {
    case 'claude-code':
      return CLAUDE_OPTION_IDS.mode
    case 'codex':
      return CODEX_MODE_ID
    case 'deepseek':
      return DSH_CONFIG.mode
    default:
      return null
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

/**
 * The record of the session whose page a browser call drives: a subagent's own record has no
 * page, so the call uses the top-level session it runs under, which does.
 */
export function sessionWithPage<T extends Pick<SessionRecord, 'id' | 'origin' | 'parentId'>>(
  record: T,
  find: (id: string) => T | undefined,
): T {
  let current = record
  const seen = new Set<string>()
  while (current.origin === 'subagent' && current.parentId !== null && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = find(current.parentId)
    if (!parent) break
    current = parent
  }
  return current
}
