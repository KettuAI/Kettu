// Live sessions: the authoritative thread state, prompts, permissions, cancellation, the
// session lifecycle, sub-sessions, and the session index.

import type { DeviceAccessAnswer, DeviceAccessDecision } from '@shared/device-agent'
import type { PublishVisibility } from '@shared/market-publish'
import type { PermissionRelay } from '@shared/plugin-channels'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALREADY_ANSWERED,
  REMOVED_WHILE_STARTING,
  type AgentStatus,
  type AttachmentBytes,
  type ContextBreakdown,
  type ImportableSession,
  type ConversationHit,
  type LastTurn,
  type LastTurnLimit,
  type OutlineEntry,
  type OutlineTitle,
  type PlanLimit,
  type PlanProgress,
  type ReturnedMessage,
  type RunningWork,
  type SessionAttention,
  type SessionOutputs,
  type SessionPullRequest,
  type SearchIndexing,
  type SessionFindMatch,
  type SessionSummary,
  type SideChatAgent,
  type LightAgent,
  type StartNotice,
} from '@shared/agent-host'
import { isFullAccessMode } from '@shared/agents'
import { LOCALES } from '@shared/locale'
import { PROMPT_BYTES, promptShare } from '@shared/attachments'
import { CONTEXT_REFRESH_MS, type ContextEstimates } from '@shared/context'
import { canEditAt, promptLine, promptOccurrence, turnsFrom, usedAtEnd } from '@shared/rewind'
import { firstLine, outlineText } from '@shared/outline'
import { reachedLimit } from '@shared/session-groups'
import { longEnough, queryWords } from '@shared/search-fold'
import { originLabel, type BrowserOriginAnswer, type BrowserOriginDecision } from '@shared/browser'
import type {
  ControlOutcome,
  ControlStep,
  ControlSurface,
  SurfaceAccessAnswer,
  SurfaceAccessDecision,
} from '@shared/control'
import type {
  ComputerApp,
  ComputerAppAnswer,
  ComputerAppDecision,
  ComputerSetupOutcome,
  ComputerSetupStep,
} from '@shared/computer-use'
import type {
  AttentionRequest,
  BackgroundWork,
  BusyCounts,
  BusySession,
} from '@shared/host-control'
import type { Platform } from '@shared/platform'
import { pluginStarter, type PluginHookEvent } from '@shared/plugins'
import type { PluginMentionRef } from '@shared/plugin-refs'
import type { PortDevice } from '@shared/remote/device'
import type { PermissionScope } from '@shared/routines'
import type { HostSettings } from '@shared/settings'
import {
  MEMORY_PROPOSALS_WAITING,
  type MemoryAction,
  type MemoryDecision,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryScope,
  type MemorySource,
} from '@shared/memory'
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
  type MemoryWriteEntry,
  type OlderPage,
  type Patch,
  type PatchBatch,
  type PluginAttached,
  type PendingElicitation,
  type PendingQuestion,
  type PermissionOption,
  type PlanEntry,
  type PromptCache,
  type ProblemReportEntry,
  type ProblemReportOutcome,
  type PlanItem,
  type QuestionAnswer,
  type SessionSnapshot,
  type QueuedComments,
  type SessionStatus,
  type SessionView,
  type StopReason,
  type Attachment,
  type CommandRun,
  type ContentRef,
  type SlashCommand,
  type BrowserOriginEntry,
  type ControlAskEntry,
  type ControlNoteEntry,
  type DeviceAccessEntry,
  type SurfaceAccessEntry,
  type MarketPublishEntry,
  type MarketPublishOutcome,
  type SettingChangeItem,
  type SettingsChangeEntry,
  type TaskDeliveryEntry,
  type SettingsChangeOutcome,
  type ComputerAppEntry,
  type ComputerSetupEntry,
  type ComputerUseView,
  type DeclaredMcpServer,
  type ProjectHooksDecision,
  type ProjectHooksEntry,
  type ProjectMcpDecision,
  type ProjectMcpEntry,
  type QueuedPrompt,
  type SideChatEntry,
  type SideChatRoute,
  type SideChatSaw,
  type SideChatView,
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
import { riskyRequest } from './command-safety'
import type { MarketAnswer, MarketAsk } from './marketplace/publish-tools'
import type { SettingsAnswer, SettingsAsk } from './settings/tools'
import { MODE_OPTION as AGY_MODE_OPTION } from './acp/agy-plan'
import { parseContextReport } from './acp/claude-reports'
import {
  isValueOf,
  startModeIn,
  startOrder,
  withFreshModels,
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
import {
  DEFAULT_EFFORT as CLAUDE_DEFAULT_EFFORT,
  DEFAULT_MODEL as CLAUDE_DEFAULT_MODEL,
  OPTION_IDS as CLAUDE_OPTION_IDS,
} from './claude/config'
import {
  COLLABORATION_ID as CODEX_COLLABORATION_ID,
  MODE_ID as CODEX_MODE_ID,
} from './codex/config'
import { CONFIG as DSH_CONFIG } from './dsh/options'
import { carryMode, lostValues, lostValuesNotice, type LostValue } from './config-notice'
import {
  AgentRequestError,
  promptBlocks,
  SideQuestionUnsupported,
  type AgentConnection,
  type ForkPoint,
  type RewoundSession,
  type McpServer,
  type ModelTokens,
  type PermissionAnswer,
  type PermissionRequest,
  type FolderHooks,
  type ProjectHooksGate,
  type ProjectMcpGate,
  type PromptBlock,
  type ListedSession,
  type SessionMemory,
  type SessionOptions,
  type SessionTarget,
  type SideAnswer,
  type SideAnswerEvents,
  type SideQuestion,
} from './connection'
import type { Diagnostics } from './diagnostics'
import { answeredFields, checkedValues } from './elicitation'
import { holdsNothing, mayBeEmpty } from './empty-sessions'
import type { McpTransports } from './marketplace/servers'
import { questionsResult } from './question-answers'
import { HostError, invalidParams, notFound } from './errors'
import { listOf, t } from './i18n'
import type { CommandNeeds } from './commands/format'
import type { CommandExpansion } from './commands/service'
import { roleBlock } from './roles/format'
import type { FoundRole } from './roles/service'
import { logText } from './localized-error'
import {
  GITHUB_PULL_REQUEST_URL,
  githubReferenceOf,
  type SessionWorktree,
  type WorktreeFailure,
} from '@shared/git'
import type { GitEventDraft, GitServiceApi } from './git/api'
import { canonicalizePath, isInside, pathKey, samePath } from './paths'
import type { ProjectHooksAnswers } from './project-hooks'
import type { ProjectMcpAnswers } from './project-mcp'
import { REPORTS_PER_DAY, type ReportDraft } from './report-tool'
import { isOutOfCredit } from './out-of-credit'
import { planRevision } from './plan-revision'
import { watchSettings, type PreparedRecords, type WatchTarget } from './prepared'
import type { Projects } from './projects'
import type { LastRequest, OutsideReader } from './outside-sessions'
import type { CacheTtlReader } from './prompt-cache'
import type { ModelRequestsReader, RequestsTarget } from './model-requests/reader'
import type {
  ModelRequestRaw,
  ModelRequestsOverview,
  ModelRequestsPage,
} from '@shared/model-requests'
import { missedCache, type IdleRelease } from './idle-release'
import {
  REPORT_LIMIT,
  reportText,
  type ToolChoices,
  type ToolDelivery,
  type ToolMode,
  type ToolSession,
} from './session-tools'
import {
  isRanked,
  modeLabel,
  modeRank,
  startableModes,
  startedCeiling,
  startedMode,
  starterRank,
  type ModeRank,
} from './started-mode'
import type { RoutineSessionHooksRef, RoutineSessionStart } from './routines/hooks'
import type { TaskSessionHooksRef, TaskStepStart } from './workflow/engine'
import {
  attachmentText,
  denialAnswer,
  requestFacts,
  type PluginAttachment,
  type PluginDenial,
  type RequestFacts,
} from './plugin-runtime/hooks'
import { scopeAnswer } from './routines/scope'
import { CONTEXT_REPORT, runReport } from './reports'
import type { ScratchFolders } from './scratch'
import type { WorktreeInspection } from './worktrees/api'
import type { PrepareState, SetupLog, WorktreeManager } from './worktrees/manager'
import { BranchNaming } from './worktrees/naming'
import {
  carriedContext,
  compactedTurns,
  sideContext,
  threadTurns,
  type CarriedContext,
  type RenderedTurn,
} from './carried-context'
import {
  MAX_SESSION_PULL_REQUESTS,
  type EarlierAgent,
  type JsonFile,
  type OutsideValues,
  type PendingCarry,
  type ReturnedFile,
  type SessionRecord,
  type SessionRole,
  type SessionsFile,
  type WorktreeRecord,
} from './storage'
import { SUMMARY_RETRY_MS, writeTitles } from './outline-titles'
import { lightTarget, type LightTarget } from './light-model'
import {
  SIDE_ANSWER_CHARS,
  SIDE_STEPS,
  SIDE_TEXT_MS,
  answerFork,
  answerHidden,
  answersForOthers,
  copySaw,
  forkPrompt,
  hiddenPrompt,
  ownSaw,
  questionText,
  sideHistory,
  sideRoute,
  sideRouteWith,
} from './side-chat'
import { SIDE_ENTRIES, type StoredSideChat } from './threads/side-chat'
import { ToolActivity } from './session-activity'
import { listedTitle, titleMessageText, writeBranchSlug, writeSessionTitle } from './session-titles'
import {
  addTokenTotals,
  firstUserMessage,
  isStopReason,
  mergeConfig,
  newTurnScope,
  SYNTHETIC_MODE_ID,
  type MapperEffect,
  type MapperOutput,
  type RequestCache,
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
  type StoredEntry,
  type StoredOutline,
  type StoredThread,
  type ThreadPage,
  type ThreadWrite,
} from './threads/model'
import { turnPhase } from '@shared/turn-phase'
import { originOf, originText, restoredOrigins, type StoredOrigin } from './threads/origins'
import { ThreadStoreError, type ThreadStore } from './threads/store'
import type { UsageRow } from './usage/model'
import { recordRows } from './usage/record'

/** What a step may do without asking until it reports: edit and run commands in its folder. */
const STEP_SCOPE: PermissionScope = { level: 'commands', web: false }

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
  /**
   * `request`: what waits, for a permission, with the answers a notification may give itself.
   * `facts`: what that request asks for, which a plugin that may answer it is told.
   */
  attention(
    sessionId: string,
    kind: 'permission' | 'turn-ended' | 'error',
    title: string,
    body: string,
    request?: AttentionRequest,
    facts?: RequestFacts,
  ): void
  badge(count: number): void
  /** What waits for the user now, by session, each change of it. */
  waiting(sessions: Record<string, string[]>): void
  /** The session was shown or marked read, so its turn was seen. */
  seen(sessionId: string): void
  busy(counts: BusyCounts): void
  /** A turn of a session the user started themselves ended normally. */
  completed(sessionId: string): void
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
  /**
   * The paragraph on where Kettu's tools are and when to use them, for an agent that takes it
   * ahead of its prompt rather than in instructions of its own.
   */
  guide(agentId: AgentId): string
}

/** Kettu's own slash commands, as sessions use them. */
export interface SessionCommands {
  /**
   * The message a text starting with one of the commands expands to; null when it starts with
   * none, or with a name the agent has itself. Throws when the command cannot go.
   */
  expand(text: string, agentOwn: ReadonlySet<string>): Promise<CommandExpansion | null>
  /** What of `needs` the agent is not handed anyway, which its session must be given. */
  extra(agentId: AgentId, needs: CommandNeeds): CommandNeeds
}

/** Kettu's own events as plugins hear of them, and the two hooks that may act. */
export interface SessionPlugins {
  /** Whether a plugin would be sent the event, so nothing is worked out when none would. */
  wants(event: PluginHookEvent): boolean
  /** Tells the plugins that hold the event's permission; nothing waits for them. */
  emit(
    event: PluginHookEvent,
    session: SessionSummary,
    payload?: Record<string, unknown>,
    content?: Record<string, unknown>,
  ): void
  /** What plugins attach to a message about to be sent, within a deadline Kettu never exceeds. */
  attachments(session: SessionSummary, text: string): Promise<PluginAttachment[]>
  /** What the items the user mentioned add to the message, or why one could not be added. */
  mentions(
    session: SessionSummary,
    mentioned: readonly PluginMentionRef[],
  ): Promise<PluginAttachment[]>
  /** The plugin that denies a permission request, when one does within the deadline. */
  check(session: SessionSummary, facts: RequestFacts): Promise<PluginDenial | null>
}

/** Kettu's own roles, as sessions start as them. */
export interface SessionRoles {
  /**
   * The role a reference names. Throws when none does, or when a skill or MCP server it names is
   * not installed or is turned off.
   */
  resolve(ref: string): Promise<FoundRole>
}

/** Kettu's memory as sessions hand it to their agents and write what their agents propose. */
export interface SessionMemoryDeps {
  readonly enabled: boolean
  index(project: string | null, tools: boolean): Promise<string>
  save(
    scope: MemoryScope,
    id: string | null,
    draft: MemoryDraft,
    by: MemorySource,
  ): Promise<{ entry: MemoryEntry; undo: string }>
  remove(scope: MemoryScope, id: string, by: MemorySource): Promise<{ undo: string; title: string }>
  undo(undoId: string): Promise<'undone' | 'changed' | 'gone'>
}

/** A project memory write an agent made, as its thread records it. */
export interface MemoryWritten {
  layer: 'project'
  action: MemoryAction
  memoryId: string
  title: string
  undo: string
}

/** A global memory write an agent proposed, which waits in its thread for the user. */
export interface MemoryProposal {
  action: MemoryAction
  memoryId: string | null
  title: string
  draft: MemoryDraft | null
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
  /** The user's answers about each folder's own Claude Code hooks; without them none run. */
  projectHooks?: ProjectHooksAnswers
  /** Whether a port is still open, so a failed start knows whether its window can take its message. */
  portOpen(portId: string): boolean
  /** The paired device an open port serves, null for a window's; without it every port is one. */
  portDevice?(portId: string): PortDevice | null
  /** Where threads are stored; without it every session opens through its agent. */
  threads: ThreadStore | null
  /**
   * The text of a file a session's agent keeps for it, read only from that session's own folder;
   * null when it cannot be read. Without it no such file is read.
   */
  agentFile?(sessionId: string, path: string): Promise<string | null>
  /**
   * The text of a file in the folder a session works in, read as the Files pane reads one; null
   * when it cannot be read there. Without it no such file is read.
   */
  projectFile?(sessionId: string, path: string): Promise<string | null>
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
  /** Reads a session's requests to its model from the agent's own record of the session. */
  modelRequests?: ModelRequestsReader
  /**
   * Reads how a Claude Code session last ran outside Kettu and whether a process there still has
   * it open; without it a session is imported and attached unchecked.
   */
  outside?: OutsideReader
  /** When idle Claude Code sessions let their agent go; without it they follow `timings`. */
  idleRelease?: IdleRelease
  /** The attachments drafts and queued prompts hold; without it a prompt carries none. */
  attachments?: Attachments
  /** The artifacts service; without it every attach passes no MCP servers. */
  mcp?: SessionMcp
  /**
   * The skills an attach of the session passes, Kettu's own with them when `kettu`, the session
   * reaching Kettu's server, and a workflow step's own; without it none.
   */
  skills?: (
    record: SessionRecord,
    kettu: boolean,
  ) => Promise<Pick<SessionOptions, 'skillRoots' | 'localPlugins'>>
  /** Kettu's own slash commands; without it a text goes as typed. */
  commands?: SessionCommands
  /** Kettu's own roles; without it no session starts as one. */
  roles?: SessionRoles
  /** Plugins' hooks on Kettu's own events; without it none are told. */
  plugins?: SessionPlugins
  /** Kettu's memory; without it no session is handed any. */
  memory?: SessionMemoryDeps
  /** The prepared sessions not yet adopted or removed, kept for the host after a crash. */
  prepared?: PreparedRecords
  /** What to watch for changes to the agent's options in a folder; without it nothing is. */
  settingsTargets?: (agentId: AgentId, folder: string) => WatchTarget[]
  /** The host's settings, read as a turn starts for whether a title is to be written. */
  settings: () => HostSettings
  /** What a routine's run hears of its session; set once the routines manager exists. */
  routine?: RoutineSessionHooksRef
  /** What a workflow step hears of its session; set once the task engine exists. */
  task?: TaskSessionHooksRef
  /** The workflow suggestions that wait for the user's answer in a session, which it counts. */
  cards?: {
    waiting(sessionId: string): number
    /** A turn started, so the suggestions that waited stop waiting on the session. */
    turnStarted(sessionId: string): void
  }
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
  /** Told once it has ended, as an edit from a message waits for the turn it stops. */
  ends: (() => void)[]
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
  /** The agent waits for nothing: the request outlasts its turn and never holds the session. */
  nonBlocking: boolean
  answer(answer: PermissionAnswer): void
}

/**
 * The mode of a session another session's agent or a workflow started: the starter's rank, null
 * for none Kettu can rank, the mode it asked for, and the ceiling, known once the agent's own mode is.
 */
interface StartedModeHold {
  starter: ModeRank | null
  wanted: string | null
  ceiling: ModeRank | null
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
  /** Publish cards that outlived the turn that opened them, which no turn waits on. */
  lateCards: Set<string>
  /** Who answered the latest new origins, by entry id: a device, or null for a window. */
  originsAnswered: Map<string, FromDevice | null>
  /** Each first use of an app that waits for the user: its entry, by the request's id. */
  apps: Map<number, string>
  /** Who answered the latest first uses of apps, by entry id: a device, or null for a window. */
  appsAnswered: Map<string, FromDevice | null>
  /** Each setup a call waits on: its entry, by the request's id. */
  setups: Map<number, string>
  /** The step the agent asked the user to do on its page, and the first answer a client gave. */
  ask: {
    entryId: string
    answer: { outcome: ControlOutcome; device: FromDevice | null } | null
  } | null
  /** When each request that waits began to, by the id `waitingIds` gives it. */
  waitingSince: Map<string, number>
  /** The tool calls its thread runs now, for the summary's activity. */
  activity: ToolActivity
  /** Who sent the latest turn: a window's or a device's port, and the device it serves. */
  sender: TurnSender | null
  failure: Failure | null
  /** The sign-in notices it shows, settled once the agent reports it is signed in. */
  signInNotices: string[]
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
  /** It attached as the user started typing, before anything was sent. */
  typed: boolean
  /** A new session's first message, in its thread already, to send once the session has started. */
  first: {
    content: UserContent[]
    entryId: string
    from?: FromSession
    device?: FromDevice
    kettu?: true
    portId?: string
  } | null
  /** A first message that waits for its worktree's preparation, which sends it. */
  heldFirst: Live['first']
  /** Who queued each waiting prompt, by item id; apart from the queue, which every client sees. */
  queuedBy: Map<string, string>
  /**
   * What says each waiting prompt Kettu queued itself, such as a step's reminder, is still due when
   * its turn comes, by item id.
   */
  kettuQueued: Map<string, () => boolean>
  /** The last turn began with the user's own message, which owes no step report. */
  userTurn: boolean
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
  /**
   * Work runs on after its tool call ended. An agent that says when that work ends sets it back;
   * for one that does not, it stays set until the agent exits.
   */
  background: boolean
  /** The agent sent its full list of background work, background subagents among it. */
  backgroundListed: boolean
  /** Jobs the agent scheduled to wake the session later, such as cron and /loop wakeups. */
  scheduled: number
  /** Why it last kept its agent while idle, so a change of reason is logged once. */
  held: string | null
  /** The agent runs a turn of its own, which shows as the session's once no other turn runs. */
  agentTurn: boolean
  /** Set while it is a prepared session, not yet in the index. */
  prepared: Prepared | null
  /** A run's session: the mode it must start in, its scope, and its first turn's course. */
  routineMode: string | null
  routineScope: PermissionScope | null
  routineTurnStarted: boolean
  routineTurnEnded: boolean
  /** A session another session's agent or a workflow started: what its mode is held to. */
  startedMode: StartedModeHold | null
  /** Since when nothing has needed its agent, and since when no port has shown it in front. */
  idleSince: number | null
  hiddenSince: number | null
  releaseTimer: ReturnType<typeof setTimeout> | null
  /** The version of the harness's program its agent runs, when the agent says. */
  harnessVersion: string | null
  /**
   * Set as it resumes within its prompt cache's lifetime, until its first request says how much
   * of the cache it read: the context it had before, in tokens.
   */
  resumeRead: { before: number; lastRequestAt: number; expiresAt: number } | null
  /** When its model list was last read again, and the read running now. */
  modelsReadAt: number | null
  modelsRead: Promise<void> | null
  /** The models a read again added to a list its agent process gave when it attached. */
  refreshedModels: Set<string>
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
  /** The entries an edit from a message took out, at their positions, while `record.rewound` holds. */
  setAside: PositionedEntry[] | null
  /** The set-aside entries changed since the last checkpoint, which writes them whole. */
  setAsideDirty: boolean
  /** The position the next checkpoint drops the stored thread from, as an edit cut it there. */
  cutAt: number | null
  /** The cut of the agent's own session for an edit, while it runs. */
  rewinding: Promise<void> | null
}

const TITLE_LENGTH = 60
// Titles from `session/list`, kept for an import that follows; bounded like every cache here.
const LISTED_SESSIONS = 1_000
// The sessions a search of the conversations returns, the most recently changed first.
const SEARCH_SESSIONS = 100
// The messages a find in one session lists, the newest when it has more.
const FIND_MESSAGES = 500
// Requests whose answerer a session remembers, so a late answer hears where it was answered.
const ANSWERS_KEPT = 50

/**
 * A new origin's request by who asks it, `owner` being '' for main and a device's port for a
 * desktop app's page, since each numbers its own requests.
 */
function originKey(owner: string, requestId: number): string {
  return `${owner}:${requestId}`
}

const MINUTE = 60_000
// A session's model list is read again when its menu opens, at most this often.
const MODELS_FRESH_MS = MINUTE
/** How long a prompt cache lasts when the agent's own records do not say. */
const CACHE_TTL_MS = 5 * MINUTE
/** A session used outside Kettu longer ago than this has no cache left worth carrying over. */
const OUTSIDE_WINDOW_MS = 60 * MINUTE
/** How often a shown Claude Code session is looked at for a program outside Kettu holding it. */
const FOLLOW_MS = 3_000

/** How long after a window resets Kettu waits before it carries a session on. */
const CONTINUE_AFTER_RESET_MS = 30_000
/** How soon after the host starts a continuation that is already due goes, so startup stays fast. */
const CONTINUE_AFTER_START_MS = 10_000
/** How long a continuation waits before it reads the limits again while a window still reads reached. */
const CONTINUE_RETRY_MS = MINUTE
/** How many times it reads again before it leaves the session to the user. */
const CONTINUE_RETRIES = 5

/** What a session is sent to carry on once the window that stopped it has reset. */
const CONTINUE_PROMPT =
  'The plan limit that stopped your last turn has reset. Continue the work from where you left off.'

/** When the session's prompt cache expires, from its main thread's latest request, if any. */
function cacheExpiresAt(live: Live): number | null {
  const cache = live.thread.session.usage?.cache
  return cache ? cache.lastRequestAt + (cache.ttl ?? CACHE_TTL_MS) : null
}

/**
 * Claude Code takes its effort from the command line it resumes with, not from the session, so a
 * resumed session's effort and model go out again even when they look unchanged. A default needs
 * nothing: it is what that command line resolves to.
 */
function resentOnResume(
  agentId: AgentId,
  values: Record<string, string | boolean>,
): ReadonlySet<string> | undefined {
  if (harnessOf(agentId) !== 'claude-code') return undefined
  const { model, effort } = CLAUDE_OPTION_IDS
  const resent = new Set<string>()
  if (values[model] !== undefined && values[model] !== CLAUDE_DEFAULT_MODEL) resent.add(model)
  if (values[effort] !== undefined && values[effort] !== CLAUDE_DEFAULT_EFFORT) resent.add(effort)
  return resent
}

/** The requests that wait for the user: permissions, new sites, first uses of apps and setups. */
function waitingCount(live: Live): number {
  return (
    live.permissions.size +
    live.origins.size +
    live.apps.size +
    live.setups.size +
    (live.ask ? 1 : 0)
  )
}

/** The entries of what waits, in thread order: the same requests `waitingCount` counts. */
function waitingEntries(live: Live): ThreadEntry[] {
  const ids = new Set([
    ...[...live.permissions.values()].map(({ toolEntryId }) => toolEntryId),
    ...live.origins.values(),
    ...live.apps.values(),
    ...live.setups.values(),
    ...(live.ask ? [live.ask.entryId] : []),
  ])
  const at = (id: string): number => live.positions.get(id) ?? Number.MAX_SAFE_INTEGER
  return [...ids]
    .sort((a, b) => at(a) - at(b))
    .flatMap((id) => {
      const entry = live.thread.byId[id]
      return entry ? [entry] : []
    })
}

/** The latest plan's progress; null without a plan, or for one without steps. */
function planProgress({ order, byId }: ThreadState): PlanProgress | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = byId[order[i]!]
    if (entry?.kind !== 'plan') continue
    const { items } = entry
    if (items.length === 0) return null
    const index = items.findIndex((item) => item.status === 'in_progress')
    return {
      done: items.filter((item) => item.status === 'completed').length,
      total: items.length,
      current: index === -1 ? null : { index, text: firstLine(items[index]!.content) },
    }
  }
  return null
}

/** The window that stopped a turn, as its summary names it. */
function lastTurnLimit(status: AgentStatus, limit: PlanLimit): LastTurnLimit {
  return {
    window: limit.window,
    label: limit.label,
    account: status.account?.label || status.name,
    resetsAt: limit.resetsAt,
  }
}

/** Whether a patch can change the latest plan, which the session's summary carries. */
function changesPlan(thread: ThreadState, patch: Patch): boolean {
  if (patch.op === 'entry.add') return patch.entry.kind === 'plan'
  if (patch.op === 'entry.update') return thread.byId[patch.id]?.kind === 'plan'
  return patch.op === 'thread.reset' || patch.op === 'thread.truncate'
}

/** Notes when each of `ids` began to wait, and forgets the requests that no longer do. */
function stampWaiting(live: Live, ids: readonly string[], now: number): void {
  const current = new Set(ids)
  for (const id of live.waitingSince.keys()) if (!current.has(id)) live.waitingSince.delete(id)
  for (const id of ids) if (!live.waitingSince.has(id)) live.waitingSince.set(id, now)
}

/** The ids of what waits: each permission's request id, and the entry id of the others. */
function waitingIds(live: Live): string[] {
  return [
    ...live.permissions.keys(),
    ...live.origins.values(),
    ...live.apps.values(),
    ...live.setups.values(),
    ...(live.ask ? [live.ask.entryId] : []),
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

/** The values a session's last request outside Kettu ran with, to take on its first attach. */
function outsideValuesOf(last: LastRequest): OutsideValues | null {
  const values: OutsideValues = {
    ...(last.model ? { model: last.model } : {}),
    ...(last.effort ? { effort: last.effort } : {}),
    ...(last.fast !== null ? { fast: last.fast } : {}),
    ...(last.mode ? { mode: last.mode } : {}),
  }
  return Object.keys(values).length > 0 ? values : null
}

/** The choice of a Claude Code model option that runs the model `id` names, suffix and all. */
function claudeModelChoice(option: ConfigOption, id: string): string | null {
  const choices = option.choices ?? []
  const named = (value: string | undefined): boolean =>
    value !== undefined && value.toLowerCase() === id.toLowerCase()
  const current = choices.find((choice) => choice.value === option.value)
  if (current && (named(current.modelId) || named(current.value))) return current.value
  return (
    choices.find((choice) => named(choice.modelId))?.value ??
    choices.find((choice) => named(choice.value))?.value ??
    null
  )
}

/**
 * The option values that make a Claude Code session's next request like its last one outside
 * Kettu: the model it named, its effort and fast mode, and its mode unless that was full access,
 * which is never taken.
 */
function outsideOptionValues(
  config: readonly ConfigOption[],
  outside: OutsideValues,
): { values: Record<string, string | boolean>; fullAccess: boolean } {
  const values: Record<string, string | boolean> = {}
  const option = (id: string): ConfigOption | undefined => config.find((o) => o.id === id)
  const model = option(CLAUDE_OPTION_IDS.model)
  const modelValue = model && outside.model ? claudeModelChoice(model, outside.model) : null
  if (modelValue !== null) values[CLAUDE_OPTION_IDS.model] = modelValue
  const effort = option(CLAUDE_OPTION_IDS.effort)
  if (effort && outside.effort && isValueOf(effort, outside.effort)) {
    values[CLAUDE_OPTION_IDS.effort] = outside.effort
  }
  if (option(CLAUDE_OPTION_IDS.fast) && outside.fast !== undefined) {
    values[CLAUDE_OPTION_IDS.fast] = outside.fast
  }
  const fullAccess = outside.mode === 'bypassPermissions'
  const mode = option(CLAUDE_OPTION_IDS.mode)
  if (mode && outside.mode && !fullAccess && isValueOf(mode, outside.mode)) {
    values[CLAUDE_OPTION_IDS.mode] = outside.mode
  }
  return { values, fullAccess }
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

type FinishedTool = ToolEntry & { status: 'completed' | 'failed' }

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
  // Reports each session got since the user last wrote there; one past the limit once its notice
  // is shown. In memory: a restart lets a few more through, which the limit tolerates.
  private readonly reportsSent = new Map<string, number>()
  private readonly watchers = new Map<string, Set<string>>()
  // Port id to the sessions it shows in front, every pane of a split view in view.
  private readonly shown = new Map<string, Set<string>>()
  /** Each waiting new origin's session and entry, by `originKey`. */
  private readonly originRequests = new Map<string, OriginRequest>()
  /** Each device card's answer, by its entry id, which the waiting tool call takes. */
  private readonly deviceWaits = new Map<string, (answer: DeviceAccessAnswer) => void>()
  private readonly surfaceWaits = new Map<string, (answer: SurfaceAccessAnswer) => void>()
  /** Marketplace cards that wait for the user, by entry id. */
  private readonly marketWaits = new Map<string, (answer: MarketAnswer) => void>()
  /** Cards whose Publish is setting the account's publisher name, which a second answer waits out. */
  private readonly marketAnswering = new Set<string>()
  /** Settings cards that wait for the user, by entry id. */
  private readonly settingsWaits = new Map<string, (answer: SettingsAnswer) => void>()
  /** Each first use of an app that waits, by the computer use service's request id. */
  private readonly appRequests = new Map<number, AppRequest>()
  /** Each session's card holding its folder's own MCP servers while it waits, with the folder. */
  private readonly projectMcpCards = new Map<string, { entryId: string; folder: string }>()
  /** Each session's card holding its folder's own hooks while it waits, with what it holds. */
  private readonly projectHooksCards = new Map<
    string,
    { entryId: string; folder: string; digest: string }
  >()
  /** Memory proposals and writes being answered or taken back, by session and entry, with who. */
  private readonly memoryAnswers = new Map<string, FromDevice | null>()
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
  /**
   * New worktrees whose branch name their agent is writing, by path key, until it is settled, with
   * the template's other values they were made with.
   */
  private readonly branchNames = new Map<
    string,
    { naming: BranchNaming; values: { type?: string; issue?: string } }
  >()
  private readonly lastSummaries = new Map<string, string>()
  /** `/context` reports running, by session id. */
  private readonly contextRuns = new Map<string, Promise<ContextBreakdown | null>>()
  private readonly contextEstimateRuns = new WeakMap<Live, Promise<ContextEstimates | null>>()
  /** The side question each session is answering, stopped through its controller. */
  private readonly sideRuns = new Map<string, AbortController>()
  /** What the last clear of each session's side chat emptied, for its undo. */
  private readonly sideCleared = new Map<string, SideChatEntry[]>()
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
  /** A look at the idle limit is due once the current work is done. */
  private limitCheck = false
  /** Sessions let go for idleness since this host started, whose resume the cache guard checks. */
  private readonly idleReleased = new Set<string>()
  /** Transcript reads waiting to run, by session id. */
  private readonly cacheReads = new Map<string, ReturnType<typeof setTimeout>>()
  /** Looks at the shown Claude Code sessions for a program outside Kettu that holds one. */
  private followTimer: ReturnType<typeof setInterval> | null = null
  private following = false
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
  /** The timers that carry sessions on once the window that stopped them resets, by session. */
  private readonly continues = new Map<string, ReturnType<typeof setTimeout>>()
  /** How many times a continuation re-armed because its window still read reached. */
  private readonly continueRetries = new Map<string, number>()
  /** Each window's prepared sessions, by port. */
  private readonly preparedSlots = new Map<string, PreparedSlot>()
  private emptyRemoval: Promise<void> | null = null
  /** Each session's pull requests as plugins were last told of them, by url: state and checks. */
  private readonly pullRequestsTold = new Map<string, Map<string, string>>()

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
    await this.deps.projectHooks?.load()
    // A limit that reset while Kettu was closed still carries its sessions on, once.
    if (this.deps.settings().continueAfterLimit) {
      for (const record of this.records.values()) {
        const at = record.lastTurn?.reason === 'limit' ? record.lastTurn.continuesAt : undefined
        if (typeof at !== 'number') continue
        this.scheduleContinue(
          record.id,
          Math.max(at + CONTINUE_AFTER_RESET_MS, this.now() + CONTINUE_AFTER_START_MS),
        )
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.deps.file.flush(),
      this.deps.returned.flush(),
      this.deps.projectMcp?.flush(),
      this.deps.projectHooks?.flush(),
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
    if (!record) throw notFound(t('session.notFound'))
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
    // A suggestion waits in the cards file, so it counts whether the session is live or not.
    const permissionCount =
      (live ? waitingCount(live) : 0) + (this.deps.cards?.waiting(record.id) ?? 0)
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
      task: record.task ?? null,
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
      plan: live ? planProgress(live.thread) : null,
      turnStartedAt: live?.thread.session.turnStartedAt ?? null,
      activity:
        live && (status === 'running' || status === 'awaiting_permission')
          ? live.activity.current(live.thread)
          : null,
      phase: live && status === 'running' ? turnPhase(live.thread).phase : null,
      lastTurn: record.lastTurn ?? null,
      ...(record.worktree ? { worktree: this.worktreeSummary(record.worktree) } : {}),
      ...(record.agentWorktree ? { agentWorktree: { ...record.agentWorktree } } : {}),
      ...(live?.prepared
        ? {
            prepared: {
              config: session?.config ?? [],
              commands: session?.commands ?? [],
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
      // A routine's runs are listed under their routine, a task's steps under their task.
      if (summary.origin === 'routine' || summary.origin === 'task') continue
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
    const now = this.now()
    for (const live of this.live.values()) {
      count += waitingCount(live)
      const ids = waitingIds(live)
      if (ids.length > 0) waiting[live.id] = ids
      stampWaiting(live, ids, now)
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
    let plan = false
    let activity = false
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
      plan ||= changesPlan(live.thread, patch)
      activity = live.activity.follow(live.thread, patch, this.now()) || activity
      if (keeper && patch.op === 'entry.add') {
        for (const entry of keeper.after(patch.entry)) this.apply(live, { op: 'entry.add', entry })
      }
    }
    this.scheduleFlush(live)
    this.scheduleCheckpoint(live)
    // A replay ends with a summary of its own, which carries the plan it brought back.
    if ((plan || activity) && !live.replaying) this.touch(live.id)
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
  async answerReport(
    sessionId: string,
    entryId: string,
    outcome: ProblemReportOutcome,
    device?: FromDevice,
  ): Promise<void> {
    this.recordOf(sessionId)
    const live = await this.revive(sessionId)
    const entry = live.thread.byId[entryId]
    if (entry?.kind !== 'problem_report') throw notFound(t('session.waiting.report.gone'))
    if (entry.outcome !== null) {
      throw new HostError('not_found', t('session.waiting.report.answered'), {
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

  /** A project memory write the session's agent made goes in its thread, with its Undo. */
  memoryWritten(sessionId: string, write: MemoryWritten): void {
    const live = this.live.get(sessionId)
    if (!live) return
    const entry: MemoryWriteEntry = {
      kind: 'memory',
      id: this.nextId(live),
      layer: write.layer,
      action: write.action,
      memoryId: write.memoryId,
      title: write.title,
      status: 'written',
      undo: write.undo,
      draft: null,
      after: agentEntryBefore(live.thread),
    }
    this.emit(live, [{ op: 'entry.add', entry }])
  }

  /**
   * A global memory write the agent proposed waits in its thread for the user, unless the session
   * is not in memory or enough proposals wait already. It does not mark the session as waiting:
   * the agent carries on meanwhile.
   */
  memoryProposed(sessionId: string, proposal: MemoryProposal): 'added' | 'closed' | 'full' {
    const live = this.live.get(sessionId)
    if (!live) return 'closed'
    let waiting = 0
    for (const item of Object.values(live.thread.byId)) {
      if (item.kind === 'memory' && item.status === 'proposed') waiting++
    }
    if (waiting >= MEMORY_PROPOSALS_WAITING) return 'full'
    const entry: MemoryWriteEntry = {
      kind: 'memory',
      id: this.nextId(live),
      layer: 'global',
      action: proposal.action,
      memoryId: proposal.memoryId,
      title: proposal.title,
      status: 'proposed',
      undo: null,
      draft: proposal.draft,
      after: agentEntryBefore(live.thread),
    }
    this.emit(live, [{ op: 'entry.add', entry }])
    return 'added'
  }

  /**
   * The answer to a proposed global memory write, from the window or device that answered first:
   * `remember` writes it in global memory as the session's agent's.
   */
  async answerMemory(
    sessionId: string,
    entryId: string,
    decision: MemoryDecision,
    device?: FromDevice,
  ): Promise<void> {
    const memory = this.deps.memory
    this.recordOf(sessionId)
    const live = await this.revive(sessionId)
    const entry = live.thread.byId[entryId]
    if (!memory || entry?.kind !== 'memory' || entry.layer !== 'global') {
      throw notFound(t('session.waiting.memoryProposal.gone'))
    }
    const key = `${sessionId}\n${entryId}`
    const answering = this.memoryAnswers.get(key)
    if (entry.status !== 'proposed' || answering !== undefined) {
      throw new HostError('not_found', t('session.waiting.memoryProposal.answered'), {
        reason: ALREADY_ANSWERED,
        device: answering !== undefined ? answering : (entry.device ?? null),
      })
    }
    const from = device ? { device } : {}
    if (decision === 'skip') {
      this.emit(live, [
        { op: 'entry.update', id: entryId, changes: { status: 'declined', ...from } },
      ])
      return
    }
    this.memoryAnswers.set(key, device ?? null)
    try {
      const scope: MemoryScope = { layer: 'global' }
      const by: MemorySource = { agentId: live.record.agentId, sessionId }
      let memoryId = entry.memoryId
      if (entry.action === 'forget') {
        if (memoryId === null) throw invalidParams(t('session.waiting.memoryProposal.noForget'))
        await memory.remove(scope, memoryId, by)
      } else {
        if (entry.draft === null) throw invalidParams(t('session.waiting.memoryProposal.noDraft'))
        const id = entry.action === 'update' ? memoryId : null
        memoryId = (await memory.save(scope, id, entry.draft, by)).entry.id
      }
      const changes = { status: 'accepted' as const, memoryId, ...from }
      this.emit(live, [{ op: 'entry.update', id: entryId, changes }])
    } finally {
      this.memoryAnswers.delete(key)
    }
  }

  /** Takes an agent's project memory write back, while the entry is as that write left it. */
  async undoMemory(sessionId: string, entryId: string): Promise<void> {
    const memory = this.deps.memory
    this.recordOf(sessionId)
    const live = await this.revive(sessionId)
    const entry = live.thread.byId[entryId]
    if (!memory || entry?.kind !== 'memory' || entry.status !== 'written' || entry.undo === null) {
      throw notFound(t('session.waiting.memoryUndo.gone'))
    }
    const key = `${sessionId}\n${entryId}`
    if (this.memoryAnswers.has(key)) throw notFound(t('session.waiting.memoryUndo.busy'))
    this.memoryAnswers.set(key, null)
    let result: 'undone' | 'changed' | 'gone'
    try {
      result = await memory.undo(entry.undo)
    } finally {
      this.memoryAnswers.delete(key)
    }
    if (result === 'undone') {
      this.emit(live, [
        { op: 'entry.update', id: entryId, changes: { status: 'undone', undo: null } },
      ])
      return
    }
    if (result === 'changed') {
      throw new HostError('conflict', t('session.waiting.memoryUndo.changed'), {
        reason: 'memory_changed',
      })
    }
    // Its record is gone for good, so the thread offers Undo no more.
    this.emit(live, [{ op: 'entry.update', id: entryId, changes: { undo: null } }])
    throw new HostError('not_found', t('session.waiting.memoryUndo.undone'), {
      reason: 'memory_gone',
    })
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
      expiresAt: Date.now() + waitMs,
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

  /**
   * An agent wants a terminal the user opened in its session: a card in the thread that waits for
   * the user, as a device's first use does, and settles with their answer or `timeout`.
   */
  surfaceAccessAsked(
    sessionId: string,
    target: { surface: 'terminal' | 'browser'; id: string; name: string },
    ask: { readOnly: boolean; rename?: string; passwords?: boolean },
    waitMs: number,
  ): Promise<SurfaceAccessAnswer> {
    const live = this.live.get(sessionId)
    if (!live) return Promise.resolve('timeout')
    const entry: SurfaceAccessEntry = {
      kind: 'surface_access',
      id: this.nextId(live),
      surface: target.surface,
      targetId: target.id,
      targetName: target.name,
      ...(ask.readOnly ? { readOnly: true as const } : {}),
      ...(ask.passwords ? { passwords: true as const } : {}),
      ...(ask.rename !== undefined ? { rename: ask.rename } : {}),
      decision: null,
      expiresAt: Date.now() + waitMs,
      after: agentEntryBefore(live.thread),
    }
    live.origins.set(`surface:${entry.id}`, entry.id)
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
      target.surface === 'browser'
        ? t('attention.tabAccess', { tab: target.name })
        : ask.rename !== undefined
          ? t('attention.terminalRename', { terminal: target.name, name: ask.rename })
          : t('attention.terminalAccess', { terminal: target.name }),
      { id: entry.id },
    )
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.settleSurfaceAccess(sessionId, entry.id, 'timeout'),
        waitMs,
      )
      this.surfaceWaits.set(entry.id, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
    })
  }

  /** A window's or a device's answer to a terminal card; the first one counts. */
  answerSurfaceAccess(
    sessionId: string,
    entryId: string,
    decision: SurfaceAccessDecision,
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const entry = live?.thread.byId[entryId]
    if (!live || entry?.kind !== 'surface_access')
      throw notFound(t('session.waiting.terminal.gone'))
    if (entry.decision !== null || !this.surfaceWaits.has(entryId)) {
      throw new HostError('not_found', t('session.waiting.terminal.answered'), {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    this.settleSurfaceAccess(sessionId, entryId, decision, device)
  }

  /** Marks the cards that allowed the agent a terminal as taken back. */
  surfaceAccessRevoked(sessionId: string, targetId: string): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    if (!live) return
    const patches = threadEntries(live.thread)
      .filter(
        (entry) =>
          entry.kind === 'surface_access' &&
          entry.targetId === targetId &&
          entry.decision === 'allow' &&
          !entry.revoked,
      )
      .map((entry) => ({
        op: 'entry.update' as const,
        id: entry.id,
        changes: { revoked: true as const },
      }))
    if (patches.length > 0) this.emit(live, patches)
  }

  /** Full access let the agent use a terminal the user opened without asking: the thread says so. */
  surfaceUsed(sessionId: string, surface: ControlSurface, name: string): void {
    this.controlNote(sessionId, surface, { event: 'used', name })
  }

  private settleSurfaceAccess(
    sessionId: string,
    entryId: string,
    decision: SurfaceAccessAnswer,
    device?: FromDevice,
  ): void {
    const resolve = this.surfaceWaits.get(entryId)
    this.surfaceWaits.delete(entryId)
    const live = this.live.get(sessionId)
    if (live) {
      live.origins.delete(`surface:${entryId}`)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'surface_access' && entry.decision === null) {
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
    if (!live || entry?.kind !== 'device_access') throw notFound(t('session.waiting.device.gone'))
    if (entry.decision !== null || !this.deviceWaits.has(entryId)) {
      throw new HostError('not_found', t('session.waiting.device.answered'), {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    this.settleDeviceAccess(sessionId, entryId, decision, device)
  }

  /** Marks the session's allow for a device as taken back on the cards that gave it. */
  deviceAccessRevoked(sessionId: string, deviceId: string): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    if (!live) return
    const patches = threadEntries(live.thread)
      .filter(
        (entry) =>
          entry.kind === 'device_access' &&
          entry.deviceId === deviceId &&
          entry.decision === 'session' &&
          !entry.revoked,
      )
      .map((entry) => ({
        op: 'entry.update' as const,
        id: entry.id,
        changes: { revoked: true as const },
      }))
    if (patches.length > 0) this.emit(live, patches)
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
   * An agent wants to publish to the Kettu Marketplace, or to unlist a listing: a card in the
   * thread that waits for the user as a device's first use does, and settles with their answer,
   * `expired` after `waitMs`, or `ended` when the session closes. The turn's end leaves it waiting.
   */
  marketAsked(
    sessionId: string,
    ask: MarketAsk,
    waitMs: number,
  ): { entryId: string; answer: Promise<MarketAnswer> } | null {
    const live = this.live.get(sessionId)
    if (!live) return null
    const entry: MarketPublishEntry = {
      kind: 'market_publish',
      id: this.nextId(live),
      ...ask,
      expiresAt: Date.now() + waitMs,
      outcome: null,
      after: agentEntryBefore(live.thread),
    }
    live.origins.set(`market:${entry.id}`, entry.id)
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
      t(ask.action === 'unlist' ? 'attention.marketUnlist' : 'attention.marketPublish', {
        name: ask.item.name,
      }),
      { id: entry.id },
    )
    const answer = new Promise<MarketAnswer>((resolve) => {
      const timer = setTimeout(
        () => this.settleMarket(sessionId, entry.id, { decision: 'expired' }),
        waitMs,
      )
      this.marketWaits.set(entry.id, (given) => {
        clearTimeout(timer)
        resolve(given)
      })
    })
    return { entryId: entry.id, answer }
  }

  /**
   * A window's or a device's answer to a Marketplace card; the first one counts. Publish on a first
   * publish sets the publisher name before anything else, and a name the service refuses keeps the
   * card waiting with the reason.
   */
  async answerMarket(
    sessionId: string,
    entryId: string,
    given: {
      decision: 'confirm' | 'later'
      visibility?: PublishVisibility
      notes?: string
      handle?: string
    },
    setPublisher: (handle: string) => Promise<void>,
    device?: FromDevice,
  ): Promise<void> {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const entry = live?.thread.byId[entryId]
    if (!live || entry?.kind !== 'market_publish') throw notFound(t('session.waiting.market.gone'))
    const answered = (): HostError =>
      new HostError('not_found', t('session.waiting.market.answered'), {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    if (
      entry.outcome !== null ||
      !this.marketWaits.has(entryId) ||
      this.marketAnswering.has(entryId)
    )
      throw answered()
    if (given.decision === 'confirm' && entry.action === 'publish' && entry.publisher) {
      if (!given.handle) throw invalidParams(t('session.publisherName'))
      this.marketAnswering.add(entryId)
      try {
        await setPublisher(given.handle)
      } finally {
        this.marketAnswering.delete(entryId)
      }
      if (!this.marketWaits.has(entryId)) throw answered()
    }
    const notes = given.notes === undefined ? entry.notes : given.notes.trim() || null
    this.settleMarket(
      sessionId,
      entryId,
      given.decision === 'later'
        ? { decision: 'later' }
        : { decision: 'confirm', visibility: given.visibility ?? null, notes },
      device,
    )
  }

  /** What became of a card the user answered: published, unlisted or refused. */
  marketSettled(sessionId: string, entryId: string, outcome: MarketPublishOutcome): void {
    const live = this.live.get(sessionId)
    if (live?.thread.byId[entryId]?.kind !== 'market_publish') return
    this.emit(live, [{ op: 'entry.update', id: entryId, changes: { outcome } }])
  }

  private settleMarket(
    sessionId: string,
    entryId: string,
    answer: MarketAnswer,
    device?: FromDevice,
  ): void {
    const resolve = this.marketWaits.get(entryId)
    this.marketWaits.delete(entryId)
    const live = this.live.get(sessionId)
    if (live) {
      live.origins.delete(`market:${entryId}`)
      live.lateCards.delete(entryId)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'market_publish' && entry.outcome === null) {
        const outcome: MarketPublishOutcome =
          answer.decision === 'confirm'
            ? { kind: entry.action === 'unlist' ? 'unlisting' : 'publishing' }
            : { kind: answer.decision }
        const changes = {
          outcome,
          ...(answer.decision === 'confirm' ? { notes: answer.notes } : {}),
          ...(answer.decision === 'confirm' && answer.visibility
            ? { visibility: answer.visibility }
            : {}),
          ...(device ? { device } : {}),
        }
        this.emit(live, [{ op: 'entry.update', id: entryId, changes }])
      }
      this.stopWaiting(live)
      this.touch(live.id)
      this.updateBadge()
    }
    resolve?.(answer)
  }

  /**
   * An agent wants to change Kettu's settings: a card in the thread that waits for the user as a
   * permission request does, and settles with their answer, `expired` after `waitMs`, or `ended`
   * with the turn.
   */
  settingsAsked(
    sessionId: string,
    ask: SettingsAsk,
    waitMs: number,
  ): { entryId: string; answer: Promise<SettingsAnswer> } | null {
    const live = this.live.get(sessionId)
    if (!live) return null
    const entry: SettingsChangeEntry = {
      kind: 'settings_change',
      id: this.nextId(live),
      items: ask.items,
      asked: true,
      expiresAt: Date.now() + waitMs,
      outcome: null,
      after: agentEntryBefore(live.thread),
    }
    live.origins.set(`settings:${entry.id}`, entry.id)
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
      t('attention.settingsChange', { count: ask.items.length }),
      { id: entry.id },
    )
    const answer = new Promise<SettingsAnswer>((resolve) => {
      const timer = setTimeout(
        () => this.settleSettings(sessionId, entry.id, { decision: 'expired' }),
        waitMs,
      )
      this.settingsWaits.set(entry.id, (given) => {
        clearTimeout(timer)
        resolve(given)
      })
    })
    return { entryId: entry.id, answer }
  }

  /** A change Full access made without asking: only the line it leaves, with its undo. */
  settingsRecorded(sessionId: string, items: SettingChangeItem[]): string | null {
    const live = this.live.get(sessionId)
    if (!live) return null
    const entry: SettingsChangeEntry = {
      kind: 'settings_change',
      id: this.nextId(live),
      items,
      asked: false,
      expiresAt: null,
      outcome: { kind: 'changed' },
      after: agentEntryBefore(live.thread),
    }
    this.emit(live, [{ op: 'entry.add', entry }])
    return entry.id
  }

  /**
   * A task this session's suggestion card started ended: what it delivered goes at the end of
   * the conversation, which is read back from storage if it is not open, without its agent.
   */
  async taskDelivered(
    sessionId: string,
    delivery: Omit<TaskDeliveryEntry, 'kind' | 'id' | 'after'>,
  ): Promise<void> {
    if (!this.records.has(sessionId)) return
    const live = await this.revive(sessionId)
    const entry: TaskDeliveryEntry = {
      kind: 'task_delivery',
      id: this.nextId(live),
      ...delivery,
      after: agentEntryBefore(live.thread),
    }
    this.emit(live, [{ op: 'entry.add', entry }])
    if (!this.inFront(live.id)) live.unread = true
    this.touch(live.id)
    this.updateBadge()
  }

  /** The delivery of a task in the conversation it started from, for Save and Publish. */
  async taskDelivery(sessionId: string, taskId: string): Promise<TaskDeliveryEntry | null> {
    if (!this.records.has(sessionId)) return null
    const live = await this.revive(sessionId)
    for (let i = live.thread.order.length - 1; i >= 0; i--) {
      const entry = live.thread.byId[live.thread.order[i]!]
      if (entry?.kind === 'task_delivery' && entry.taskId === taskId) return entry
    }
    return null
  }

  /** The user asked the session's agent to publish the workflow a task delivered. */
  taskPublishAsked(sessionId: string, entryId: string): void {
    const live = this.live.get(sessionId)
    if (live?.thread.byId[entryId]?.kind !== 'task_delivery') return
    this.emit(live, [{ op: 'entry.update', id: entryId, changes: { publishAsked: this.now() } }])
  }

  /** A window's or a device's answer to a settings card; the first one counts. */
  answerSettings(
    sessionId: string,
    entryId: string,
    decision: 'change' | 'keep',
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const entry = live?.thread.byId[entryId]
    if (!live || entry?.kind !== 'settings_change')
      throw notFound(t('session.waiting.settings.gone'))
    if (entry.outcome !== null || !this.settingsWaits.has(entryId)) {
      throw new HostError('not_found', t('session.waiting.settings.answered'), {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    this.settleSettings(sessionId, entryId, { decision }, device)
  }

  /** What became of a change the user confirmed, or of one undone later. */
  settingsSettled(sessionId: string, entryId: string, outcome: SettingsChangeOutcome): void {
    const live = this.live.get(sessionId)
    if (live?.thread.byId[entryId]?.kind !== 'settings_change') return
    this.emit(live, [{ op: 'entry.update', id: entryId, changes: { outcome } }])
  }

  /** A settings line's change, for its undo: the rows it set, once it was made and not undone. */
  settingsChange(sessionId: string, entryId: string): SettingChangeItem[] {
    this.recordOf(sessionId)
    const entry = this.live.get(sessionId)?.thread.byId[entryId]
    if (entry?.kind !== 'settings_change') throw notFound(t('session.waiting.settings.noChange'))
    if (entry.outcome?.kind !== 'changed' || entry.outcome.undone || entry.outcome.stale) {
      throw new HostError('conflict', t('session.waiting.settings.noUndo'))
    }
    return entry.items
  }

  private settleSettings(
    sessionId: string,
    entryId: string,
    answer: SettingsAnswer,
    device?: FromDevice,
  ): void {
    const resolve = this.settingsWaits.get(entryId)
    this.settingsWaits.delete(entryId)
    const live = this.live.get(sessionId)
    if (live) {
      live.origins.delete(`settings:${entryId}`)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'settings_change' && entry.outcome === null) {
        // Change is settled by what applying it gives; the card holds until then.
        if (answer.decision !== 'change') {
          const outcome: SettingsChangeOutcome = {
            kind: answer.decision === 'keep' ? 'declined' : answer.decision,
          }
          this.emit(live, [
            {
              op: 'entry.update',
              id: entryId,
              changes: { outcome, ...(device ? { device } : {}) },
            },
          ])
        } else if (device) {
          this.emit(live, [{ op: 'entry.update', id: entryId, changes: { device } }])
        }
      }
      this.stopWaiting(live)
      this.touch(live.id)
      this.updateBadge()
    }
    resolve?.(answer)
  }

  /**
   * The agent asked the user to do a step on the session's page: the thread shows it, waiting, and
   * the session waits as for a permission. A call made again for the same step adds nothing.
   */
  controlAsked(
    sessionId: string,
    step: { surface: ControlSurface; step: ControlStep; target: string | null; reason: string },
  ): void {
    const live = this.live.get(sessionId)
    if (!live || live.ask) return
    const entry: ControlAskEntry = {
      kind: 'control_ask',
      id: this.nextId(live),
      ...step,
      outcome: null,
      after: agentEntryBefore(live.thread),
    }
    live.ask = { entryId: entry.id, answer: null }
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
      step.target === null
        ? t('attention.controlAsk.nowhere')
        : t(`attention.controlAsk.${step.step}`, { target: step.target }),
      { id: entry.id },
    )
  }

  /**
   * The step ended, with the outcome its call returned or with the turn: the card takes it, labelled
   * with the device that answered it first, if one did.
   */
  controlAskSettled(sessionId: string, outcome: ControlOutcome | 'ended'): void {
    const live = this.live.get(sessionId)
    const ask = live?.ask
    if (!live || !ask) return
    live.ask = null
    const device = outcome !== 'ended' && ask.answer?.outcome === outcome ? ask.answer.device : null
    if (live.thread.byId[ask.entryId]?.kind === 'control_ask') {
      this.emit(live, [
        {
          op: 'entry.update',
          id: ask.entryId,
          changes: { outcome, ...(device ? { device } : {}) },
        },
      ])
    }
    this.stopWaiting(live)
    this.touch(live.id)
    this.updateBadge()
  }

  /**
   * A window's or a device's Done or Skip on a step's card. The first one counts and goes to the
   * page, whose waiting call then settles the card; a later one hears where the first was given.
   */
  answerControlAsk(
    sessionId: string,
    entryId: string,
    outcome: ControlOutcome,
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const ask = this.live.get(sessionId)?.ask
    if (!ask || ask.entryId !== entryId) throw notFound(t('session.waiting.step.gone'))
    if (ask.answer) {
      throw new HostError('not_found', t('session.waiting.step.answered'), {
        reason: ALREADY_ANSWERED,
        device: ask.answer.device,
      })
    }
    ask.answer = { outcome, device: device ?? null }
  }

  /** The user handed a surface back after taking it over: the thread says for how long. */
  controlHandedBack(sessionId: string, surface: ControlSurface, durationMs: number): void {
    this.controlNote(sessionId, surface, { event: 'handed_back', durationMs })
  }

  /** The user's own click or key in the app the agent used took it over: the thread says so. */
  controlPaused(sessionId: string, surface: ControlSurface, app: string): void {
    this.controlNote(sessionId, surface, { event: 'paused', app })
  }

  private controlNote(
    sessionId: string,
    surface: ControlSurface,
    note:
      | { event: 'handed_back'; durationMs: number }
      | { event: 'paused'; app: string }
      | { event: 'used'; name: string },
  ): void {
    const live = this.live.get(sessionId)
    if (!live) return
    const entry: ControlNoteEntry = {
      kind: 'control_note',
      id: this.nextId(live),
      surface,
      after: agentEntryBefore(live.thread),
      ...note,
    }
    this.emit(live, [{ op: 'entry.add', entry }])
    this.touch(live.id)
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
      throw new HostError('not_found', t('session.waiting.origin.answered'), {
        reason: ALREADY_ANSWERED,
        device: first ? first.device : (live.originsAnswered.get(entryId) ?? null),
      })
    }
    if (!waiting) throw notFound(t('session.waiting.origin.gone'))
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
      throw new HostError('not_found', t('session.waiting.app.answered'), {
        reason: ALREADY_ANSWERED,
        device: first ? first.device : (live.appsAnswered.get(entryId) ?? null),
      })
    }
    if (!waiting || requestId === undefined) throw notFound(t('session.waiting.app.gone'))
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
    if (!waiting || requestId === undefined) throw notFound(t('session.waiting.setup.gone'))
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
      case 'thread.truncate':
        // The cut entries keep their positions in `setAside`; the next ones are numbered after them.
        for (const id of [...live.positions.keys()]) {
          if (id in live.thread.byId) continue
          live.positions.delete(id)
          live.dirty.delete(id)
        }
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
    return (
      live.rewrite ||
      live.sessionDirty ||
      live.dirty.size > 0 ||
      live.blobs.size > 0 ||
      live.cutAt !== null ||
      live.setAsideDirty
    )
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
      ...(!replace && live.cutAt !== null ? { cut: live.cutAt } : {}),
      ...(replace || live.setAsideDirty ? { setAside: live.setAside ?? [] } : {}),
    }
    live.dirty = new Set()
    live.sessionDirty = false
    live.rewrite = false
    live.blobs = new Map()
    live.cutAt = null
    live.setAsideDirty = false
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
    // A cut or the set-aside entries go again with the whole thread, which carries both.
    const edit = change.cut !== undefined || change.setAside !== undefined
    if (
      change.replace ||
      edit ||
      write !== live.writes ||
      code === 'conflict' ||
      code === 'corrupt'
    ) {
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
            ...storedSide(view, page.session.sideChat),
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

  /** One entry of the thread whole, as a device opens a step its page held as a digest. */
  async entry(
    sessionId: string,
    entryId: string,
    images: ImageMode = 'refs',
  ): Promise<ThreadEntry> {
    const live = this.live.get(sessionId)
    if (live) {
      const { entries } = await this.withBytes(live, images, () => {
        // Patches go out first, so the patches after the entry are the ones it does not hold.
        this.flushPatches(live)
        const entry = live.thread.byId[entryId]
        return { entries: entry ? [entry] : [] }
      })
      if (!entries[0]) throw notFound(t('session.noEntry'))
      return entries[0]
    }
    const record = this.recordOf(sessionId)
    const store = this.deps.threads
    let stored: StoredEntry | null = null
    if (store && record.acpSessionId) {
      try {
        stored = await store.entry(sessionId, entryId, images)
      } catch (error) {
        this.deps.diagnostics.log(
          'warn',
          `Could not read the thread of session ${record.id}: ${(error as Error).message}`,
        )
      }
    }
    if (this.live.has(sessionId) || !this.has(sessionId)) {
      return this.entry(sessionId, entryId, images)
    }
    // A tool entry stored with an artifact link comes as the page gives it, without the link.
    const entry =
      stored && this.isCurrent(record, stored.head)
        ? (splitLinks([stored.entry]) ?? [stored.entry]).find(({ id }) => id === entryId)
        : undefined
    if (!entry) throw notFound(t('session.noEntry'))
    return settled(entry)
  }

  /** What waits for the user's answer in a session, for a client that shows only that. */
  async requests(
    sessionId: string,
    images: ImageMode = 'refs',
  ): Promise<{ entries: ThreadEntry[] }> {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    if (!live) return { entries: [] }
    return this.withBytes(live, images, () => {
      // Patches go out first, so the patches after the entries are the ones they do not hold.
      this.flushPatches(live)
      const entries = waitingEntries(live)
      const askedAt: Record<string, number> = {}
      for (const entry of entries) {
        const key = entry.kind === 'tool' ? entry.permission?.requestId : entry.id
        const at = key === undefined ? undefined : live.waitingSince.get(key)
        if (at !== undefined) askedAt[entry.id] = at
      }
      return { entries, askedAt }
    })
  }

  // The requests to the model, read from the agent's own record when the Requests pane asks; none
  // of it is kept or logged.

  private requestsTarget(sessionId: string): RequestsTarget {
    const record = this.recordOf(sessionId)
    const parent =
      record.origin === 'subagent' && record.parentId ? this.recordOf(record.parentId) : null
    return {
      agentId: record.agentId,
      cwd: workDir(record),
      acpSessionId: record.acpSessionId,
      configDir: record.configDir ?? null,
      parentAcpSessionId: parent?.acpSessionId ?? null,
    }
  }

  async modelRequests(sessionId: string, before: string | null): Promise<ModelRequestsPage | null> {
    const target = this.requestsTarget(sessionId)
    return (await this.deps.modelRequests?.page(target, before)) ?? null
  }

  async modelRequestsOverview(sessionId: string): Promise<ModelRequestsOverview | null> {
    const target = this.requestsTarget(sessionId)
    return (await this.deps.modelRequests?.summary(target)) ?? null
  }

  async modelRequestRaw(sessionId: string, raw: string, full: boolean): Promise<ModelRequestRaw> {
    const reader = this.deps.modelRequests
    if (!reader) throw notFound(t('session.noRequestRecord'))
    return reader.raw(this.requestsTarget(sessionId), raw, full)
  }

  // The message outline.

  /** The session's user messages, oldest first, each with its first line and stored title. */
  async outline(sessionId: string): Promise<{ entries: OutlineEntry[] }> {
    const { rows } = await this.outlineRows(sessionId)
    return { entries: rows.map((row) => ({ ...row, text: firstLine(row.text) })) }
  }

  /**
   * The sessions whose messages hold every word of `query`, each with its latest such message, as
   * the index finds them. A session no session list shows is left out before the most recently
   * changed `SEARCH_SESSIONS` are kept.
   */
  async search(
    query: string,
  ): Promise<{ hits: ConversationHit[]; indexing: SearchIndexing | null }> {
    const words = queryWords(query)
    const threads = this.deps.threads
    if (!longEnough(words) || !threads) return { hits: [], indexing: null }
    const { candidates, indexing } = await threads.search(words)
    const picks = candidates.filter((c) => this.searchable(c.sessionId)).slice(0, SEARCH_SESSIONS)
    const found = new Map(
      (await threads.snippets(words, picks)).map((snippet) => [snippet.sessionId, snippet]),
    )
    const hits = picks.flatMap((candidate): ConversationHit[] => {
      const snippet = found.get(candidate.sessionId)
      if (!snippet) return []
      return [
        {
          sessionId: candidate.sessionId,
          pos: candidate.pos,
          entryId: snippet.entryId,
          role: snippet.role,
          snippet: snippet.snippet,
          matches: candidate.matches,
        },
      ]
    })
    return { hits, indexing }
  }

  /**
   * The messages of one session that hold every word of `query`, oldest first. A live session
   * writes its pending entries first, so a reply that has just ended is found.
   */
  async find(
    sessionId: string,
    query: string,
  ): Promise<{ matches: SessionFindMatch[]; capped: boolean; indexing: SearchIndexing | null }> {
    const words = queryWords(query)
    const threads = this.deps.threads
    if (!longEnough(words) || !threads) return { matches: [], capped: false, indexing: null }
    const live = this.live.get(sessionId)
    if (!live && !this.records.has(sessionId)) {
      return { matches: [], capped: false, indexing: null }
    }
    if (live) this.checkpoint(live)
    const { matches, capped, indexing } = await threads.find(sessionId, words, FIND_MESSAGES)
    return { matches, capped, indexing }
  }

  /** Whether a session list shows the session: not a sub-agent's, not archived with its tree. */
  private searchable(sessionId: string): boolean {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.records.get(sessionId)
    return (
      record !== undefined &&
      record.origin !== 'subagent' &&
      !live?.prepared &&
      !this.missing.has(sessionId) &&
      !this.isArchived(record)
    )
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
      if (
        entry?.kind !== 'user' ||
        entry.from ||
        entry.approval ||
        entry.kettu ||
        pos === undefined
      ) {
        continue
      }
      rows.push({
        pos,
        entryId: id,
        text: outlineText(entry.content),
        title: titles.get(pos) ?? null,
      })
    }
    return { rows, model: modelOf(current.thread.session.config) }
  }

  /** What the session made, for its card in the sidebar, a live session's latest entries included. */
  async outputs(sessionId: string): Promise<SessionOutputs> {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.recordOf(sessionId)
    if (live) this.checkpoint(live)
    const store = this.deps.threads
    const none: SessionOutputs = {
      artifacts: [],
      references: [],
      reply: null,
      turnMs: null,
      turnStartedAt: live?.thread.session.turnStartedAt ?? null,
    }
    if (!store || !record.acpSessionId) return none
    try {
      const stored = await store.outputs(record.id)
      if (!stored || !this.isCurrent(record, stored.head)) return none
      return { ...stored.outputs, turnStartedAt: none.turnStartedAt }
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not read what session ${record.id} made: ${(error as Error).message}`,
      )
      return none
    }
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
    let writer = record.agentId
    try {
      const { rows, model } = await this.outlineRows(sessionId)
      const untitled = rows.filter((row) => row.title === null && row.text.trim() !== '')
      if (untitled.length === 0) return { titles: [] }
      const target = lightTarget(this.deps.settings().lightModel, record.agentId, model)
      writer = target.agentId
      const runtime = await this.deps.agents.ensureReady(target.agentId)
      await mkdir(this.deps.reportsDir, { recursive: true })
      const titles = await writeTitles(runtime, {
        dir: this.deps.reportsDir,
        model: target.model,
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
        `${this.deps.agents.name(writer)}: could not title the outline of session ${sessionId}: ${logText(error)}`,
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
      ...(record.rewound ? { rewound: { turns: record.rewound.turns } } : {}),
      ...(record.noRewind ? { noRewind: true } : {}),
      ...(record.origin === 'subagent'
        ? {}
        : {
            sideChat: { route: this.sideRouteOf(record.agentId), answerAgent: null, entries: [] },
          }),
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
      send: (text, options) => this.sendForUser(live, text, options),
      startMode: () => startModeIn(this.deps.settings(), record.agentId) ?? null,
      readAgentFile: (file) => this.deps.agentFile?.(record.id, file) ?? Promise.resolve(null),
      readProjectFile: (file) => this.deps.projectFile?.(record.id, file) ?? Promise.resolve(null),
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
      lateCards: new Set(),
      originsAnswered: new Map(),
      apps: new Map(),
      appsAnswered: new Map(),
      setups: new Map(),
      ask: null,
      waitingSince: new Map(),
      activity: new ToolActivity(),
      sender: null,
      failure: null,
      signInNotices: [],
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
      typed: false,
      first: null,
      heldFirst: null,
      queuedBy: new Map(),
      kettuQueued: new Map(),
      userTurn: false,
      titlePrompt: null,
      titleWriting: false,
      titleFailedAt: null,
      listedTitleTimer: null,
      startValues: {},
      unansweredCancel: null,
      background: false,
      backgroundListed: false,
      scheduled: 0,
      held: null,
      agentTurn: false,
      prepared: null,
      routineMode: null,
      routineScope: null,
      routineTurnStarted: false,
      routineTurnEnded: false,
      startedMode: null,
      idleSince: null,
      hiddenSince: this.inFront(record.id) ? null : this.now(),
      releaseTimer: null,
      harnessVersion: null,
      resumeRead: null,
      modelsReadAt: null,
      modelsRead: null,
      refreshedModels: new Set(),
      contextTimer: null,
      contextDueAt: 0,
      contextDirty: false,
      contextOwed: false,
      contextRevision: 0,
      contextFailures: 0,
      contextReadAt: 0,
      archiveAfterTurn: null,
      sendNext: false,
      setAside: null,
      setAsideDirty: false,
      cutAt: null,
      rewinding: null,
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
   * What an attach of the session hands its agent: the Marketplace's skills, Kettu's own with them
   * while the session reaches Kettu's server, the MCP servers, the artifacts service to an agent
   * that takes MCP over HTTP while Kettu's server is on for it, then the Marketplace's servers
   * meant for its agent, and Kettu's memory while it is on. An agent that adds to its system
   * prompt when a session starts gets the guide, memory and role as one text.
   */
  private async attachOptions(
    sessionId: string,
    record: SessionRecord,
    runtime: AgentRuntime | null | undefined,
  ): Promise<SessionOptions> {
    const projectMcp = this.projectMcpGate(sessionId)
    const projectHooks = this.projectHooksGate(sessionId)
    const own = this.kettuServers(sessionId, record, runtime)
    const reached = own.length > 0
    const skills = (await this.deps.skills?.(record, reached)) ?? {}
    const memory = await this.memoryFor(sessionId, record, reached)
    const role = record.role ? roleBlock(record.role.title, record.role.instructions) : null
    const append = runtime?.connection.systemPromptAppend
      ? kettuAhead(
          reached ? (this.deps.mcp?.guide(record.agentId) ?? null) : null,
          memory?.text ?? null,
          role,
        )
      : null
    return {
      mcpServers: [...own, ...this.libraryServers(sessionId, record, runtime, own)],
      ...skills,
      ...(projectMcp ? { projectMcp } : {}),
      ...(projectHooks ? { projectHooks } : {}),
      ...(memory ? { memory } : {}),
      ...(record.instructionsAhead ? { promptAhead: true } : {}),
      ...(role ? { role } : {}),
      ...(append ? { systemPromptAppend: append } : {}),
      ...(this.deps.settings().promptSuggestions ? { suggestions: true } : {}),
    }
  }

  /**
   * Kettu's memory as the session starts with it, while memory is on: the index of its project's
   * memory and global memory, or global memory alone for a session outside Kettu's projects.
   * `tools`: the agent reaches Kettu's server, and with it the memory tools.
   */
  private async memoryFor(
    sessionId: string,
    record: SessionRecord,
    tools: boolean,
  ): Promise<SessionMemory | null> {
    const memory = this.deps.memory
    if (!memory?.enabled) return null
    const project = this.deps.projects.find(record.projectPath)?.path ?? null
    try {
      return { text: await memory.index(project, tools) }
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not read Kettu's memory for ${sessionId}: ${(error as Error).message}`,
      )
      return null
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

  /** Lets the user answer, in the session's thread, for the hooks its folder's settings declare. */
  private projectHooksGate(sessionId: string): ProjectHooksGate | undefined {
    const answers = this.deps.projectHooks
    if (!answers) return undefined
    return {
      hold: async (cwd, hooks) => {
        const folder = await this.folderKey(cwd)
        const allowed = answers.allowed(folder, hooks.digest)
        if (allowed === null) this.askProjectHooks(sessionId, folder, hooks)
        return allowed !== true
      },
      held: async (cwd, hooks) => answers.allowed(await this.folderKey(cwd), hooks.digest) !== true,
    }
  }

  /**
   * The key the user's answers about a folder's MCP servers and hooks are kept by: a session's
   * worktree shares its project's, as switching branches in the project's folder would.
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
    if (!live || entry?.kind !== 'project_mcp') throw notFound(t('session.waiting.mcp.gone'))
    if (entry.decision !== null) {
      throw new HostError('not_found', t('session.waiting.mcp.answered'), {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    const card = this.projectMcpCards.get(sessionId)
    const answers = this.deps.projectMcp
    if (card?.entryId !== entryId || !answers) throw notFound(t('session.waiting.mcp.gone'))
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

  /**
   * The session's folder declares hooks nobody answered for: one card asks the user, taking up the
   * hooks a later start of the session finds instead.
   */
  private askProjectHooks(sessionId: string, folder: string, hooks: FolderHooks): void {
    const live = this.live.get(sessionId)
    if (!live) return
    const card = this.projectHooksCards.get(sessionId)
    const open = card ? live.thread.byId[card.entryId] : undefined
    if (card?.folder === folder && open?.kind === 'project_hooks' && open.decision === null) {
      if (card.digest === hooks.digest) return
      card.digest = hooks.digest
      this.emit(live, [{ op: 'entry.update', id: card.entryId, changes: { hooks: hooks.hooks } }])
      return
    }
    const entry: ProjectHooksEntry = {
      kind: 'project_hooks',
      id: this.nextId(live),
      hooks: hooks.hooks,
      decision: null,
      after: agentEntryBefore(live.thread),
    }
    this.projectHooksCards.set(sessionId, { entryId: entry.id, folder, digest: hooks.digest })
    this.emit(live, [{ op: 'entry.add', entry }])
  }

  /**
   * A window's or a device's answer to a card holding its folder's own hooks. The first one counts:
   * it is kept for the folder and settles every card of the folder it answers.
   */
  answerProjectHooks(
    sessionId: string,
    entryId: string,
    decision: ProjectHooksDecision,
    device?: FromDevice,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const entry = live?.thread.byId[entryId]
    if (!live || entry?.kind !== 'project_hooks') throw notFound(t('session.waiting.hooks.gone'))
    if (entry.decision !== null) {
      throw new HostError('not_found', t('session.waiting.hooks.answered'), {
        reason: ALREADY_ANSWERED,
        device: entry.device ?? null,
      })
    }
    const card = this.projectHooksCards.get(sessionId)
    const answers = this.deps.projectHooks
    if (card?.entryId !== entryId || !answers) throw notFound(t('session.waiting.hooks.gone'))
    answers.answer(card.folder, card.digest, decision)
    for (const [id, other] of [...this.projectHooksCards]) {
      if (other.folder !== card.folder) continue
      const otherLive = this.live.get(id)
      const waiting = otherLive?.thread.byId[other.entryId]
      if (!otherLive || waiting?.kind !== 'project_hooks' || waiting.decision !== null) {
        this.projectHooksCards.delete(id)
        continue
      }
      if (answers.allowed(card.folder, other.digest) === null) continue
      this.projectHooksCards.delete(id)
      const changes = { decision, ...(device ? { device } : {}) }
      this.emit(otherLive, [{ op: 'entry.update', id: other.entryId, changes }])
    }
  }

  /** The artifacts service, for an agent that takes MCP over HTTP while Kettu's server is on for it. */
  private kettuServers(
    sessionId: string,
    record: SessionRecord,
    runtime: AgentRuntime | null | undefined,
  ): McpServer[] {
    if (!this.deps.mcp || !runtime) return []
    return runtime.init.capabilities.mcpHttp && runtime.kettu
      ? this.deps.mcp.servers(sessionId, record, runtime.connection)
      : []
  }

  private libraryServers(
    sessionId: string,
    record: SessionRecord,
    runtime: AgentRuntime | null | undefined,
    own: McpServer[],
  ): McpServer[] {
    if (!this.deps.mcp || !runtime) return []
    return this.deps.mcp.library(
      sessionId,
      record,
      runtime.connection,
      runtime.init.capabilities,
      own.map((server) => server.name),
    )
  }

  private dropLive(live: Live): void {
    // A card still waiting goes unanswered; the session's next start asks again.
    const card = this.projectMcpCards.get(live.id)
    const waiting = card ? live.thread.byId[card.entryId] : undefined
    if (card && waiting?.kind === 'project_mcp' && waiting.decision === null) {
      this.emit(live, [{ op: 'entry.update', id: card.entryId, changes: { decision: 'timeout' } }])
    }
    this.projectMcpCards.delete(live.id)
    const hooksCard = this.projectHooksCards.get(live.id)
    const hooksWaiting = hooksCard ? live.thread.byId[hooksCard.entryId] : undefined
    if (hooksCard && hooksWaiting?.kind === 'project_hooks' && hooksWaiting.decision === null) {
      const changes = { decision: 'timeout' as const }
      this.emit(live, [{ op: 'entry.update', id: hooksCard.entryId, changes }])
    }
    this.projectHooksCards.delete(live.id)
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
    const added = !this.records.has(live.id)
    live.saved = true
    this.records.set(live.id, live.record)
    this.persist(live)
    if (added) {
      this.writeIndexNow()
      this.tellPlugins(live, 'session.started')
    }
    this.scheduleCheckpoint(live)
  }

  /**
   * Tells the plugins of an event in a session the user works in, which no routine, workflow step
   * or subagent is. `content` reaches only a plugin that may read the conversation.
   */
  private tellPlugins(
    live: Live,
    event: PluginHookEvent,
    payload?: Record<string, unknown>,
    content?: Record<string, unknown>,
  ): void {
    const plugins = this.deps.plugins
    if (!plugins?.wants(event) || live.replaying || live.record.origin !== 'user') return
    plugins.emit(event, this.summary(live.id), payload, content)
  }

  /** For a session new to the index, which a host that dies within the debounce would lose. */
  private writeIndexNow(): void {
    void this.deps.file.flushWritten()
  }

  // Mapper output.

  private applyOutput(live: Live, output: MapperOutput): void {
    if (live.closing) return
    const finished = this.deps.plugins ? this.finishedTools(live, output.patches) : []
    if (output.patches.length > 0) this.emit(live, output.patches)
    for (const tool of finished) {
      this.tellPlugins(
        live,
        'session.toolFinished',
        { kind: tool.toolKind, status: tool.status },
        { title: tool.title },
      )
    }
    // A compacted context lost what went ahead of a prompt, so the next prompt sends it again.
    if (
      !live.replaying &&
      live.record.memorySentTo !== undefined &&
      output.patches.some((patch) => compacted(live.thread, patch))
    ) {
      delete live.record.memorySentTo
      this.persist(live)
    }
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

  /** The tool calls these patches finish, as the thread stands before they are applied. */
  private finishedTools(live: Live, patches: readonly Patch[]): FinishedTool[] {
    const done = (tool: ToolEntry): boolean =>
      tool.status === 'completed' || tool.status === 'failed'
    // The entries these patches add or change, as the later ones in the batch find them.
    const current = new Map<string, ToolEntry>()
    const find = (id: string): ToolEntry | undefined => {
      const known = live.thread.byId[id]
      return current.get(id) ?? (known?.kind === 'tool' ? known : undefined)
    }
    const out: FinishedTool[] = []
    for (const patch of patches) {
      if (patch.op === 'entry.add' && patch.entry.kind === 'tool') {
        const before = find(patch.entry.id)
        current.set(patch.entry.id, patch.entry)
        if (done(patch.entry) && !(before && done(before))) out.push(patch.entry as FinishedTool)
      } else if (patch.op === 'entry.update') {
        const before = find(patch.id)
        if (!before) continue
        const next = { ...before, ...patch.changes } as ToolEntry
        current.set(patch.id, next)
        if (done(next) && !done(before)) out.push(next as FinishedTool)
      }
    }
    return out
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
      case 'extra-usage':
        this.deps.agents.setExtraUsage(agentId, effect.inUse)
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
      case 'backgroundRunning':
        live.background = effect.running
        live.backgroundListed = effect.listed
        this.refreshRelease(live)
        break
      case 'scheduled':
        live.scheduled = effect.jobs
        this.refreshRelease(live)
        break
      case 'tasks':
        this.update(live, { background: effect.tasks })
        break
      case 'suggestion': {
        // One that comes once the next turn started, as a queued message, is about the last one.
        const text = effect.text.trim()
        if (live.turn || !text || !this.deps.settings().promptSuggestions) break
        this.update(live, { suggestion: text })
        break
      }
      case 'agentTurn':
        this.agentTurn(live, effect)
        break
      case 'request':
        if (live.resumeRead) this.checkResumeRead(live, effect.cache)
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
    const { agentId, acpSessionId, configDir } = live.record
    let ttl: number | null
    try {
      ttl =
        (await this.deps.cacheTtl?.(
          agentId,
          workDir(live.record),
          acpSessionId,
          configDir ?? null,
        )) ?? null
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
    this.followShown([...next].filter((id) => !previous?.has(id)))
  }

  /** The Claude Code sessions a port shows in front, which a program outside Kettu may share. */
  private sharedShown(): string[] {
    const ids = new Set<string>()
    for (const shown of this.shown.values()) {
      for (const id of shown) {
        const record = this.records.get(id)
        if (record && this.sharedOutside(record)) ids.add(id)
      }
    }
    return [...ids]
  }

  /**
   * Keeps an eye on the Claude Code sessions in front while any is: a pass looks for a program
   * outside Kettu that holds one, and the sessions just shown also for what such a program wrote.
   */
  private followShown(entered: readonly string[]): void {
    const shown = this.sharedShown()
    if (shown.length === 0) {
      if (this.followTimer) clearInterval(this.followTimer)
      this.followTimer = null
      return
    }
    this.followTimer ??= setInterval(() => void this.followPass(), FOLLOW_MS)
    void this.followPass(new Set(entered))
  }

  private async followPass(entered: ReadonlySet<string> = new Set()): Promise<void> {
    if (this.following || this.stopped) return
    this.following = true
    try {
      for (const id of this.sharedShown()) {
        await this.followOutside(id, entered.has(id)).catch((error: unknown) => {
          this.deps.diagnostics.log(
            'warn',
            `Could not follow session ${id} outside Kettu: ${(error as Error).message}`,
          )
        })
      }
    } finally {
      this.following = false
    }
  }

  /**
   * A shown session's side of sharing with a program outside Kettu. While one holds it, the
   * session says so and lets its own agent go; once it lets go, or when the session is first
   * shown, what it wrote comes into the thread.
   */
  private async followOutside(sessionId: string, entered: boolean): Promise<void> {
    const record = this.records.get(sessionId)
    if (!record) return
    const live = this.live.get(sessionId)
    const held = live?.thread.session.heldOutside === true
    const holding = await this.heldBy(record)
    if (holding && !held) {
      if (live?.connection && this.holdReason(live) === null) {
        // Its Claude Code holds a copy of the conversation the other program is about to change.
        await this.closeAll([...this.descendants(live.id, 'subagent'), live.record], true)
        await this.revive(sessionId)
      } else if (live) {
        this.update(live, { heldOutside: true })
      } else {
        await this.revive(sessionId)
      }
      return
    }
    if (holding) return
    if (live && held) this.update(live, { heldOutside: false })
    if (!entered && !held) return
    if (!(await this.writtenOutside(record))) return
    if (!live) {
      await this.revive(sessionId)
    } else if (this.holdReason(live) === null) {
      await this.closeAll([...this.descendants(live.id, 'subagent'), live.record], true)
      await this.revive(sessionId)
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
      /** What the mode of a session an agent starts is held to. */
      startedMode?: { starter: ModeRank | null; wanted: string | null }
      /** Whose prompt the first message is, when another session's agent sends it. */
      from?: FromSession
      /** The paired device that sent the first message. */
      device?: FromDevice
      /** Its title, when another session's agent starts it; the prompt's first line otherwise. */
      title?: string
      /** A new worktree to work in, cut from `base`; a sub-session takes its parent's instead. */
      worktree?: { base: string; branch?: string }
      /** A role to start as, by its reference. */
      role?: string
    },
    portId?: string,
  ): Promise<SessionSummary> {
    const { agents, projects, scratch } = this.deps
    if (!agents.has(params.agentId))
      throw invalidParams(t('agent.unknown', { agent: params.agentId }))
    agents.assertEnabled(params.agentId)
    // Before a prepared session is taken over, so a refused prompt leaves it prepared. What
    // another session's agent sends is no command of the user's.
    let prompt = params.prompt && this.hydrate(params.prompt)
    let commandTools: CommandNeeds | null = null
    let commandRun: CommandRun | null = null
    if (prompt && params.from === undefined && params.startedBy === undefined) {
      const own = this.live.get(params.preparedId ?? '')?.thread.session.commands ?? []
      const found = await this.commandContent(params.agentId, null, own, prompt)
      prompt = found.content
      commandTools = found.fresh
      commandRun = found.run
    }
    const role = params.role === undefined ? null : await this.resolveRole(params.role)
    const roleTools = role ? this.deps.commands?.extra(params.agentId, role.needs) : undefined
    // A prepared session's agent already works in the project's folder, so a worktree starts anew,
    // and it is attached already, so a command that names more tools or a role starts anew too.
    if (
      params.preparedId !== undefined &&
      params.worktree === undefined &&
      !commandTools &&
      !role
    ) {
      const adopted = await this.adopt({
        agentId: params.agentId,
        preparedId: params.preparedId,
        prompt,
        device: params.device,
      })
      if (adopted) return adopted
    }
    if (params.projectPath === null && params.parentId !== undefined) {
      throw invalidParams(t('session.subSessionProject'))
    }
    const projectPath =
      params.projectPath === null
        ? await scratch.create()
        : await projects.resolveDirectory(params.projectPath)
    if (params.parentId !== undefined) {
      const parent = this.recordOf(params.parentId)
      if (!samePath(parent.projectPath, projectPath, this.deps.platform)) {
        throw invalidParams(t('session.subSessionProject'))
      }
    }
    if (!scratch.contains(projectPath)) await projects.add(projectPath)
    let worktree: WorktreeRecord | undefined
    let newWorktree = false
    if (params.parentId !== undefined) {
      const inherited = this.recordOf(params.parentId).worktree
      if (inherited) worktree = { ...inherited }
    } else if (params.worktree !== undefined) {
      if (scratch.contains(projectPath)) {
        throw invalidParams(t('session.worktreeNeedsRepo'))
      }
      const request: Parameters<WorktreeManager['create']>[1] = {
        base: params.worktree.base,
        ...(params.worktree.branch === undefined ? {} : { branch: params.worktree.branch }),
        text: (prompt && fallbackTitle(prompt)) ?? '',
      }
      worktree = await this.createWorktree(projectPath, request, params, prompt ?? null)
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
    const kept = joinNeeds(commandTools, roleTools)
    if (kept) record.commandTools = kept
    if (role) record.role = sessionRole(role)
    const options = params.options ?? {}
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    live.used = true
    if (params.startedMode) live.startedMode = { ...params.startedMode, ceiling: null }
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
      if (commandTools && commandRun) this.noteCommandTools(live, commandRun.name, commandTools)
    }
    if (role) this.noteRole(live, role.title, roleTools)
    this.touch(live.id)
    if (newWorktree && worktree) this.prepareWorktree(projectPath, worktree)
    try {
      // As a prepared session starts: the settings' start mode and the agent's remembered values
      // under what the caller picked, which a client sends only when changed.
      live.startValues = {
        ...this.startModeOf(params.agentId),
        ...this.deps.options?.rememberedOf(params.agentId),
        ...options,
      }
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
          this.dropBranchName(worktree.path)
          void this.discardWorktree(projectPath, worktree)
        }
        throw error
      }
    }
    return this.summary(live.id)
  }

  /** Names the task's branch before it is saved or any step uses it. */
  async createTaskWorktree(
    projectPath: string,
    request: Parameters<WorktreeManager['create']>[1],
    first: { agentId: AgentId; options: Record<string, string | boolean> },
  ): Promise<WorktreeRecord> {
    const message: UserContent[] = [{ type: 'text', text: request.text }]
    const worktree = await this.createWorktree(
      projectPath,
      { ...request, text: fallbackTitle(message) ?? '' },
      first,
      message,
    )
    await this.finishBranchName(projectPath, worktree)
    return worktree
  }

  /**
   * A workflow step's session: top-level with `origin: 'task'`, in its task's folder, in the agent's
   * start mode held as a started session's is, so never full access or a plan mode; Kettu answers
   * the requests that still reach it inside the step's scope. The step's prompt goes first.
   * A worktree it is handed is the task's: removing the session never removes it.
   */
  async createStep(params: TaskStepStart): Promise<SessionSummary> {
    const { agents, projects } = this.deps
    if (!agents.has(params.agentId))
      throw invalidParams(t('agent.unknown', { agent: params.agentId }))
    agents.assertEnabled(params.agentId)
    const projectPath = await projects.resolveDirectory(params.projectPath)
    const role = params.role === undefined ? null : await this.resolveRole(params.role)
    const roleTools = role ? this.deps.commands?.extra(params.agentId, role.needs) : undefined
    const now = this.now()
    const worktree = params.worktree ? { ...params.worktree } : undefined
    if (worktree) delete worktree.pending
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: params.agentId,
      acpSessionId: '',
      projectPath,
      ...(worktree ? { worktree } : {}),
      title: params.title,
      titleSource: 'agent',
      createdAt: now,
      updatedAt: now,
      lastViewedAt: now,
      parentId: null,
      origin: 'task',
      task: { ...params.task },
      description: null,
      branch: null,
    }
    const kept = joinNeeds(null, roleTools)
    if (kept) record.commandTools = kept
    if (role) record.role = sessionRole(role)
    const live = this.makeLive(record, false, 'starting')
    live.unread = false
    live.used = true
    live.startedMode = { starter: null, wanted: null, ceiling: null }
    const content: UserContent[] = [{ type: 'text', text: params.prompt }]
    // The step's prompt is Kettu's, written from the workflow, not the user's.
    const entryId = this.addPrompt(live, content, now, undefined, undefined, undefined, true)
    live.first = { content, entryId, kettu: true }
    if (role) this.noteRole(live, role.title, roleTools)
    this.touch(live.id)
    this.deps.task?.current?.sessionCreated(live.id, params.task)
    if (worktree && params.prepare) this.prepareWorktree(projectPath, worktree)
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
   * The user's answer on a card the session's thread shows, such as Do it here on a workflow's:
   * the agent gets it, but it is no bubble of the user's, since the card already says it.
   */
  async sendCardAnswer(sessionId: string, text: string): Promise<void> {
    const live = await this.revive(sessionId)
    this.sendForUser(live, text, { approval: true })
  }

  /**
   * Kettu's own message to a session, such as a step's reminder: sent now or queued. `due` is asked
   * again when it would go out, and the message is dropped unsent once it says no.
   */
  async sendFromKettu(sessionId: string, text: string, due?: () => boolean): Promise<void> {
    const content: UserContent[] = [{ type: 'text', text }]
    const live = await this.revive(sessionId)
    const { status, queue, queuePaused } = live.thread.session
    if (canSend(status) && (queue.length === 0 || queuePaused)) {
      if (due && !due()) return
      this.sendPrompt(live, content, undefined, undefined, undefined, undefined, true)
      return
    }
    if (!canSend(status) && status !== 'running' && status !== 'awaiting_permission') {
      throw busyError(status)
    }
    const id = randomUUID()
    if (due) live.kettuQueued.set(id, due)
    this.update(live, { queue: [...queue, { id, content, at: this.now(), kettu: true }] })
    this.persist(live)
    this.touch(live.id)
  }

  /**
   * A routine's run's session: created as `sessions.create` creates one, but top-level with
   * `origin: 'routine'`, in the routine's folder, in the mode its scope names, with the
   * routine's prompt as its first message.
   */
  async createRun(params: RoutineSessionStart): Promise<SessionSummary> {
    const { agents, projects, scratch } = this.deps
    if (!agents.has(params.agentId))
      throw invalidParams(t('agent.unknown', { agent: params.agentId }))
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
      throw invalidParams(t('agent.unknown', { agent: params.agentId }))
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
        throw invalidParams(t('session.subSessionProject'))
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
    prepared.opening = this.deps.agents
      .whileOpening(record.agentId, this.runPrepare(live, options))
      .catch(async (error: unknown) => {
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
    let attach: SessionOptions
    try {
      attach = await this.attachOptions(live.id, live.record, runtime)
      if (this.startsInFullAccess(live, { ...this.startModeOf(agentId), ...picks })) {
        attach = { ...attach, fullAccess: true }
      }
      setup = await runtime.connection.newSession(workDir(live.record), attach)
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
    this.noteSystemPrompt(live.record, attach, setup.sessionId)
    this.stampConfig(live.record)
    this.attach(live, runtime.connection)
    this.attachedOn(live, setup.harnessVersion, false)
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
  private startNew(live: Live): Promise<void> {
    return this.deps.agents.whileOpening(live.record.agentId, this.openNew(live))
  }

  private async openNew(live: Live): Promise<void> {
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
    let attach: SessionOptions
    try {
      attach = await this.attachOptions(live.id, live.record, runtime)
      if (this.startsInFullAccess(live, live.startValues)) attach = { ...attach, fullAccess: true }
      setup = await runtime.connection.newSession(await this.cwdOf(live), attach)
    } catch (error) {
      // Its failure, such as the agent's exit, no longer belongs to a session that went meanwhile.
      if (gone()) throw removedWhileStarting()
      const failed = this.failStart(live, error, { action: 'create' })
      // The first message waits for the sign-in, which retries the start and then sends it.
      if (failed.code === 'auth_required' && live.first) this.signInNotice(live, failed)
      throw failed
    }
    if (live.startedMode) this.holdStartedMode(live, setup.config)
    if (gone()) {
      // It never reached the index, so the agent's new session goes the way a hidden one does.
      await this.removeUnlisted(live.id, runtime, setup.sessionId)
      throw removedWhileStarting()
    }
    if (this.stopped) {
      // The quit ran while `session/new` was pending: the message waits in its queue and the
      // session goes into the index and the thread store as the quit closes them.
      live.record.acpSessionId = setup.sessionId
      this.noteSystemPrompt(live.record, attach, setup.sessionId)
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
    this.noteSystemPrompt(live.record, attach, setup.sessionId)
    this.stampConfig(live.record)
    this.attach(live, runtime.connection)
    this.attachedOn(live, setup.harnessVersion, false)
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
      remember: live.record.startedBy === undefined,
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
    if (live.startedMode) await this.applyStartedMode(live, runtime.connection)
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
          ...(first.kettu ? { kettu: first.kettu } : {}),
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
    const { content, from, kettu } = live.first
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
      queue: [
        {
          id: randomUUID(),
          content,
          at: this.now(),
          ...(from ? { from } : {}),
          ...(kettu ? { kettu } : {}),
        },
        ...queue,
      ],
      queuePaused: true,
    })
    this.persist(live)
  }

  /** The thread's notice that the agent asks to sign in, as a failed turn adds it. */
  private signInNotice(live: Live, error: HostError): void {
    const id = this.nextId(live)
    live.signInNotices.push(id)
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id,
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
      remember = true,
      from,
      stop,
      resend,
    }: {
      restore?: boolean
      /** Whether the values count as the user's choice; not those an agent picked for a session. */
      remember?: boolean
      from?: ConfigOption[]
      stop?: () => boolean
      /** Options sent even when they look unchanged, since the agent may not have kept them. */
      resend?: ReadonlySet<string>
    } = {},
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
      if (value === undefined || (option?.value === value && !offerMissing && !resend?.has(id))) {
        continue
      }
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
        if (!restore && remember) this.deps.options?.chose(agentId, option, value, next)
        else if (!restore) this.deps.options?.seen(agentId, next)
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
      await this.setModeBeforeStart(live, connection, option, wanted)
    } catch {
      throw new HostError(
        'restricted',
        t('routines.modeFailed', { agent: this.deps.agents.name(live.record.agentId) }),
      )
    }
  }

  /** Sets a starting session's mode option before its first prompt; the agent's refusal throws. */
  private async setModeBeforeStart(
    live: Live,
    connection: AgentConnection,
    option: ConfigOption,
    value: string,
  ): Promise<void> {
    let config: ConfigOption[]
    if (option.id === SYNTHETIC_MODE_ID) {
      await connection.setMode(live.record.acpSessionId, value)
      config = live.thread.session.config.map((current) =>
        current.id === option.id ? { ...current, value } : current,
      )
    } else {
      config = mergeConfig(
        live.thread.session.config,
        await connection.setConfigOption(live.record.acpSessionId, option.id, value),
      )
    }
    this.update(live, { config })
    this.save(live)
  }

  /**
   * Sets the start value of a started session's mode once the agent's own is known: the mode asked
   * for, else the start mode or the agent's own, held to the ceiling.
   */
  private holdStartedMode(live: Live, config: readonly ConfigOption[]): void {
    const hold = live.startedMode
    const { agentId } = live.record
    const harness = harnessOf(agentId)
    const optionId = modeOptionId(agentId)
    if (!hold || optionId === null || !isRanked(harness)) return
    const own = config.find((option) => option.id === optionId)?.value
    const agentMode =
      startModeIn(this.deps.settings(), agentId) ?? (typeof own === 'string' ? own : '')
    hold.ceiling = startedCeiling(hold.starter, harness, agentMode)
    live.startValues[optionId] = startedMode(harness, hold.wanted ?? agentMode, hold.ceiling)
  }

  /**
   * A started session keeps a mode under its ceiling, the widest the agent takes when the one held
   * is refused; one it leaves wider fails the start before anything is sent.
   */
  private async applyStartedMode(live: Live, connection: AgentConnection): Promise<void> {
    const ceiling = live.startedMode?.ceiling ?? null
    const { agentId } = live.record
    const harness = harnessOf(agentId)
    const optionId = modeOptionId(agentId)
    if (ceiling === null || optionId === null || !isRanked(harness)) return
    const option = live.thread.session.config.find(
      (candidate) => candidate.id === optionId && candidate.type === 'select',
    )
    const allowed = startableModes(harness, ceiling)
    if (option && typeof option.value === 'string' && allowed.includes(option.value)) return
    const held = live.startValues[optionId]
    const limit = Math.min(ceiling, typeof held === 'string' ? (modeRank(harness, held) ?? 1) : 1)
    const offered = option?.choices?.map((choice) => choice.value) ?? []
    for (const mode of startableModes(harness, limit as ModeRank).reverse()) {
      if (!option || !offered.includes(mode)) continue
      try {
        await this.setModeBeforeStart(live, connection, option, mode)
        return
      } catch {
        // The next narrower mode may still be taken.
      }
    }
    throw new HostError(
      'restricted',
      t('session.startedModeFailed', { agent: this.deps.agents.name(agentId) }),
    )
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
    if (page) {
      // A program outside Kettu holds the session or wrote to it: it comes back through its revive.
      if ((await this.outsideState(record)) === 'current') return this.storedSnapshot(record, page)
      await this.revive(sessionId)
      return this.snapshot(sessionId, undefined, images)
    }
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

  /**
   * A session imported from outside Kettu shows the prompt cache its last request there left, since
   * a replay never says when the latest request was.
   */
  private seedCache(live: Live): void {
    const usage = live.thread.session.usage
    const cache = live.record.cache
    if (!usage || usage.cache || !cache) return
    this.update(live, { usage: { ...usage, cache } })
  }

  /**
   * A session's first attach after it ran outside Kettu takes the model, effort, fast mode and mode
   * of its last request there, so the prompt cache that request left still matches. Full access is
   * not taken, which the thread says.
   */
  private async takeOutside(live: Live, connection: AgentConnection): Promise<void> {
    const outside = live.record.outside
    if (!outside || harnessOf(live.record.agentId) !== 'claude-code') return
    delete live.record.outside
    this.saveIndex()
    const { values, fullAccess } = outsideOptionValues(live.thread.session.config, outside)
    const config = await this.applyStartOptions(live, connection, values, {
      restore: true,
      stop: () => live.closing || this.live.get(live.id) !== live || connection.isClosed,
      resend: resentOnResume(live.record.agentId, values),
    })
    if (!fullAccess) return
    const mode = config.find((option) => option.id === CLAUDE_OPTION_IDS.mode)
    const name =
      mode?.choices?.find((choice) => choice.value === mode.value)?.name ??
      String(mode?.value ?? '')
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'info',
          title: t('notice.fullAccessNotCarried.title'),
          description: t('notice.fullAccessNotCarried.description', { mode: name }),
          after: agentEntryBefore(live.thread),
        },
      },
    ])
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
    try {
      await this.refuseHeld(live.record.agentId, acpSessionId, live.record.configDir ?? null)
    } catch (error) {
      throw this.failStart(live, error, { action: useLoad ? 'load' : 'resume' })
    }
    const attach = await this.attachOptions(live.id, live.record, runtime)
    // Read before the replay empties the thread, which a write in flight may still be storing.
    const kept = useLoad ? await this.keptOrigins(live.id) : []
    this.attach(live, connection)
    try {
      if (useLoad) {
        this.prepareReplay(live, connection)
        let setup
        try {
          setup = await connection.loadSession(acpSessionId, projectPath, attach)
        } catch (error) {
          this.finishReplay(live, false, kept)
          throw error
        }
        this.finishReplay(live, true, kept)
        this.opened(live, setup.config)
        this.seedCache(live)
        await this.noteOutsideTail(live.record)
        await this.takeOutside(live, connection)
      } else {
        const setup = await connection.resumeSession(acpSessionId, projectPath, attach)
        this.opened(live, setup.config)
        await this.takeOutside(live, connection)
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
   * After a replay, its messages get back the origins Kettu kept for them, and children it did not
   * mention are marked missing. After a failed one, every child goes back to the index, to come
   * back with the next attempt.
   */
  private finishReplay(live: Live, ok: boolean, kept: readonly StoredOrigin[]): void {
    live.replaying = false
    live.partial = !ok
    this.restoreOrigins(live, kept)
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
   * Kettu's memory was turned on or off: every prepared session started with the old setting, and
   * an open session that takes it ahead of its prompts gets it with its next one.
   */
  memorySwitched(): void {
    for (const live of [...this.live.values()]) {
      if (live.prepared) void this.dropPrepared(live)
      else if (live.record.memorySentTo !== undefined) {
        delete live.record.memorySentTo
        this.persist(live)
      }
    }
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
   * Whether a session the user starts takes full access from `values`, so its agent can open it in
   * full access at once; a session another one started, a workflow step's and a routine's never do.
   */
  private startsInFullAccess(live: Live, values: Record<string, string | boolean>): boolean {
    if (live.startedMode || live.routineMode !== null) return false
    const optionId = modeOptionId(live.record.agentId)
    const mode = optionId === null ? undefined : values[optionId]
    return typeof mode === 'string' && isFullAccessMode(mode)
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
        const stopped: { message: string } = { message: t('notice.stopped.title', { agent: name }) }
        if (turn) {
          live.record.lastTurn = this.failedTurn(live, stopped.message, now)
          this.planContinue(live.record)
        }
        this.persist(live)
        const routineTurn =
          (turn
            ? this.reportRun(live, { stopReason: null, error: stopped, usage: null, turn })
            : false) || this.reportStep(live)
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
      if (live.record.agentId !== agentId) continue
      this.settleSignInNotices(live)
      if (live.thread.session.status === 'auth_required') void this.retry(live.id).catch(() => {})
    }
  }

  /** The thread's sign-in notices say the agent is signed in now, instead of asking for it. */
  private settleSignInNotices(live: Live): void {
    const ids = live.signInNotices.filter((id) => live.thread.byId[id]?.kind === 'notice')
    live.signInNotices = []
    if (ids.length === 0) return
    const agent = this.deps.agents.name(live.record.agentId)
    const changes = {
      severity: 'info' as const,
      title: t('notice.signedIn.title', { agent }),
      // A description is replaced rather than dropped, since a patch sent as JSON drops undefined.
      description: t('notice.signedIn.description'),
    }
    this.emit(
      live,
      ids.map((id) => ({ op: 'entry.update', id, changes })),
    )
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

  /**
   * Why a session needs its agent now, or null: work runs, waits for the user, or runs on unseen.
   * Once the agent listed its background work, that list alone says whether subagents run, so a
   * subagent whose end never came does not keep the agent; one waiting for the user still does.
   */
  private holdReason(live: Live): string | null {
    const { status } = live.thread.session
    if (status !== 'ready' && status !== 'closed') return status
    if (live.turn) return 'turn'
    if (live.opening || live.attaching) return 'attach'
    if (live.background) return 'background'
    if (live.scheduled > 0) return 'scheduled'
    if (waitingCount(live) > 0) return 'waiting'
    if (this.contextRuns.has(live.id)) return 'context'
    if (this.sideRuns.has(live.id)) return 'side question'
    const [first] = this.workingSubagents(live)
    if (first) return first.waiting ? 'subagent waiting' : 'subagent'
    return null
  }

  private holdsAgent(live: Live): boolean {
    return this.holdReason(live) !== null
  }

  /**
   * The session's subagents that run or wait for the user. Once the agent listed its background
   * work, a running one counts only while that list says work runs.
   */
  private workingSubagents(live: Live): { child: Live; waiting: boolean }[] {
    const out: { child: Live; waiting: boolean }[] = []
    for (const record of this.descendants(live.id, 'subagent')) {
      const child = this.live.get(record.id)
      if (!child) continue
      const childStatus = child.thread.session.status
      if (child.permissions.size > 0 || childStatus === 'awaiting_permission') {
        out.push({ child, waiting: true })
        continue
      }
      if (live.backgroundListed && !live.background) continue
      if (
        child.childRunning ||
        child.background ||
        childStatus === 'running' ||
        childStatus === 'starting'
      ) {
        out.push({ child, waiting: false })
      }
    }
    return out
  }

  /** What the session runs beside a turn, as `holdReason` counts it; null when nothing. */
  private backgroundWork(live: Live): BackgroundWork | null {
    const commands: string[] = []
    const tasks: string[] = []
    for (const task of live.thread.session.background ?? []) {
      if (task.status !== 'running') continue
      ;(task.kind === 'shell' ? commands : tasks).push(task.title)
    }
    const subagents = this.workingSubagents(live).map(
      ({ child }) =>
        child.thread.session.subagent?.description ??
        child.thread.session.title ??
        t('session.untitled'),
    )
    const named = commands.length + tasks.length + subagents.length > 0
    const unnamed = live.background && !named
    if (!named && !unnamed && live.scheduled === 0) return null
    return { commands, tasks, subagents, scheduled: live.scheduled, unnamed }
  }

  /** What ending the session's agent would stop; null when nothing runs. */
  private workOf(live: Live): RunningWork | null {
    const status = live.thread.session.status
    const turn = live.turn !== null || status === 'running'
    const waiting = waitingCount(live)
    const background = this.backgroundWork(live)
    if (!turn && waiting === 0 && !background) return null
    return {
      sessionId: live.id,
      agentId: live.record.agentId,
      title: live.record.customTitle ?? live.thread.session.title ?? live.record.title,
      turn,
      waiting,
      commands: background?.commands ?? [],
      tasks: background?.tasks ?? [],
      subagents: background?.subagents ?? [],
      scheduled: background?.scheduled ?? 0,
      unnamed: background?.unnamed ?? false,
    }
  }

  /**
   * What ending these sessions and their sub-sessions would stop, for the ones with any: a session
   * not in memory runs nothing. Subagents count with the session that started them.
   */
  runningWork(sessionIds: readonly string[]): RunningWork[] {
    const seen = new Set<string>()
    const out: RunningWork[] = []
    for (const id of sessionIds) {
      const record = this.live.get(id)?.record ?? this.records.get(id)
      if (!record) continue
      for (const item of [record, ...this.descendants(id)]) {
        if (item.origin === 'subagent' || seen.has(item.id)) continue
        seen.add(item.id)
        const live = this.live.get(item.id)
        const work = live ? this.workOf(live) : null
        if (work) out.push(work)
      }
    }
    return out
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
    const held = this.holdReason(live)
    if (held !== null) {
      live.idleSince = null
      // A turn is no news; what keeps an idle session's agent is.
      if (held !== live.held && held !== 'turn' && held !== 'running') {
        this.deps.diagnostics.event(live.record.agentId, 'session held', `${live.id}: ${held}`)
      }
      live.held = held
      return
    }
    live.held = null
    const now = this.now()
    live.idleSince ??= now
    const plan = this.releaseAt(live, now)
    if (plan) {
      const { due, why } = plan
      live.releaseTimer = setTimeout(
        () => {
          live.releaseTimer = null
          if (this.live.get(live.id) !== live) return
          if (this.now() >= due && !live.closing && !this.holdsAgent(live)) this.release(live, why)
          else this.refreshRelease(live)
        },
        Math.max(0, due - now),
      )
    }
    if (this.deps.idleRelease && harnessOf(live.record.agentId) === 'claude-code') {
      this.checkIdleLimitSoon()
    }
  }

  /**
   * When an idle session lets its agent go, and why; null while nothing ends it for idleness.
   * Claude Code's follow the idle rule, the others `timings`.
   */
  private releaseAt(live: Live, now: number): { due: number; why: string } | null {
    const idleSince = live.idleSince ?? now
    const { releaseHiddenMs, releaseShownMs, releaseUnusedMs } = this.timings
    if (!live.used) return { due: idleSince + releaseUnusedMs, why: 'unused' }
    const front = this.inFront(live.id)
    const hiddenFrom = Math.max(idleSince, live.hiddenSince ?? now)
    const idle = this.deps.idleRelease
    if (!idle || harnessOf(live.record.agentId) !== 'claude-code') {
      return front
        ? { due: idleSince + releaseShownMs, why: 'idle in view' }
        : { due: hiddenFrom + releaseHiddenMs, why: 'out of view' }
    }
    const rule = idle.rule()
    if (!rule) return null
    if (rule.now) return { due: now, why: 'memory critical' }
    const expiry = cacheExpiresAt(live)
    // Never sooner than the shortest wait, as when an attach sent nothing to renew the cache.
    const floor = idleSince + releaseUnusedMs
    // On a version whose resumes lost the cache, a released session would write it all again.
    if (expiry !== null && this.cacheGuarded(live)) {
      return { due: Math.max(expiry, floor), why: 'cache expired' }
    }
    let due = front ? idleSince + rule.inView * MINUTE : hiddenFrom + rule.outOfView * MINUTE
    let why = front ? 'idle in view' : 'out of view'
    // Past it the next turn writes the whole context again anyway, and the process saves little.
    if (expiry !== null && expiry < due) {
      due = expiry
      why = 'cache expired'
    }
    return { due: Math.max(due, floor), why }
  }

  /** Its version lost the cache on resumes, so it keeps its agent until the cache expires. */
  private cacheGuarded(live: Live): boolean {
    const idle = this.deps.idleRelease
    if (!idle || idle.memoryState() === 'critical') return false
    return idle.guard.holds(live.harnessVersion)
  }

  /** A Claude Code session whose agent runs and is idle, which the idle limit counts. */
  private idleProcess(live: Live): boolean {
    return (
      live.record.origin !== 'subagent' &&
      harnessOf(live.record.agentId) === 'claude-code' &&
      live.saved &&
      !live.prepared &&
      !live.closing &&
      !this.releasing.has(live.id) &&
      live.connection !== null &&
      live.thread.session.status === 'ready' &&
      this.holdReason(live) === null
    )
  }

  private checkIdleLimitSoon(): void {
    if (this.limitCheck) return
    this.limitCheck = true
    queueMicrotask(() => {
      this.limitCheck = false
      this.checkIdleLimit()
    })
  }

  /**
   * Over the rule's limit, the least recently used idle sessions let their agent go: those out of
   * view by when they left it or went idle, then those in view by how long they have been idle.
   */
  private checkIdleLimit(): void {
    const limit = this.deps.idleRelease?.rule()?.limit
    if (limit === null || limit === undefined || this.stopped) return
    const idle = [...this.live.values()].filter((live) => this.idleProcess(live))
    let over = idle.length - limit
    if (over <= 0) return
    const now = this.now()
    const order = (live: Live): [number, number] =>
      this.inFront(live.id)
        ? [1, live.idleSince ?? now]
        : [0, Math.max(live.idleSince ?? now, live.hiddenSince ?? now)]
    idle.sort((a, b) => {
      const [frontA, atA] = order(a)
      const [frontB, atB] = order(b)
      return frontA - frontB || atA - atB
    })
    for (const live of idle) {
      if (over <= 0) break
      if (this.cacheGuarded(live) && (cacheExpiresAt(live) ?? 0) > now) continue
      over--
      this.release(live, 'over limit')
    }
  }

  /** The idle rule, the memory state or a fallback changed: every idle session is armed again. */
  idleRulesChanged(): void {
    for (const live of this.live.values()) {
      if (live.record.origin !== 'subagent') this.refreshRelease(live)
    }
  }

  /**
   * Notes the harness version a session attached on, and for a resume within its prompt cache's
   * lifetime, that its first request is to say how much of the cache it read.
   */
  private attachedOn(live: Live, version: string | undefined, resumed: boolean): void {
    live.resumeRead = null
    if (version === undefined) return
    live.harnessVersion = version
    const idle = this.deps.idleRelease
    if (!idle) return
    if (idle.guard.seen(live.record.agentId, version)) {
      this.deps.diagnostics.log('info', `Claude Code is now ${version}: the cache fallback ended`)
      idle.notify()
    }
    // A session the quit let go, not an idle release, says nothing about releasing: across runs
    // the agent may start with other servers and instructions.
    const released = this.idleReleased.delete(live.id)
    const usage = live.thread.session.usage
    const cache = usage?.cache
    if (!resumed || !released || !cache || !usage.used) return
    const expiresAt = cacheExpiresAt(live)
    if (expiresAt !== null && expiresAt > this.now()) {
      live.resumeRead = { before: usage.used, lastRequestAt: cache.lastRequestAt, expiresAt }
    }
  }

  /**
   * The first request after a resume within the cache's lifetime: one that read under half the
   * context the session had is a miss, and two in a row on a version put it in fallback.
   */
  private checkResumeRead(live: Live, cache: RequestCache | undefined): void {
    const check = live.resumeRead
    live.resumeRead = null
    const idle = this.deps.idleRelease
    const version = live.harnessVersion
    if (!check || !cache || !idle || version === null) return
    const now = this.now()
    if (now >= check.expiresAt) return
    const missed = missedCache({ before: check.before, ...cache })
    this.deps.diagnostics.event(
      live.record.agentId,
      missed ? 'cache missed after resume' : 'cache read after resume',
      `${live.id}: Claude Code ${version}, ${Math.round((now - check.lastRequestAt) / 1000)} s ` +
        `after the last request, read ${cache.read} and wrote ${cache.written} tokens of ` +
        `${check.before} before`,
    )
    if (!idle.guard.resumed(version, missed)) return
    this.deps.diagnostics.log(
      'warn',
      `Claude Code ${version} lost the prompt cache on two resumes in a row: its idle sessions ` +
        'keep their agent until the cache expires',
    )
    idle.notify()
  }

  /** Stores the session's thread, closes its agent's session and its subagents, and drops it. */
  private release(live: Live, why: string): void {
    if (this.releasing.has(live.id)) return
    if (harnessOf(live.record.agentId) === 'claude-code') this.idleReleased.add(live.id)
    const reason = why === 'unused' && live.typed ? 'typed, nothing sent' : why
    this.deps.diagnostics.event(live.record.agentId, 'session released', `${live.id}: ${reason}`)
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
    const outside = await this.outsideState(record)
    tree.forEach((item, i) => {
      const stored = threads[i]
      if (stored && !this.live.has(item.id) && this.records.has(item.id)) {
        this.fill(this.makeLive(item, true, 'closed'), stored)
      }
    })
    const live = this.live.get(sessionId)!
    if (outside === 'held') {
      this.update(live, { heldOutside: true })
    } else if (outside === 'written') {
      // The stored thread lacks what the outside program wrote: the agent's history replaces it.
      await this.runOpening(live)
    }
    return live
  }

  /** Whether a program outside Kettu may share the session: a user's Claude Code session. */
  private sharedOutside(record: SessionRecord): boolean {
    return (
      this.deps.outside !== undefined &&
      harnessOf(record.agentId) === 'claude-code' &&
      record.origin === 'user' &&
      record.acpSessionId !== ''
    )
  }

  /** Whether a program outside Kettu has the session open, such as a terminal. */
  private async heldBy(record: SessionRecord): Promise<boolean> {
    if (!this.sharedOutside(record)) return false
    const holder = await this.deps
      .outside!.holder(record.agentId, record.acpSessionId, record.configDir ?? null)
      .catch(() => null)
    return holder !== null
  }

  /** Whether a program outside Kettu wrote to the session since its thread last took that. */
  private async writtenOutside(record: SessionRecord): Promise<boolean> {
    if (!this.sharedOutside(record)) return false
    const tail = await this.deps
      .outside!.tail(record.agentId, workDir(record), record.acpSessionId, record.configDir ?? null)
      .catch(() => null)
    return tail?.outside === true && tail.uuid !== record.outsideTail
  }

  /**
   * Where a Claude Code session stands against a program outside Kettu: `held` while one has it
   * open, `written` once one wrote what the stored thread lacks, else `current`. A held session is
   * not read, since its writer is not done.
   */
  private async outsideState(record: SessionRecord): Promise<'held' | 'written' | 'current'> {
    if (await this.heldBy(record)) return 'held'
    return (await this.writtenOutside(record)) ? 'written' : 'current'
  }

  /** Keeps the last message an outside program wrote that the thread now holds, after a replay. */
  private async noteOutsideTail(record: SessionRecord): Promise<void> {
    if (!this.deps.outside || harnessOf(record.agentId) !== 'claude-code') return
    const tail = await this.deps.outside
      .tail(record.agentId, workDir(record), record.acpSessionId, record.configDir ?? null)
      .catch(() => null)
    if (!tail?.outside || tail.uuid === record.outsideTail) return
    record.outsideTail = tail.uuid
    this.saveIndex()
  }

  /** Puts a stored thread, settled, into a session that just went live. */
  private fill(live: Live, stored: StoredThread): void {
    const order: string[] = []
    const byId: Record<string, ThreadEntry> = {}
    let { entries } = stored
    let aside = stored.setAside
    const rewound = live.record.rewound
    const cutAt = rewound ? entries.findIndex(({ entry }) => entry.id === rewound.entryId) : -1
    if (cutAt >= 0) {
      // The cut was not stored before the host stopped, so it is made again.
      aside = [...entries.slice(cutAt), ...aside].sort((a, b) => a.pos - b.pos)
      entries = entries.slice(0, cutAt)
      live.cutAt = aside[0]!.pos
      live.setAsideDirty = true
    }
    const split = splitLinks(entries.map((item) => item.entry))
    if (split) {
      // New entries between stored ones: the thread is stored again whole, numbered afresh.
      entries = split.map((entry, pos) => ({ pos, entry }))
      aside = aside.map(({ entry }, i) => ({ pos: entries.length + i, entry }))
      live.rewrite = true
    }
    if (rewound) live.setAside = aside
    // Left by an edit whose next message went before they were dropped.
    else if (aside.length > 0) live.setAsideDirty = true
    for (const { pos, entry } of aside) {
      live.nextPos = Math.max(live.nextPos, pos + 1)
      live.counter = Math.max(live.counter, idNumber(entry.id))
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
    const { config, commands, usage, context, sideChat } = stored.session
    live.thread = {
      session: {
        ...live.thread.session,
        config: this.deps.agents.restoreConfig(live.record.agentId, config, live.record),
        commands,
        usage,
        ...storedContext(context),
        ...storedSide(live.thread.session, sideChat),
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
    await this.refuseHeld(record.agentId, record.acpSessionId, record.configDir ?? null)
    let config: ConfigOption[]
    let version: string | undefined
    let resumed = false
    if (record.acpSessionId === '') {
      // An agent taking the session over that never had it.
      config = await this.renew(
        live,
        connection,
        await this.attachOptions(live.id, record, runtime),
      )
      this.deps.options?.started(
        record.agentId,
        config,
        pathKey(record.projectPath, this.deps.platform),
      )
    } else if (caps.resumeSession) {
      const attach = await this.attachOptions(live.id, record, runtime)
      try {
        const setup = await connection.resumeSession(
          record.acpSessionId,
          await this.cwdOf(live),
          attach,
        )
        config = setup.config
        version = setup.harnessVersion
        resumed = !carry
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
      const attach = await this.attachOptions(live.id, record, runtime)
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
    const values = agentValues(wanted)
    config = await this.applyStartOptions(live, connection, values, {
      restore: !carry,
      from: config,
      stop: () => gone() || connection.isClosed,
      resend: resumed ? resentOnResume(record.agentId, values) : undefined,
    })
    if (gone()) {
      await this.closeUnseen(live, runtime)
      throw new HostError('busy', t('session.openFirst'))
    }
    if (connection.isClosed) throw new AgentRequestError('closed', 'The agent connection closed')
    this.attach(live, connection)
    this.attachedOn(live, version, resumed)
    this.checkRewind(live, connection)
    this.opened(live, config)
    await this.takeOutside(live, connection)
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
    const item: QueuedPrompt = {
      id: randomUUID(),
      content: turn.content,
      at: now,
      ...originOf(turn.entryId === null ? undefined : live.thread.byId[turn.entryId]),
    }
    this.update(live, {
      status: 'ready',
      turnStartedAt: null,
      turnStartUsed: null,
      updatedAt: now,
      error: { message: notice.title },
      queue: [item, ...live.thread.session.queue],
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
    live.refreshedModels.clear()
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

  /** Notes that the agent's new session got Kettu's guide and memory in its system prompt. */
  private noteSystemPrompt(record: SessionRecord, attach: SessionOptions, sessionId: string): void {
    if (attach.systemPromptAppend) record.systemPromptSentTo = sessionId
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
    this.noteSystemPrompt(live.record, attach, setup.sessionId)
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

  contextEstimates(sessionId: string): Promise<ContextEstimates | null> {
    const live = this.live.get(sessionId)
    const connection = live?.connection
    if (!live || !connection?.readContextEstimates || !this.contextCurrent(live)) {
      return Promise.resolve(null)
    }
    const running = this.contextEstimateRuns.get(live)
    if (running) return running
    const { acpSessionId } = live.record
    const read = connection
      .readContextEstimates(acpSessionId, workDir(live.record))
      .then((estimates) =>
        this.contextCurrent(live) &&
        live.connection === connection &&
        live.record.acpSessionId === acpSessionId
          ? estimates
          : null,
      )
      .catch((error: unknown) => {
        throw agentError(error)
      })
      .finally(() => this.contextEstimateRuns.delete(live))
    this.contextEstimateRuns.set(live, read)
    return read
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
    this.reportsSent.delete(sessionId)
    const revived = await this.revive(sessionId)
    const { live, content: hydrated } = await this.withCommand(revived, this.hydrate(content))
    if (!canSend(live.thread.session.status) || this.waitsForWorktree(live)) {
      throw busyError(live.thread.session.status)
    }
    this.sendPrompt(live, hydrated, undefined, portId, device)
  }

  /**
   * A text that starts with one of Kettu's commands, as the message it expands to, with what it
   * names that the agent is not handed anyway in `fresh`; any other content as it is. Throws when
   * the command cannot go. `own` is what the agent calls its own commands, whose names it takes
   * as typed; `record` holds what an earlier command added, so it is not added twice.
   */
  private async commandContent(
    agentId: AgentId,
    record: Pick<SessionRecord, 'commandTools'> | null,
    own: readonly SlashCommand[],
    content: UserContent[],
  ): Promise<{ content: UserContent[]; fresh: CommandNeeds | null; run: CommandRun | null }> {
    const first = content[0]
    const commands = this.deps.commands
    if (!commands || first?.type !== 'text' || !first.text.startsWith('/')) {
      return { content, fresh: null, run: null }
    }
    const found = await commands.expand(first.text, new Set(own.map((command) => command.name)))
    if (!found) return { content, fresh: null, run: null }
    const extra = commands.extra(agentId, found.needs)
    const kept = record?.commandTools
    const fresh = {
      skills: extra.skills.filter((name) => !kept?.skills.includes(name)),
      mcp: extra.mcp.filter((name) => !kept?.mcp.includes(name)),
    }
    return {
      content: [{ ...first, command: found.run }, ...content.slice(1)],
      fresh: fresh.skills.length + fresh.mcp.length > 0 ? fresh : null,
      run: found.run,
    }
  }

  /**
   * `content` with its leading command expanded, and the session given the skills and MCP servers
   * the command names: an attached one lets its agent go and attaches it again, which only an idle
   * session can.
   */
  private async withCommand(
    live: Live,
    content: UserContent[],
  ): Promise<{ live: Live; content: UserContent[] }> {
    const found = await this.commandContent(
      live.record.agentId,
      live.record,
      live.thread.session.commands,
      content,
    )
    if (!found.fresh || !found.run) return { live, content: found.content }
    const attached = !!live.connection
    if (attached && (this.holdReason(live) !== null || !live.saved)) {
      throw new HostError('busy', t('commands.addsBusy', { command: found.run.name }))
    }
    const kept = live.record.commandTools
    live.record.commandTools = {
      skills: [...(kept?.skills ?? []), ...found.fresh.skills],
      mcp: [...(kept?.mcp ?? []), ...found.fresh.mcp],
    }
    this.saveRecord(live.id)
    const target = attached ? await this.attachAgain(live, 'a command added tools') : live
    this.noteCommandTools(target, found.run.name, found.fresh)
    return { live: target, content: found.content }
  }

  /** The thread says which skills and MCP servers a command added to the session. */
  private noteCommandTools(live: Live, command: string, added: CommandNeeds): void {
    const items = [
      ...added.skills.map((name) => t('commands.added.skill', { name })),
      ...added.mcp.map((name) => t('commands.added.mcp', { name })),
    ]
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'info',
          title: t('commands.added.title', { command }),
          description: listOf(items),
          after: agentEntryBefore(live.thread),
        },
      },
    ])
  }

  /** The role a reference names, or why the session cannot start as it. */
  private resolveRole(ref: string): Promise<FoundRole> {
    const roles = this.deps.roles
    if (!roles) throw invalidParams(t('roles.unknown', { role: ref }))
    return roles.resolve(ref)
  }

  /** The thread says which role the session started as and what the role added to it. */
  private noteRole(live: Live, title: string, added: CommandNeeds | undefined): void {
    const items = [
      ...(added?.skills ?? []).map((name) => t('commands.added.skill', { name })),
      ...(added?.mcp ?? []).map((name) => t('commands.added.mcp', { name })),
    ]
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'info',
          title: t('roles.started', { role: title }),
          ...(items.length > 0 ? { description: listOf(items) } : {}),
          after: agentEntryBefore(live.thread),
        },
      },
    ])
  }

  /** Sends a prompt; `kettu` when Kettu sends it itself, as a step's reminder. */
  private sendPrompt(
    live: Live,
    content: UserContent[],
    from?: FromSession,
    portId?: string,
    device?: FromDevice,
    approval?: true,
    kettu?: true,
  ): void {
    live.used = true
    live.userTurn = kettu !== true && from === undefined
    if (live.userTurn) this.deps.options?.used(live.record.agentId, live.thread.session.config)
    const now = this.now()
    const entryId = this.addPrompt(live, content, now, from, device, approval, kettu)
    this.startTurn(live, content, now, entryId, portId)
  }

  /**
   * The user started typing in the session: a Claude Code session whose agent was let go attaches
   * now, as a send would, so the message need not wait for the agent to start. Nothing is sent and
   * the session stays unused, so its agent is let go again when no message follows.
   */
  async attachEarly(sessionId: string): Promise<void> {
    const record = this.recordOf(sessionId)
    if (this.stopped || record.origin === 'subagent' || this.isArchived(record)) return
    if (harnessOf(record.agentId) !== 'claude-code') return
    // An edit waiting to be sent may carry on in another session of the agent's.
    if (record.rewound) return
    // A worktree that is not there yet, or no longer, is the send's to make or refuse.
    if (record.worktree && this.worktreeSummary(record.worktree).state !== 'ready') return
    if (!this.attachable(this.live.get(sessionId))) return
    this.assertRegistered(sessionId)
    const live = await this.revive(sessionId)
    // A send or a setting got to it first and attaches it itself.
    if (!this.attachable(live)) return
    live.typed = true
    try {
      await this.attachClosed(live)
    } catch (error) {
      throw agentError(error)
    }
  }

  /** Whether a session is let go, or live without its agent, and no attach of it runs. */
  private attachable(live: Live | undefined): boolean {
    if (!live) return true
    if (live.prepared || live.closing || live.connection || live.attaching || live.opening) {
      return false
    }
    return live.thread.session.status === 'closed'
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
    if (!this.deps.agents.has(agentId)) throw invalidParams(t('agent.unknown', { agent: agentId }))
    this.deps.agents.assertEnabled(agentId)
    this.reportsSent.delete(sessionId)
    const hydrated = this.hydrate(params.content)
    const live = await this.revive(sessionId)
    const { status } = live.thread.session
    if (!canSend(status) || live.turn || waitingCount(live) > 0) throw busyError(status)
    // The agent it had keeps its session cut where the edit went back to, should it come back.
    if (live.record.agentId !== agentId && live.record.rewound) {
      await this.applyRewind(live).catch((error: unknown) => {
        throw agentError(error)
      })
    }
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
    delete record.carried
    delete record.noRewind
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
      // Speed is the old agent's model; the new one may not be timed at all.
      speed: undefined,
      lastRequest: undefined,
      ...(live.thread.session.suggestion ? { suggestion: null } : {}),
      // The side chat stays; the new agent answers it its own way.
      ...(live.thread.session.sideChat
        ? { sideChat: { ...live.thread.session.sideChat, route: this.sideRouteOf(agentId) } }
        : {}),
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
    entryId: string | null,
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
    // An edit from this message gives the conversation to the agent again with the next one.
    if (entryId) record.carried = { entryId, carry }
    else delete record.carried
    // The session it had is its current one now, no longer an earlier agent's to take back.
    record.earlier = record.earlier?.map((item) =>
      item.agentId === record.agentId && item.acpSessionId === record.acpSessionId
        ? { ...item, acpSessionId: '' }
        : item,
    )
    this.save(live)
    return out
  }

  /**
   * What goes ahead of the prompt, before anything carried, for an agent that takes no
   * instructions of the session's own: Kettu's guide while the session reaches Kettu's server,
   * Kettu's memory while it is on, and the instructions of the role it started as. With the first
   * prompt its own session gets, and again after its context was compacted; the thread shows the
   * message as the user wrote it.
   */
  private async aheadText(live: Live, connection: AgentConnection): Promise<string | null> {
    const { record } = live
    const own = connection.ownInstructions && !record.instructionsAhead
    if (own || record.memorySentTo === record.acpSessionId) return null
    // Its creation carried them in its system prompt, which it keeps through a compaction.
    if (record.systemPromptSentTo === record.acpSessionId) return null
    const runtime = this.deps.agents.runtime(record.agentId)
    const servers = this.kettuServers(live.id, record, runtime)
    const tools = servers.length > 0
    // What the session's own instructions would hold, the plan paragraph with the guide.
    const text = record.instructionsAhead
      ? servers
          .flatMap((server) => (server.type === 'stdio' ? [] : (server.prompt ?? [])))
          .join('\n\n')
      : (this.deps.mcp?.guide(record.agentId) ?? '')
    const memory = (await this.memoryFor(live.id, record, tools))?.text ?? null
    const role = record.role ? roleBlock(record.role.title, record.role.instructions) : null
    return kettuAhead(tools && this.deps.mcp && text ? text : null, memory, role)
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

  /**
   * Keeps who sent a message that is not the user's own from this computer, in the thread store
   * beside the thread, since the agent's history never says and a rebuild would lose it.
   */
  private keepOrigin(live: Live, entry: ThreadEntry): void {
    const origin = originOf(entry)
    const store = this.deps.threads
    if (!origin || !store || entry.kind !== 'user') return
    store
      .putOrigin(live.id, { text: originText(entry.content), origin })
      .catch((error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `Could not keep who sent a message of session ${live.id}: ${(error as Error).message}`,
        )
      })
  }

  /** The origins kept for a session's messages, for a thread about to be rebuilt; none on failure. */
  private async keptOrigins(sessionId: string): Promise<StoredOrigin[]> {
    try {
      return (await this.deps.threads?.origins(sessionId)) ?? []
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not read who sent the messages of session ${sessionId}: ${(error as Error).message}`,
      )
      return []
    }
  }

  /** Puts back who sent each message of a rebuilt thread that matches one Kettu kept. */
  private restoreOrigins(live: Live, kept: readonly StoredOrigin[]): void {
    if (kept.length === 0) return
    const found = restoredOrigins(threadEntries(live.thread), kept)
    if (found.size === 0) return
    this.emit(
      live,
      [...found].map(([id, changes]): Patch => ({ op: 'entry.update', id, changes })),
    )
  }

  /** The user entry of a prompt, and the title it gives a session that has none; its entry id. */
  private addPrompt(
    live: Live,
    content: UserContent[],
    now: number,
    from?: FromSession,
    device?: FromDevice,
    approval?: true,
    kettu?: true,
  ): string {
    const entryId = this.nextId(live)
    const entry: ThreadEntry = {
      kind: 'user',
      id: entryId,
      content,
      at: now,
      ...(from ? { from } : {}),
      ...(device ? { device } : {}),
      ...(approval ? { approval } : {}),
      ...(kettu ? { kettu } : {}),
    }
    this.emit(live, [{ op: 'entry.add', entry }])
    this.keepOrigin(live, entry)
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
      if (!store) throw invalidParams(t('session.noAttachments'))
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
      if (!store) throw invalidParams(t('session.noAttachments'))
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
    if (!stored) throw notFound(t('session.noAttachment'))
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
    comments?: QueuedComments,
  ): Promise<{ itemId: string | null }> {
    this.assertRegistered(sessionId)
    if (this.recordOf(sessionId).origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noPrompt'))
    }
    this.refuseIfCannotSend(sessionId)
    this.reportsSent.delete(sessionId)
    const revived = await this.revive(sessionId)
    const { live, content } = await this.withCommand(revived, this.hydrate(input))
    const { status, queue, queuePaused } = live.thread.session
    if (canSend(status) && (queue.length === 0 || queuePaused) && !this.waitsForWorktree(live)) {
      // At once: another prompt waiting on the same revive must see this turn running.
      this.sendPrompt(live, content, undefined, portId, device)
      return { itemId: null }
    }
    if (!canSend(status) && status !== 'running' && status !== 'awaiting_permission') {
      throw busyError(status)
    }
    const item = {
      id: randomUUID(),
      content,
      at: this.now(),
      ...(device ? { device } : {}),
      ...(comments ? { comments } : {}),
    }
    if (portId !== undefined) live.queuedBy.set(item.id, portId)
    this.update(live, { queue: [...queue, item] })
    this.persist(live)
    this.touch(live.id)
    return { itemId: item.id }
  }

  async unqueue(sessionId: string, itemId: string): Promise<void> {
    const live = await this.revive(sessionId)
    const { queue } = live.thread.session
    if (!queue.some((item) => item.id === itemId)) throw notFound(t('session.noQueued'))
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
    await this.steerItem(await this.revive(sessionId), itemId)
  }

  /** Steers a queued prompt; false when the turn was ending and the prompt stays first. */
  private async steerItem(live: Live, itemId: string): Promise<boolean> {
    const item = live.thread.session.queue.find((i) => i.id === itemId)
    if (!item) throw notFound(t('session.noQueued'))
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
      return false
    }
    const steered: ThreadEntry = {
      kind: 'user',
      id: this.nextId(live),
      content: resolved.shown,
      at: this.now(),
      steered: true,
      ...(item.from ? { from: item.from } : {}),
      ...(item.device ? { device: item.device } : {}),
      ...(item.approval ? { approval: item.approval } : {}),
      ...(item.kettu ? { kettu: item.kettu } : {}),
    }
    this.emit(live, [{ op: 'entry.add', entry: steered }])
    this.keepOrigin(live, steered)
    this.commitAttachments(live, resolved)
    if (resolved.ids.length > 0) void this.deps.attachments?.release(resolved.ids)
    live.queuedBy.delete(itemId)
    this.update(live, { queue: queue.filter((i) => i.id !== itemId) })
    this.persist(live)
    this.touch(live.id)
    this.skipQuestions(live)
    return true
  }

  /**
   * Skips the questions that wait for an answer once a message went into the turn: the agent holds
   * the turn on them and would not read the message, which is the user's answer in words. One the
   * agent does not wait for holds nothing and stays.
   */
  private skipQuestions(live: Live): void {
    for (const [requestId, pending] of [...live.permissions]) {
      if (pending.questions && !pending.nonBlocking) {
        this.respond(live.id, requestId, { answers: [] })
      }
    }
  }

  /**
   * Sends a queued prompt now: into the running turn where the agent steers; otherwise as the next
   * turn, by moving it to the front of the queue and stopping this one.
   */
  async sendNow(sessionId: string, itemId: string): Promise<void> {
    this.assertRegistered(sessionId)
    await this.sendItemNow(await this.revive(sessionId), itemId)
  }

  /** Send now on a live session; `queued` when the turn was ending and the prompt stays first. */
  private async sendItemNow(
    live: Live,
    itemId: string,
  ): Promise<'steered' | 'interrupted' | 'queued'> {
    if (this.deps.agents.status(live.record.agentId).capabilities.steering) {
      return (await this.steerItem(live, itemId)) ? 'steered' : 'queued'
    }
    const { queue } = live.thread.session
    const item = queue.find((i) => i.id === itemId)
    if (!item) throw notFound(t('session.noQueued'))
    if (!live.turn || live.turn.ended) throw new HostError('busy', t('session.noTurn'))
    this.update(live, { queue: [item, ...queue.filter((i) => i.id !== itemId)] })
    this.persist(live)
    live.sendNext = true
    try {
      await this.cancel(live.id)
    } catch (error) {
      // The stop did not go out, so the turn's end pauses the queue as before.
      live.sendNext = false
      throw error
    }
    return 'interrupted'
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
    if (
      queue.length === 0 ||
      (queuePaused && !chosen) ||
      !canSend(status) ||
      this.waitsForWorktree(live)
    ) {
      return
    }
    // Kettu's own messages that are no longer due, such as a reminder for a step that reported
    // meanwhile, are dropped as their turn comes.
    const start = queue.findIndex((item) => live.kettuQueued.get(item.id)?.() !== false)
    const dropped = start === -1 ? queue : queue.slice(0, start)
    for (const item of dropped) live.kettuQueued.delete(item.id)
    const [next, ...rest] = queue.slice(dropped.length)
    if (!next) {
      this.update(live, { queue: [], queuePaused: false })
      this.persist(live)
      return
    }
    this.update(live, { queue: rest, ...(rest.length === 0 ? { queuePaused: false } : {}) })
    const queuedBy = live.queuedBy.get(next.id)
    live.queuedBy.delete(next.id)
    live.kettuQueued.delete(next.id)
    this.sendPrompt(live, next.content, next.from, queuedBy, next.device, next.approval, next.kettu)
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
      ends: [],
    }
    live.turn = turn
    live.sender =
      portId === null ? null : { portId, device: this.deps.portDevice?.(portId) ?? null }
    live.scope = newTurnScope()
    live.failure = null
    // A running turn has no ending, so a list never shows the last one's on it.
    delete live.record.lastTurn
    this.clearContinueTimer(live.id)
    this.continueRetries.delete(live.id)
    // The touch below sends the count without the suggestions the user talked past.
    this.deps.cards?.turnStarted(live.id)
    this.update(live, {
      status: 'running',
      turnStartedAt: now,
      turnStartUsed: live.thread.session.usage?.used ?? null,
      error: null,
      updatedAt: now,
      ...(live.thread.session.suggestion ? { suggestion: null } : {}),
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
    const target = lightTarget(
      this.deps.settings().lightModel,
      agentId,
      modelOf(live.thread.session.config),
    )
    const name = this.deps.agents.name(target.agentId)
    try {
      const runtime = await this.deps.agents.ensureReady(agentId)
      // Only an agent that titles none has Kettu pay for one.
      if (runtime.init.capabilities.ownTitles !== null) {
        live.titlePrompt = null
        return
      }
      const writer =
        target.agentId === agentId ? runtime : await this.deps.agents.ensureReady(target.agentId)
      const title = await this.askTitle(writer, target.model, message)
      this.applyWrittenTitle(live, title)
    } catch (error) {
      live.titleFailedAt = this.now()
      this.deps.diagnostics.log(
        'warn',
        `${name}: could not title session ${live.id}: ${logText(error)}`,
      )
    } finally {
      live.titleWriting = false
    }
  }

  /** Uses the same title writer for a requirement and falls back to its source session. */
  async titleTask(sessionId: string, text: string): Promise<string | null> {
    const live = this.live.get(sessionId)
    const source = live?.record ?? this.records.get(sessionId)
    const message: UserContent[] = [{ type: 'text', text }]
    const firstLine = fallbackTitle(message)
    function usableTitle(title: string | null): string | null {
      return listedTitle(listedTitle(title, text), firstLine)
    }
    if (source && this.deps.settings().sessionTitles && firstLine) {
      const target = lightTarget(
        this.deps.settings().lightModel,
        source.agentId,
        live
          ? (modelOf(live.thread.session.config) ?? source.model ?? null)
          : (source.model ?? null),
      )
      try {
        const writer = await this.deps.agents.ensureReady(target.agentId)
        const title = usableTitle(await this.askTitle(writer, target.model, message))
        if (title) return title
      } catch (error) {
        this.deps.diagnostics.log('warn', `Could not title a task: ${logText(error)}`)
      }
    }
    return usableTitle(this.title(sessionId) ?? null)
  }

  private async askTitle(
    writer: Parameters<typeof writeSessionTitle>[0],
    model: LightTarget['model'],
    message: UserContent[],
  ): Promise<string> {
    await mkdir(this.deps.reportsDir, { recursive: true })
    return writeSessionTitle(writer, {
      dir: this.deps.reportsDir,
      model,
      message,
      log: (line) => this.deps.diagnostics.log('warn', line),
    })
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
    // The fork copies the agent's session, which an edit not yet sent has not cut.
    if (source.record.rewound) {
      await this.applyRewind(source).catch((error: unknown) => {
        throw agentError(error)
      })
    }
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
        await this.attachOptions(forkId, source.record, runtime),
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
    delete record.rewound
    delete record.carried
    delete record.pinnedAt
    delete record.archivedAt
    delete record.leftSubSessions
    delete record.routine
    delete record.task
    if (record.origin === 'task') record.origin = 'user'
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
      'leftSubSessions',
      'routine',
      'task',
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
    if (live.record.rewound) {
      // An edit waits to be sent: the agent's session is cut there before the message goes.
      try {
        await this.applyRewind(live)
      } catch (error) {
        if (!turn.ended) this.failTurn(live, turn, error)
        return
      }
      if (turn.ended) return
    }
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
      const carried = carry
        ? await this.withCarried(live, connection, carry, resolved.wire, turn.entryId)
        : resolved.wire
      // A slash command must open the prompt to be one, so what goes ahead waits for the next.
      const ahead = opensWithCommand(resolved.wire) ? null : await this.aheadText(live, connection)
      if (turn.ended) return
      let wire = carried
      if (ahead) {
        live.record.memorySentTo = live.record.acpSessionId
        if (turn.entryId) live.record.memorySentAt = turn.entryId
        else delete live.record.memorySentAt
        this.persist(live)
        wire = [{ type: 'text', text: `${ahead}\n\n` }, ...carried]
      }
      const attached = await this.pluginAttachments(live, turn, resolved.wire)
      if (turn.ended) return
      if (attached.length > 0) wire = [...wire, ...attached]
      const entryId = turn.entryId
      const sent = (ref: string): void => {
        if (!entryId || live.thread.byId[entryId]?.kind !== 'user') return
        this.emit(live, [{ op: 'entry.update', id: entryId, changes: { agentRef: ref } }])
      }
      const sending = connection.prompt(live.record.acpSessionId, wire, sent).finally(() => {
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

  /**
   * What plugins attach to the message of a turn, as blocks after what the user wrote, which is
   * left as it is; the message shows what each plugin attached. Only a message the user wrote is
   * offered, and not one that is a command of the agent's own.
   */
  private async pluginAttachments(
    live: Live,
    turn: Turn,
    wire: readonly PromptBlock[],
  ): Promise<PromptBlock[]> {
    const plugins = this.deps.plugins
    const entry = turn.entryId ? live.thread.byId[turn.entryId] : undefined
    if (
      !plugins ||
      live.record.origin !== 'user' ||
      entry?.kind !== 'user' ||
      entry.approval ||
      entry.kettu ||
      entry.from
    ) {
      return []
    }
    const mentioned = entry.content.flatMap((item) =>
      item.type === 'ref' && item.ref.kind === 'plugin' ? [item.ref] : [],
    )
    // A command of the agent's own is not offered to the hooks, but what the user mentioned goes.
    const hooked = plugins.wants('session.beforeSend') && !opensWithCommand(wire)
    if (!hooked && mentioned.length === 0) return []
    const text = wire.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n')
    const summary = this.summary(live.id)
    const [chosen, hooks] = await Promise.all([
      mentioned.length > 0 ? plugins.mentions(summary, mentioned) : [],
      hooked ? plugins.attachments(summary, text) : [],
    ])
    const given = [...chosen, ...hooks]
    if (given.length === 0 || turn.ended) return []
    // What the message already holds counts toward the prompt's limit; what does not fit is left out.
    let bytes = wire.reduce((sum, block) => sum + blockBytes(block), 0)
    const blocks: PromptBlock[] = []
    const kept: PluginAttachment[] = []
    for (const item of given) {
      const block: PromptBlock = { type: 'text', text: attachmentText(item) }
      bytes += blockBytes(block)
      if (bytes > PROMPT_BYTES) break
      blocks.push(block)
      kept.push(item)
    }
    if (kept.length === 0) return []
    const byPlugin = new Map<string, PluginAttached>()
    for (const item of kept) {
      const group = byPlugin.get(item.pluginId) ?? {
        pluginId: item.pluginId,
        plugin: item.plugin,
        items: [],
      }
      group.items.push({
        ...(item.title === undefined ? {} : { title: item.title }),
        text: item.text,
        ...(item.failed === undefined ? {} : { failed: item.failed }),
      })
      byPlugin.set(item.pluginId, group)
    }
    this.emit(live, [
      { op: 'entry.update', id: entry.id, changes: { attached: [...byPlugin.values()] } },
    ])
    return blocks
  }

  /**
   * Ends streaming on the turn's messages, closes open thoughts and stops unfinished tools, but for
   * the calls of commands that run on past the turn.
   */
  private closeOpenEntries(live: Live): void {
    const now = this.now()
    const patches: Patch[] = []
    const runningOn = callsRunningOn(live.thread.session)
    for (const id of live.thread.order) {
      const entry = live.thread.byId[id]
      if (
        entry?.kind === 'tool' &&
        (entry.status === 'pending' || entry.status === 'in_progress')
      ) {
        if (!runningOn.has(id)) {
          patches.push({ op: 'entry.update', id, changes: { status: 'cancelled' } })
        }
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
    const first = !turn.ended
    turn.ended = true
    // After the caller sets the session's status, which the plugins read with the summary.
    if (first && this.deps.plugins?.wants('session.turnEnded')) {
      const durationMs = Math.max(0, this.now() - turn.startedAt)
      queueMicrotask(() => {
        // A turn that ended in an error has no stop reason.
        this.tellPlugins(live, 'session.turnEnded', { outcome: stopReason ?? 'error', durationMs })
      })
    }
    for (const ended of turn.ends.splice(0)) ended()
    if (turn.fallback) clearTimeout(turn.fallback)
    turn.fallback = null
    if (live.turn === turn) live.turn = null
    live.sendNext = false
    if (turn.attachments.length > 0) void this.deps.attachments?.release(turn.attachments)
    turn.attachments = []
    this.deps.mcp?.turnEnded(live.id)
    this.deps.diagnostics.turnEnded(live.record.agentId, [live.id, live.record.acpSessionId])
    this.reportTurn(live, turn, stopReason)
    // A turn ended by an error has no stop reason; its failure sets the ending.
    if (stopReason) live.record.lastTurn = { reason: stopReason, endedAt: this.now() }
    this.closeOpenEntries(live)
    live.activity.clear()
    this.clearPermissions(live, 'cancelled', true)
    const byAgent = live.archiveAfterTurn
    if (byAgent !== null) {
      live.archiveAfterTurn = null
      // Nothing but this turn ran when the agent asked; what runs now, the turn started, and the
      // archive would stop it unseen.
      const left = this.workLeft(live)
      // After the turn's own entries, so the notice and the close come once it has ended. A
      // session being closed or deleted already is left as the user asked.
      if (left && !live.closing) queueMicrotask(() => this.notArchivedNotice(live, byAgent, left))
      else if (!live.closing) {
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
    const used = live.thread.session.usage?.used
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'turn_end',
          id,
          stopReason,
          durationMs: Math.max(0, this.now() - turn.startedAt),
          after: agentEntryBefore(live.thread),
          ...(used ? { used } : {}),
        },
      },
    ])
    return id
  }

  /**
   * The ending of a turn that failed: `limit` when a used-up window of the agent's holds back the
   * session's model, as a plan refusing the request leaves it.
   */
  private failedTurn(live: Live, message: string, now: number): LastTurn {
    const error = firstLine(message)
    const { agentId } = live.record
    const status = this.deps.agents.has(agentId) ? this.deps.agents.status(agentId) : undefined
    const model = live.thread.session.config.find((option) => option.category === 'model')
    const limit = reachedLimit(status, model, now)
    if (!limit || !status) return { reason: 'failed', endedAt: now, error }
    return { reason: 'limit', endedAt: now, error, limit: lastTurnLimit(status, limit) }
  }

  /**
   * A used-up window was noticed just after a session's turn failed: the window stopped it. Only
   * a failed ending changes, and only while no turn has started since.
   */
  turnLimited(sessionId: string, status: AgentStatus, limit: PlanLimit): void {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.records.get(sessionId)
    if (!record || record.lastTurn?.reason !== 'failed' || live?.turn) return
    record.lastTurn = { ...record.lastTurn, reason: 'limit', limit: lastTurnLimit(status, limit) }
    this.planContinue(record)
    if (live) this.persist(live)
    else this.saveIndex()
    this.touch(sessionId)
  }

  /**
   * Plans to carry the session on when the window that stopped its last turn resets, unless the
   * user turned that off, the window gives no reset, or the session is a subagent's.
   */
  private planContinue(record: SessionRecord): void {
    const turn = record.lastTurn
    if (turn?.reason !== 'limit' || !turn.limit?.resetsAt) return
    if (record.origin === 'subagent' || this.isArchived(record)) return
    if (!this.deps.settings().continueAfterLimit) return
    turn.continuesAt = turn.limit.resetsAt
    this.continueRetries.delete(record.id)
    this.scheduleContinue(record.id, turn.limit.resetsAt + CONTINUE_AFTER_RESET_MS)
  }

  private scheduleContinue(sessionId: string, at: number): void {
    this.clearContinueTimer(sessionId)
    if (this.stopped) return
    const delay = Math.min(Math.max(at - this.now(), 0), 2 ** 31 - 1)
    const timer = setTimeout(() => {
      this.continues.delete(sessionId)
      void this.continueSession(sessionId)
    }, delay)
    timer.unref?.()
    this.continues.set(sessionId, timer)
  }

  private clearContinueTimer(sessionId: string): void {
    const timer = this.continues.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.continues.delete(sessionId)
  }

  /**
   * Carries a session on once the window that stopped its last turn has reset. A window that still
   * holds the model, such as the weekly one behind the 5-hour one, is waited for instead.
   */
  private async continueSession(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId)
    const turn = record?.lastTurn
    if (!record || turn?.reason !== 'limit' || typeof turn.continuesAt !== 'number') return
    if (!this.deps.settings().continueAfterLimit || this.isArchived(record)) {
      this.dropContinue(sessionId)
      return
    }
    const { agentId } = record
    if (!this.deps.agents.has(agentId) || this.deps.agents.isDisabled(agentId)) {
      this.dropContinue(sessionId)
      return
    }
    // Reading the limits costs no model call, and the reading decides whether it can run now.
    await this.deps.agents.refreshLimits(agentId).catch(() => {})
    if (!this.deps.agents.has(agentId)) return
    const page = await this.readPage(record, (store) => store.page(sessionId, null, null, 'refs'))
    const model = page?.session.config.find((option) => option.category === 'model')
    const held = reachedLimit(this.deps.agents.status(agentId), model, this.now())
    if (held) {
      if (held.resetsAt !== null && held.resetsAt > this.now()) {
        this.setContinue(sessionId, held.resetsAt)
        return
      }
      // The reset has passed but the reading has not caught up with it; look again shortly.
      const tried = (this.continueRetries.get(sessionId) ?? 0) + 1
      if (tried <= CONTINUE_RETRIES) {
        this.continueRetries.set(sessionId, tried)
        this.scheduleContinue(sessionId, this.now() + CONTINUE_RETRY_MS)
        return
      }
      this.dropContinue(sessionId)
      return
    }
    let live: Live
    try {
      live = await this.revive(sessionId)
    } catch {
      this.dropContinue(sessionId)
      return
    }
    const current = live.record.lastTurn
    if (current?.reason !== 'limit' || current.continuesAt !== turn.continuesAt) return
    const { status, queue, queuePaused } = live.thread.session
    if (!canSend(status)) {
      this.dropContinue(sessionId)
      return
    }
    // What waited in the queue goes first, such as what the user typed during the wait.
    if (queue.length > 0) {
      if (queuePaused) this.update(live, { queuePaused: false })
      this.drainQueue(live)
      if (live.turn) return
    }
    try {
      await this.sendFromKettu(sessionId, CONTINUE_PROMPT)
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not carry session ${sessionId} on: ${(error as Error).message}`,
      )
      this.dropContinue(sessionId)
    }
  }

  /** Moves a session's continuation to a window that resets later, said to clients. */
  private setContinue(sessionId: string, resetsAt: number): void {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.records.get(sessionId)
    if (!record?.lastTurn || record.lastTurn.reason !== 'limit') return
    record.lastTurn = { ...record.lastTurn, continuesAt: resetsAt }
    if (live) this.persist(live)
    else this.saveIndex()
    this.touch(sessionId)
    this.continueRetries.delete(sessionId)
    this.scheduleContinue(sessionId, resetsAt + CONTINUE_AFTER_RESET_MS)
  }

  /**
   * Stops a session's continuation, leaving the last turn's ending as it was: clients show that
   * it will not carry on by itself.
   */
  private dropContinue(sessionId: string): void {
    this.clearContinueTimer(sessionId)
    this.continueRetries.delete(sessionId)
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.records.get(sessionId)
    if (!record?.lastTurn || record.lastTurn.continuesAt == null) return
    record.lastTurn = { ...record.lastTurn, continuesAt: null }
    if (live) this.persist(live)
    else this.saveIndex()
    this.touch(sessionId)
  }

  /** Drops the continuation planned for a session, as its Don't continue line asks. */
  async cancelContinue(sessionId: string): Promise<void> {
    this.assertRegistered(sessionId)
    this.dropContinue(sessionId)
  }

  /** The setting that carries sessions on was turned off: none waits to continue any more. */
  continueSettingChanged(on: boolean): void {
    if (on) return
    let changed = false
    for (const record of this.records.values()) {
      if (record.lastTurn?.continuesAt == null) continue
      record.lastTurn = { ...record.lastTurn, continuesAt: null }
      this.clearContinueTimer(record.id)
      this.continueRetries.delete(record.id)
      const live = this.live.get(record.id)
      if (live) this.persist(live)
      else changed = true
      this.touch(record.id)
    }
    if (changed) this.saveIndex()
  }

  /** A session's workflow suggestions changed, which its count of what waits includes. */
  cardsChanged(sessionId: string): void {
    this.touch(sessionId)
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
    const routineTurn =
      this.reportRun(live, {
        stopReason,
        error: null,
        usage: turnTokens ?? null,
        turn,
      }) || this.reportStep(live)
    // A run's end notifies as the routine's, once, and a step's as its task's, so its session
    // sends nothing here.
    if (!routineTurn) {
      if (stopReason === 'end_turn' && live.record.origin === 'user' && !live.record.startedBy) {
        this.deps.events.completed(live.id)
      }
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

  /** Tells the task engine a step's turn ended; true for a step's session, which stays quiet. */
  private reportStep(live: Live): boolean {
    if (live.record.origin !== 'task') return false
    this.deps.task?.current?.turnEnded(live.id, { byUser: live.userTurn })
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
    live.record.lastTurn = this.failedTurn(live, mapped.message, now)
    this.planContinue(live.record)
    const noticeId = this.nextId(live)
    if (authRequired) live.signInNotices.push(noticeId)
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: noticeId,
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
    const routineTurn =
      this.reportRun(live, {
        stopReason: null,
        error: mapped,
        usage: null,
        turn,
      }) || this.reportStep(live)
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
    // Only what the user wrote goes back to a composer: never Kettu's own message, a card's answer
    // or another session's message.
    const sent = turn.entryId === null ? undefined : live.thread.byId[turn.entryId]
    if (sent?.kind === 'user' && (sent.kettu || sent.approval || sent.from)) return
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
    live.record.lastTurn = this.failedTurn(live, failure.message, this.now())
    this.planContinue(live.record)
    this.touch(live.id)
    this.reportRun(live, { stopReason: null, error: failure, usage: null, turn })
    this.persist(live)
    this.checkpoint(live)
  }

  // Edit from a message: the turns from it leave the thread at once and are set aside, kept on
  // disk, until the next message cuts the agent's own session there and drops them, or Put back
  // returns them.

  /**
   * Takes the turns from `entryId` on out of the thread and hands back the message for the
   * composer, its attachments as new records; `draft` is what the composer held, for Put back.
   * What runs stops first, as for an agent switch: the turn, its subagents and background work.
   */
  async rewind(
    sessionId: string,
    entryId: string,
    draft: UserContent[],
  ): Promise<{ content: UserContent[] }> {
    this.assertRegistered(sessionId)
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent') {
      throw new HostError('restricted', t('session.subagent.noPrompt'))
    }
    if (this.isArchived(record)) throw new HostError('restricted', t('rewind.archived'))
    const live = await this.revive(sessionId)
    if (live.prepared || live.first || live.heldFirst || live.rewinding) {
      throw new HostError('busy', t('rewind.starting'))
    }
    const agent = this.deps.agents.name(live.record.agentId)
    if (!this.deps.agents.status(live.record.agentId).capabilities.rewind) {
      throw new HostError('restricted', t('rewind.unsupported', { agent }))
    }
    if (live.record.noRewind) throw new HostError('restricted', t('rewind.olderThread'))
    const editable = (): boolean => {
      const at = live.thread.order.indexOf(entryId)
      return at >= 0 && canEditAt(live.thread, at)
    }
    if (!editable()) throw new HostError('restricted', t('rewind.notEligible'))
    await this.stopForRewind(live)
    const { status } = live.thread.session
    if (status === 'starting' || status === 'auth_required') throw busyError(status)
    if (!editable()) throw new HostError('restricted', t('rewind.notEligible'))
    const entry = live.thread.byId[entryId] as Extract<ThreadEntry, { kind: 'user' }>
    const content = await this.composerCopy(live, entry.content)
    const at = live.thread.order.indexOf(entryId)
    const aside = live.thread.order.slice(at).flatMap((id) => {
      const item = live.thread.byId[id]
      const pos = live.positions.get(id)
      return item && pos !== undefined ? [{ pos, entry: item }] : []
    })
    const prior = live.record.rewound
    const carried = live.record.carried
    const carry =
      carried && aside.some((item) => item.entry.id === carried.entryId)
        ? carried.carry
        : prior?.carry
    // Put back restores the ending, not a continuation planned before the edit.
    const lastTurn = prior ? prior.lastTurn : live.record.lastTurn
    const stowed = lastTurn ? { ...lastTurn } : undefined
    if (stowed) delete stowed.continuesAt
    live.record.rewound = {
      entryId,
      turns: turnsFrom(live.thread, at) + (prior?.turns ?? 0),
      draft: prior?.draft ?? draft,
      used: prior ? prior.used : (live.thread.session.usage?.used ?? null),
      point: {
        ref: entry.agentRef ?? null,
        text: promptLine(entry.content),
        occurrence: promptOccurrence(live.thread, at),
      },
      ...(carry ? { carry } : {}),
      ...(stowed ? { lastTurn: stowed } : {}),
    }
    delete live.record.lastTurn
    this.clearContinueTimer(live.id)
    this.continueRetries.delete(live.id)
    live.setAside = [...aside, ...(live.setAside ?? [])].sort((a, b) => a.pos - b.pos)
    live.setAsideDirty = true
    if (aside[0]) live.cutAt = Math.min(live.cutAt ?? aside[0].pos, aside[0].pos)
    live.failure = null
    this.emit(live, [{ op: 'thread.truncate', id: entryId }])
    const used = usedAtEnd(live.thread)
    const usage = live.thread.session.usage
    this.update(live, {
      rewound: { turns: live.record.rewound.turns },
      ...(usage && used !== null ? { usage: { ...usage, used } } : {}),
      ...(live.thread.session.suggestion ? { suggestion: null } : {}),
      context: undefined,
      error: null,
      updatedAt: this.now(),
    })
    this.persist(live)
    this.touch(live.id)
    this.checkpoint(live)
    this.deps.diagnostics.event(live.record.agentId, 'session rewound', live.id)
    return { content }
  }

  /** Stops what runs in a session an edit goes back in: its turn, subagents and its agent's session. */
  private async stopForRewind(live: Live): Promise<void> {
    this.pauseQueue(live)
    const turn = live.turn
    if (turn && !turn.ended) {
      const ended = new Promise<void>((resolve) => turn.ends.push(resolve))
      await this.cancel(live.id)
      await ended
    }
    this.clearPermissions(live, 'cancelled')
    await this.closeAll(this.descendants(live.id, 'subagent'), true)
    await this.letGo(live)
    if (live.thread.session.status === 'ready') this.update(live, { status: 'closed' })
  }

  /**
   * The message an edit gives back, with each attachment as a record of its own: the thread's
   * copy goes once the next message is sent. A file or folder is added again from where it is;
   * one that is no longer there is left out.
   */
  private async composerCopy(live: Live, content: readonly UserContent[]): Promise<UserContent[]> {
    const out: UserContent[] = []
    let images = 0
    for (const item of content) {
      if (item.type === 'text') {
        out.push(item)
        continue
      }
      const copy = await this.attachmentCopy(live, item.ref, () => ++images).catch(
        (error: unknown) => {
          this.deps.diagnostics.log(
            'warn',
            `Could not give back an attachment of session ${live.id}: ${(error as Error).message}`,
          )
          return null
        },
      )
      if (copy) out.push({ type: 'ref', ref: { kind: 'attachment', attachment: copy } })
    }
    return out
  }

  private async attachmentCopy(
    live: Live,
    ref: ContentRef,
    nextImage: () => number,
  ): Promise<Attachment | null> {
    const store = this.deps.attachments
    if (!store) return null
    const bytes = async (hash: string | null): Promise<ArrayBuffer | null> => {
      const stored = hash ? await this.storedBlob(live.id, hash) : null
      return stored ? new Uint8Array(stored.data).slice().buffer : null
    }
    if (ref.kind === 'image') {
      const data =
        'data' in ref
          ? new Uint8Array(Buffer.from(ref.data, 'base64')).buffer
          : await bytes(ref.blob)
      if (!data) return null
      const name = t('content.image', { number: nextImage() })
      return store.add({ bytes: data, mimeType: ref.mimeType, name }, null)
    }
    if (ref.kind !== 'attachment') return null
    const { attachment } = ref
    // Not sent, as a message held back before it went: its record is still the one it names.
    if (!attachment.sent) return store.held([attachment.id]).length > 0 ? attachment : null
    if (attachment.blob) {
      const data = await bytes(attachment.blob)
      if (data) {
        const mimeType = attachment.mimeType ?? 'application/octet-stream'
        return store.add({ bytes: data, mimeType, name: attachment.name }, attachment.thumb)
      }
    }
    if (!attachment.uri) return null
    const kind = attachment.type === 'folder' ? 'folder' : 'file'
    return store.addPath(fileURLToPath(attachment.uri), kind, attachment.thumb)
  }

  /**
   * Put back: the turns an edit set aside return where they were, with the context and the last
   * turn's ending they had; what the composer held before is handed back.
   */
  async putBack(sessionId: string): Promise<{ draft: UserContent[] }> {
    this.assertRegistered(sessionId)
    const live = await this.revive(sessionId)
    const rewound = live.record.rewound
    const aside = live.setAside
    if (!rewound || !aside) throw new HostError('restricted', t('rewind.nothing'))
    if (live.rewinding || (live.turn && !live.turn.ended)) {
      throw busyError(live.thread.session.status)
    }
    const from = aside[0]?.pos ?? live.nextPos
    // Entries added since, as a notice, follow the returned ones as they followed the cut.
    const later = live.thread.order.flatMap((id) => {
      const entry = live.thread.byId[id]
      const pos = live.positions.get(id)
      return entry && pos !== undefined && pos > from ? [{ pos, entry }] : []
    })
    if (later[0]) this.emit(live, [{ op: 'thread.truncate', id: later[0].entry.id }])
    const back = [...aside, ...later].sort((a, b) => a.pos - b.pos)
    for (const { pos, entry } of back) live.positions.set(entry.id, pos)
    this.emit(
      live,
      back.map(({ entry }): Patch => ({ op: 'entry.add', entry })),
    )
    live.cutAt = Math.min(live.cutAt ?? from, from)
    live.setAside = null
    live.setAsideDirty = true
    delete live.record.rewound
    if (rewound.lastTurn) live.record.lastTurn = rewound.lastTurn
    const usage = live.thread.session.usage
    this.update(live, {
      rewound: null,
      ...(usage && rewound.used !== null ? { usage: { ...usage, used: rewound.used } } : {}),
      context: undefined,
      updatedAt: this.now(),
    })
    this.persist(live)
    this.touch(live.id)
    this.checkpoint(live)
    const held = new Set(this.deps.attachments?.held(attachmentIds(rewound.draft)) ?? [])
    const draft = rewound.draft.filter(
      (item) =>
        item.type !== 'ref' || item.ref.kind !== 'attachment' || held.has(item.ref.attachment.id),
    )
    return { draft }
  }

  /** Cuts the agent's own session where an edit went back to, once, before anything else reaches it. */
  private applyRewind(live: Live): Promise<void> {
    if (!live.record.rewound) return Promise.resolve()
    live.rewinding ??= this.cutAgentSession(live).finally(() => {
      live.rewinding = null
    })
    return live.rewinding
  }

  /**
   * The agent's session is cut before the edited message, the same one or a new one carrying on
   * with what came before; only then are the set-aside entries dropped. A cut that fails leaves
   * everything as it was, for Put back or another try.
   */
  private async cutAgentSession(live: Live): Promise<void> {
    const { record } = live
    const rewound = record.rewound
    if (!rewound) return
    const agent = this.deps.agents.name(record.agentId)
    const from = record.acpSessionId
    let cut: RewoundSession = { sessionId: from }
    if (from !== '') {
      const runtime = await this.deps.agents.ensureReady(record.agentId)
      const { connection } = runtime
      if (!runtime.init.capabilities.rewind || !connection.rewindSession) {
        throw new HostError('restricted', t('rewind.unsupported', { agent }))
      }
      if (connection.rewindsOpen) await this.connect(live)
      try {
        cut = await connection.rewindSession(
          from,
          await this.cwdOf(live),
          rewound.point,
          record.customTitle ?? live.thread.session.title,
        )
      } catch (error) {
        const mapped = agentError(error)
        throw new HostError(
          mapped.code,
          t('rewind.failed', { reason: mapped.message }),
          mapped.data,
        )
      }
    }
    if (live.record !== record || record.rewound !== rewound) return
    const aside = new Set((live.setAside ?? []).map(({ entry }) => entry.id))
    if (record.memorySentAt && aside.has(record.memorySentAt)) {
      delete record.memorySentTo
      delete record.memorySentAt
    }
    if (cut.sessionId !== from) {
      await this.letGo(live)
      record.acpSessionId = cut.sessionId
      // The copy keeps what the session was started with, as its system prompt.
      if (cut.sessionId === '') {
        delete record.systemPromptSentTo
        delete record.memorySentTo
      } else {
        if (record.systemPromptSentTo === from) record.systemPromptSentTo = cut.sessionId
        if (record.memorySentTo === from) record.memorySentTo = cut.sessionId
      }
      const renamed = Object.entries(cut.refs ?? {})
      const refs = new Map(renamed)
      const patches = live.thread.order.flatMap((id): Patch[] => {
        const entry = live.thread.byId[id]
        const ref = entry?.kind === 'user' && entry.agentRef ? refs.get(entry.agentRef) : undefined
        return ref ? [{ op: 'entry.update', id, changes: { agentRef: ref } }] : []
      })
      if (patches.length > 0) this.emit(live, patches)
      this.update(live, {
        acpSessionId: cut.sessionId || null,
        ...(live.thread.session.status === 'ready' ? { status: 'closed' } : {}),
      })
    }
    if (rewound.carry) record.carry = rewound.carry
    delete record.rewound
    live.setAside = null
    live.setAsideDirty = true
    this.update(live, { rewound: null })
    this.save(live)
    // A session cut to nothing gets its new one as the turn attaches, which writes it whole.
    if (record.acpSessionId) this.checkpoint(live)
    this.deps.diagnostics.event(record.agentId, 'session cut for an edit', live.id)
  }

  /** An agent that cannot cut every session it has says which, as for an older Codex thread. */
  private checkRewind(live: Live, connection: AgentConnection): void {
    const { record } = live
    const id = record.acpSessionId
    if (!connection.canRewind || record.noRewind || id === '' || record.origin === 'subagent') {
      return
    }
    void this.cwdOf(live)
      .then((cwd) => connection.canRewind!(id, cwd))
      .then(
        (can) => {
          if (can || record.acpSessionId !== id || this.live.get(live.id) !== live) return
          record.noRewind = true
          this.persist(live)
          this.update(live, { noRewind: true })
        },
        (error: unknown) => {
          this.deps.diagnostics.log(
            'warn',
            `Could not ask whether session ${live.id} can be cut: ${(error as Error).message}`,
          )
        },
      )
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
    this.clearPermissions(live, 'cancelled', true)
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
    this.endCallsRunningOn(live)
    live.background = false
    live.backgroundListed = false
    live.scheduled = 0
    if (live.thread.session.background?.length) this.update(live, { background: [] })
  }

  /** The commands that ran on past their turn in their calls stop with the agent's session. */
  private endCallsRunningOn(live: Live): void {
    const running = callsRunningOn(live.thread.session)
    if (running.size === 0) return
    const patches: Patch[] = []
    for (const id of running) {
      const entry = live.thread.byId[id]
      if (
        entry?.kind === 'tool' &&
        (entry.status === 'pending' || entry.status === 'in_progress')
      ) {
        patches.push({ op: 'entry.update', id, changes: { status: 'cancelled' } })
      }
    }
    if (patches.length > 0) this.emit(live, patches)
    const now = this.now()
    this.update(live, {
      background: (live.thread.session.background ?? []).map((task) =>
        task.entryId !== undefined && running.has(task.entryId)
          ? { ...task, status: 'stopped', endedAt: now }
          : task,
      ),
    })
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

  // Side questions.

  /** How the agent answers side questions, by what it is known to do. */
  private sideRouteOf(agentId: AgentId): SideChatRoute {
    const capabilities = this.deps.agents.has(agentId)
      ? this.deps.agents.status(agentId).capabilities
      : null
    return sideRouteWith(agentId, capabilities)
  }

  /** The session's side chat; null for a subagent, which has none. */
  private sideOf(live: Live): SideChatView | null {
    if (live.record.origin === 'subagent') return null
    return (
      live.thread.session.sideChat ?? {
        route: this.sideRouteOf(live.record.agentId),
        answerAgent: null,
        entries: [],
      }
    )
  }

  private setSide(live: Live, side: SideChatView): void {
    this.update(live, { sideChat: { ...side, route: this.sideRouteOf(live.record.agentId) } })
  }

  private sideEntry(live: Live, entryId: string): SideChatEntry | null {
    return this.sideOf(live)?.entries.find((entry) => entry.id === entryId) ?? null
  }

  /** Changes one side question; nothing once a clear took it away. */
  private patchSideEntry(live: Live, entryId: string, changes: Partial<SideChatEntry>): void {
    const side = this.sideOf(live)
    if (!side?.entries.some((entry) => entry.id === entryId)) return
    const entries = side.entries.map((entry) =>
      entry.id === entryId ? { ...entry, ...changes } : entry,
    )
    this.setSide(live, { ...side, entries })
  }

  /**
   * Asks a side question and answers it beside the session: the request returns once it is
   * asked, the answer arrives in `sideChat` patches. `agentId` picks the agent that answers for a
   * session whose own agent cannot, and the session keeps it.
   */
  async sideAsk(
    sessionId: string,
    question: string,
    quote: string | null,
    agentId: AgentId | null,
  ): Promise<void> {
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent') throw new HostError('restricted', t('session.side.subagent'))
    if (record.archivedAt !== undefined) {
      throw new HostError('restricted', t('session.side.archived'))
    }
    if (this.sideRuns.has(sessionId)) throw new HostError('busy', t('session.side.busy'))
    const own = this.sideRouteOf(record.agentId)
    const borrowed = agentId !== null && agentId !== record.agentId
    if (borrowed && !this.sideAgents(sessionId).some((agent) => agent.agentId === agentId)) {
      throw new HostError(
        'agent_unavailable',
        t('session.side.cannotAnswer', { agent: this.deps.agents.name(agentId) }),
      )
    }
    const live = await this.revive(sessionId)
    // Another request may have started one while the session came back.
    if (this.sideRuns.has(sessionId)) throw new HostError('busy', t('session.side.busy'))
    // The side question sees the conversation as the thread shows it, cut where an edit went.
    if (live.record.rewound) {
      await this.applyRewind(live).catch((error: unknown) => {
        throw agentError(error)
      })
    }
    const side = this.sideOf(live)!
    const answerAgent = borrowed ? agentId : side.answerAgent
    const answering = borrowed || own === 'none' ? answerAgent : record.agentId
    if (answering === null) {
      throw new HostError(
        'agent_unavailable',
        t('session.side.pickAgent', { agent: this.deps.agents.name(record.agentId) }),
      )
    }
    this.deps.agents.assertEnabled(answering)
    const route = answering === record.agentId && own !== 'none' ? own : 'hidden'
    const entry: SideChatEntry = {
      id: randomUUID(),
      question,
      quote,
      agentId: answering,
      route,
      status: 'answering',
      answer: '',
      steps: [],
      saw:
        route === 'hidden' ? null : ownSaw(route, null, compactedTurns(threadEntries(live.thread))),
      error: null,
      askedAt: this.now(),
      answeredAt: null,
    }
    this.sideCleared.delete(sessionId)
    const entries = [...side.entries, entry].slice(-SIDE_ENTRIES)
    this.setSide(live, { ...side, answerAgent, entries })
    const controller = new AbortController()
    this.sideRuns.set(sessionId, controller)
    void this.answerSide(live, entry, controller.signal).finally(() => {
      if (this.sideRuns.get(sessionId) === controller) this.sideRuns.delete(sessionId)
      this.refreshRelease(live)
    })
  }

  private async answerSide(live: Live, entry: SideChatEntry, signal: AbortSignal): Promise<void> {
    const earlier = (this.sideOf(live)?.entries ?? []).filter((item) => item.id !== entry.id)
    const ask = {
      question: questionText(entry.question, entry.quote),
      history: sideHistory(earlier),
    }
    let shown = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const showText = (): void => {
      timer = null
      this.patchSideEntry(live, entry.id, { answer: cutAnswer(shown) })
    }
    const events: SideAnswerEvents = {
      text: (answer) => {
        shown = answer
        timer ??= setTimeout(showText, SIDE_TEXT_MS)
      },
      step: (step) => {
        const steps = this.sideEntry(live, entry.id)?.steps
        if (steps && steps.length < SIDE_STEPS) {
          this.patchSideEntry(live, entry.id, { steps: [...steps, step] })
        }
      },
    }
    const ended = (changes: Partial<SideChatEntry>): void => {
      if (timer) clearTimeout(timer)
      this.patchSideEntry(live, entry.id, { ...changes, answeredAt: this.now() })
      // An answer that ends out of sight leaves the session unread; a stopped or cleared one
      // has nothing to show.
      if (
        changes.status !== 'stopped' &&
        this.sideEntry(live, entry.id) &&
        !this.inFront(live.id)
      ) {
        this.markUnread(live.id, true)
      }
    }
    try {
      const result = await this.sideAnswer(live, entry, ask, events, signal)
      if (signal.aborted) {
        ended({ status: 'stopped', answer: cutAnswer(shown) })
      } else if (result.synthetic || result.text.trim() === '') {
        const agent = this.deps.agents.name(entry.agentId)
        ended({ status: 'failed', answer: '', error: t('session.side.noAnswer', { agent }) })
      } else {
        ended({ status: 'answered', answer: cutAnswer(result.text), error: null })
        this.recordSideUsage(live, entry, result)
      }
    } catch (error) {
      if (signal.aborted) {
        ended({ status: 'stopped', answer: cutAnswer(shown) })
        return
      }
      ended({ status: 'failed', error: agentError(error).message })
      this.deps.diagnostics.log('warn', `The side question of ${live.id} failed: ${logText(error)}`)
    }
  }

  /**
   * Answers the agent's own way where it has one, then in a fork of the session, else in a hidden
   * session given a text copy; the first that cannot says why the question moved on.
   */
  private async sideAnswer(
    live: Live,
    entry: SideChatEntry,
    ask: Pick<SideQuestion, 'question' | 'history'>,
    events: SideAnswerEvents,
    signal: AbortSignal,
  ): Promise<SideAnswer> {
    let fellBackFrom: SideChatSaw['fellBackFrom'] = null
    for (const way of await this.sideWays(live, entry)) {
      try {
        if (way !== entry.route) {
          this.patchSideEntry(live, entry.id, {
            route: way,
            saw: ownSaw(way, fellBackFrom, compactedTurns(threadEntries(live.thread))),
          })
        }
        return way === 'fork'
          ? await this.sideFork(live, ask, events, signal)
          : await this.sideOwn(live, way, ask, events, signal)
      } catch (error) {
        if (!(error instanceof SideQuestionUnsupported)) throw error
        this.deps.diagnostics.log(
          'info',
          `The side question of ${live.id} cannot go ${way}: ${error.message}`,
        )
        fellBackFrom ??= way
      }
    }
    this.patchSideEntry(live, entry.id, { route: 'hidden', saw: null })
    return this.sideHidden(live, entry, ask, events, signal, fellBackFrom)
  }

  /** The agent's own ways to answer, best first; none for an agent given a text copy. */
  private async sideWays(
    live: Live,
    entry: SideChatEntry,
  ): Promise<('claude' | 'codex' | 'fork')[]> {
    if (entry.route === 'claude') return ['claude', 'fork']
    if (entry.route === 'codex') return ['codex']
    if (entry.route === 'fork') return ['fork']
    // An agent not known yet to fork may turn out to when it runs.
    if (entry.agentId !== live.record.agentId || sideRoute(entry.agentId) !== 'hidden') return []
    const runtime = await this.deps.agents.ensureReady(entry.agentId)
    return runtime.init.capabilities.forkSession ? ['fork'] : []
  }

  private async sideOwn(
    live: Live,
    route: 'claude' | 'codex',
    ask: Pick<SideQuestion, 'question' | 'history'>,
    events: SideAnswerEvents,
    signal: AbortSignal,
  ): Promise<SideAnswer> {
    // A closed session attaches first, as a message would make it.
    try {
      await this.attachClosed(live)
    } catch (error) {
      throw agentError(error)
    }
    const runtime = await this.deps.agents.ensureReady(live.record.agentId)
    const { connection } = runtime
    if (!connection.sideQuestion) throw new SideQuestionUnsupported()
    // A fork of Codex's thread keeps the session's tools so that its prompt starts as the
    // session's and reads its cache.
    const options =
      route === 'codex' ? await this.attachOptions(live.id, live.record, runtime) : undefined
    return connection.sideQuestion(
      live.record.acpSessionId,
      { ...ask, ...(options ? { options } : {}) },
      events,
      signal,
    )
  }

  /** Answers in a fork of the session that the agent makes and Kettu removes after. */
  private async sideFork(
    live: Live,
    ask: Pick<SideQuestion, 'question' | 'history'>,
    events: SideAnswerEvents,
    signal: AbortSignal,
  ): Promise<SideAnswer> {
    // Not every agent forks a session it does not have open, so a closed one attaches first.
    try {
      await this.attachClosed(live)
    } catch (error) {
      throw agentError(error)
    }
    const runtime = await this.deps.agents.ensureReady(live.record.agentId)
    if (!runtime.init.capabilities.forkSession) throw new SideQuestionUnsupported()
    const { connection } = runtime
    const text = await answerFork(runtime, {
      // The session's folder: an agent forks a session only where it was made.
      open: () =>
        connection.forkSession(live.record.acpSessionId, workDir(live.record), { hidden: 'side' }),
      model: modelOf(live.thread.session.config),
      prompt: forkPrompt(ask),
      signal,
      text: events.text,
      log: (message) => this.deps.diagnostics.log('warn', message),
    })
    return { text, synthetic: false }
  }

  private async sideHidden(
    live: Live,
    entry: SideChatEntry,
    ask: Pick<SideQuestion, 'question' | 'history'>,
    events: SideAnswerEvents,
    signal: AbortSignal,
    fellBackFrom: SideChatSaw['fellBackFrom'],
  ): Promise<SideAnswer> {
    const runtime = await this.deps.agents.ensureReady(entry.agentId)
    // The session's own window only counts when its own agent answers.
    const own = entry.agentId === live.record.agentId
    const carried = sideContext(threadEntries(live.thread), {
      firstAgent: this.firstAgentOf(live.record),
      agentName: (agentId) => this.deps.agents.name(agentId),
      ...(own && live.thread.session.usage?.size ? { window: live.thread.session.usage.size } : {}),
    })
    this.patchSideEntry(live, entry.id, {
      saw: copySaw(carried, fellBackFrom, compactedTurns(threadEntries(live.thread))),
    })
    // Kettu's own folder, never the project's: an agent without permissions could change it.
    await mkdir(this.deps.reportsDir, { recursive: true })
    const text = await answerHidden(runtime, {
      dir: this.deps.reportsDir,
      prompt: hiddenPrompt(carried?.text ?? null, ask),
      model: own ? modelOf(live.thread.session.config) : null,
      signal,
      text: events.text,
      log: (message) => this.deps.diagnostics.log('warn', message),
    })
    return { text, synthetic: false }
  }

  private recordSideUsage(live: Live, entry: SideChatEntry, result: SideAnswer): void {
    if (!result.tokens || !this.deps.usage) return
    this.deps.usage.record(
      recordRows({
        sessionId: live.id,
        acpSessionId: live.record.acpSessionId,
        agentId: entry.agentId,
        project: live.record.projectPath,
        turnEntryId: `side-${entry.id}`,
        at: this.now(),
        tokens: result.tokens,
        models: result.model ? [{ model: result.model, tokens: result.tokens }] : [],
        model: result.model ?? null,
      }),
    )
  }

  /** Stops the side question being answered; its question stays, marked stopped. */
  sideStop(sessionId: string): void {
    this.recordOf(sessionId)
    this.sideRuns.get(sessionId)?.abort()
  }

  /** Empties the side chat, or with `undo` puts back what the last clear emptied. */
  async sideClear(sessionId: string, undo: boolean): Promise<void> {
    const record = this.recordOf(sessionId)
    if (record.origin === 'subagent') return
    if (!undo) this.sideRuns.get(sessionId)?.abort()
    const live = await this.revive(sessionId)
    const side = this.sideOf(live)!
    if (undo) {
      const cleared = this.sideCleared.get(sessionId)
      if (!cleared) return
      this.sideCleared.delete(sessionId)
      this.setSide(live, { ...side, entries: [...cleared, ...side.entries].slice(-SIDE_ENTRIES) })
      return
    }
    if (side.entries.length === 0) return
    this.sideCleared.set(
      sessionId,
      side.entries.map((entry) =>
        entry.status === 'answering' ? { ...entry, status: 'stopped' } : entry,
      ),
    )
    this.setSide(live, { ...side, entries: [] })
  }

  /** The agents of this host that can answer side questions for the session's agent. */
  sideAgents(sessionId: string): SideChatAgent[] {
    const record = this.recordOf(sessionId)
    return this.lightAgents().filter((agent) => agent.agentId !== record.agentId)
  }

  /**
   * The agents that may ask a prompt in a hidden session for others: on, added and installed, and
   * able to remove such a session without a trace. Side questions and lightweight tasks take them.
   */
  lightAgents(): LightAgent[] {
    return this.deps.agents
      .ids()
      .filter(
        (agentId) =>
          !this.deps.agents.isDisabled(agentId) &&
          answersForOthers(agentId) &&
          this.sideUsable(agentId),
      )
      .map((agentId) => ({ agentId, name: this.deps.agents.name(agentId) }))
  }

  /** An agent the user has and can start: added, installed and shown, not a catalog entry. */
  private sideUsable(agentId: AgentId): boolean {
    const status = this.deps.agents.status(agentId)
    return (
      status.registered !== false &&
      !status.uninstalled &&
      !status.hidden &&
      !UNUSABLE_STATES.has(status.state)
    )
  }

  /** Stops what the sessions' side questions run and drops what is kept for them. */
  private endSide(ids: readonly string[], forget: boolean): void {
    for (const id of ids) {
      this.sideRuns.get(id)?.abort()
      if (forget) this.sideCleared.delete(id)
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

  /** The `allow_once` option a step's scope allows in its folder, or null to ask the user. */
  private stepAnswer(live: Live, request: PermissionRequest): string | null {
    if (request.plan !== undefined || request.elicitation || request.questions) return null
    const entry = live.thread.byId[request.toolEntryId]
    if (entry?.kind !== 'tool') return null
    return scopeAnswer(
      STEP_SCOPE,
      workDir(live.record),
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
    return this.pluginCheck(live, request, signal) ?? this.askPermission(live, request, signal)
  }

  /**
   * Lets the plugins that hold `requests.check` look at a request to use a tool before anything
   * else answers or shows it; one of them may deny it and none can allow it. Null when no plugin
   * would look, so the request goes on at once. A question, a plan or a request of an MCP server
   * asks for no authorization, so it is not checked.
   */
  private pluginCheck(
    live: Live,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionAnswer> | null {
    const plugins = this.deps.plugins
    const deny = request.options.find((option) => option.kind === 'reject_once')
    if (
      !plugins?.wants('session.permissionRequested') ||
      live.record.origin !== 'user' ||
      request.questions ||
      request.plan !== undefined ||
      request.elicitation ||
      !deny
    ) {
      return null
    }
    const entry = live.thread.byId[request.toolEntryId]
    const tool = entry?.kind === 'tool' ? entry : undefined
    const facts = requestFacts(tool)
    return plugins.check(this.summary(live.id), facts).then((denial) => {
      if (signal.aborted) throw signal.reason
      if (live.closing || live.turn?.cancelRequested) return 'cancelled'
      if (!denial) return this.askPermission(live, request, signal)
      this.emit(live, [
        {
          op: 'entry.update',
          id: request.toolEntryId,
          changes: {
            permission: null,
            permissionResult: { optionId: deny.id, kind: 'reject_once' },
          },
        },
        {
          op: 'entry.add',
          entry: {
            kind: 'plugin_denial',
            id: this.nextId(live),
            pluginId: denial.pluginId,
            plugin: denial.plugin,
            request: facts.command ?? facts.tool,
            reason: denial.reason,
            after: agentEntryBefore(live.thread),
          },
        },
      ])
      this.touch(live.id)
      // The agent hears who denied it and why, where its option takes a note.
      return denialAnswer(deny, denial)
    })
  }

  private askPermission(
    live: Live,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionAnswer> {
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
    // A step answers inside its scope until it reports; anything else waits for the user.
    if (live.record.origin === 'task' && this.deps.task?.current?.working(live.id)) {
      const optionId = this.stepAnswer(live, request)
      if (optionId !== null) {
        this.emit(live, [
          {
            op: 'entry.update',
            id: request.toolEntryId,
            changes: {
              permission: null,
              permissionResult: { optionId, kind: 'allow_once', by: 'task' },
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
    const asked = live.thread.byId[request.toolEntryId]
    const risky =
      asked?.kind === 'tool' && riskyRequest(asked.toolKind, asked.rawInput, request.shell)
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
        outsideTurn: live.turn === null && !request.nonBlocking,
        nonBlocking: request.nonBlocking === true,
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
              risky,
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
      if (!request.nonBlocking && (status === 'running' || status === 'ready'))
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
      } else if (live.record.origin === 'task' && this.deps.task?.current) {
        // A step's request needs the user as its task does, which says so once.
        this.deps.task.current.waiting(live.id, true)
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
          requestFacts(tool),
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
    if (live.permissions.size === 0 && live.record.origin === 'task') {
      this.deps.task?.current?.waiting(live.id, false)
    }
    this.updateBadge()
  }

  /**
   * Settles every pending request; after an exit the answer goes nowhere, but frees the handler.
   * `keepNonBlocking` leaves the requests no turn waits on, which a turn's end does not end.
   */
  private clearPermissions(
    live: Live,
    result: 'cancelled' | 'withdrawn',
    keepNonBlocking = false,
  ): void {
    for (const [requestId, pending] of [...live.permissions]) {
      if (keepNonBlocking && pending.nonBlocking) continue
      this.settlePermission(live, requestId, result)
      pending.answer('cancelled')
    }
    // A new origin still waiting dies with the session's page: its card says it went unanswered.
    for (const [requestId, entryId] of [...live.origins]) {
      if (requestId.startsWith('device:')) {
        this.settleDeviceAccess(live.id, entryId, 'timeout')
        continue
      }
      if (requestId.startsWith('surface:')) {
        this.settleSurfaceAccess(live.id, entryId, 'timeout')
        continue
      }
      // A publish card waits its own time past the turn; put off when the session closes, it is
      // kept as a draft, as by Not now.
      if (requestId.startsWith('market:')) {
        if (keepNonBlocking) live.lateCards.add(entryId)
        else this.settleMarket(live.id, entryId, { decision: 'ended' })
        continue
      }
      // A settings card ends with its turn, changing nothing.
      if (requestId.startsWith('settings:')) {
        this.settleSettings(live.id, entryId, { decision: 'ended' })
        continue
      }
      live.origins.delete(requestId)
      this.originRequests.delete(requestId)
      const entry = live.thread.byId[entryId]
      if (entry?.kind === 'browser_origin' && entry.decision === null) {
        this.emit(live, [{ op: 'entry.update', id: entryId, changes: { decision: 'timeout' } }])
      }
    }
    // A step the agent asked for ends with its turn.
    if (live.ask) this.controlAskSettled(live.id, 'ended')
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
    const nonBlocking =
      [...live.permissions.values()].filter((p) => p.nonBlocking).length + live.lateCards.size
    if (waitingCount(live) - nonBlocking > 0) return
    if (live.thread.session.status !== 'awaiting_permission') return
    this.update(live, { status: live.turn || live.childRunning ? 'running' : 'ready' })
  }

  respond(
    sessionId: string,
    requestId: string,
    answer:
      { optionId: string; note?: string } | { answers: QuestionAnswer[] } | { values: FormValues },
    device?: FromDevice,
    relayed?: PermissionRelay,
  ): void {
    this.recordOf(sessionId)
    const live = this.live.get(sessionId)
    const pending = live?.permissions.get(requestId)
    if (live && !pending && live.answered.has(requestId)) {
      throw new HostError('not_found', t('session.waiting.permission.answered'), {
        reason: ALREADY_ANSWERED,
        device: live.answered.get(requestId) ?? null,
      })
    }
    if (!live || !pending) throw notFound(t('session.waiting.permission.gone'))
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
        ...(relayed ? { relayed: { plugin: relayed.plugin, from: relayed.from } } : {}),
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
   * Answers a request on the user's behalf from a plugin's channel, by the path of their click but
   * only with allow once or deny of a plain permission request: never a question, a plan, a form
   * or anything that lasts.
   */
  relayPermission(
    sessionId: string,
    requestId: string,
    optionId: string,
    relay: PermissionRelay,
  ): void {
    this.recordOf(sessionId)
    const pending = this.live.get(sessionId)?.permissions.get(requestId)
    if (pending) {
      const option = pending.options.find((o) => o.id === optionId)
      const plain = !pending.questions && !pending.plan && !pending.elicitation
      if (!plain || (option?.kind !== 'allow_once' && option?.kind !== 'reject_once')) {
        throw new HostError('restricted', t('session.waiting.permission.notRelayable'))
      }
    }
    this.respond(sessionId, requestId, { optionId }, undefined, relay)
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
   * answer the user just gave; behind the queue while a turn runs, unless `now` sends it into
   * that turn, as an answer an agent waits for must be.
   */
  private sendForUser(live: Live, text: string, options?: { approval?: true; now?: true }): void {
    if (this.live.get(live.id) !== live || live.closing) return
    const approval = options?.approval
    const content: UserContent[] = [{ type: 'text', text }]
    const { status, queue } = live.thread.session
    if (canSend(status)) {
      this.sendPrompt(live, content, undefined, undefined, undefined, approval)
      return
    }
    if (status !== 'running' && status !== 'awaiting_permission') {
      this.deps.diagnostics.log('warn', `Session ${live.id} could not take a message: ${status}`)
      return
    }
    const item = { id: randomUUID(), content, at: this.now(), ...(approval ? { approval } : {}) }
    this.update(live, { queue: [...queue, item] })
    this.persist(live)
    this.touch(live.id)
    if (!options?.now) return
    // A turn that cannot take it leaves the message in the queue, which goes when the turn ends.
    this.steerItem(live, item.id).catch((error: unknown) => {
      this.deps.diagnostics.log(
        'warn',
        `Session ${live.id} kept a message queued: ${String(error)}`,
      )
    })
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
    let live = await this.revive(sessionId)
    const status = live.thread.session.status
    if (!live.connection && status !== 'closed') throw busyError(status)
    const option = live.thread.session.config.find((o) => o.id === optionId)
    if (!option) throw invalidParams(t('session.noConfigOption', { option: optionId }))
    if (!isValueOf(option, value)) {
      throw invalidParams(t('session.notAChoice', { value: String(value), option: option.name }))
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
        let config: ConfigOption[]
        try {
          config = await connection.setConfigOption(live.record.acpSessionId, optionId, value)
        } catch (error) {
          // A model its agent process did not list when it attached is new to that process.
          if (!this.listedAfterAttach(live, option, value)) throw error
          live = await this.attachAgain(live)
          config = await live.connection!.setConfigOption(live.record.acpSessionId, optionId, value)
        }
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
   * Lists the models the agent offers now in a session that listed them when it attached, or
   * kept them when its agent was let go, read from a hidden session in its folder.
   */
  async refreshModels(sessionId: string): Promise<void> {
    this.assertRegistered(sessionId)
    if (this.recordOf(sessionId).origin === 'subagent') return
    const live = await this.revive(sessionId)
    if (live.prepared || live.closing) return
    if (!live.connection && live.thread.session.status !== 'closed') return
    if (live.modelsRead) return live.modelsRead
    const readAt = live.modelsReadAt
    if (readAt !== null && this.now() - readAt < MODELS_FRESH_MS) return
    live.modelsRead = this.readModels(live).finally(() => {
      live.modelsRead = null
    })
    return live.modelsRead
  }

  private async readModels(live: Live): Promise<void> {
    const fresh = await this.deps.agents.readConfig(live.record.agentId, workDir(live.record))
    live.modelsReadAt = this.now()
    if (!fresh || live.closing || this.live.get(live.id) !== live) return
    const read = withFreshModels(live.thread.session.config, fresh)
    if (!read) return
    for (const model of read.added) live.refreshedModels.add(model)
    this.update(live, { config: read.config })
  }

  /** Whether `value` is a model that a read again added to what the session's process listed. */
  private listedAfterAttach(live: Live, option: ConfigOption, value: string | boolean): boolean {
    if (option.category !== 'model' || typeof value !== 'string') return false
    // Letting the agent go ends a session that was never saved, and a turn's work with it.
    return live.refreshedModels.has(value) && live.saved && this.holdReason(live) === null
  }

  /** Lets the session's agent go and attaches it again, which then lists what it offers now. */
  private async attachAgain(live: Live, why = 'models listed again'): Promise<Live> {
    this.release(live, why)
    await this.releasing.get(live.id)
    const again = await this.revive(live.id)
    await this.attachClosed(again)
    return again
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

  /**
   * Takes a top-level session off the list, closed, with its sub-sessions; the index keeps them.
   * Without them, its subagents still go with it, and the sub-sessions in the list leave its tree
   * to stay there as sessions of their own until it is restored.
   */
  async archive(sessionId: string, subSessions = true): Promise<void> {
    const record = this.topLevel(sessionId)
    if (record.archivedAt !== undefined) return
    await this.settled(sessionId)
    const left = subSessions ? [] : this.listedSubSessions(sessionId)
    const staying = new Set(
      left.flatMap((child) => [child.id, ...this.descendants(child.id).map((item) => item.id)]),
    )
    const all = [...this.descendants(sessionId).filter((item) => !staying.has(item.id)), record]
    await this.closeAll(all, true)
    for (const item of all) this.dropContinue(item.id)
    for (const child of left) {
      child.parentId = null
      this.saveRecord(child.id)
    }
    if (left.length > 0) record.leftSubSessions = left.map((child) => child.id)
    else delete record.leftSubSessions
    delete record.pinnedAt
    record.archivedAt = this.now()
    this.saveRecord(sessionId)
    this.deps.events.ended(all.map((item) => item.id))
  }

  /**
   * The sub-sessions right under a session that the list shows, reached through its subagents,
   * which belong to it: not one archived on its own, nor one a window prepared and never sent.
   */
  private listedSubSessions(sessionId: string): SessionRecord[] {
    return this.children(sessionId).flatMap((child) => {
      if (child.origin === 'subagent') return this.listedSubSessions(child.id)
      const listed = child.archivedAt === undefined && !this.live.get(child.id)?.prepared
      return listed ? [child] : []
    })
  }

  /** Puts the sub-sessions a session left in the list when archived back under it. */
  private takeBackSubSessions(record: SessionRecord): void {
    const left = record.leftSubSessions
    if (!left) return
    delete record.leftSubSessions
    for (const id of left) {
      const child = this.live.get(id)?.record ?? this.records.get(id)
      // One deleted since stays gone, and one another tree took stays there.
      if (!child || child.parentId !== null) continue
      child.parentId = record.id
      // Only a top-level session is pinned.
      delete child.pinnedAt
      this.saveRecord(id)
    }
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

  /**
   * The rank the caller's mode holds the sessions it starts to: planning counts as asking. Null
   * for an agent whose modes Kettu cannot rank.
   */
  starterRank(sessionId: string): ModeRank | null {
    const record = this.recordOf(sessionId)
    const harness = harnessOf(record.agentId)
    const config = this.live.get(sessionId)?.thread.session.config ?? []
    const optionId = modeOptionId(record.agentId)
    const mode = config.find((option) => option.id === optionId)?.value
    // Codex plans in its collaboration mode, beside its permission mode.
    const planning =
      harness === 'codex' &&
      config.some((option) => option.id === CODEX_COLLABORATION_ID && option.value === 'plan')
    return starterRank(harness, typeof mode === 'string' ? mode : undefined, planning)
  }

  /**
   * Whether the session's agent changes Kettu's settings without asking: a session the user
   * started, in Full access at this moment. One another session started, a workflow step's and a
   * routine's always ask, as do agents whose modes Kettu cannot rank.
   */
  settingsFullAccess(sessionId: string): boolean {
    const record = this.records.get(sessionId) ?? this.live.get(sessionId)?.record
    if (!record || record.origin !== 'user' || record.startedBy) return false
    return this.starterRank(sessionId) === 4
  }

  /**
   * What a session's mode lets its agent do with a terminal the user opened: Full access uses it
   * without asking, planning only reads it. A mode Kettu cannot rank asks.
   */
  surfaceAccessOf(sessionId: string): { fullAccess: boolean; planning: boolean } {
    const record = this.recordOf(sessionId)
    const harness = harnessOf(record.agentId)
    const config = this.live.get(sessionId)?.thread.session.config ?? []
    const optionId = modeOptionId(record.agentId)
    const mode = config.find((option) => option.id === optionId)?.value
    const planning =
      mode === 'plan' ||
      (harness === 'codex' &&
        config.some((option) => option.id === CODEX_COLLABORATION_ID && option.value === 'plan'))
    const rank = starterRank(harness, typeof mode === 'string' ? mode : undefined, planning)
    return { fullAccess: rank === 4, planning }
  }

  /** A session's options, from memory or its stored thread. */
  private async toolConfig(record: SessionRecord): Promise<ConfigOption[]> {
    const live = this.live.get(record.id)
    return live
      ? live.thread.session.config
      : ((await this.readThread(record))?.session.config ?? [])
  }

  /** A session's model and level as the session tools show them. */
  async toolChoices(sessionId: string): Promise<ToolChoices> {
    const config = await this.toolConfig(this.recordOf(sessionId))
    const shown = (category: ConfigOption['category']): ToolMode | null => {
      const option = config.find((o) => o.category === category && o.type === 'select')
      if (typeof option?.value !== 'string') return null
      const name = option.choices?.find((choice) => choice.value === option.value)?.name
      return { id: option.value, name: name ?? option.value }
    }
    return { model: shown('model'), effort: shown('thought_level') }
  }

  /** Whether a started session's first message waits in its paused queue for the user. */
  firstHeld(sessionId: string): boolean {
    const live = this.live.get(sessionId)
    const starter = live?.record.startedBy
    if (!live || !starter || !live.thread.session.queuePaused) return false
    return live.thread.session.queue.some((item) => item.from?.sessionId === starter)
  }

  /** A session's permission mode, from memory or its stored thread; null when it has none. */
  async toolMode(sessionId: string): Promise<ToolMode | null> {
    const record = this.recordOf(sessionId)
    const config = await this.toolConfig(record)
    const optionId = modeOptionId(record.agentId)
    const option = config.find((candidate) =>
      optionId === null
        ? candidate.category === 'mode' && candidate.type === 'select'
        : candidate.id === optionId,
    )
    if (typeof option?.value !== 'string') return null
    const harness = harnessOf(record.agentId)
    if (isRanked(harness)) return { id: option.value, name: modeLabel(harness, option.value).name }
    const name = option.choices?.find((choice) => choice.value === option.value)?.name
    return { id: option.value, name: name ?? option.value }
  }

  /** The latest agent message of a session's thread, from memory or the stored one. */
  async lastReply(sessionId: string): Promise<string | null> {
    const live = this.live.get(sessionId)
    if (live) {
      this.flushPatches(live)
      const { order, byId } = live.thread
      for (let i = order.length - 1; i >= 0; i--) {
        const entry = byId[order[i]!]
        if (entry?.kind === 'agent' && entry.markdown.trim() !== '') return entry.markdown
      }
      return null
    }
    const record = this.recordOf(sessionId)
    const stored = await this.readThread(record)
    if (!stored) return null
    for (let i = stored.entries.length - 1; i >= 0; i--) {
      const entry = stored.entries[i]!.entry
      if (entry.kind === 'agent' && entry.markdown.trim() !== '') return entry.markdown
    }
    return null
  }

  /** A session's agent's display name, for the notice an archive leaves. */
  agentName(sessionId: string): string {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    return record ? this.deps.agents.name(record.agentId) : ''
  }

  /** The session's agent now, null for a session Kettu does not hold. */
  sessionAgent(sessionId: string): AgentId | null {
    return (this.live.get(sessionId)?.record ?? this.records.get(sessionId))?.agentId ?? null
  }

  /** The workflow task whose step the session does; null for any other session. */
  sessionTask(sessionId: string): SessionRecord['task'] | null {
    return (this.live.get(sessionId)?.record ?? this.records.get(sessionId))?.task ?? null
  }

  /** The skills and MCP servers commands added to the session; null when none did. */
  sessionCommandTools(sessionId: string): SessionRecord['commandTools'] | null {
    return (this.live.get(sessionId)?.record ?? this.records.get(sessionId))?.commandTools ?? null
  }

  /** The folder the session works in, its worktree or its project; null for one Kettu does not hold. */
  workFolder(sessionId: string): string | null {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    if (!record) return null
    const { worktree } = record
    return worktree && worktree.path !== '' && worktree.removed === undefined
      ? worktree.path
      : record.projectPath
  }

  /** The session's agent now and that agent's own id of it, null for a session Kettu does not hold. */
  agentSession(sessionId: string): { agentId: AgentId; agentSessionId: string } | null {
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    return record ? { agentId: record.agentId, agentSessionId: record.acpSessionId } : null
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
    for (const item of all) this.dropContinue(item.id)
    delete record.pinnedAt
    record.archivedAt = this.now()
    this.saveRecord(sessionId)
    this.deps.events.ended(all.map((item) => item.id))
  }

  /**
   * Archives a session for the session that started it, which is done with it, so the reports of
   * its turns still waiting in that session's queue go too. A session that archives itself, or one
   * the user archives, still reports: its starter may be waiting for that.
   */
  async archiveStarted(sessionId: string, byAgent: string): Promise<void> {
    const starterId = this.recordOf(sessionId).startedBy
    await this.archiveByAgent(sessionId, byAgent)
    const starter = starterId ? this.live.get(starterId) : undefined
    if (!starter) return
    const { queue } = starter.thread.session
    const rest = queue.filter((item) => !item.from?.ended || item.from.sessionId !== sessionId)
    if (rest.length === queue.length) return
    this.update(starter, { queue: rest, ...(rest.length === 0 ? { queuePaused: false } : {}) })
    this.persist(starter)
    this.touch(starter.id)
  }

  /**
   * What an archive at the end of this turn would stop, named as the notice lists it: the
   * session's background work and anything its sub-sessions run. Null when nothing.
   */
  private workLeft(live: Live): string | null {
    const names: string[] = []
    for (const work of this.runningWork([live.id])) {
      const own = work.sessionId === live.id
      if (!own && (work.turn || work.waiting > 0)) names.push(work.title ?? t('session.untitled'))
      names.push(...work.commands, ...work.tasks, ...work.subagents)
      if (work.scheduled > 0) names.push(t('notice.scheduledJobs', { count: work.scheduled }))
      if (work.unnamed) names.push(t('notice.backgroundWork'))
    }
    return names.length > 0 ? names.join(t('notice.listSeparator')) : null
  }

  /** The archive an agent asked for did not happen: the turn left work running. */
  private notArchivedNotice(live: Live, byAgent: string, work: string): void {
    if (this.live.get(live.id) !== live) return
    this.emit(live, [
      {
        op: 'entry.add',
        entry: {
          kind: 'notice',
          id: this.nextId(live),
          severity: 'info',
          title: t('notice.notArchivedByAgent.title', { agent: byAgent }),
          description: t('notice.notArchivedByAgent.description', { work }),
          after: agentEntryBefore(live.thread),
        },
      },
    ])
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
   * The model and level a session the caller starts with `agentId` takes when the caller names
   * none: with the caller's agent its own, with another the ones New session remembers.
   */
  carriedOptions(callerId: string, agentId: AgentId): Record<string, string | boolean> {
    const caller = this.recordOf(callerId)
    if (agentId !== caller.agentId) return this.deps.options?.rememberedOf(agentId) ?? {}
    const options: Record<string, string | boolean> = {}
    const config = this.live.get(callerId)?.thread.session.config ?? []
    for (const option of config) {
      if (option.category !== 'model' && option.category !== 'thought_level') continue
      options[option.id] = option.value
    }
    return options
  }

  /**
   * Starts a sub-session of the caller with its first prompt and start values, as New sub-session
   * would: the caller's project and parent. Its mode is the one asked for or the start mode, never
   * wider than the caller's or than full access allows.
   */
  async startFromTool(
    callerId: string,
    params: {
      prompt: string
      title?: string
      agentId?: AgentId
      mode?: string
      options: Record<string, string | boolean>
      report: boolean
      /** A role to start as, by its reference. */
      role?: string
    },
  ): Promise<string> {
    const caller = this.recordOf(callerId)
    const agentId = params.agentId ?? caller.agentId
    const from: FromSession = {
      sessionId: callerId,
      title: this.toolName(callerId),
      ...(params.report ? {} : { report: false }),
    }
    const options = { ...params.options, ...this.startModeOf(agentId) }
    const summary = await this.create({
      agentId,
      projectPath: caller.projectPath,
      parentId: callerId,
      options,
      prompt: [{ type: 'text', text: params.prompt }],
      startedBy: callerId,
      startedMode: { starter: this.starterRank(callerId), wanted: params.mode ?? null },
      from,
      ...(params.role === undefined ? {} : { role: params.role }),
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
   * Starts a top-level session for a plugin in `projectPath`, or in a scratch folder of its own
   * when that is null. As for a session an agent starts, its mode is held to Auto at most and
   * never full access, and it is marked as started by the plugin.
   */
  async startFromPlugin(
    pluginId: string,
    params: {
      prompt: string
      projectPath: string | null
      agentId: AgentId
      mode?: string
      title?: string
    },
  ): Promise<string> {
    const summary = await this.create({
      agentId: params.agentId,
      projectPath: params.projectPath,
      prompt: [{ type: 'text', text: params.prompt }],
      startedBy: pluginStarter(pluginId),
      startedMode: { starter: null, wanted: params.mode ?? null },
      ...(params.title === undefined ? {} : { title: params.title }),
    })
    return summary.id
  }

  /** Prompts a session the plugin started, as an agent's message to one it started goes. */
  async sendFromPlugin(pluginId: string, sessionId: string, text: string): Promise<ToolDelivery> {
    if (this.recordOf(sessionId).startedBy !== pluginStarter(pluginId)) {
      throw new HostError('restricted', 'The plugin can message only the sessions it started')
    }
    return this.sendFromTool(sessionId, text, undefined, false)
  }

  /**
   * Prompts a session the caller started, or queues the prompt while that session works.
   * Unlike a message from the user, this brings an archived session back.
   */
  async sendFromTool(
    sessionId: string,
    text: string,
    from: FromSession | undefined,
    now: boolean,
  ): Promise<ToolDelivery> {
    const content: UserContent[] = [{ type: 'text', text }]
    await this.unarchive(sessionId)
    const live = await this.revive(sessionId)
    const { status, queue, queuePaused } = live.thread.session
    if (canSend(status) && (queue.length === 0 || queuePaused)) {
      this.sendPrompt(live, content, from)
      return { delivered: 'sent' }
    }
    const working = status === 'running' || status === 'awaiting_permission'
    if (!canSend(status) && !working) throw busyError(status)
    const item = { id: randomUUID(), content, at: this.now(), ...(from ? { from } : {}) }
    this.update(live, { queue: [...queue, item] })
    this.persist(live)
    this.touch(live.id)
    if (!now || !working) return { delivered: 'queued' }
    // Queued first, so a prompt that cannot go in now still goes once the turn ends.
    try {
      const delivered = await this.sendItemNow(live, item.id)
      return delivered === 'queued' ? { delivered, reason: 'its turn was ending' } : { delivered }
    } catch (error) {
      const reason = (error as Error).message
      this.deps.diagnostics.log('warn', `Could not send a session's message now: ${reason}`)
      return { delivered: 'queued', reason }
    }
  }

  /**
   * Tells the session that started this one that a turn it asked for ended: one whose first
   * message came from it without `report: false`. Not while the session closes, which the user
   * or the host chose.
   */
  private reportTurn(live: Live, turn: Turn, stopReason: StopReason | null): void {
    const starterId = live.record.startedBy
    if (!starterId || turn.entryId === null || this.stopped || live.closing) return
    const entry = live.thread.byId[turn.entryId]
    if (entry?.kind !== 'user' || entry.from?.sessionId !== starterId) return
    if (entry.from.report === false) return
    const agent = this.agentName(live.id)
    const text = reportText(agent, live.id, stopReason)
    const from: FromSession = {
      sessionId: live.id,
      title: this.toolName(live.id),
      ended: { agent, stopReason },
    }
    queueMicrotask(() => {
      void this.deliverReport(starterId, text, from).catch((error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `Could not report to session ${starterId}: ${(error as Error).message}`,
        )
      })
    })
  }

  /**
   * Sends a report as a turn when the session is idle, else at the end of its queue, which stays
   * paused if it is. An archived session gets none. Past the limit since the user's last message
   * there, the thread says so once and later reports go nowhere.
   */
  private async deliverReport(sessionId: string, text: string, from: FromSession): Promise<void> {
    if (!this.has(sessionId) || this.isArchived(this.recordOf(sessionId))) return
    const sent = this.reportsSent.get(sessionId) ?? 0
    if (sent > REPORT_LIMIT) return
    this.reportsSent.set(sessionId, sent + 1)
    const live = await this.revive(sessionId)
    if (sent === REPORT_LIMIT) {
      this.emit(live, [
        {
          op: 'entry.add',
          entry: {
            kind: 'notice',
            id: this.nextId(live),
            severity: 'info',
            title: t('notice.reportsPaused.title'),
            description: t('notice.reportsPaused.description', { count: REPORT_LIMIT }),
            after: agentEntryBefore(live.thread),
          },
        },
      ])
      this.touch(live.id)
      return
    }
    const content: UserContent[] = [{ type: 'text', text }]
    const { status, queue } = live.thread.session
    if (canSend(status) && queue.length === 0 && !this.waitsForWorktree(live)) {
      this.sendPrompt(live, content, from)
      return
    }
    this.update(live, { queue: [...queue, { id: randomUUID(), content, at: this.now(), from }] })
    this.persist(live)
    this.touch(live.id)
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
      if (next.state === 'ready') {
        this.afterBranchName(projectPath, worktree.path, () => {
          this.preparing.delete(key)
          this.markWorktree(worktree.path, (record) => {
            delete record.pending
          })
          this.releaseWorktreeWaiters(worktree.path)
        })
        return
      }
      this.preparing.set(key, next)
      for (const record of this.worktreeUsers(worktree.path)) this.touch(record.id)
    })
  }

  /** Creates a worktree and starts writing its branch name while the caller gets it ready. */
  private async createWorktree(
    projectPath: string,
    request: Parameters<WorktreeManager['create']>[1],
    first: { agentId: AgentId; options?: Record<string, string | boolean> },
    message: UserContent[] | null,
  ): Promise<WorktreeRecord> {
    const manager = this.deps.worktrees
    if (!manager) throw invalidParams(t('session.worktreeNeedsRepo'))
    const worktree = await manager.create(projectPath, request)
    if (
      message &&
      !request.branch?.trim() &&
      this.deps.settings().sessionTitles &&
      manager.settings(projectPath).waitForSetup &&
      titleMessageText(message).trim() !== ''
    ) {
      const target = lightTarget(
        this.deps.settings().lightModel,
        first.agentId,
        this.startModel(first.agentId, first.options ?? {}),
      )
      const naming = new BranchNaming(this.writeBranchSlug(target, message))
      const { type, issue } = request
      this.branchNames.set(pathKey(worktree.path, this.deps.platform), {
        naming,
        values: {
          ...(type === undefined ? {} : { type }),
          ...(issue === undefined ? {} : { issue }),
        },
      })
    }
    return worktree
  }

  /** The slug the agent's hidden session writes for a branch, or null when it writes none. */
  private async writeBranchSlug(
    target: LightTarget,
    message: UserContent[],
  ): Promise<string | null> {
    try {
      const runtime = await this.deps.agents.ensureReady(target.agentId)
      await mkdir(this.deps.reportsDir, { recursive: true })
      return await writeBranchSlug(runtime, {
        dir: this.deps.reportsDir,
        model: target.model,
        message,
        log: (line) => this.deps.diagnostics.log('warn', line),
      })
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `${this.deps.agents.name(target.agentId)}: could not name a branch: ${logText(error)}`,
      )
      return null
    }
  }

  /** The model a new session of the agent starts on with New session's picks, as cached. */
  private startModel(agentId: AgentId, picks: Record<string, string | boolean>): string | null {
    const cached = this.deps.options?.get(agentId)
    const option = cached?.config.find((o) => o.category === 'model' && o.type === 'select')
    if (!cached || !option) return null
    const value = picks[option.id] ?? cached.remembered[option.id] ?? option.value
    return typeof value === 'string' ? value : null
  }

  /**
   * Runs `release`, which sends what waited for the worktree, once its branch has the name its
   * agent wrote or keeps its own: at once when no name is being written.
   */
  private afterBranchName(projectPath: string, path: string, release: () => void): void {
    const worktree = this.branchNames.has(pathKey(path, this.deps.platform))
      ? this.worktreeUsers(path)[0]?.worktree
      : undefined
    if (!worktree) {
      release()
      return
    }
    void this.finishBranchName(projectPath, worktree).then(release)
  }

  private async finishBranchName(projectPath: string, worktree: WorktreeRecord): Promise<void> {
    const key = pathKey(worktree.path, this.deps.platform)
    const entry = this.branchNames.get(key)
    if (!entry) return
    await entry.naming.settle((slug) =>
      this.renameBranch(projectPath, worktree, { ...entry.values, slug }),
    )
    if (this.branchNames.get(key) === entry) this.branchNames.delete(key)
  }

  /** Names the worktree's branch from the slug, for every session in it; never rejects. */
  private async renameBranch(
    projectPath: string,
    worktree: WorktreeRecord,
    values: { slug: string; type?: string; issue?: string },
  ): Promise<void> {
    const manager = this.deps.worktrees
    if (!manager || worktree.removed !== undefined) return
    const { path } = worktree
    try {
      const branch = await manager.renameBranch(projectPath, { ...worktree }, values)
      if (branch === null) return
      worktree.branch = branch
      this.markWorktree(path, (record) => {
        record.branch = branch
      })
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `Could not rename the branch of the worktree ${path}: ${(error as Error).message}`,
      )
    }
  }

  private dropBranchName(path: string): void {
    const key = pathKey(path, this.deps.platform)
    this.branchNames.get(key)?.naming.drop()
    this.branchNames.delete(key)
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
      throw notFound(t('session.noWorktree'))
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
      throw notFound(t('session.noWorktreeToRemove'))
    }
    const users = this.worktreeUsers(worktree.path)
    await this.closeAll(
      users.filter((user) => this.live.has(user.id)),
      true,
    )
    manager.stop(worktree.path)
    this.dropBranchName(worktree.path)
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
    if (!worktree || worktree.removed !== undefined) throw notFound(t('session.noWorktree'))
    if (this.deps.worktrees?.isPreparing(worktree.path)) return
    this.prepareWorktree(record.projectPath, worktree)
  }

  /** Goes on without the setup command: what waited for it is sent now. */
  skipWorktreeSetup(sessionId: string): void {
    const record = this.recordOf(sessionId)
    const { worktree } = record
    if (!worktree || worktree.removed !== undefined) throw notFound(t('session.noWorktree'))
    this.deps.worktrees?.stop(worktree.path)
    this.afterBranchName(record.projectPath, worktree.path, () => {
      this.preparing.delete(pathKey(worktree.path, this.deps.platform))
      this.markWorktree(worktree.path, (item) => {
        delete item.pending
      })
      this.releaseWorktreeWaiters(worktree.path)
    })
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
  async unarchive(sessionId: string): Promise<void> {
    let record = this.recordOf(sessionId)
    if (record.archivedAt === undefined) {
      while (record.parentId !== null && this.has(record.parentId)) {
        record = this.recordOf(record.parentId)
      }
      if (record.archivedAt === undefined) return
    }
    // The sidebar lists only the projects in the list, which the user may have removed it from.
    const { projectPath } = record
    const listed = this.deps.projects
      .list()
      .some((project) => samePath(project.path, projectPath, this.deps.platform))
    if (!listed && !this.deps.scratch.contains(projectPath)) {
      await this.deps.projects.add(projectPath)
    }
    delete record.archivedAt
    this.takeBackSubSessions(record)
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
    for (const record of records) this.dropContinue(record.id)
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
    this.endSide(
      records.map((record) => record.id),
      false,
    )
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
    this.endCallsRunningOn(live)
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
    for (const item of all) {
      this.clearContinueTimer(item.id)
      this.continueRetries.delete(item.id)
    }
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
    this.endSide([sessionId], true)
    const record = this.live.get(sessionId)?.record ?? this.records.get(sessionId)
    const known = this.records.delete(sessionId) || this.lastSummaries.has(sessionId)
    this.lastSummaries.delete(sessionId)
    this.missing.delete(sessionId)
    this.watchers.delete(sessionId)
    this.seqs.delete(sessionId)
    this.idleReleased.delete(sessionId)
    this.pullRequestsTold.delete(sessionId)
    if (record?.origin === 'routine') this.deps.routine?.current?.sessionGone(sessionId)
    if (record?.origin === 'task') this.deps.task?.current?.sessionGone(sessionId)
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
    for (const item of page.sessions) this.remember(agentId, item)
    const recent = await this.outsideStates(
      agentId,
      canonical,
      page.sessions.filter((item) => this.isRecent(item.updatedAt)).map((item) => item.sessionId),
    )
    return {
      sessions: page.sessions.map((item) => {
        const state = recent.get(item.sessionId)
        return {
          acpSessionId: item.sessionId,
          title: item.title,
          updatedAt: item.updatedAt,
          imported:
            this.findByAcp(agentId, item.sessionId) !== undefined ||
            this.takenEarlier(agentId, item.sessionId),
          ...(state ? { cache: state.cache, held: state.held } : {}),
        }
      }),
      nextCursor: page.nextCursor,
    }
  }

  /** Whether a listed session changed recently enough to have a prompt cache left. */
  private isRecent(updatedAt: string | null): boolean {
    const at = updatedAt ? Date.parse(updatedAt) : NaN
    return Number.isFinite(at) && this.now() - at < OUTSIDE_WINDOW_MS
  }

  /**
   * For Claude Code sessions of `cwd`, the cache their last request left and whether a process
   * outside Kettu still has them open; nothing for another agent's.
   */
  private async outsideStates(
    agentId: AgentId,
    cwd: string,
    ids: readonly string[],
  ): Promise<Map<string, { cache: PromptCache | null; held: boolean; last: LastRequest | null }>> {
    const reader = this.deps.outside
    const states = new Map<
      string,
      { cache: PromptCache | null; held: boolean; last: LastRequest | null }
    >()
    if (!reader || harnessOf(agentId) !== 'claude-code') return states
    const configDir = this.deps.agents.runningConfig(agentId)?.chosen ?? null
    await Promise.all(
      ids.map(async (id) => {
        const [last, holder] = await Promise.all([
          reader.lastRequest(agentId, cwd, id, configDir).catch(() => null),
          reader.holder(agentId, id, configDir).catch(() => null),
        ])
        states.set(id, {
          cache: last ? { lastRequestAt: last.at, ttl: last.ttl } : null,
          held: holder !== null,
          last,
        })
      }),
    )
    return states
  }

  /** Keeps a listed session's title and time for its import. */
  private remember(agentId: AgentId, item: ListedSession): void {
    const key = `${agentId}\n${item.sessionId}`
    this.listed.delete(key)
    this.listed.set(key, { title: item.title, updatedAt: item.updatedAt })
    if (this.listed.size > LISTED_SESSIONS) {
      this.listed.delete(this.listed.keys().next().value!)
    }
  }

  async importSession(params: {
    agentId: AgentId
    projectPath: string
    acpSessionId: string
    fork?: boolean
  }): Promise<SessionSummary> {
    if (!this.deps.agents.has(params.agentId))
      throw invalidParams(t('agent.unknown', { agent: params.agentId }))
    this.deps.agents.assertEnabled(params.agentId)
    const projectPath = await this.deps.projects.resolveDirectory(params.projectPath)
    const existing = this.findByAcp(params.agentId, params.acpSessionId)
    if (existing && !params.fork) return this.summary(existing.id)
    if (this.takenEarlier(params.agentId, params.acpSessionId) && !params.fork) {
      throw new HostError('busy', t('session.alreadyInSession'))
    }
    // A fork reads the session itself and fails when it is gone.
    if (!params.fork) await this.assertListed(params.agentId, projectPath, params.acpSessionId)
    const claude = harnessOf(params.agentId) === 'claude-code'
    const configDir = this.deps.agents.runningConfig(params.agentId)?.chosen ?? null
    let acpSessionId = params.acpSessionId
    if (params.fork) {
      const runtime = await this.deps.agents.ensureReady(params.agentId)
      if (!runtime.connection.copySession) {
        throw new HostError(
          'agent_unavailable',
          t('session.cannotFork', { agent: this.deps.agents.name(params.agentId) }),
        )
      }
      try {
        acpSessionId = await runtime.connection.copySession(params.acpSessionId, projectPath)
      } catch (error) {
        throw agentError(error)
      }
    } else if (claude) {
      await this.refuseHeld(params.agentId, acpSessionId, configDir)
    }
    // Read from the original: a copy has its history but not its settings rows.
    const last = claude
      ? await this.deps.outside
          ?.lastRequest(params.agentId, projectPath, params.acpSessionId, configDir)
          .catch(() => null)
      : null
    await this.deps.projects.add(projectPath)
    const listed = this.listed.get(`${params.agentId}\n${params.acpSessionId}`)
    const now = this.now()
    const updatedAt = listed?.updatedAt ? Date.parse(listed.updatedAt) : NaN
    const outside = last ? outsideValuesOf(last) : null
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: params.agentId,
      acpSessionId,
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
      ...(last ? { cache: { lastRequestAt: last.at, ttl: last.ttl } } : {}),
      ...(outside ? { outside } : {}),
      // Claude Code keeps the instructions it recorded outside Kettu, which have nothing of Kettu's.
      ...(claude ? { instructionsAhead: true as const } : {}),
    }
    this.stampConfig(record)
    this.records.set(record.id, record)
    this.saveIndex()
    this.writeIndexNow()
    this.touch(record.id)
    return this.summary(record.id)
  }

  /** Fails unless the agent lists the session for the folder, reading every page it gives. */
  private async assertListed(
    agentId: AgentId,
    projectPath: string,
    acpSessionId: string,
  ): Promise<void> {
    const runtime = await this.deps.agents.ensureReady(agentId)
    if (!runtime.init.capabilities.listSessions) {
      throw new HostError(
        'agent_unavailable',
        t('session.cannotList', { agent: this.deps.agents.name(agentId) }),
      )
    }
    const asked = new Set<string | null>()
    let cursor: string | null = null
    try {
      // A cursor the agent gives twice would never end.
      while (!asked.has(cursor)) {
        asked.add(cursor)
        const page = await runtime.connection.listSessions(projectPath, cursor)
        if (page.sessions.some((item) => item.sessionId === acpSessionId)) return
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
    } catch (error) {
      throw agentError(error)
    }
    throw notFound(t('session.notInAgent', { agent: this.deps.agents.name(agentId) }))
  }

  /**
   * Refuses a Claude Code session that a process outside Kettu, as in a terminal, has open: two
   * processes writing one transcript tangle it.
   */
  private async refuseHeld(
    agentId: AgentId,
    acpSessionId: string,
    configDir: string | null,
  ): Promise<void> {
    if (!this.deps.outside || acpSessionId === '' || harnessOf(agentId) !== 'claude-code') return
    const holder = await this.deps.outside
      .holder(agentId, acpSessionId, configDir)
      .catch(() => null)
    if (holder) throw new HostError('busy', t('session.heldOutside'))
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
      this.tellPullRequests(live.id, added)
    }
  }

  /**
   * Tells the plugins of a pull request of the session that was opened in it, or whose state or
   * checks changed since they were last told. One read for the first time is only noted: it is
   * not a change.
   */
  private tellPullRequests(sessionId: string, opened: readonly string[] = []): void {
    const live = this.live.get(sessionId)
    const record = live?.record ?? this.records.get(sessionId)
    if (
      !record ||
      record.origin !== 'user' ||
      !this.deps.plugins?.wants('session.pullRequestChanged')
    ) {
      return
    }
    const told = this.pullRequestsTold.get(sessionId) ?? new Map<string, string>()
    this.pullRequestsTold.set(sessionId, told)
    const summary = this.summary(sessionId)
    for (const pr of summary.prs ?? []) {
      const now = `${pr.state ?? ''} ${pr.failing}`
      const before = told.get(pr.url)
      told.set(pr.url, now)
      if (before === now || (before === undefined && !opened.includes(pr.url))) continue
      const [state = '', failing = 'false'] = before?.split(' ') ?? []
      this.deps.plugins.emit('session.pullRequestChanged', summary, {
        pullRequest: {
          url: pr.url,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          state: pr.state,
          failing: pr.failing,
        },
        previous:
          before === undefined
            ? null
            : { state: state === '' ? null : state, failing: failing === 'true' },
      })
    }
  }

  /** Pull requests changed for a project's branches: its rows may show a new badge. */
  pullRequestsChanged(projectPath: string): void {
    for (const summary of this.list(projectPath)) {
      this.touch(summary.id)
      this.tellPullRequests(summary.id)
    }
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
      if (ofBranch || record.pullRequests?.includes(url)) {
        this.touch(id)
        this.tellPullRequests(id)
      }
    }
  }

  // For main.

  /** The sessions quitting would stop: a turn runs or waits, or work runs beside one. */
  busy(): BusySession[] {
    const out: BusySession[] = []
    for (const live of this.live.values()) {
      const status = live.thread.session.status
      const turn = status === 'running' || status === 'awaiting_permission'
      // A subagent's work counts with the session that started it.
      const background = live.record.origin === 'subagent' ? null : this.backgroundWork(live)
      if (turn || background) {
        out.push({
          sessionId: live.id,
          agentId: live.record.agentId,
          title: live.thread.session.title,
          turnStartedAt: turn ? live.thread.session.turnStartedAt : null,
          background,
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
    for (const timer of this.continues.values()) clearTimeout(timer)
    this.continues.clear()
    this.continueRetries.clear()
    if (this.followTimer) clearInterval(this.followTimer)
    this.followTimer = null
    this.stopped = true
  }
}

/** A new session or fork deleted, or its project removed, while it started. */
function removedWhileStarting(): HostError {
  return new HostError('not_found', t('session.removedWhileStarting'), {
    reason: REMOVED_WHILE_STARTING,
  })
}

function opensWithCommand(wire: readonly PromptBlock[]): boolean {
  const first = wire[0]
  return first?.type === 'text' && first.text.startsWith('/')
}

/** Whether the patch, applied to `thread`, completes a compaction of the agent's context. */
function compacted(thread: Pick<ThreadState, 'byId'>, patch: Patch): boolean {
  if (patch.op === 'entry.add') {
    return patch.entry.kind === 'compaction' && patch.entry.status === 'completed'
  }
  return (
    patch.op === 'entry.update' &&
    thread.byId[patch.id]?.kind === 'compaction' &&
    'status' in patch.changes &&
    patch.changes.status === 'completed'
  )
}

/** Whether a session in this status takes a prompt: an attached one that is free, or one to attach. */
function canSend(status: SessionStatus): boolean {
  return status === 'ready' || status === 'closed'
}

/** The entries of the tool calls whose commands the session lists as running on past their turn. */
function callsRunningOn(session: SessionView): Set<string> {
  const ids = new Set<string>()
  for (const task of session.background ?? []) {
    if (task.status === 'running' && task.entryId !== undefined) ids.add(task.entryId)
  }
  return ids
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
/** The stored side chat on a view that has one; its route follows the session's agent. */
function storedSide(
  view: SessionView,
  stored: StoredSideChat | null,
): Pick<SessionView, 'sideChat'> {
  if (!view.sideChat || !stored) return {}
  return {
    sideChat: { ...view.sideChat, answerAgent: stored.answerAgent, entries: stored.entries },
  }
}

// An agent in one of these needs the user before it can answer anything.
const UNUSABLE_STATES: ReadonlySet<AgentStatus['state']> = new Set([
  'not-installed',
  'node-missing',
  'node-outdated',
])

/** What a command and a role each added, as one list; null when neither added any. */
function joinNeeds(a: CommandNeeds | null | undefined, b: CommandNeeds | null | undefined) {
  const skills = [...new Set([...(a?.skills ?? []), ...(b?.skills ?? [])])]
  const mcp = [...new Set([...(a?.mcp ?? []), ...(b?.mcp ?? [])])]
  return skills.length + mcp.length > 0 ? { skills, mcp } : null
}

function sessionRole(role: FoundRole): SessionRole {
  return { name: role.ref, title: role.title, instructions: role.instructions }
}

/** Kettu's guide, marked as such, then its memory and a role's block; null when there is none. */
function kettuAhead(
  guide: string | null,
  memory: string | null,
  role: string | null = null,
): string | null {
  const parts = [guide ? `<kettu-guide>\n${guide}\n</kettu-guide>` : null, memory, role].filter(
    (part): part is string => part !== null,
  )
  return parts.length > 0 ? parts.join('\n\n') : null
}

const cutAnswer = (text: string): string =>
  text.length > SIDE_ANSWER_CHARS ? text.slice(0, SIDE_ANSWER_CHARS) : text

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
    case 'antigravity':
      return AGY_MODE_OPTION
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
