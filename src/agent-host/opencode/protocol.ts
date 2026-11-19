// The parts of OpenCode 2's HTTP API and event stream that Kettu uses, as OpenCode 2.3.2 sends
// them. OpenCode marks the API experimental, so every field is read as it may be missing.

export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface StructuredError {
  type: string
  message: string
  status?: number
}

export interface SessionInfo {
  id: string
  parentID?: string
  fork?: { sessionID: string }
  agent?: string
  model?: ModelRef
  cost?: number
  tokens?: TokenUsage
  outcome?: 'succeeded' | 'failed' | 'interrupted'
  time: { created: number; updated: number; busy?: number; idle?: number }
  title?: string
  location: { directory: string }
}

export interface ModelInfo {
  id: string
  providerID: string
  name: string
  enabled?: boolean
  variants?: { id: string }[]
  limit?: { context?: number }
}

export interface AgentInfo {
  id: string
  name: string
  description?: string
  mode: string
  hidden?: boolean
}

export interface CommandInfo {
  name: string
  description?: string
}

export interface ServerInfo {
  version: string
}

export type ToolResultContent =
  { type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string | null }

export interface PermissionRequestInfo {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  source?: { type: string; messageID: string; id: string }
  message?: string
}

export interface FormOption {
  value: string
  label: string
  description?: string
}

export type FormFieldInfo = {
  key: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
} & (
  | {
      type: 'string'
      format?: 'email' | 'uri' | 'date' | 'date-time'
      minLength?: number
      maxLength?: number
      default?: string
      options?: FormOption[]
      custom?: boolean
    }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; default?: number }
  | { type: 'boolean'; default?: boolean }
  | {
      type: 'multiselect'
      options: FormOption[]
      minItems?: number
      maxItems?: number
      custom?: boolean
      default?: string[]
    }
  | { type: 'external'; url: string }
)

export interface FormInfo {
  id: string
  sessionID: string
  title: string
  metadata?: { kind?: string; tool?: { messageID: string; id: string } }
  fields: FormFieldInfo[]
}

export type FormAnswer = Record<string, string | number | boolean | string[]>

/** A tool call inside an assistant message, as `GET message` lists it. */
export interface ToolPart {
  type: 'tool'
  id: string
  name: string
  state:
    | { status: 'streaming'; input: string }
    | { status: 'running'; input: Record<string, unknown>; metadata?: Record<string, unknown> }
    | {
        status: 'completed'
        input: Record<string, unknown>
        content?: ToolResultContent[]
        metadata?: Record<string, unknown>
      }
    | {
        status: 'error'
        input: Record<string, unknown>
        error: StructuredError
        content?: ToolResultContent[]
        metadata?: Record<string, unknown>
      }
}

export type AssistantPart =
  { type: 'text'; text: string } | { type: 'reasoning'; text: string } | ToolPart

export interface MessageFile {
  data: string
  mime: string
  source?: { type: 'inline' } | { type: 'uri'; uri: string }
  name?: string
}

export type MessageInfo =
  | { type: 'user'; id: string; text: string; files?: MessageFile[] }
  | {
      type: 'assistant'
      id: string
      model?: ModelRef
      content: AssistantPart[]
      finish?: string
      tokens?: TokenUsage
      cost?: number
      error?: StructuredError
      time?: { created: number; completed?: number }
    }
  | {
      type: 'compaction'
      id: string
      status?: 'running' | 'completed' | 'failed'
      summary?: string
      time?: { created: number }
    }
  | {
      type: 'idle'
      id: string
      outcome: 'succeeded' | 'failed' | 'interrupted'
      error?: StructuredError
    }
  | {
      type: 'synthetic' | 'system' | 'skill' | 'shell'
      id: string
      text?: string
      metadata?: Record<string, unknown>
    }
  | { type: 'model-switched' | 'agent-switched' | 'location-switched'; id: string }

interface OfSession {
  sessionID: string
}

interface OfMessage extends OfSession {
  assistantMessageID: string
}

interface OfPart extends OfMessage {
  ordinal: number
}

interface OfTool extends OfMessage {
  id: string
}

/** What each event Kettu reads carries, by its type. */
export interface EventData {
  'server.connected': Record<string, never>
  'session.created': OfSession & {
    parentID?: string
    title?: string
    location?: { directory: string }
  }
  'session.deleted': OfSession
  'session.renamed': OfSession & { title: string }
  'session.model.selected': OfSession & { model: ModelRef }
  'session.agent.selected': OfSession & { agent: string }
  'session.usage.updated': OfSession & { cost: number; tokens: TokenUsage }
  'session.inbox.enqueued': OfSession & {
    inboxID: string
    item: { type: string; payload?: { metadata?: Record<string, unknown> } }
  }
  'session.inbox.delivered': OfSession & { inboxID: string }
  'session.execution.started': OfSession
  'session.execution.succeeded': OfSession
  'session.execution.failed': OfSession & { error?: StructuredError }
  'session.execution.interrupted': OfSession & { reason?: string }
  'session.step.started': OfMessage & { agent?: string; model?: ModelRef; started?: number }
  'session.step.first-token': OfMessage
  'session.step.streamed': OfMessage
  'session.step.ended': OfMessage & { finish?: string; tokens?: TokenUsage; cost?: number }
  'session.step.failed': OfMessage & { error?: StructuredError; tokens?: TokenUsage }
  'session.retry.scheduled': OfSession & { attempt?: number; error?: StructuredError }
  'session.text.started': OfPart
  'session.text.delta': OfPart & { delta: string }
  'session.text.ended': OfPart & { text: string }
  'session.reasoning.started': OfPart
  'session.reasoning.delta': OfPart & { delta: string }
  'session.reasoning.ended': OfPart & { text: string }
  'session.tool.input.started': OfTool & { name: string }
  'session.tool.input.delta': OfTool
  'session.tool.input.ended': OfTool & { text?: string }
  'session.tool.called': OfTool & { input?: Record<string, unknown> }
  'session.tool.progress': OfTool & { metadata?: Record<string, unknown> }
  'session.tool.success': OfTool & {
    content?: ToolResultContent[]
    metadata?: Record<string, unknown>
  }
  'session.tool.failed': OfTool & {
    error?: StructuredError
    content?: ToolResultContent[]
    metadata?: Record<string, unknown>
  }
  'session.compaction.started': OfSession & { reason?: string; inputID?: string }
  'session.compaction.delta': OfSession & { text: string }
  'session.compaction.ended': OfSession & { text?: string }
  'session.compaction.failed': OfSession & { error?: StructuredError }
  'permission.asked': PermissionRequestInfo
  'permission.replied': OfSession & { requestID: string; reply: string }
  'form.created': { form: FormInfo }
  'form.replied': OfSession & { id: string }
  'form.cancelled': { id: string; sessionID?: string }
  'command.updated': Record<string, unknown>
  'model.updated': Record<string, unknown>
  'agent.updated': Record<string, unknown>
}

export type EventType = keyof EventData

export interface ServerEvent {
  id?: string
  type: string
  data?: unknown
  location?: { directory: string }
}

/** The session an event is about, or null for one about the server or a folder. */
export function sessionOf(event: ServerEvent): string | null {
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const direct = (data as { sessionID?: unknown }).sessionID
  if (typeof direct === 'string') return direct
  const form = (data as { form?: { sessionID?: unknown } }).form
  return typeof form?.sessionID === 'string' ? form.sessionID : null
}
