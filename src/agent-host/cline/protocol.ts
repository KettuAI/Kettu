// What crosses between the agent host and the process that runs Cline's SDK for an Agent
// (`host.ts`), as JSON-RPC over the process's stdio, and the parts of the SDK's own events Kettu
// reads (@cline/sdk 0.2.0, the runtime the `cline` CLI 3.0.74 is built on).

export type ClineMode = 'plan' | 'act'

/** One request's tokens; the totals count the run so far. */
export interface ClineUsage {
  type: 'usage'
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  reasoningTokenCount?: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  totalCost?: number
}

export interface ClineMedia {
  modality: string
  mediaType: string
  source: { type: string; data?: string }
}

/** The SDK's `AgentEvent`; an error crosses as its message. */
export type ClineEvent =
  | {
      type: 'content_start'
      contentType: 'text' | 'reasoning' | 'media' | 'tool'
      text?: string
      reasoning?: string
      redacted?: boolean
      toolName?: string
      toolCallId?: string
      input?: unknown
    }
  | {
      type: 'content_update'
      contentType: 'tool'
      toolName?: string
      toolCallId?: string
      update: unknown
    }
  | {
      type: 'content_end'
      contentType: 'text' | 'reasoning' | 'media' | 'tool'
      text?: string
      reasoning?: string
      media?: ClineMedia
      toolName?: string
      toolCallId?: string
      output?: unknown
      error?: string
      durationMs?: number
    }
  | { type: 'iteration_start'; iteration: number }
  | { type: 'iteration_end'; iteration: number; hadToolCalls: boolean; toolCallCount: number }
  | ClineUsage
  | {
      type: 'notice'
      noticeType: 'recovery' | 'stop' | 'status'
      message: string
      reason?: string
      /** A compaction's notices say here how far it is: `phase` started, completed or skipped. */
      metadata?: Record<string, unknown>
    }
  | { type: 'done'; reason: string; text: string; iterations: number }
  | { type: 'error'; error: { message: string }; recoverable: boolean; iteration: number }

/** A provider Cline is set up for, or signs in to. */
export interface ClineProvider {
  id: string
  name: string
  /** Cline holds a sign-in or a key it can use. */
  ready: boolean
  /** Signs in through a page rather than with a key. */
  oauth: boolean
}

export interface ClineModel {
  id: string
  name: string
  description?: string
  /** The input the model takes, less than its whole window where the catalog names both. */
  contextWindow?: number
  /** The model reasons when asked to. */
  reasoning: boolean
  images: boolean
}

/** What a session runs with; each field holds for the next request on. */
export interface ClineSettings {
  provider: string
  model: string
  mode: ClineMode
  thinking: boolean
  autoApprove: boolean
}

/** An MCP server a session gets, in the SDK's own transport words. */
export type ClineMcpServer =
  | {
      name: string
      type: 'streamableHttp' | 'sse'
      url: string
      headers: Record<string, string>
      /** Its tools that run without asking. */
      autoAllow: string[]
    }
  | {
      name: string
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
      autoAllow: string[]
    }

// Requests of the agent host.

export interface HelloResult {
  /** The SDK's own version. */
  core: string
  providers: ClineProvider[]
  /** The provider Cline last ran with, when it has one. */
  provider: string | null
}

export interface ModelsParams {
  provider: string
}

export interface ModelsResult {
  models: ClineModel[]
  /** The model the provider starts with: the one Cline last used with it, else its default. */
  model: string
}

export interface OpenParams {
  sessionId: string
  cwd: string
  /** The session may be in Cline's store, which then names its provider and model. */
  resume: boolean
  settings: Partial<ClineSettings>
  mcpServers: ClineMcpServer[]
  /** Kettu's paragraphs for the session's own instructions. */
  instructions: string | null
}

export interface OpenResult {
  /** Cline has the session, so its next request carries on from it. */
  stored: boolean
  settings: ClineSettings
  providers: ClineProvider[]
  models: ClineModel[]
}

export interface PromptParams {
  sessionId: string
  text: string
  /** Images as data URLs. */
  images: string[]
  /** Paths of files Cline reads into the message. */
  files: string[]
}

export interface TurnResult {
  finishReason: string
  model: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number | null
  } | null
}

export interface SteerResult {
  /** False when no turn was running to take the message. */
  injected: boolean
}

export interface SetParams {
  sessionId: string
  settings: Partial<ClineSettings>
}

export interface SetResult {
  settings: ClineSettings
  models: ClineModel[]
}

export interface SignInParams {
  provider: string
}

// What the process sends.

export interface EventNotification {
  sessionId: string
  event: ClineEvent
}

export interface ApprovalParams {
  sessionId: string
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ApprovalResult {
  approved: boolean
  /** Holds for the rest of the session, for this tool. */
  always?: boolean
  reason?: string
}

export interface QuestionParams {
  sessionId: string
  toolCallId: string | null
  question: string
  options: string[]
}

export interface QuestionResult {
  /** Null when the user gave none. */
  answer: string | null
}

export interface OpenUrlParams {
  url: string
}

export const METHOD = {
  hello: 'hello',
  models: 'models',
  open: 'session/open',
  prompt: 'session/prompt',
  steer: 'session/steer',
  cancel: 'session/cancel',
  set: 'session/set',
  close: 'session/close',
  signIn: 'auth/sign-in',
  shutdown: 'shutdown',
  event: 'event',
  approval: 'approval',
  question: 'question',
  openUrl: 'open-url',
} as const

/** Error codes of the process's answers. */
export const ERROR = {
  authRequired: -32000,
  noSession: -32002,
  failed: -32603,
} as const
