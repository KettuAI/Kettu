// The contract between the renderer and the agent host, over the agent host port.

import type { ArtifactContent, ArtifactSummary, VersionSummary } from './artifacts'
import type { FileContent, FileList, FileSearch, FileWritten } from './files'
import type {
  ChangedFile,
  CommitDetails,
  FileDiff,
  GitOperation,
  GitStatus,
  GitTools,
  LogCommit,
  PullRequest,
  PullRequestState,
  RepositoryVisibility,
} from './git'
import type { PortConnectionState } from './port-rpc'
import type { UsageScope, UsageStatus, UsageSummary, UsageTotal } from './usage'
import type {
  AgentId,
  Attachment,
  ConfigOption,
  OlderPage,
  PatchBatch,
  SessionSnapshot,
  SessionStatus,
  UserContent,
} from './thread'

export interface AttachmentBytes {
  mimeType: string
  bytes: ArrayBuffer
}

export interface AgentAccount {
  kind: 'account' | 'api_key' | 'external' | 'gateway' | 'none'
  label: string // "Claude Max", "ChatGPT Plus", "Anthropic API key"
  email: string | null
}

export interface PlanLimit {
  window: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | (string & {})
  label: string // "5-hour", "Weekly", "Weekly · Opus"
  usedPercent: number | null
  resetsAt: number | null
  state: 'ok' | 'warning' | 'reached' // from `status`: allowed, allowed_warning, rejected
  observedAt: number
}

/** What fills a session's context, as the agent's own report breaks it down. */
export interface ContextBreakdown {
  model: string | null
  used: number
  size: number
  /** In the report's order, free space and the autocompact buffer included. */
  categories: { name: string; tokens: number; share: number | null }[]
  /** The itemised lists that follow, such as MCP tools, memory files and skills. */
  lists: ContextList[]
  observedAt: number
}

export interface ContextList {
  name: string // "MCP Tools", "Memory Files", "Skills"
  items: { name: string; detail: string | null; tokens: string }[] // tokens as reported: "~310"
}

export type AgentState =
  | 'not-installed'
  | 'node-missing'
  | 'node-outdated'
  | 'available'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'failed'

export interface AgentAuthMethod {
  id: string
  name: string
  description?: string
  type: 'agent' | 'terminal'
  command?: string // for terminal methods: the full command, quoted for the platform
}

/** A newer adapter or CLI than the installed one, found by `agents.checkUpdates`. */
export interface AgentUpdate {
  adapterVersion: string // the adapter version a fresh install takes
  cliVersion: string | null // the CLI that install carries, such as Claude Code or Codex
}

/** An install or update OverBench runs for an agent at the user's request. */
export interface AgentTask {
  kind: 'install' | 'update'
  state: 'running' | 'failed'
  command: string // what runs, quoted for the platform
  method: AgentInstallMethod['id'] | null // the route a binary agent's install took; null otherwise
  progress: string[] // the latest output lines
  error: string | null // why it failed, in the user's terms
}

/** Which CLI a Claude Code or Codex adapter runs: the user's own, or the copy it brings. */
export interface AgentCli {
  command: string // looked up on PATH, such as claude
  prefer: AgentCliSource // the setting: the installed program when it can run, or always the copy
  runs: AgentCliSource // what a start runs now
  active: AgentCliSource | null // what the running adapter process uses; null while none runs
  installed: InstalledCli | null // null: none found
  needsCopy: boolean // the copy is to run but is not on disk: the next start downloads it
  copyMegabytes: number // about how much that download is
}

export type AgentCliSource = 'installed' | 'bundled'

export interface InstalledCli {
  path: string // as the adapter runs it, after resolving shims
  version: string | null
  variable: string | null // set by this variable in the environment, which then decides alone
  problem: InstalledCliProblem | null // why the copy runs instead
}

export type InstalledCliProblem =
  | { kind: 'unsupported' } // cannot run without a shell
  | { kind: 'failed'; reason: string } // its version could not be read, or a start with it failed
  | { kind: 'too-old'; minimum: string }
  | { kind: 'no-minimum' } // the adapter names no version it needs

/** A way OverBench can install a binary agent such as OpenCode, in the order it prefers them. */
export interface AgentInstallMethod {
  id: 'brew' | 'npm' | 'script'
  command: string // quoted for the platform, as the page shows it
  available: boolean // the tool it needs was found on the agent environment's PATH
}

export interface AgentStatus {
  id: AgentId
  name: string
  state: AgentState
  version: string | null // from agentInfo, once initialized
  package: { name: string; version: string; installed: boolean } | null // the adapter a start runs; the pin until one is installed
  signIn: 'unknown' | 'signed-in' | 'required'
  authMethods: AgentAuthMethod[]
  canLogout: boolean
  account: AgentAccount | null // what the agent reports through `_auth/status_update`
  limits: PlanLimit[] // subscription windows, see plan limits in the session model
  detail: string | null // install hint or error message
  installUrl: string | null
  progress: string[] // latest npm output or stderr lines while installing or starting
  launchCommand: string // as shown in Settings › Agents, quoted for the platform
  binaryOverride: string | null // the program picked in Settings, if any
  update: AgentUpdate | null // from the last update check; null when up to date or unchecked
  updateCheckedAt: number | null // when that check finished; always null for binary agents
  task: AgentTask | null
  installMethods: AgentInstallMethod[] // a binary agent's ways to install; empty for the others
  cli: AgentCli | null // which CLI a Claude Code or Codex adapter runs; null for the others
  capabilities: {
    loadSession: boolean
    listSessions: boolean
    resumeSession: boolean
    closeSession: boolean
    deleteSession: boolean
    forkSession: boolean
    forkAtMessage: boolean // `session/fork` up to a message, through the adapters' fork point
    steering: boolean // `_session/steering` into a running turn
    reports: boolean // plan limits from its own report (`/usage`, `/status`)
    account: boolean // names its account through `_auth/status_update` as it starts
    progressNotes: boolean // its messages that more work in a turn follows are progress notes
    prompt: PromptCapabilities | null // what a prompt may carry; null until the agent has started
  }
}

/** ACP's `promptCapabilities`: the content a prompt may carry besides text and links. */
export interface PromptCapabilities {
  image: boolean
  audio: boolean
  embeddedContext: boolean
}

/**
 * What New session shows for an agent before a session exists, since ACP lists the options only in
 * answer to `session/new`. See config options in the session model.
 */
export interface AgentOptions {
  agentId: AgentId
  config: ConfigOption[] // from the agent's last `session/new`, at the agent's own values
  levels: Record<string, ConfigOption> // the `thought_level` option each model offered, by model
  remembered: Record<string, string | boolean> // the user's last values, by option id
  observedAt: number
  provisional?: boolean // from a loaded or resumed session, so not the agent's own defaults
}

/** An agent's page in Settings › Agents: what its status leaves out, read when the page opens. */
export interface AgentDetails {
  /** The CLI an adapter runs, such as Claude Code inside its ACP adapter; null for the others. */
  cliVersion: string | null
  config: AgentConfigItem[]
}

/** A place the agent reads its own configuration from, in the order Settings lists them. */
export interface AgentConfigItem {
  id: 'folder' | 'settings' | 'instructions'
  path: string
  exists: boolean
  env: string | null // the variable that moved it, such as CLAUDE_CONFIG_DIR; null at the default
}

/** Where the agent environment came from, for Settings › Agents. */
export interface EnvironmentInfo {
  source: 'pending' | 'login-shell' | 'inherited' | 'fallback'
  shell: string | null
  resolvedAt: number | null
  durationMs: number | null
  warning: string | null // why it fell back, or a note such as the Windows restart hint
  nodeVersion: string | null
  npmPath: string | null
}

export interface Project {
  path: string
  name: string
  missing: boolean // the folder no longer exists
  lastOpenedAt: number
}

export type SessionAttention = 'none' | 'permission' | 'unread' | 'error'

/**
 * The `reason` in the `data` of the `not_found` that `sessions.create` fails with when its new
 * session was deleted, or its project removed, while it started: nothing is left to show.
 */
export const REMOVED_WHILE_STARTING = 'removed_while_starting'

export interface SessionSummary {
  id: string
  agentId: AgentId
  projectPath: string
  scratch: boolean // started with No project: projectPath is its own scratch folder
  title: string | null
  status: SessionStatus
  attention: SessionAttention
  permissionCount: number // pending permission requests in this session alone
  createdAt: number
  updatedAt: number
  parentId: string | null
  origin: 'user' | 'subagent'
  description: string | null // a subagent's purpose, as its parent described it
  missing: boolean // a subagent the parent's replay did not mention
  branch: string | null // the branch checked out when its last turn ended
  pr: { number: number; state: PullRequestState; url: string } | null
}

export interface ImportableSession {
  acpSessionId: string
  title: string | null
  updatedAt: string | null
  imported: boolean // already in the session index
}

export interface TrafficRecord {
  at: number
  direction: 'in' | 'out'
  method: string | null
  size: number
  message: unknown
}

export interface AgentDiagnostics {
  status: AgentStatus
  capabilities: unknown
  traffic: TrafficRecord[]
  stderr: string
  events: { at: number; event: string; detail?: string }[]
  /** The installed adapter's `installed.json` and `package-lock.json`, for a package agent. */
  adapter: { installed: unknown; lock: unknown } | null
}

export interface DiagnosticsBundle {
  createdAt: number
  appVersion: string
  platform: string
  environment: { PATH: string | null; SHELL: string | null; node: string | null }
  environmentInfo: EnvironmentInfo
  agents: AgentDiagnostics[]
  sessions: SessionSummary[]
  log: { at: number; level: 'info' | 'warn' | 'error'; message: string }[]
}

/** Every request the agent host accepts, keyed by method name. */
export interface HostContract {
  'agents.list': { params: void; result: AgentStatus[] }
  'agents.check': { params: { agentId?: AgentId }; result: AgentStatus[] }
  'agents.reloadEnvironment': { params: void; result: AgentStatus[] }
  'agents.environment': { params: void; result: EnvironmentInfo }
  'agents.authenticate': { params: { agentId: AgentId; methodId: string }; result: void }
  'agents.logout': { params: { agentId: AgentId }; result: void }
  'agents.retry': { params: { agentId: AgentId }; result: void }
  'agents.reinstall': { params: { agentId: AgentId }; result: void }
  // Asks npm for each package agent's latest adapter and the CLI it carries.
  'agents.checkUpdates': { params: void; result: AgentStatus[] }
  // Both resolve once the task is done or cancelled, and reject with its error.
  'agents.update': { params: { agentId: AgentId }; result: void }
  'agents.install': {
    params: { agentId: AgentId; method?: AgentInstallMethod['id'] }
    result: void
  }
  // Stops a running task, or clears a failed one.
  'agents.cancelTask': { params: { agentId: AgentId }; result: void }
  'agents.start': { params: { agentId: AgentId }; result: void }
  'agents.refreshLimits': { params: { agentId: AgentId }; result: void }
  'agents.details': { params: { agentId: AgentId }; result: AgentDetails }
  'agents.refreshAccount': { params: { agentId: AgentId }; result: void }
  'agents.listSessions': {
    params: { agentId: AgentId; projectPath: string; cursor?: string }
    result: { sessions: ImportableSession[]; nextCursor: string | null }
  }
  'agents.options': { params: void; result: AgentOptions[] }
  'projects.list': { params: void; result: Project[] }
  'projects.add': { params: { path: string }; result: Project }
  'projects.remove': { params: { path: string }; result: void }
  'projects.touch': { params: { path: string }; result: void }
  'sessions.list': { params: { projectPath?: string }; result: SessionSummary[] }
  'sessions.create': {
    // projectPath null: No project, in a new scratch folder.
    // options: config values to start with, by option id.
    params: {
      agentId: AgentId
      projectPath: string | null
      parentId?: string
      options?: Record<string, string | boolean>
    }
    result: SessionSummary
  }
  'sessions.import': {
    params: { agentId: AgentId; projectPath: string; acpSessionId: string }
    result: SessionSummary
  }
  'sessions.open': { params: { sessionId: string }; result: SessionSnapshot }
  // With `from`, every entry from that position on, as a replica that holds older pages needs.
  'sessions.snapshot': { params: { sessionId: string; from?: number }; result: SessionSnapshot }
  'sessions.page': { params: { sessionId: string; before: number }; result: OlderPage }
  'sessions.watch': { params: { sessionId: string }; result: void }
  'sessions.unwatch': { params: { sessionId: string }; result: void }
  // The session a port shows in front, or null; a turn that ends out of view is unread.
  'sessions.show': { params: { sessionId: string | null }; result: void }
  'sessions.prompt': { params: { sessionId: string; content: UserContent[] }; result: void }
  'sessions.cancel': { params: { sessionId: string }; result: void }
  'sessions.retry': { params: { sessionId: string }; result: void }
  // `entryId`: a reply's agent message, to fork the session up to its turn; see the session model.
  'sessions.fork': { params: { sessionId: string; entryId?: string }; result: SessionSummary }
  'sessions.context': { params: { sessionId: string }; result: ContextBreakdown | null }
  'sessions.queue': {
    params: { sessionId: string; content: UserContent[] }
    result: { itemId: string | null } // null when it was sent at once
  }
  'sessions.unqueue': { params: { sessionId: string; itemId: string }; result: void }
  'sessions.steer': { params: { sessionId: string; itemId: string }; result: void }
  'sessions.resumeQueue': { params: { sessionId: string }; result: void }
  // An image or pasted text the thread store keeps for a sent attachment, by its hash.
  'sessions.blob': { params: { sessionId: string; hash: string }; result: AttachmentBytes }
  'sessions.setConfigOption': {
    params: { sessionId: string; optionId: string; value: string | boolean }
    result: void
  }
  // title null: back to the agent's title.
  'sessions.rename': { params: { sessionId: string; title: string | null }; result: void }
  'sessions.close': { params: { sessionId: string }; result: void }
  'sessions.delete': { params: { sessionId: string }; result: void }
  // Once per index: the sessions left with no message go, except `keep`, those with a draft.
  'sessions.removeEmpty': { params: { keep: string[] }; result: void }
  'sessions.removeAll': { params: void; result: void }
  'permissions.respond': {
    params: { sessionId: string; requestId: string; optionId: string }
    result: void
  }
  'diagnostics.collect': { params: void; result: DiagnosticsBundle }
  'git.status': { params: { projectPath: string }; result: GitStatus }
  'git.unwatch': { params: { projectPath: string }; result: void }
  'git.fetch': { params: { projectPath: string }; result: GitOperation }
  'git.pull': { params: { projectPath: string }; result: GitOperation }
  // Publishes the branch when it has no upstream.
  'git.push': {
    params: { projectPath: string; remote: string; branch: string }
    result: GitOperation
  }
  'git.publish': {
    params: { projectPath: string; name: string; visibility: RepositoryVisibility }
    result: GitOperation
  }
  'git.createPullRequest': {
    params: { projectPath: string; title: string; body: string; base: string; draft: boolean }
    result: PullRequest
  }
  'git.commit': { params: { projectPath: string; oid: string }; result: CommitDetails }
  'git.changes': { params: { projectPath: string }; result: ChangedFile[] }
  'git.incoming': {
    params: { projectPath: string; from: 'upstream' | 'base' }
    result: LogCommit[]
  }
  // ref null: the working tree against HEAD; otherwise the commit against its first parent.
  'git.fileDiff': {
    params: { projectPath: string; path: string; oldPath: string | null; ref: string | null }
    result: FileDiff
  }
  'git.pullRequest': { params: { url: string }; result: PullRequest }
  'git.currentPullRequest': { params: { projectPath: string }; result: PullRequest | null }
  'git.tools': { params: void; result: GitTools }
  // A draft's attachment, kept until it is sent or removed; see attachments in the session model.
  'attachments.add': {
    params: { source: { bytes: ArrayBuffer; mimeType: string; name: string }; thumb: string | null }
    result: Attachment
  }
  'attachments.read': { params: { id: string }; result: AttachmentBytes }
  'attachments.remove': { params: { id: string }; result: void }
  'files.list': { params: { projectPath: string }; result: FileList }
  'files.read': { params: { projectPath: string; path: string }; result: FileContent }
  'files.search': { params: { projectPath: string; query: string }; result: FileSearch }
  // A null `version` overwrites whatever the file holds.
  'files.write': {
    params: { projectPath: string; path: string; text: string; version: string | null }
    result: FileWritten
  }
  // `dayStarts`: the periods to sum, local days or a day's hours, as n + 1 ascending boundaries.
  'usage.summary': {
    params: { dayStarts: number[]; from: number; to: number; scope: UsageScope }
    result: UsageSummary
  }
  'usage.total': { params: { from: number; to: number }; result: UsageTotal }
  'usage.status': { params: void; result: UsageStatus }
  // Resolves once the scan is done; does nothing while Usage on this computer is off.
  'usage.sync': { params: void; result: void }
  'usage.reimport': { params: { agentId: AgentId }; result: void }
  'usage.clearRecord': { params: void; result: void }
  // Every artifact, newest first, or those in Recently deleted, the latest deletion first.
  'artifacts.list': { params: { deleted?: boolean }; result: ArtifactSummary[] }
  // The latest version without `version`.
  'artifacts.read': { params: { id: string; version?: number }; result: ArtifactContent }
  // Newest first.
  'artifacts.versions': { params: { id: string }; result: VersionSummary[] }
  'artifacts.rename': { params: { id: string; title: string }; result: void }
  // Permanently only from Recently deleted.
  'artifacts.delete': { params: { id: string; permanently?: boolean }; result: void }
  'artifacts.undelete': { params: { id: string }; result: void }
  // Authored by the user; `conflict` when `baseVersion` is not the latest.
  'artifacts.restoreVersion': {
    params: { id: string; version: number; baseVersion: number }
    result: { version: number }
  }
  // Each watch counts as a viewer, and brings `artifacts.version`.
  'artifacts.watch': { params: { id: string }; result: void }
  'artifacts.unwatch': { params: { id: string }; result: void }
}

export type HostMethod = keyof HostContract
export type HostParams<M extends HostMethod> = HostContract[M]['params']
export type HostResult<M extends HostMethod> = HostContract[M]['result']

export const HOST_METHODS = [
  'agents.list',
  'agents.check',
  'agents.reloadEnvironment',
  'agents.environment',
  'agents.authenticate',
  'agents.logout',
  'agents.retry',
  'agents.reinstall',
  'agents.checkUpdates',
  'agents.update',
  'agents.install',
  'agents.cancelTask',
  'agents.start',
  'agents.refreshLimits',
  'agents.details',
  'agents.refreshAccount',
  'agents.listSessions',
  'agents.options',
  'projects.list',
  'projects.add',
  'projects.remove',
  'projects.touch',
  'sessions.list',
  'sessions.create',
  'sessions.import',
  'sessions.open',
  'sessions.snapshot',
  'sessions.page',
  'sessions.watch',
  'sessions.unwatch',
  'sessions.show',
  'sessions.prompt',
  'sessions.cancel',
  'sessions.retry',
  'sessions.fork',
  'sessions.context',
  'sessions.queue',
  'sessions.unqueue',
  'sessions.steer',
  'sessions.resumeQueue',
  'sessions.blob',
  'sessions.setConfigOption',
  'sessions.rename',
  'sessions.close',
  'sessions.delete',
  'sessions.removeEmpty',
  'sessions.removeAll',
  'permissions.respond',
  'diagnostics.collect',
  'git.status',
  'git.unwatch',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.publish',
  'git.createPullRequest',
  'git.commit',
  'git.changes',
  'git.incoming',
  'git.fileDiff',
  'git.pullRequest',
  'git.currentPullRequest',
  'git.tools',
  'attachments.add',
  'attachments.read',
  'attachments.remove',
  'files.list',
  'files.read',
  'files.search',
  'files.write',
  'usage.summary',
  'usage.total',
  'usage.status',
  'usage.sync',
  'usage.reimport',
  'usage.clearRecord',
  'artifacts.list',
  'artifacts.read',
  'artifacts.versions',
  'artifacts.rename',
  'artifacts.delete',
  'artifacts.undelete',
  'artifacts.restoreVersion',
  'artifacts.watch',
  'artifacts.unwatch',
] as const satisfies readonly HostMethod[]

export type HostEvent =
  | { type: 'session.patches'; batch: PatchBatch }
  | { type: 'session.summary'; summary: SessionSummary }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'agent.options'; options: AgentOptions }
  | { type: 'projects.changed'; projects: Project[] }
  | { type: 'environment.changed'; info: EnvironmentInfo }
  | { type: 'git.changed'; status: GitStatus }
  | { type: 'git.pr'; projectPath: string; pr: PullRequest | null }
  | { type: 'git.tools'; tools: GitTools }
  | { type: 'usage.changed' } // the figures changed; a page showing them reads again
  | { type: 'usage.status'; status: UsageStatus }
  | { type: 'artifacts.changed' } // the list changed; a page showing it reads again
  | { type: 'artifacts.version'; id: string; version: number }
  | { type: 'artifacts.activity'; id: string; viewers: number; editing: string[] }

export interface AgentsApi {
  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>>
  onEvent(listener: (event: HostEvent) => void): () => void
  /** Calls the listener with the current state, if there is one yet, and then on every change. */
  onConnection(listener: (state: PortConnectionState) => void): () => void
  /** Starts the host again after it failed (crashed too often); does nothing otherwise. */
  restart(): Promise<void>
}
