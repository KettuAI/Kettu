// The parts of the Claude Agent SDK that Kettu uses, typed here because the package is never a
// dependency: its license grants no right to ship it, so Kettu installs it on first use into its
// data folder and loads it from there. Only the fields Kettu reads are named; the SDK sends more.

import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'

export type PermissionMode =
  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

export type SettingSource = 'user' | 'project' | 'local'

export type RuleDestination =
  'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'

export interface PermissionRule {
  toolName: string
  ruleContent?: string
}

/** A change to the permission settings a permission request suggests. */
export type PermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      rules: PermissionRule[]
      behavior: 'allow' | 'deny' | 'ask'
      destination: RuleDestination
    }
  | { type: 'setMode'; mode: PermissionMode; destination: RuleDestination }
  | {
      type: 'addDirectories' | 'removeDirectories'
      directories: string[]
      destination: RuleDestination
    }

export interface ToolPermissionContext {
  signal: AbortSignal
  suggestions?: PermissionUpdate[]
  toolUseID: string
  /** Set when a subagent asks: its task id. */
  agentID?: string
  title?: string
  displayName?: string
  description?: string
  blockedPath?: string
  /** The CLI would not offer to remember the answer. */
  suppressAlwaysAllowRule?: boolean
}

export type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string }

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
) => Promise<PermissionResult>

export interface SpawnOptions {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}

export interface HttpMcpServer {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

/** The settings layer a query adds on top of the files. */
export interface FlagSettings {
  disableAllHooks?: boolean
  ultracode?: boolean
  effortLevel?: string | null
  fastMode?: boolean
  [key: string]: unknown
}

export interface QueryOptions {
  cwd: string
  env: Record<string, string | undefined>
  pathToClaudeCodeExecutable: string
  spawnClaudeCodeProcess: (options: SpawnOptions) => ChildProcess
  abortController?: AbortController
  includePartialMessages?: boolean
  forwardSubagentText?: boolean
  perTaskStopAffordance?: boolean
  settingSources?: SettingSource[]
  systemPrompt?: { type: 'preset'; preset: 'claude_code' }
  tools?: { type: 'preset'; preset: 'claude_code' }
  disallowedTools?: string[]
  permissionMode?: PermissionMode
  allowDangerouslySkipPermissions?: boolean
  canUseTool?: CanUseTool
  mcpServers?: Record<string, HttpMcpServer>
  settings?: FlagSettings
  extraArgs?: Record<string, string | null>
  persistSession?: boolean
  /** The id a new session gets. */
  sessionId?: string
  resume?: string
  resumeSessionAt?: string
  forkSession?: boolean
  stderr?: (text: string) => void
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string } | { type: string }
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface ToolUseBlock {
  type: 'tool_use' | 'server_tool_use' | 'mcp_tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | (TextBlock | ImageBlock | { type: string })[]
  is_error?: boolean
}

export type ContentBlock =
  TextBlock | ImageBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string }

export interface ApiUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  contextWindow?: number
}

export interface UserInput {
  type: 'user'
  message: { role: 'user'; content: string | ContentBlock[] }
  parent_tool_use_id: null
  uuid: string
  session_id: string
  priority?: 'now' | 'next' | 'later'
}

export interface AssistantMessage {
  type: 'assistant'
  message: { id: string; model?: string; content: ContentBlock[]; usage?: ApiUsage }
  parent_tool_use_id: string | null
  /** A message of a subagent: its task id. */
  agent_id?: string
  error?: string
  uuid: string
  session_id: string
}

export interface UserMessage {
  type: 'user'
  message: { role: 'user'; content: string | ContentBlock[] }
  parent_tool_use_id: string | null
  agent_id?: string
  tool_use_result?: unknown
  isSynthetic?: boolean
  isReplay?: boolean
  priority?: 'now' | 'next' | 'later'
  uuid?: string
  session_id: string
}

export interface ResultMessage {
  type: 'result'
  subtype: string
  is_error: boolean
  result?: string
  errors?: string[]
  stop_reason: string | null
  terminal_reason?: string
  total_cost_usd: number
  usage: ApiUsage
  modelUsage: Record<string, ModelUsage>
  session_id: string
}

export interface StreamEvent {
  type: 'stream_event'
  event: {
    type: string
    message?: { id: string; model?: string; usage?: ApiUsage }
    index?: number
    content_block?: ContentBlock
    delta?: { type: string; text?: string; thinking?: string }
  }
  parent_tool_use_id: string | null
  agent_id?: string
  session_id: string
}

export interface SystemMessage {
  type: 'system'
  subtype: string
  session_id: string
  [key: string]: unknown
}

export interface RateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: unknown
  session_id: string
}

export type SdkMessage =
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | StreamEvent
  | SystemMessage
  | RateLimitEvent
  | { type: string; subtype?: string; session_id?: string }

export interface ModelInfo {
  value: string
  /** The model id the row stands for: another one for an alias such as `opus`, else its own. */
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

export interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
  apiProvider?: string
}

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint?: string | string[]
}

export interface InitializeAnswer {
  commands: SlashCommandInfo[]
  models: ModelInfo[]
  account?: AccountInfo
  fast_mode_state?: string
}

export interface ContextUsageAnswer {
  categories: { name: string; tokens: number; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens?: number
  model?: string
  memoryFiles?: { path: string; type?: string; tokens: number }[]
  mcpTools?: { name: string; serverName?: string; tokens: number; isLoaded?: boolean }[]
  agents?: { agentType: string; source?: string; tokens: number }[]
  skills?: { skillFrontmatter?: { name: string; source?: string; tokens: number }[] }
}

export interface UsageWindow {
  utilization: number | null
  resets_at: string | null
}

export interface UsageAnswer {
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: UsageWindow | null
    seven_day?: UsageWindow | null
    seven_day_opus?: UsageWindow | null
    seven_day_sonnet?: UsageWindow | null
    model_scoped?: ({ display_name: string } & UsageWindow)[] | null
  } | null
}

export interface Query extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: FlagSettings): Promise<void>
  initializationResult(): Promise<InitializeAnswer>
  getContextUsage(options?: { detail?: 'summary' | 'full' }): Promise<ContextUsageAnswer>
  accountInfo(): Promise<AccountInfo>
  stopTask(taskId: string): Promise<void>
  close(): void
  /** Present in the SDK Kettu pins, though not in its published types. */
  generateSessionTitle?(description: string, options: { persist: boolean }): Promise<string | null>
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(options: {
    skipBehaviors?: boolean
  }): Promise<UsageAnswer>
}

export interface SessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  customTitle?: string
  firstPrompt?: string
  cwd?: string
}

export interface StoredMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  session_id: string
  message: unknown
  parent_tool_use_id: string | null
}

export interface ResolvedSettings {
  effective: Record<string, unknown>
}

/** The SDK's module, as its entry exports it. */
export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<UserInput>; options: QueryOptions }): Query
  listSessions(options: { dir: string; limit?: number; offset?: number }): Promise<SessionInfo[]>
  getSessionInfo(sessionId: string, options: { dir: string }): Promise<SessionInfo | undefined>
  getSessionMessages(sessionId: string, options: { dir: string }): Promise<StoredMessage[]>
  getSubagentMessages(
    sessionId: string,
    agentId: string,
    options: { dir: string },
  ): Promise<StoredMessage[]>
  deleteSession(sessionId: string, options: { dir?: string }): Promise<void>
  forkSession(
    sessionId: string,
    options: { dir: string; upToMessageId?: string },
  ): Promise<{ sessionId: string }>
  resolveSettings(options: {
    cwd: string
    settingSources?: SettingSource[]
  }): Promise<ResolvedSettings>
  filterEscalatingDefaultMode(resolved: ResolvedSettings): Record<string, unknown>
}

const EXPORTS = [
  'query',
  'listSessions',
  'getSessionInfo',
  'getSessionMessages',
  'getSubagentMessages',
  'deleteSession',
  'forkSession',
  'resolveSettings',
  'filterEscalatingDefaultMode',
] as const

/** Loads the SDK from its installed entry module, checking that it has what Kettu calls. */
export async function loadClaudeSdk(entry: string): Promise<ClaudeSdk> {
  const module = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Record<
    string,
    unknown
  >
  const missing = EXPORTS.filter((name) => typeof module[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(`The Claude Agent SDK at ${entry} lacks ${missing.join(', ')}`)
  }
  return module as unknown as ClaudeSdk
}
