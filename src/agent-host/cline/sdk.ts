// Kettu's own types for the part of `@cline/sdk` its host process uses (0.2.0). The package is
// never a dependency: the process loads it from the `cline` package Kettu installed.

import type { ClineEvent } from './protocol'

export interface SdkProviderSettings {
  provider: string
  model?: string
  apiKey?: string
  baseUrl?: string
  reasoning?: { enabled?: boolean; effort?: string }
}

export interface SdkProviderSettingsManager {
  getProviderSettings(providerId: string): SdkProviderSettings | undefined
  getLastUsedProviderSettings(options?: {
    isClinePassEnabled?: boolean
  }): SdkProviderSettings | undefined
  read(): { providers?: Record<string, unknown> }
}

export interface SdkModelInfo {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxInputTokens?: number
  capabilities?: string[]
}

export interface SdkMessage {
  role: string
  content: unknown
}

export interface SdkToolPolicy {
  enabled?: boolean
  autoApprove?: boolean
}

export interface SdkApprovalRequest {
  sessionId: string
  toolCallId: string
  toolName: string
  input: unknown
}

export interface SdkToolContext {
  sessionId?: string
  toolCallId?: string
}

export interface SdkTool {
  name: string
}

export interface SdkSessionRecord {
  sessionId: string
  provider: string
  model: string
  cwd: string
}

export interface SdkAgentResult {
  finishReason: string
  model?: { id?: string; provider?: string }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalCost?: number
  }
}

export type SdkSessionEvent =
  | { type: 'agent_event'; payload: { sessionId: string; event: ClineEvent & { error?: unknown } } }
  | { type: string; payload?: { sessionId?: string } }

export interface SdkStartInput {
  config: Record<string, unknown>
  source?: string
  interactive?: boolean
  initialMessages?: SdkMessage[]
  initialCompactionState?: unknown
  toolPolicies?: Record<string, SdkToolPolicy>
}

export interface SdkCore {
  start(input: SdkStartInput): Promise<{ sessionId: string }>
  send(input: {
    sessionId: string
    prompt: string
    mode?: string
    userImages?: string[]
    userFiles?: string[]
    delivery?: 'queue' | 'steer'
  }): Promise<SdkAgentResult | undefined>
  abort(sessionId: string, reason?: unknown): Promise<void>
  dispose(reason?: string): Promise<void>
  get(sessionId: string): Promise<SdkSessionRecord | undefined>
  readMessages(sessionId: string): Promise<SdkMessage[]>
  readSessionCompactionState(sessionId: string): Promise<unknown>
  subscribe(listener: (event: SdkSessionEvent) => void): () => void
  updateSessionModel(sessionId: string, modelId: string): Promise<void>
  updateSessionConnection(sessionId: string, updates: Record<string, unknown>): Promise<void>
}

export interface SdkCoreOptions {
  clientName: string
  backendMode: 'local'
  capabilities?: {
    requestToolApproval?(
      request: SdkApprovalRequest,
    ): Promise<{ approved: boolean; reason?: string }>
    toolExecutors?: {
      askQuestion?(question: string, options: string[], context: SdkToolContext): Promise<string>
    }
  }
  toolPolicies?: Record<string, SdkToolPolicy>
}

export interface SdkMcpManager {
  registerServer(registration: { name: string; transport: Record<string, unknown> }): Promise<void>
  dispose(): Promise<void>
}

export interface Sdk {
  CORE_BUILD_VERSION: string
  USER_REJECTED_TOOL_REASON?: string
  ClineCore: { create(options: SdkCoreOptions): Promise<SdkCore> }
  ProviderSettingsManager: new () => SdkProviderSettingsManager
  InMemoryMcpManager: new (options: { clientFactory: unknown }) => SdkMcpManager
  Llms: {
    getModelsForProvider(
      providerId: string,
      options?: { filter?: string },
    ): Promise<Record<string, SdkModelInfo>>
    getProvider(providerId: string): Promise<{ name?: string; defaultModelId?: string } | undefined>
  }
  createDefaultMcpServerClientFactory(): unknown
  createMcpTools(options: { serverName: string; provider: SdkMcpManager }): Promise<SdkTool[]>
  isProviderSettingsUsable(providerId: string, settings: SdkProviderSettings | undefined): boolean
  isOAuthProvider(providerId: string): boolean
  getPersistedProviderApiKey(
    providerId: string,
    settings: SdkProviderSettings | undefined,
  ): string | undefined
  getClineDefaultSystemPrompt(options: Record<string, unknown>): string
  /** Undefined when the user never chose in Cline, which then compacts. */
  readCompactionModeGlobally(): 'basic' | 'agentic' | 'off' | undefined
  buildWorkspaceMetadata(cwd: string): Promise<string>
  projectSessionCompactionState(state: unknown, messages: SdkMessage[]): SdkMessage[] | undefined
  createSessionCompactionState(input: Record<string, unknown>): unknown
  loginAndSaveLocalProviderOAuthCredentials(
    manager: SdkProviderSettingsManager,
    providerId: string,
    openUrl: (url: string) => void,
  ): Promise<SdkProviderSettings>
}
