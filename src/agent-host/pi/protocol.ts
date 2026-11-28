// The records of `pi --mode rpc` that Kettu reads and writes, as pi 0.81.0 to 1.5.2 send them.
// Only the fields Kettu uses are named; everything else a record carries is left alone.

export interface PiModel {
  id: string
  name?: string
  provider: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
}

export interface PiState {
  /** Absent, or `unknown/unknown`, while no provider is signed in. */
  model?: PiModel
  thinkingLevel: string
  isStreaming: boolean
  isCompacting?: boolean
  steeringMode?: string
  followUpMode?: string
  /** Absent for a session that is not saved. */
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled?: boolean
  messageCount?: number
  pendingMessageCount?: number
}

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Counted in `output` already. */
  reasoning?: number
  totalTokens: number
  cost?: { total?: number }
}

export interface PiStats {
  sessionFile?: string
  sessionId?: string
  totalMessages?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  cost?: number
  /** `tokens` is null right after a compaction, until a reply reports its use. */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
}

export interface PiCommandInfo {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill' | string
}

export interface PiImage {
  type: 'image'
  data: string
  mimeType: string
}

export type PiContent =
  | { type: 'text'; text: string }
  | PiImage
  | { type: 'thinking'; thinking: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments?: Record<string, unknown> }

export type PiStopReason =
  'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'

export interface PiToolResult {
  content?: PiContent[]
  details?: unknown
  structuredContent?: unknown
}

/** An `AgentMessage`: what a `message` entry stores and the message events carry. */
export interface PiMessage {
  role:
    | 'system'
    | 'user'
    | 'assistant'
    | 'toolResult'
    | 'bashExecution'
    | 'custom'
    | 'branchSummary'
    | 'compactionSummary'
    | string
  content?: string | PiContent[]
  timestamp?: number
  // assistant
  provider?: string
  model?: string
  usage?: PiUsage
  stopReason?: PiStopReason
  errorMessage?: string
  responseId?: string
  // toolResult
  toolCallId?: string
  toolName?: string
  details?: unknown
  isError?: boolean
  // bashExecution
  command?: string
  output?: string
  exitCode?: number
  // custom
  display?: boolean
  // summaries
  summary?: string
}

/** An entry of the session tree, as `get_entries` returns it and the session file stores it. */
export interface PiEntry {
  type:
    | 'message'
    | 'model_change'
    | 'thinking_level_change'
    | 'compaction'
    | 'branch_summary'
    | 'custom'
    | 'custom_message'
    | 'context_edit'
    | 'usage'
    | 'label'
    | 'session_info'
    | string
  id: string
  parentId: string | null
  timestamp?: string
  message?: PiMessage
  // compaction and branch_summary
  summary?: string
  firstKeptEntryId?: string
  // custom_message
  content?: string | PiContent[]
  display?: boolean
  // session_info
  name?: string
  // label
  targetId?: string
  label?: string
}

/** The delta a `message_update` carries. Before 0.84.0 it also held the whole partial message. */
export interface PiMessageDelta {
  type:
    | 'start'
    | 'text_start'
    | 'text_delta'
    | 'text_end'
    | 'thinking_start'
    | 'thinking_delta'
    | 'thinking_end'
    | 'toolcall_start'
    | 'toolcall_delta'
    | 'toolcall_end'
    | 'done'
    | 'error'
    | string
  contentIndex?: number
  delta?: string
  content?: string
  /** `toolcall_start`, from 0.84.3. */
  id?: string
  toolName?: string
  /** `toolcall_end`. */
  toolCall?: { id: string; name: string; arguments?: Record<string, unknown> }
  /** Before 0.84.0: the message so far, whose block at `contentIndex` names a starting call. */
  partial?: { content?: PiContent[] }
}

export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; willRetry?: boolean }
  /** `aborted` from 1.1.0. */
  | { type: 'agent_settled'; aborted?: boolean }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; message: PiMessage }
  | { type: 'message_update'; usage?: PiUsage; assistantMessageEvent: PiMessageDelta }
  | { type: 'message_end'; message: PiMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args?: unknown
      partialResult?: PiToolResult
    }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result?: PiToolResult
      isError?: boolean
    }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'session_info_changed'; name?: string }
  | { type: 'thinking_level_changed'; level: string }
  | { type: 'compaction_start'; reason?: string }
  | {
      type: 'compaction_end'
      reason?: string
      result?: { summary?: string; tokensBefore?: number }
      aborted?: boolean
      willRetry?: boolean
      errorMessage?: string
    }
  | {
      type: 'auto_retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage?: string
    }
  | { type: 'auto_retry_end'; success: boolean; attempt?: number; finalError?: string }
  | { type: 'extension_error'; extensionPath?: string; event?: string; error?: string }
  | PiUiRequest

/** What an extension asks of the user, or tells them, through its UI. */
export interface PiUiRequest {
  type: 'extension_ui_request'
  id: string
  method:
    | 'select'
    | 'confirm'
    | 'input'
    | 'editor'
    | 'notify'
    | 'setStatus'
    | 'setWidget'
    | 'setTitle'
    | 'set_editor_text'
    | string
  title?: string
  message?: string
  options?: unknown[]
  placeholder?: string
  prefill?: string
  notifyType?: string
  statusKey?: string
  statusText?: string
  widgetKey?: string
  widgetLines?: unknown
  widgetPlacement?: string
  /** Milliseconds after which pi answers a dialog by itself. */
  timeout?: number
}

export type PiUiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true }

export interface PiResponse {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/** How pi took a prompt, from 0.99.0: started a run, queued it, or an extension handled it. */
export type PiDisposition = 'started' | 'queued' | 'handled'
