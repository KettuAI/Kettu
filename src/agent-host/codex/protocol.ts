// The part of `codex app-server`'s JSON-RPC protocol Kettu uses, as Codex 0.166.0 defines it. Only
// the fields Kettu reads or sends are typed; the server sends many more, which nothing here reads,
// so a newer Codex that adds fields keeps working.
// Adapted from the TypeScript types `codex app-server generate-ts` writes for Codex 0.166.0
// (Apache-2.0, Copyright OpenAI):
// https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs/app-server-protocol

export type RequestId = string | number

export interface ClientInfo {
  name: string
  title: string | null
  version: string
}

export interface InitializeParams {
  clientInfo: ClientInfo
  capabilities: {
    experimentalApi: boolean
    requestAttestation: boolean
    optOutNotificationMethods?: string[] | null
  } | null
}

export interface InitializeResponse {
  /** `<client name>/<Codex version> (<os>; <arch>) ...` */
  userAgent: string
  codexHome: string
  platformFamily?: string
  platformOs?: string
}

export type ReasoningEffort = string

export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean
        rules: boolean
        skill_approval: boolean
        request_permissions: boolean
        mcp_elicitations: boolean
      }
    }

export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: unknown }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export type CollaborationModeKind = 'plan' | 'default'

export interface CollaborationMode {
  mode: CollaborationModeKind
  settings: {
    model: string
    reasoning_effort: ReasoningEffort | null
    developer_instructions: null
  }
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined }

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] }

export interface Thread {
  id: string
  /** Set for a subagent's thread. */
  parentThreadId: string | null
  preview: string
  ephemeral: boolean
  /** `legacy` threads give their history only with `thread/read` and `includeTurns`. */
  historyMode?: 'legacy' | 'paginated' | (string & {})
  model: string | null
  reasoningEffort: ReasoningEffort | null
  /** Unix seconds. */
  createdAt: number
  updatedAt: number
  status: ThreadStatus
  cwd: string
  agentNickname: string | null
  agentRole: string | null
  name: string | null
  turns: Turn[]
}

export interface ThreadSettings {
  model: string
  modelProvider: string
  serviceTier: string | null
  approvalPolicy: AskForApproval
  approvalsReviewer: ApprovalsReviewer
  sandbox: SandboxPolicy
  reasoningEffort: ReasoningEffort | null
}

/** What `thread/start`, `thread/resume` and `thread/fork` answer with. */
export interface ThreadResponse extends ThreadSettings {
  thread: Thread
  /** Only `thread/resume` answers with it; absent from older servers. */
  collaborationMode?: CollaborationMode | null
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The overrides `thread/start`, `thread/resume` and `thread/fork` take. */
export interface ThreadOverrides {
  model?: string | null
  serviceTier?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandbox?: SandboxMode | null
  config?: Record<string, JsonValue> | null
}

export interface ThreadStartParams extends ThreadOverrides {
  ephemeral?: boolean | null
  experimentalRawEvents?: boolean
}

export interface ThreadResumeParams extends ThreadOverrides {
  threadId: string
  excludeTurns?: boolean
}

export interface ThreadForkParams extends ThreadOverrides {
  threadId: string
  /** The last turn the fork keeps, inclusive. */
  lastTurnId?: string | null
  ephemeral?: boolean
  excludeTurns?: boolean
}

export type ThreadSourceKind = 'cli' | 'vscode' | 'exec' | 'appServer' | 'unknown' | (string & {})

export interface ThreadListParams {
  cursor?: string | null
  limit?: number | null
  sourceKinds?: ThreadSourceKind[] | null
  cwd?: string | string[] | null
}

export interface ThreadListResponse {
  data: Thread[]
  nextCursor: string | null
}

export interface ThreadItemsListParams {
  threadId: string
  turnId?: string | null
  cursor?: string | null
  limit?: number | null
  sortDirection?: 'asc' | 'desc' | null
}

export interface ThreadItemsListResponse {
  data: { turnId: string; item: ThreadItem }[]
  nextCursor: string | null
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export interface TurnError {
  message: string
  codexErrorInfo: JsonValue | null
  additionalDetails: string | null
}

export interface Turn {
  id: string
  /** The turn this one runs inside, as a review's own turn runs inside the turn it started. */
  rootTurnId?: string | null
  items: ThreadItem[]
  status: TurnStatus
  error: TurnError | null
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'image'; fileId: string }
  | { type: 'localImage'; path: string }
  | { type: 'audio'; url: string }
  | { type: 'localAudio'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandboxPolicy?: SandboxPolicy | null
  model?: string | null
  serviceTier?: string | null
  effort?: ReasoningEffort | null
  summary?: 'auto' | 'concise' | 'detailed' | 'none' | null
  collaborationMode?: CollaborationMode | null
}

export interface TurnSteerParams {
  threadId: string
  input: UserInput[]
  expectedTurnId: string
}

export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string }

export type PatchChangeKind =
  { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }

export interface FileUpdateChange {
  path: string
  kind: PatchChangeKind
  /** The new file for an add, the old one for a delete, a unified diff for an update. */
  diff: string
}

export type CollabAgentStatus =
  'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound'

export type WebSearchAction =
  | { type: 'search'; query: string | null; queries: string[] | null }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; url: string | null; pattern: string | null }
  | { type: 'other' }

interface ItemTimes {
  startedAtMs?: number | null
  completedAtMs?: number | null
}

export type ThreadItem = ItemTimes &
  (
    | { type: 'userMessage'; id: string; content: UserInput[] }
    | { type: 'agentMessage'; id: string; text: string; phase: string | null }
    | { type: 'plan'; id: string; text: string }
    | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
    | {
        type: 'commandExecution'
        id: string
        command: string
        cwd: string
        status: 'inProgress' | 'completed' | 'failed' | 'declined'
        commandActions: CommandAction[]
        aggregatedOutput: string | null
        exitCode: number | null
      }
    | {
        type: 'fileChange'
        id: string
        changes: FileUpdateChange[]
        status: 'inProgress' | 'completed' | 'failed' | 'declined'
      }
    | {
        type: 'mcpToolCall'
        id: string
        server: string
        tool: string
        status: 'inProgress' | 'completed' | 'failed'
        arguments: JsonValue
        result: { content: JsonValue[] } | null
        error: { message: string } | null
      }
    | {
        type: 'dynamicToolCall'
        id: string
        tool: string
        arguments: JsonValue
        status: 'inProgress' | 'completed' | 'failed'
        contentItems:
          | (
              | { type: 'inputText'; text: string }
              | { type: 'inputImage'; imageUrl: string }
              | { type: 'inputAudio'; audioUrl: string }
            )[]
          | null
      }
    | {
        type: 'collabAgentToolCall'
        id: string
        tool: string
        status: 'inProgress' | 'completed' | 'failed' | 'interrupted'
        senderThreadId: string
        receiverThreadIds: string[]
        prompt: string | null
        agentsStates: Record<
          string,
          { status: CollabAgentStatus; message: string | null } | undefined
        >
      }
    | {
        type: 'subAgentActivity'
        id: string
        kind: 'started' | 'interacted' | 'interrupted' | 'completed'
        agentThreadId: string
        agentPath: string
      }
    | { type: 'webSearch'; id: string; query: string; action: WebSearchAction | null }
    | { type: 'imageView'; id: string; path: string }
    | {
        type: 'imageGeneration'
        id: string
        status: string
        revisedPrompt: string | null
        result?: string
        savedPath?: string
      }
    | { type: 'enteredReviewMode'; id: string; review: string }
    | { type: 'exitedReviewMode'; id: string; review: string }
    | { type: 'contextCompaction'; id: string }
    | { type: 'hookPrompt'; id: string }
    | { type: 'functionCallOutput'; id: string }
    | { type: 'sleep'; id: string }
  )

export interface TokenUsageBreakdown {
  totalTokens: number
  /** Includes the cached and cache-written input. */
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface ThreadTokenUsage {
  /** The thread's running total. */
  total: TokenUsageBreakdown
  /** The latest request to the model. */
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface ReasoningEffortOption {
  reasoningEffort: ReasoningEffort
  description: string
}

export interface Model {
  id: string
  displayName: string
  description: string
  hidden?: boolean
  supportedReasoningEfforts: ReasoningEffortOption[]
  defaultReasoningEffort: ReasoningEffort
  /** Deprecated for `serviceTiers`; still names `fast`. */
  additionalSpeedTiers?: string[]
  serviceTiers?: { id: string; name: string; description?: string }[]
  isDefault: boolean
}

export interface ModelListResponse {
  data: Model[]
  nextCursor: string | null
}

export type PlanType = string

export type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: PlanType }
  | { type: 'amazonBedrock' }
  | { type: 'gcp' }

export interface GetAccountResponse {
  account: Account | null
  requiresOpenaiAuth: boolean
}

export type AuthMode = string

export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  /** Unix seconds. */
  resetsAt: number | null
}

export interface RateLimitSnapshot {
  limitId: string | null
  limitName: string | null
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
}

export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null
}

// What Codex's commands use.

export interface SkillMetadata {
  name: string
  description: string
  shortDescription?: string
  path: string
  enabled: boolean
}

export interface SkillsListResponse {
  data: { cwd: string; skills: SkillMetadata[] }[]
}

export type McpServerConnectionStatus =
  | 'notStarted'
  | 'starting'
  | 'connected'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled'

export interface McpServerStatus {
  name: string
  /** Null when Codex has no connection state, or the server's configuration changed. */
  runtimeStatus: McpServerConnectionStatus | null
  tools: Record<string, unknown>
  /** Set when the server gave no tool list. */
  toolsError: string | null
  authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
}

export interface ListMcpServerStatusResponse {
  data: McpServerStatus[]
  nextCursor: string | null
}

export interface McpServerStartupNotification {
  /** Null for every thread. */
  threadId: string | null
  name: string
  status: 'starting' | 'ready' | 'failed' | 'cancelled'
  error: string | null
  failureReason?: 'reauthenticationRequired' | null
}

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string }

export interface ReviewStartResponse {
  turn: Turn
  reviewThreadId: string
}

export type ThreadGoalStatus =
  'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'

export interface ThreadGoalSetResponse {
  goal: { threadId: string; objective: string; status: ThreadGoalStatus }
}

// Requests the server sends.

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } }
  | 'decline'
  | 'cancel'

export interface NetworkPolicyAmendment {
  host: string
  action: 'allow' | 'deny'
}

export interface AdditionalPermissions {
  network?: { enabled?: boolean | null } | null
  fileSystem?: { read?: string[] | null; write?: string[] | null } | null
}

export interface CommandExecutionRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  networkApprovalContext?: { host: string; protocol: string } | null
  command?: string | null
  cwd?: string | null
  commandActions?: CommandAction[] | null
  additionalPermissions?: AdditionalPermissions | null
  proposedExecpolicyAmendment?: string[] | null
  proposedNetworkPolicyAmendments?: NetworkPolicyAmendment[] | null
  availableDecisions?: CommandExecutionApprovalDecision[] | null
}

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface FileChangeRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}

export interface PermissionsRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  cwd: string
  reason: string | null
  permissions: AdditionalPermissions
}

export interface PermissionsRequestApprovalResponse {
  permissions: AdditionalPermissions
  scope: 'turn' | 'session'
  strictAutoReview?: boolean
}

export interface ToolRequestUserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: { label: string; description: string }[] | null
}

export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  questions: ToolRequestUserInputQuestion[]
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>
}

export type McpServerElicitationRequestParams = {
  threadId: string
  turnId: string | null
  serverName: string
} & (
  | { mode: 'url'; _meta: JsonValue | null; message: string; url: string; elicitationId: string }
  | {
      mode: 'form' | 'openai/form' | 'openaiForm'
      _meta: JsonValue | null
      message: string
      requestedSchema: JsonValue
    }
  | { mode: 'openai/userVerification'; _meta: JsonValue | null; title: string; description: string }
)

export interface McpServerElicitationRequestResponse {
  action: 'accept' | 'decline' | 'cancel'
  content: JsonValue | null
  _meta: JsonValue | null
}
