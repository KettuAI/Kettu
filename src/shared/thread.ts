// Kettu's own session and thread model, shared by the agent host and the renderer.
// It never imports ACP types; only the mapper in src/agent-host/acp/ does.

import { isAgentId, type AgentId } from './agents'
import type { LastRequest } from './model-requests'
import type { BrowserOriginAnswer } from './browser'
import {
  isControlOutcome,
  isControlStep,
  isControlSurface,
  type ControlOutcome,
  type ControlStep,
  type ControlSurface,
  type SurfaceAccessAnswer,
} from './control'
import type { DeviceAccessAnswer } from './device-agent'
import type {
  ComputerAct,
  ComputerAppAnswer,
  ComputerControl,
  ComputerSetupOutcome,
  ComputerSetupStep,
} from './computer-use'
import { isComputerSetupStep } from './computer-use'
import type { ContextReport } from './context'
import type { OutputSpeed } from './output-speed'
import type {
  ListingVisibility,
  MarketProblem,
  PublishAdds,
  PublishHarness,
  PublishKind,
} from './market-publish'
import type { MemoryAction, MemoryDraft, MemoryLayer, MemoryWriteStatus } from './memory'
import type { PluginConversion } from './plugin-convert'
import type { RoutineRef } from './routines'
import type { SettingScalar, SettingsSection } from './settings-catalog'
import type { TaskDeliverable, Workflow } from './workflow'

export {
  AUTO_AGENT_HARNESSES,
  HARNESS_IDS,
  MULTI_AGENT_HARNESSES,
  addedAgentId,
  harnessOf,
  isAgentId,
  isDefaultAgent,
  isHarnessId,
  sortAgentIds,
  type AgentId,
  type HarnessId,
} from './agents'

export type SessionStatus =
  | 'starting' // agent starting, or session/new, load or resume in flight
  | 'auth_required'
  | 'ready'
  | 'running' // a prompt turn is in progress
  | 'awaiting_permission' // running, with at least one unanswered permission request
  | 'failed' // could not start or recover; needs user action
  | 'closed'

export interface SessionView {
  id: string // Kettu id; ACP ids are only unique per agent
  agentId: AgentId
  projectPath: string // canonical absolute path
  acpSessionId: string | null
  status: SessionStatus
  title: string | null
  config: ConfigOption[]
  commands: SlashCommand[]
  usage: SessionUsage | null
  /** Ephemeral context snapshot; absent on hosts that only answer context requests. */
  context?: ContextReport
  error: { message: string; detail?: string } | null
  turnStartedAt: number | null
  turnStartUsed: number | null // usage.used when the running turn started, for what it adds
  createdAt: number
  updatedAt: number
  parentId: string | null // the parent session, for sub-sessions
  origin: 'user' | 'subagent' | 'routine' | 'task'
  subagent: SubagentInfo | null // set when origin is 'subagent'
  routine: RoutineRef | null // set when origin is 'routine'
  queue: QueuedPrompt[] // prompts waiting for the running turn to end, oldest first
  queuePaused: boolean // after Stop, a failed turn or a restart, until the user resumes it
  /** Ephemeral: set while the session holds the computer, with the app it last used. */
  computer?: ComputerUseView | null
  /**
   * Ephemeral: the commands and monitors the agent left running, and those that ended since,
   * oldest first. Absent for an agent that reports none.
   */
  background?: BackgroundTaskView[]
  /** Ephemeral: how fast the model writes, for an agent whose stream times its requests. */
  speed?: OutputSpeed
  /** Ephemeral: the main thread's latest request, for an agent whose stream counts its tokens. */
  lastRequest?: LastRequest
  /**
   * Ephemeral: the agent's guess at the user's next message after a turn, which the empty
   * composer offers; null once the next turn starts.
   */
  suggestion?: string | null
  /** Questions asked beside the session, never part of its conversation. Absent for subagents. */
  sideChat?: SideChatView
  /** Ephemeral: a program outside Kettu, such as a terminal, has the agent's session open. */
  heldOutside?: boolean
  /** Set while an edit from a message holds the turns from it aside, until the next send. */
  rewound?: RewoundView | null
  /** The agent said this conversation cannot be cut, as a Codex thread of the older format. */
  noRewind?: boolean
}

export interface RewoundView {
  /** The turns set aside, which Put back brings back. */
  turns: number
}

/**
 * How a session's side questions are answered: Claude Code's own side question, which sees the
 * whole conversation with the running turn; an ephemeral fork of the Codex thread through its last
 * finished turn; a hidden session of the same agent given carried context; or, for an agent whose
 * hidden sessions are not removed cleanly, a hidden session of another agent the user picks.
 */
export type SideChatRoute = 'claude' | 'codex' | 'fork' | 'hidden' | 'none'

export interface SideChatView {
  route: SideChatRoute
  /** The agent the user picked to answer for a session whose route is `none`. */
  answerAgent: AgentId | null
  entries: SideChatEntry[]
}

export interface SideChatEntry {
  id: string
  question: string
  /** A passage of a reply the question is about. */
  quote: string | null
  /** The agent that answers it, which is another one for a session whose route is `none`. */
  agentId: AgentId
  route: Exclude<SideChatRoute, 'none'>
  status: 'answering' | 'answered' | 'failed' | 'stopped'
  /** Markdown; grows while a streamed answer arrives. */
  answer: string
  /** What a read-only answer looked at first. */
  steps: SideChatStep[]
  /** What the answer saw of the conversation, and how it got it. */
  saw: SideChatSaw | null
  error: string | null
  askedAt: number
  answeredAt: number | null
}

export interface SideChatStep {
  kind: 'read' | 'search' | 'run' | 'other'
  title: string
}

/**
 * Where a side question's answer got the conversation: the agent's own side question, the agent's
 * fork of the session, or a text copy Kettu built.
 */
export interface SideChatSaw {
  source: 'agent' | 'fork' | 'copy'
  /** The turns the agent's compaction folded into a summary, which are not in what it saw. */
  compacted: number
  /** For a copy: its turns of the conversation's, whether the first request stands apart, its size. */
  copy: { turns: number; total: number; first: boolean; bytes: number } | null
  /** The route tried first, when the answer fell back from it to another. */
  fellBackFrom: 'claude' | 'codex' | 'fork' | null
}

/** A command or monitor an agent runs beside its turn, as the session board lists it. */
export interface BackgroundTaskView {
  id: string
  kind: 'shell' | 'monitor' | 'workflow' | 'other'
  /** What the agent said it does, or its command. */
  title: string
  /** The shell command, for a command task whose tool call is known. */
  command?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number | null
  /** How it ended, as the agent reported it; null while it runs. */
  summary: string | null
  /**
   * Set for a command that runs on in its own tool call: that call's entry, which stays running
   * while it does. Kettu can neither stop it nor read its output before the call ends.
   */
  entryId?: string
}

/** A session's hold on the computer, which the label on its composer shows. */
export interface ComputerUseView {
  /** The name of the app it last read or drove; null before its first. */
  app: string | null
  /** Where that app lies, for its icon: the bundle on macOS, the executable elsewhere. */
  appPath?: string | null
  /** Whether its latest call to that app only read the window or acted on it. */
  action?: 'read' | 'act' | null
  /** The agent, or the user once they took the app over: the agent's calls then wait. */
  control?: ComputerControl
  /** The window it last read or drove, for the Computer pane; null before its first. */
  window?: { id: number; title: string | null } | null
  /** Its latest action in that window, where the pane draws its pointer. */
  act?: ComputerAct | null
}

export interface QueuedPrompt {
  id: string
  content: UserContent[]
  at: number
  /** Set for a prompt another session's agent sent: whose it is, for its label. */
  from?: FromSession
  /** Set for a prompt a paired device queued. */
  device?: FromDevice
  /** Set for a message Kettu sends as the answer a card already shows, such as a plan's approval. */
  approval?: true
  /** Set for a message Kettu itself wrote to the agent, such as a workflow step's reminder. */
  kettu?: true
  /** Set for a message built from comments on passages, for its row in the queue. */
  comments?: QueuedComments
}

/** How a message of comments reads in the queue: how many, and the text or else the first one. */
export interface QueuedComments {
  count: number
  text: string
}

/** The most characters of a queued message's comment summary. */
export const QUEUED_COMMENTS_TEXT = 500

export function isQueuedComments(value: unknown): value is QueuedComments {
  if (typeof value !== 'object' || value === null) return false
  const { count, text } = value as Record<string, unknown>
  return (
    typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    typeof text === 'string' &&
    text.length > 0 &&
    text.length <= QUEUED_COMMENTS_TEXT
  )
}

/** The session that started or messaged another one through the session tools. */
export interface FromSession {
  sessionId: string
  title: string
  /** The sender asked not to be told when the turn this message begins ends. */
  report?: false
  /**
   * Set on Kettu's report of a turn the receiver asked this session for: the agent's name and how
   * the turn ended, null for a failure. The thread draws it from these, not from the message text.
   */
  ended?: { agent: string; stopReason: StopReason | null }
}

/** The paired device a message or answer came from, under the name the host lists it by. */
export interface FromDevice {
  id: string
  name: string
}

export interface SessionUsage {
  used: number // tokens in the context window now
  size: number // the context window
  cost: { amount: number; currency: string } | null
  tokens: TokenTotals | null // session totals, when the agent reports them
  cache?: PromptCache // the main thread's prompt cache, from its first request on
}

export interface PromptCache {
  lastRequestAt: number // when Kettu saw the main thread's latest request
  ttl: number | null // ms the cache lasts, when the agent's own transcript says
}

export interface TokenTotals {
  total: number
  /** Input neither read from nor written to the cache, which `cacheRead` and `cacheWrite` count. */
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
  /** The model id of the child's latest request, which can differ from its parent's model. */
  model?: string
}

export interface ConfigOption {
  id: string
  name: string
  description?: string
  category: 'mode' | 'model' | 'model_config' | 'thought_level' | 'other'
  type: 'select' | 'boolean'
  value: string | boolean
  choices?: {
    value: string
    name: string
    description?: string
    group?: string
    /** An earlier version the agent still offers, which menus fold under More models. */
    older?: true
    /** The value of the choice this one is shown as, the same model under another name. */
    shownAs?: string
    /** The model id the choice stands for, as Claude Code's settings key models. */
    modelId?: string
  }[]
  idleOnly?: boolean // can change only while no turn runs
  /** A boolean's inherited value; null until the agent has resolved its settings. */
  defaultValue?: boolean | null
  /** Show the option's name beside the model while it is enabled. */
  indicator?: boolean
}

export function booleanConfigValue(option: ConfigOption): boolean | undefined {
  return typeof option.value === 'boolean'
    ? option.value
    : option.value === 'default'
      ? (option.defaultValue ?? undefined)
      : undefined
}

export function isConfigValue(option: ConfigOption, value: string | boolean): boolean {
  if (option.type === 'boolean') {
    return typeof value === 'boolean' || (value === 'default' && 'defaultValue' in option)
  }
  return typeof value === 'string' && !!option.choices?.some((choice) => choice.value === value)
}

/**
 * A command of more than one step, or too long for one line: a card shows it in full below its
 * header, and a notification, which shows one line, does not offer to allow it.
 */
export function previewsCommand(command: string): boolean {
  return command.length > 60 || /&&|\|\||[;|\n]/.test(command)
}

export interface SlashCommand {
  name: string
  description: string
  inputHint?: string
  /** Set on Kettu's own commands; an agent's carry none. */
  source?: CommandSource
}

/**
 * Where a command Kettu keeps in a file comes from: a plugin, whose `name` qualifies its commands
 * as `name:command`, or the user's own folder.
 */
export type CommandOrigin =
  { kind: 'plugin'; id: string; name: string; title: string } | { kind: 'user' }

/** What qualifies a command's name where two share it: `name:command`. */
export function commandQualifier(origin: CommandOrigin): string {
  return origin.kind === 'plugin' ? origin.name : 'user'
}

/** Where a command in the slash list comes from; `kettu` is one the app itself provides. */
export type CommandSource = CommandOrigin | { kind: 'kettu' }

/** A command of Kettu's as the host expanded it: the message the agent got in its place. */
export interface CommandRun {
  /** The command's own name, without any plugin before it. */
  name: string
  origin: CommandOrigin
  sent: string
}

export type ThreadEntry =
  // `at`: when the message was sent or began, for live messages only; a replay carries no times.
  // `steered`: sent into a running turn rather than as a turn of its own.
  | {
      kind: 'user'
      id: string
      content: UserContent[]
      at?: number
      steered?: boolean
      /** Set for a prompt another session's agent sent. */
      from?: FromSession
      /** Set for a message a paired device sent; the host's own windows send none. */
      device?: FromDevice
      /**
       * Set for a message Kettu sent as the answer a card already shows, such as a plan's approval:
       * the agent got it, but it is no bubble and no message of the user's own.
       */
      approval?: true
      /**
       * Set for a message Kettu itself wrote to the agent, such as a workflow step's prompt or
       * reminder: drawn as Kettu's, never as the user's own.
       */
      kettu?: true
      /**
       * The agent's own id for the prompt that started the turn, Claude Code's message uuid or
       * Codex's turn id, which an edit from this message cuts the agent's session at.
       */
      agentRef?: string
      /** What plugins attached to the message before it went to the agent; the text stays as written. */
      attached?: PluginAttached[]
    }
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
  // A session the agent started through the session tools, kept across a replay as an artifact's entry is.
  | { kind: 'session_started'; id: string; sessionId: string; after: string | null }
  | { kind: 'session_message'; id: string; senderId: string | null; content: UserContent[] }
  | { kind: 'plan'; id: string; items: PlanItem[] }
  | {
      kind: 'notice'
      id: string
      severity: 'info' | 'warning' | 'error'
      title: string
      description?: string
      // The notice ends the turn: the agent exited mid-turn, its model provider is out of credit,
      // or the turn of a message failed otherwise.
      cause?: 'agent_stopped' | 'out_of_credit' | 'turn_failed'
      model?: string // out_of_credit: the session's model when the turn failed
      // The agent's entry before it, to put it back after a replay: set on the notices Kettu
      // adds itself, never on an agent's, which its replay sends again.
      after?: string | null
    }
  | {
      kind: 'compaction'
      id: string
      status: 'in_progress' | 'completed' | 'failed' | 'cancelled'
      summary: string
    }
  | {
      kind: 'turn_end'
      id: string
      stopReason: StopReason
      durationMs: number
      after?: string | null // the agent's entry before it, to put it back after a replay
      used?: number // the context in tokens as the turn ended, which an edit after it goes back to
    }
  | TakeoverEntry // Kettu's own record of another agent taking the session over
  | GitEntry // Kettu's own observation of the repository, see the git design
  | ArtifactEntry // Kettu's own record of a write to the artifacts service
  | BrowserOriginEntry // Kettu's own record of a new site's request and answer
  | ControlAskEntry // Kettu's own record of a step an agent asked the user to do, and its end
  | ControlNoteEntry // Kettu's own record of the user taking a surface over and handing it back
  | DeviceAccessEntry // Kettu's own record of an agent asking for a mobile device
  | SurfaceAccessEntry // Kettu's own record of an agent asking for a terminal the user opened
  | ComputerAppEntry // Kettu's own record of a session's first use of an app, and the answer
  | ComputerSetupEntry // Kettu's own record of the setup a first call waited on, and its end
  | ProjectMcpEntry // Kettu's own record of a folder's MCP servers held for the user, and the answer
  | ProjectHooksEntry // Kettu's own record of a folder's hooks held for the user, and the answer
  | ProblemReportEntry // Kettu's own record of a problem report an agent drafted, and its outcome
  | MemoryWriteEntry // Kettu's own record of an agent's write to Kettu's memory, and its answer
  | MarketPublishEntry // Kettu's own record of a publish to the Kettu Marketplace, and its outcome
  | SettingsChangeEntry // Kettu's own record of an agent's change to Kettu's settings, and its answer
  | TaskDeliveryEntry // Kettu's own record of a task this session started ending, and what it delivered
  | PluginDenialEntry // Kettu's own record of a plugin denying a permission request

/** What one plugin attached to a message before it was sent. */
export interface PluginAttached {
  pluginId: string
  /** The plugin's title. */
  plugin: string
  /**
   * `failed` says why a mentioned item could not be added (`text` is then empty): the plugin did
   * not answer in time, was unavailable, or answered with what was not content.
   */
  items: { title?: string; text: string; failed?: string }[]
}

/**
 * A plugin denied a permission request, which the agent was told. `request` is the command, or the
 * tool's title for any other request; `after`: the agent's entry before it, for a replay.
 */
export interface PluginDenialEntry {
  kind: 'plugin_denial'
  id: string
  pluginId: string
  plugin: string
  request: string
  reason: string
  after: string | null
}

/**
 * Where another agent took the session over: from here on its turns are that agent's. `turns` of
 * the earlier ones went to it in `carried`, as it was given them, and `omitted` were left out for
 * it to read with the history tool. `after`: the agent's entry before it, for a replay.
 */
export interface TakeoverEntry {
  kind: 'takeover'
  id: string
  agentId: AgentId
  turns: number
  omitted: number
  carried: string
  /** The agent was asked to summarize the earlier conversation before carrying on. */
  summarize?: boolean
  after: string | null
}

/** `after`: the agent's entry before it, to put it back after a replay; older entries lack it. */
export type GitEntry =
  | {
      kind: 'git'
      id: string
      event: 'commit'
      commits: { oid: string; subject: string }[]
      more: number
      after?: string | null
    }
  | {
      kind: 'git'
      id: string
      event: 'push'
      upstream: string
      count: number
      after?: string | null
    }
  | { kind: 'git'; id: string; event: 'branch'; branch: string; after?: string | null }
  | { kind: 'git'; id: string; event: 'pull_request'; url: string; after?: string | null }

/**
 * A write to the artifacts service, added by the host to the calling session's thread. Writes to
 * one artifact in one turn share an entry; a deletion stands alone.
 */
export interface ArtifactEntry {
  kind: 'artifact'
  id: string
  artifactId: string
  /** As of the latest write it records. */
  title: string
  /** The first write of its turn. */
  action: ArtifactAction
  /** The latest version written in its turn; null for a deletion. */
  version: number | null
  /** How many writes of its turn it records. */
  writes: number
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

export type ArtifactAction = 'create' | 'update' | 'restore' | 'delete'

/**
 * An agent's page asked to open a new site. `decision` is null while it waits for the user, then
 * the answer they gave, `timeout` when none came.
 */
export interface BrowserOriginEntry {
  kind: 'browser_origin'
  id: string
  /** The id the asking page's main gave the request, which its pane's bar answers too. */
  requestId: number
  origin: string
  decision: BrowserOriginAnswer | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/**
 * An agent asked the user to do a step on a surface it uses that only a person can do: sign in,
 * enter a code, pass a check. `outcome` is null while it waits, then Done or Skip, or `ended` when
 * the turn ended first.
 */
export interface ControlAskEntry {
  kind: 'control_ask'
  id: string
  surface: ControlSurface
  step: ControlStep
  /** Where: the page's site, a device's name; null when the host did not know it. */
  target: string | null
  /** The agent's words for why. */
  reason: string
  outcome: ControlOutcome | 'ended' | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/**
 * The user took a surface over during the turn: `handed_back` once they handed it back after
 * `durationMs`; `paused` when their own click or key in `app`, the app the agent used, took it.
 */
export type ControlNoteEntry = {
  kind: 'control_note'
  id: string
  surface: ControlSurface
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
} & (
  | { event: 'handed_back'; durationMs: number }
  | { event: 'paused'; app: string }
  /** The agent started using a terminal the user opened, which Full access lets it without asking. */
  | { event: 'used'; name: string }
)

/**
 * An agent asked to read or operate a mobile device for the first time in its session. `decision`
 * is null while it waits for the user, then the answer, `timeout` when none came.
 */
export interface DeviceAccessEntry {
  kind: 'device_access'
  id: string
  deviceId: string
  deviceName: string
  decision: DeviceAccessAnswer | null
  /** When an unanswered request counts as denied, in the host's milliseconds. */
  expiresAt?: number
  /** The user took the session's allow back, so the agent's next use of the device asks again. */
  revoked?: true
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/**
 * An agent asked to use a terminal the user opened in its session. `decision` is null while it
 * waits for the user, then the answer, `timeout` when none came.
 */
export interface SurfaceAccessEntry {
  kind: 'surface_access'
  id: string
  surface: 'terminal' | 'browser'
  /** The terminal's or the browser tab's id, and its name or page title when the agent asked. */
  targetId: string
  targetName: string
  /** The session planned when it asked, so the agent would only read it. */
  readOnly?: true
  /** The user let agents type passwords when it asked, so the terminal's are not theirs alone. */
  passwords?: true
  /** It asked to give the terminal this name, which an allow does this once, and nothing else. */
  rename?: string
  decision: SurfaceAccessAnswer | null
  /** When an unanswered request counts as denied, in the host's milliseconds. */
  expiresAt?: number
  /** The user took the allow back, so the agent's next use asks again. */
  revoked?: true
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/**
 * An agent asked to read or drive a desktop app for the first time in the session. `decision` is
 * null while it waits for the user, then the answer they gave, `timeout` when none came.
 */
export interface ComputerAppEntry {
  kind: 'computer_app'
  id: string
  /** The host's id for the request, which the card's answer names. */
  requestId: number
  /** The app's identity, which an Always allow is kept under, and its name. */
  appId: string
  appName: string
  decision: ComputerAppAnswer | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/**
 * An agent's call found computer use off or a macOS permission missing, and waits while the user
 * sets it up. `outcome` is null while it waits, then how it ended.
 */
export interface ComputerSetupEntry {
  kind: 'computer_setup'
  id: string
  /** The host's id for the setup, which Not now names. */
  requestId: number
  /** The steps missing when the call came, in the order the card explains them. */
  steps: ComputerSetupStep[]
  /** Those done since. */
  done: ComputerSetupStep[]
  outcome: ComputerSetupOutcome | null
  /** Set when a paired device said Not now; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/** Which of a folder's own MCP servers the user lets start: these, every one of the folder's, none. */
export type ProjectMcpDecision = 'use' | 'all' | 'skip'

/** `timeout` when the session left memory before an answer came. */
export type ProjectMcpAnswer = ProjectMcpDecision | 'timeout'

/** A server a folder's own MCP config declares: its name and the command or URL it runs on. */
export interface DeclaredMcpServer {
  name: string
  target: string
}

/**
 * The folder's own MCP config declares servers the user has not answered for, which the agent does
 * not start until they do. `decision` is null while it waits, then the answer, `timeout` when none
 * came.
 */
export interface ProjectMcpEntry {
  kind: 'project_mcp'
  id: string
  servers: DeclaredMcpServer[]
  decision: ProjectMcpAnswer | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/**
 * Whether a folder's own Claude Code hooks may run: these ones (a changed or added hook asks
 * again), every one of the folder's, later ones too, or none.
 */
export type ProjectHooksDecision = 'use' | 'all' | 'skip'

/** `timeout` when the session left memory before an answer came. */
export type ProjectHooksAnswer = ProjectHooksDecision | 'timeout'

/** A hook a folder's own settings declare: the event it runs on and the command or URL it runs. */
export interface DeclaredHook {
  event: string
  target: string
}

/**
 * The folder's own settings declare hooks the user has not allowed, which the agent does not run
 * until they do. `decision` is null while it waits, then the answer, `timeout` when none came.
 */
export interface ProjectHooksEntry {
  kind: 'project_hooks'
  id: string
  hooks: DeclaredHook[]
  decision: ProjectHooksAnswer | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/** What became of a drafted problem report: submitted with its id, saved as a zip, or not sent. */
export type ProblemReportOutcome =
  { kind: 'sent'; reportId: string } | { kind: 'saved' } | { kind: 'skipped' }

/**
 * A problem report the agent drafted for Kettu, which waits for the user to send it: nothing leaves
 * the computer before they do. `outcome` is null until they answer.
 */
export interface ProblemReportEntry {
  kind: 'problem_report'
  id: string
  title: string
  details: string
  error: string | null
  /** When the agent drafted it, in Unix milliseconds, for the daily limit. */
  at: number
  outcome: ProblemReportOutcome | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/** A file of a new version against the current one; lines are null where they were not counted. */
export interface MarketPublishChange {
  path: string
  status: 'added' | 'changed' | 'removed'
  added: number | null
  removed: number | null
}

/**
 * What became of a publish or an unlisting: on its way after the user's answer, done, refused by
 * the service, or not done: Not now, no answer within the wait, the turn ending first, or Kettu
 * stopping before the service answered. A publish not done is kept as a draft.
 */
export type MarketPublishOutcome =
  | { kind: 'publishing' | 'unlisting' }
  // `held`: the service stored the version and lists it only after a review.
  | { kind: 'published'; listingId: string; handle: string; version: string; held?: true }
  | { kind: 'unlisted' }
  | { kind: 'failed'; message: string; problems: MarketProblem[] }
  | { kind: 'later' | 'expired' | 'ended' | 'interrupted' }

/**
 * An agent asked to publish a folder to the Kettu Marketplace, as a new listing or a new version
 * of one, or to unlist one; nothing goes to the service before the user answers. `outcome` is null
 * while it waits.
 */
export interface MarketPublishEntry {
  kind: 'market_publish'
  id: string
  action: 'publish' | 'unlist'
  item: {
    name: string
    slug: string
    kind: PublishKind
    harness: PublishHarness | null
    description: string
  }
  /** The listing it is a new version of, or the one to unlist; null for a new listing. */
  listingId: string | null
  /** The version to publish, and the listing's current one before it. */
  version: string | null
  previous: string | null
  /** How many people have the listing. */
  installs: number
  /** Who sees it: proposed for a new listing, the listing's own for the others. */
  visibility: ListingVisibility
  /** The agent's notes for the version; once answered, the ones the user sent. */
  notes: string | null
  adds: PublishAdds[]
  /** What the install runs: commands and servers' command lines or URLs. */
  runs: string[]
  /** The file Kettu read what it is from, such as `SKILL.md`. */
  manifest: string | null
  /** Where the folder is, from the session's folder or with `~` for the home folder. */
  folder: string
  files: { path: string; size: number }[]
  bytes: number
  /** A new version's files against the current one; null when they could not be compared. */
  changes: MarketPublishChange[] | null
  /** The publisher name a first publish suggests; null once the account has one. */
  publisher: { suggested: string } | null
  /** A workflow's flowchart, as its `workflow.yaml` reads; absent for the other kinds. */
  workflow?: Workflow
  /**
   * A Kettu plugin's script, if it has one, with the permissions it declares, and what an install
   * would leave out of the package; absent for the other kinds.
   */
  plugin?: {
    script: { entry: string; api: number } | null
    permissions: string[]
    notes: string[]
  }
  /** A plugin Kettu made from a Claude Code or Codex plugin: what came over and what did not. */
  converted?: PluginConversion
  /**
   * The task whose workflow this generalizes, when its agent says so: whether the steps and arrows
   * stayed, the agent's sentence on what it changed, and both files to compare.
   */
  fromTask?: {
    taskId: string
    title: string
    sameFlow: boolean
    changes: string | null
    before: string
    after: string
  }
  /** When an unanswered card counts as put off, in the host's milliseconds. */
  expiresAt: number
  outcome: MarketPublishOutcome | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/**
 * A task started from this session's suggestion card ended: what it delivered, as it stood then.
 * It waits for no answer. `written` names the agent that wrote the task's workflow for it, which
 * offers Save and Publish once the task is done; `publishAsked` is when the user last asked the
 * session's agent to publish that workflow.
 */
export interface TaskDeliveryEntry {
  kind: 'task_delivery'
  id: string
  taskId: string
  title: string
  status: 'done' | 'dropped' | 'cancelled'
  /** The steps that ran, and how long the task took from its start. */
  steps: number
  durationMs: number
  deliverables: TaskDeliverable[]
  written: { agentId: AgentId } | null
  publishAsked?: number
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/** One row an agent's change sets, as its card and line show it, in the host's words when asked. */
export interface SettingChangeItem {
  /** The row as the settings tools name it, such as `appearance.color-mode`. */
  id: string
  /** Its section and group, as "Appearance › Theme", then its name. */
  place: string
  name: string
  from: { value: SettingScalar; text: string }
  to: { value: SettingScalar; text: string }
  /** What an always-asking row opens up, said on the card. */
  warning?: string
  /** Where View in Settings opens: the section, an agent's or harness's page, and the row. */
  section: SettingsSection
  item: string | null
  row: string
}

/**
 * What became of a change: made (and later undone, or changed again since, which takes its undo
 * away), not made because the user said Don't change, nobody answered in time or the turn ended
 * first, or refused when it was applied.
 */
export type SettingsChangeOutcome =
  | { kind: 'changed'; undone?: true; stale?: true }
  | { kind: 'declined' | 'expired' | 'ended' }
  | { kind: 'failed'; message: string }

/**
 * An agent's change to Kettu's settings through `change_settings`: a card while it waits for the
 * user (`outcome` null), or, when Full access made it without asking, only the line it leaves.
 */
export interface SettingsChangeEntry {
  kind: 'settings_change'
  id: string
  items: SettingChangeItem[]
  /** It waited for the user in a card; false when Full access changed it without asking. */
  asked: boolean
  /** When an unanswered card counts as declined, in the host's milliseconds; null when not asked. */
  expiresAt: number | null
  outcome: SettingsChangeOutcome | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

/** What a publish or an unlisting asks the user, whether in a session's card or a dialog. */
export type MarketPublishAsk = Omit<
  MarketPublishEntry,
  'kind' | 'id' | 'expiresAt' | 'outcome' | 'device' | 'after'
>

/**
 * An agent's write to Kettu's memory, at its tool call. A project write is done when it appears and
 * `undo` names the record that takes it back, null once undone; a global write is only proposed,
 * `draft` holding what would be written until the user answers.
 */
export interface MemoryWriteEntry {
  kind: 'memory'
  id: string
  layer: MemoryLayer
  action: MemoryAction
  /** The entry written; null for a proposed new global entry until it is accepted. */
  memoryId: string | null
  title: string
  status: MemoryWriteStatus
  undo: string | null
  draft: MemoryDraft | null
  /** Set when a paired device gave the answer; the host's own windows give none. */
  device?: FromDevice
  /** The agent's entry before it, to put it back after a replay. */
  after: string | null
}

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
  permissionResult:
    // by: answered within a scope; device: answered on a paired device; relayed: answered through
    // a plugin's channel; name: a question's answer;
    // questions: what each question of an ask got, in the agent's order
    | {
        optionId: string
        kind: PermissionKind
        by?: 'routine' | 'task'
        device?: FromDevice
        // A plugin relayed the answer, which the user gave where `from` says
        relayed?: { plugin: string; from: string | null }
        name?: string
        questions?: AnsweredQuestion[]
        // The note sent with the answer, such as what to change in a plan
        note?: string
        // What a form sent: each field's title and its value as it read
        fields?: AnsweredField[]
      }
    | 'cancelled'
    | 'withdrawn'
    | null
  rawInput?: string // the command or input as text, when the agent sent one
  description?: string // what a command does, in the agent's words (Claude Code's Bash)
  /** The agent's own name for the work this call is part of; the work line shows it. */
  label?: string
  // The agent's question, when the call asks the user to pick an answer rather than to allow it.
  question?: string
  // A plan to approve: its number since the last approved plan, from 1; kept once answered.
  planVersion?: number
  // A request from an MCP server, kept once answered: what it asked, without the form's fields.
  elicitation?: { server: string; kind: 'form' | 'url'; url?: string }
  /**
   * What a call of one of Kettu's workflow tools returned beside its text, which its card draws; absent
   * where the harness did not pass it on, such as Claude Code for a call that returned an error.
   */
  structured?: Record<string, unknown>
}

export type ToolContent =
  | { type: 'markdown'; markdown: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'ref'; ref: ContentRef }

export interface PendingPermission {
  requestId: string
  options: PermissionOption[]
  // An ask's questions, answered together. `options` then holds the first question's choices and
  // Something else, for a client that does not know `questions`.
  questions?: PendingQuestion[]
  // A plan to approve: the agent's plan, and the one it revises when the user sent that back.
  plan?: { markdown: string; previous: string | null }
  // An MCP server's request: a form to fill in, or a page to open.
  elicitation?: PendingElicitation
  // Whether the card labels the request Risky, as the host judged it; a request stored without
  // it is judged by its tool kind alone.
  risky?: boolean
}

export interface PermissionOption {
  id: string
  name: string // may hold `code` spans
  kind: PermissionKind
  // What the option does, or what a question's answer means, in the agent's words
  description?: string
  // The option a card that confirms starts with chosen, such as the mode a plan builds in
  preferred?: boolean
  // The option goes with a note the user writes in the card, such as what to change in a plan
  note?: boolean
}

/** An MCP server's request through the agent; `server` is the name it shows. */
export type PendingElicitation =
  | { kind: 'form'; server: string; message: string; fields: FormField[] }
  | { kind: 'url'; server: string; message: string; url: string }

/** One field of an MCP server's form, from its JSON Schema property `key`. */
export type FormField = {
  key: string
  title: string
  description?: string
  required: boolean
} & (
  | {
      type: 'text'
      format?: 'email' | 'uri' | 'date' | 'date-time'
      minLength?: number
      maxLength?: number
      default?: string
    }
  | { type: 'number'; integer: boolean; minimum?: number; maximum?: number; default?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'choice'; choices: FormChoice[]; default?: string }
  | {
      type: 'choices'
      choices: FormChoice[]
      minItems?: number
      maxItems?: number
      default?: string[]
    }
)

export interface FormChoice {
  value: string
  label: string
}

/** A form's answer, by field key: what a field of each type takes. */
export type FormValues = Record<string, string | number | boolean | string[]>

/** What the entry keeps of a submitted field: its title and its value as text. */
export interface AnsweredField {
  title: string
  value: string
}

export interface PendingQuestion {
  header: string
  question: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
  // Whether the user may write an answer of their own
  allowsText: boolean
  // Whether the answer is a secret: typed as dots, never kept
  secret: boolean
}

/** What the user gave one question: option indexes, and the text they wrote instead or as well. */
export interface QuestionAnswer {
  // The question's position in the ask
  question: number
  choices: number[]
  text?: string
}

/** What the card keeps of one question once the ask is answered; no answer for a secret one. */
export interface AnsweredQuestion {
  question: string
  answered: boolean
  answer?: string
}

export type PermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
export type UserContent =
  // `command`: the text starts with one of Kettu's commands, which the host expanded; the text
  // stays what the user typed.
  { type: 'text'; text: string; command?: CommandRun } | { type: 'ref'; ref: ContentRef }
export type ContentRef =
  | { kind: 'image'; mimeType: string; data: string }
  // An image the host keeps in its thread store, whose bytes `sessions.blob` reads by `blob`,
  // their SHA-256; only for a client that said it reads them (`IMAGE_REFS_FEATURE`).
  | { kind: 'image'; mimeType: string; blob: string }
  // A sound or a clip the conversation carries, `size` its bytes; `name` from a resource's URI.
  | { kind: 'audio'; mimeType: string; data: string; size: number; name: string | null }
  | { kind: 'video'; mimeType: string; data: string; size: number; name: string | null }
  | { kind: 'link'; uri: string; name: string }
  | { kind: 'attachment'; attachment: Attachment } // what the user added, see attachments
  // A terminal, browser tab or device of the session the user referenced, which lets its agent use
  // it; `name` as it read then.
  | { kind: 'terminal'; terminalId: string; name: string }
  | { kind: 'page'; tabId: string; name: string }
  | { kind: 'device'; deviceId: string; name: string }
  // An item a plugin's mention source offered that the user chose: the plugin adds its content to
  // the message when it is sent. `word` is what the text names it by after the `@`.
  | { kind: 'plugin'; pluginId: string; source: string; item: string; word: string; name: string }
  | { kind: 'unsupported'; label: string }

export interface Attachment {
  id: string // the host's record while a draft or the queue holds it; unique in a thread
  type: 'image' | 'file' | 'folder' | 'text' // 'text' is a long paste
  name: string // the file's name, or "Image 1", "Pasted text 1"
  uri: string | null // the original's file:// URI; null for a pasted image or text
  mimeType: string | null
  size: number | null // bytes: what was sent, or the file's when it went as a link
  sent: 'image' | 'embedded' | 'linked' | 'inline' | null // how it went; null until sent
  thumb: string | null // an image's thumbnail, a 224 px WebP data URL
  blob: string | null // SHA-256 of the bytes kept in the thread store: an image or a pasted text
}

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
  | { op: 'thread.truncate'; id: string } // the entry and all after it leave, as an edit from it does

export interface PatchBatch {
  sessionId: string
  seq: number
  /** The seq of the first batch, when this one merges several up to `seq`, as a slow device gets. */
  from?: number
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
  /** The latest plan when it lies before `entries`, for the plan in the top bar. */
  plan: PlanEntry | null
}

/** A page of older entries, read with the `older` cursor of the page after it. */
export interface OlderPage {
  entries: ThreadEntry[]
  older: number | null
}

/**
 * What stands for a tool output too long to send in the pages of a device that sent
 * `TOOL_DIGESTS_FEATURE`; `sessions.entry` reads the entry whole. `size` is the left-out text's
 * length in UTF-8 bytes, a diff's old and new text together.
 */
export type ToolContentDigest =
  | { type: 'digest'; of: 'markdown'; size: number; lines: number }
  | {
      type: 'digest'
      of: 'diff'
      path: string
      size: number
      /** Lines added and removed; null when the change is too large to compare quickly. */
      added: number | null
      removed: number | null
    }

/** What stands for a tool call's input too long to send, in place of `rawInput`. */
export interface ToolInputDigest {
  size: number
  lines: number
}

/**
 * A tool entry in such a device's pages. A call that waits for an answer is always whole. A later
 * patch may set `rawInput` beside `rawInputDigest`, and then it is the input.
 */
export type DigestedToolEntry = Omit<ToolEntry, 'content' | 'rawInput'> & {
  content: (ToolContent | ToolContentDigest)[]
  rawInput?: string
  rawInputDigest?: ToolInputDigest
}

export type DigestedThreadEntry = Exclude<ThreadEntry, ToolEntry> | DigestedToolEntry

/** `SessionSnapshot` as a device that sent `TOOL_DIGESTS_FEATURE` gets it. */
export type DigestedSnapshot = Omit<SessionSnapshot, 'entries'> & {
  entries: DigestedThreadEntry[]
}

/** `OlderPage` as a device that sent `TOOL_DIGESTS_FEATURE` gets it. */
export interface DigestedPage {
  entries: DigestedThreadEntry[]
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

type Notice = Extract<ThreadEntry, { kind: 'notice' }>

/** A turn that ended on a notice, with the message it was sent for. */
export interface EndedTurn {
  notice: Notice
  prompt: Extract<ThreadEntry, { kind: 'user' }>
}

/** The latest turn, when it ended on a notice of one of `causes`: that notice and its prompt. */
function turnEndedOn(
  state: Pick<ThreadState, 'order' | 'byId'>,
  causes: readonly NonNullable<Notice['cause']>[],
): EndedTurn | null {
  let notice: Notice | null = null
  for (let i = state.order.length - 1; i >= 0; i--) {
    const entry = state.byId[state.order[i]!]
    if (!entry) continue
    if (entry.kind === 'user' && !entry.steered) return notice && { notice, prompt: entry }
    if (notice) continue
    if (entry.kind === 'notice' && entry.cause && causes.includes(entry.cause)) notice = entry
    // A retry runs under the same prompt, so work after the notice means it went through.
    else if (entry.kind !== 'notice' && entry.kind !== 'git') return null
  }
  return null
}

/** The latest turn, when its model provider refused it for want of credit: its notice and prompt. */
export function outOfCreditTurn(state: Pick<ThreadState, 'order' | 'byId'>): EndedTurn | null {
  return turnEndedOn(state, ['out_of_credit'])
}

/** The latest turn, when it failed so that Retry sends its message again: its notice and prompt. */
export function retryableTurn(state: Pick<ThreadState, 'order' | 'byId'>): EndedTurn | null {
  return turnEndedOn(state, ['out_of_credit', 'turn_failed'])
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
      case 'thread.truncate': {
        // One a partial state lacks is on an older page: a snapshot follows, as the cursor moves.
        const at = patch.id in byId ? order.indexOf(patch.id) : -1
        if (at < 0) throw new UnknownEntryError(patch.id)
        const dropped = order.slice(at)
        order = order.slice(0, at)
        orderCopied = true
        const next = writableById()
        for (const id of dropped) delete next[id]
        break
      }
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
    case 'thread.truncate': {
      const at = patch.id in state.byId ? state.order.indexOf(patch.id) : -1
      if (at < 0) throw new UnknownEntryError(patch.id)
      for (const id of state.order.splice(at)) delete state.byId[id]
      return state
    }
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

const BLOB = /^[0-9a-f]{64}$/

function isContentRef(value: unknown): value is ContentRef {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'image':
      return (
        typeof value.mimeType === 'string' &&
        (typeof value.data === 'string' ||
          (typeof value.blob === 'string' && BLOB.test(value.blob)))
      )
    case 'audio':
    case 'video':
      return (
        typeof value.mimeType === 'string' &&
        typeof value.data === 'string' &&
        typeof value.size === 'number' &&
        (value.name === null || typeof value.name === 'string')
      )
    case 'link':
      return typeof value.uri === 'string' && typeof value.name === 'string'
    case 'terminal':
      return typeof value.terminalId === 'string' && typeof value.name === 'string'
    case 'page':
      return typeof value.tabId === 'string' && typeof value.name === 'string'
    case 'device':
      return typeof value.deviceId === 'string' && typeof value.name === 'string'
    case 'plugin':
      return (
        typeof value.pluginId === 'string' &&
        typeof value.source === 'string' &&
        typeof value.item === 'string' &&
        typeof value.word === 'string' &&
        typeof value.name === 'string'
      )
    case 'attachment':
      return isAttachment(value.attachment)
    case 'unsupported':
      return typeof value.label === 'string'
    default:
      return false
  }
}

const ATTACHMENT_TYPES = new Set(['image', 'file', 'folder', 'text'])
const SENT_AS = new Set(['image', 'embedded', 'linked', 'inline'])
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

export function isAttachment(value: unknown): value is Attachment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    ATTACHMENT_TYPES.has(value.type) &&
    typeof value.name === 'string' &&
    isStringOrNull(value.uri) &&
    isStringOrNull(value.mimeType) &&
    (value.size === null || typeof value.size === 'number') &&
    (value.sent === null || (typeof value.sent === 'string' && SENT_AS.has(value.sent))) &&
    isStringOrNull(value.thumb) &&
    isStringOrNull(value.blob)
  )
}

function isCommandOrigin(value: unknown): value is CommandOrigin {
  if (!isRecord(value)) return false
  if (value.kind === 'user') return true
  return (
    value.kind === 'plugin' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.title === 'string'
  )
}

function isCommandRun(value: unknown): value is CommandRun {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.sent === 'string' &&
    isCommandOrigin(value.origin)
  )
}

export function isUserContent(value: unknown): value is UserContent {
  if (!isRecord(value)) return false
  if (value.type === 'text') {
    return (
      typeof value.text === 'string' && (value.command === undefined || isCommandRun(value.command))
    )
  }
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

function isMemoryWriteStatus(value: unknown): value is MemoryWriteStatus {
  return (
    value === 'written' ||
    value === 'undone' ||
    value === 'proposed' ||
    value === 'accepted' ||
    value === 'declined'
  )
}

function isMemoryDraft(value: unknown): value is MemoryDraft {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.body === 'string'
  )
}

function isProblemReportOutcome(value: unknown): value is ProblemReportOutcome {
  if (!isRecord(value)) return false
  if (value.kind === 'sent') return typeof value.reportId === 'string'
  return value.kind === 'saved' || value.kind === 'skipped'
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
      return (
        isListOf(value.content, isUserContent) &&
        (value.agentRef === undefined || typeof value.agentRef === 'string') &&
        (value.attached === undefined || isListOf(value.attached, isPluginAttached))
      )
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
        (value.description === undefined || typeof value.description === 'string') &&
        (value.permission == null ||
          (isRecord(value.permission) && isListOf(value.permission.options, isRecord)))
      )
    case 'subagent':
      return typeof value.sessionId === 'string'
    case 'session_started':
      return (
        typeof value.sessionId === 'string' &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'plan':
      return isListOf(value.items, isRecord)
    case 'notice':
      return (
        typeof value.severity === 'string' &&
        typeof value.title === 'string' &&
        (value.cause === undefined ||
          value.cause === 'agent_stopped' ||
          value.cause === 'out_of_credit' ||
          value.cause === 'turn_failed') &&
        (value.model === undefined || typeof value.model === 'string') &&
        (value.after === undefined || value.after === null || typeof value.after === 'string')
      )
    case 'compaction':
      return typeof value.status === 'string' && typeof value.summary === 'string'
    case 'turn_end':
      return (
        typeof value.stopReason === 'string' &&
        typeof value.durationMs === 'number' &&
        (value.after === undefined || value.after === null || typeof value.after === 'string') &&
        (value.used === undefined || typeof value.used === 'number')
      )
    case 'takeover':
      return (
        isAgentId(value.agentId) &&
        typeof value.turns === 'number' &&
        typeof value.omitted === 'number' &&
        typeof value.carried === 'string' &&
        (value.summarize === undefined || typeof value.summarize === 'boolean') &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'git':
      return (
        (value.event === 'commit'
          ? isListOf(value.commits, isRecord)
          : typeof value.event === 'string') &&
        (value.after === undefined || value.after === null || typeof value.after === 'string')
      )
    case 'artifact':
      return (
        typeof value.artifactId === 'string' &&
        typeof value.title === 'string' &&
        ARTIFACT_ACTIONS.has(value.action as string) &&
        (value.version === null || typeof value.version === 'number') &&
        typeof value.writes === 'number' &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'browser_origin':
      return (
        Number.isSafeInteger(value.requestId) &&
        typeof value.origin === 'string' &&
        (value.decision === null ||
          value.decision === 'session' ||
          value.decision === 'project' ||
          value.decision === 'deny' ||
          value.decision === 'timeout') &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'control_ask':
      return (
        isControlSurface(value.surface) &&
        isControlStep(value.step) &&
        (value.target === null || typeof value.target === 'string') &&
        typeof value.reason === 'string' &&
        (value.outcome === null || value.outcome === 'ended' || isControlOutcome(value.outcome)) &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'control_note':
      return (
        isControlSurface(value.surface) &&
        ((value.event === 'handed_back' && typeof value.durationMs === 'number') ||
          (value.event === 'paused' && typeof value.app === 'string') ||
          (value.event === 'used' && typeof value.name === 'string')) &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'device_access':
      return (
        typeof value.deviceId === 'string' &&
        typeof value.deviceName === 'string' &&
        (value.decision === null ||
          value.decision === 'session' ||
          value.decision === 'always' ||
          value.decision === 'deny' ||
          value.decision === 'timeout') &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'surface_access':
      return (
        (value.surface === 'terminal' || value.surface === 'browser') &&
        typeof value.targetId === 'string' &&
        (value.rename === undefined || typeof value.rename === 'string') &&
        typeof value.targetName === 'string' &&
        (value.decision === null ||
          value.decision === 'allow' ||
          value.decision === 'deny' ||
          value.decision === 'timeout') &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'computer_app':
      return (
        Number.isSafeInteger(value.requestId) &&
        typeof value.appId === 'string' &&
        typeof value.appName === 'string' &&
        (value.decision === null ||
          value.decision === 'session' ||
          value.decision === 'always' ||
          value.decision === 'deny' ||
          value.decision === 'timeout') &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'memory':
      return (
        (value.layer === 'global' || value.layer === 'project') &&
        (value.action === 'remember' || value.action === 'update' || value.action === 'forget') &&
        (value.memoryId === null || typeof value.memoryId === 'string') &&
        typeof value.title === 'string' &&
        isMemoryWriteStatus(value.status) &&
        (value.undo === null || typeof value.undo === 'string') &&
        (value.draft === null || isMemoryDraft(value.draft)) &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'problem_report':
      return (
        typeof value.title === 'string' &&
        typeof value.details === 'string' &&
        (value.error === null || typeof value.error === 'string') &&
        typeof value.at === 'number' &&
        (value.outcome === null || isProblemReportOutcome(value.outcome)) &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'market_publish':
      return (
        (value.action === 'publish' || value.action === 'unlist') &&
        isRecord(value.item) &&
        typeof value.item.name === 'string' &&
        typeof value.item.slug === 'string' &&
        typeof value.item.kind === 'string' &&
        (value.version === null || typeof value.version === 'string') &&
        (value.previous === null || typeof value.previous === 'string') &&
        typeof value.installs === 'number' &&
        (value.notes === null || typeof value.notes === 'string') &&
        isListOf(value.adds, isRecord) &&
        isListOf(value.runs, (item): item is string => typeof item === 'string') &&
        typeof value.folder === 'string' &&
        isListOf(value.files, isRecord) &&
        typeof value.bytes === 'number' &&
        (value.changes === null || isListOf(value.changes, isRecord)) &&
        (value.publisher === null || isRecord(value.publisher)) &&
        (value.outcome === null ||
          (isRecord(value.outcome) && typeof value.outcome.kind === 'string')) &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'computer_setup':
      return (
        Number.isSafeInteger(value.requestId) &&
        Array.isArray(value.steps) &&
        value.steps.every(isComputerSetupStep) &&
        Array.isArray(value.done) &&
        value.done.every(isComputerSetupStep) &&
        (value.outcome === null ||
          value.outcome === 'ready' ||
          value.outcome === 'declined' ||
          value.outcome === 'timeout') &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'plugin_denial':
      return (
        typeof value.pluginId === 'string' &&
        typeof value.plugin === 'string' &&
        typeof value.request === 'string' &&
        typeof value.reason === 'string' &&
        (value.after === null || typeof value.after === 'string')
      )
    case 'task_delivery':
      return (
        typeof value.taskId === 'string' &&
        typeof value.title === 'string' &&
        (value.status === 'done' || value.status === 'dropped' || value.status === 'cancelled') &&
        typeof value.steps === 'number' &&
        typeof value.durationMs === 'number' &&
        isListOf(value.deliverables, isTaskDeliverable) &&
        (value.written === null || (isRecord(value.written) && isAgentId(value.written.agentId))) &&
        (value.publishAsked === undefined || typeof value.publishAsked === 'number') &&
        (value.after === null || typeof value.after === 'string')
      )
    default:
      return false
  }
}

function isPluginAttached(value: unknown): value is PluginAttached {
  return (
    isRecord(value) &&
    typeof value.pluginId === 'string' &&
    typeof value.plugin === 'string' &&
    isListOf(
      value.items,
      (item): item is PluginAttached['items'][number] =>
        isRecord(item) &&
        typeof item.text === 'string' &&
        (item.title === undefined || typeof item.title === 'string') &&
        (item.failed === undefined || typeof item.failed === 'string'),
    )
  )
}

function isTaskDeliverable(value: unknown): value is TaskDeliverable {
  if (!isRecord(value)) return false
  const detail = value.detail === null || typeof value.detail === 'string'
  switch (value.kind) {
    case 'pull_request':
      return typeof value.url === 'string'
    case 'document':
      return (
        typeof value.artifactId === 'string' &&
        typeof value.version === 'number' &&
        typeof value.title === 'string'
      )
    case 'file':
      return typeof value.title === 'string' && detail && typeof value.path === 'string'
    case 'link':
      return typeof value.title === 'string' && detail && typeof value.url === 'string'
    default:
      return false
  }
}

/**
 * Merges what applies the same as one patch, as the host does before a flush: consecutive text
 * appends to an entry, consecutive session updates, and an entry update into the entry's earlier
 * update when no patch between them touches that entry or removes entries. Patches keep their
 * order and none is changed; a merged one is a new object.
 */
export function coalescePatches(patches: readonly Patch[]): Patch[] {
  const out: Patch[] = []
  // The index in `out` of each entry's latest update that nothing has touched since.
  const open = new Map<string, number>()
  for (const patch of patches) {
    const last = out[out.length - 1]
    switch (patch.op) {
      case 'entry.appendText':
        open.delete(patch.id)
        if (last?.op === 'entry.appendText' && last.id === patch.id) {
          out[out.length - 1] = {
            op: 'entry.appendText',
            id: patch.id,
            text: last.text + patch.text,
          }
        } else {
          out.push(patch)
        }
        break
      case 'entry.update': {
        const at = open.get(patch.id)
        const earlier = at === undefined ? undefined : out[at]
        if (at !== undefined && earlier?.op === 'entry.update') {
          out[at] = {
            op: 'entry.update',
            id: patch.id,
            changes: { ...earlier.changes, ...patch.changes } as EntryChanges,
          }
        } else {
          open.set(patch.id, out.length)
          out.push(patch)
        }
        break
      }
      case 'session.update':
        if (last?.op === 'session.update') {
          out[out.length - 1] = {
            op: 'session.update',
            changes: { ...last.changes, ...patch.changes },
          }
        } else {
          out.push(patch)
        }
        break
      case 'entry.add':
        open.delete(patch.entry.id)
        out.push(patch)
        break
      case 'thread.reset':
      case 'thread.truncate':
        open.clear()
        out.push(patch)
        break
    }
  }
  return out
}

const ARTIFACT_ACTIONS = new Set<string>(['create', 'update', 'restore', 'delete'])
