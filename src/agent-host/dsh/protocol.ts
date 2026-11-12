// The parts of DeepSeek Harness's SDK wire (`dsh --profile sdk`, @deepseek-ai/dsh 0.2.2) that Kettu
// reads and sends, written from its sources since Kettu depends on none of its packages. Every
// session event the runtime logs reaches the client; unknown types are read as nothing.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface InitializeParams {
  cwd: string
  approvalRequests?: boolean
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
  capabilities?: { userQuestions?: boolean }
}

export interface InitializeResult {
  serverInfo: { name: string; version: string }
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true }
  | { type: 'file'; attachment: { attachmentId: string; name: string; bytes: number } }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-addition'; toolName: string }
  | { type: 'tool-removal'; toolName: string }

/** A prompt's block: durable content, or an image the runtime stores before it queues the prompt. */
export type PromptContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string; name?: string }

export type QueryResult =
  { kind: 'prompt'; messageId: string } | { kind: 'command'; execution: unknown }

export type MessageSource =
  | { kind: 'user' }
  | { kind: 'model'; provider: string; model: string }
  | { kind: 'tool'; callId: string }
  | { kind: string; [key: string]: unknown }

export interface WireMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'developer'
  content: ContentBlock[]
  source?: MessageSource
  toolCallId?: string
  isError?: boolean
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface LlmFailure {
  message: string
  code: string
  status?: number
}

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: { kind: string } }
  | { kind: 'blocked' }
  | { kind: 'error'; error: LlmFailure }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }
  | { kind: 'forked' }

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** The events Kettu reads, by type; each arrives in the envelope below. */
export interface EventData {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'user/message': WireMessage
  'assistant/message': {
    turn: number
    step: number
    message: WireMessage
    usage?: TokenUsage
    interrupted?: true
  }
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
  'tool/result': {
    turn: number
    step: number
    message: WireMessage
    error?: { name: string; code: string; reason?: string }
    meta?: JsonValue
  }
  'request/context': { provider: string; model: string; contextWindow?: number }
  'model/selection': { provider: string; model: string; reasoningEffort?: string }
  'permission/preset': { preset: string }
  'plan/mode': { active: boolean }
  'todo/write': { todos: TodoItem[] }
  'session/title': { title: string }
  'compaction/start': { compactionId: string; turn: number | null }
  'compaction/end': { compactionId: string; error?: unknown }
  'llm/retry': { retry: number; maxRetries?: number; delayMs: number; failure: LlmFailure }
}

export type EventType = keyof EventData

export interface SessionEvent<T extends string = string> {
  type: T
  seq: number
  time: number
  data: T extends EventType ? EventData[T] : unknown
}

export interface SessionEventNotification {
  sessionId: string
  event: SessionEvent
}

export interface SessionStatusNotification {
  sessionId: string
  status: 'idle' | 'running'
}

export interface SubagentStartedNotification {
  parentSessionId: string
  childSessionId: string
}

export interface SubagentFinishedNotification {
  parentSessionId: string
  childSessionId: string
  status: 'ok' | 'error'
  stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
}

export interface ApprovalRequestParams {
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
  intent?:
    | { kind: 'plan-review'; approve: string; callId?: string }
    | { kind: 'approval'; approve: string; reject: string; always?: string }
}

export interface QuestionRequest {
  requestId: string
  sessionId: string
  questions: QuestionItem[]
}

export type QuestionResult =
  { answers: { id: string; selected: string[]; custom?: string }[] } | { cancelled: true }

/** The diffs `write` and `edit` attach to their results. */
export interface FileChangeMeta {
  path: string
  diffs: { path: string; oldText: string | null; newText: string }[]
  operation?: 'create' | 'update'
}
