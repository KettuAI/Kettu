// What a scenario gets to work with during one prompt turn.

import type {
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable'
import type { ScenarioOptions } from './options.ts'

export interface FakeSessionState {
  id: string
  cwd: string
  title: string | null
  turns: number
  usedTokens: number
  /** The entries its `session/load` replay synthesizes; null replays what it recorded. */
  largeHistory: number | null
  /** Its last prompt signed the agent out with the auth-required scenario. */
  signedOut: boolean
  /** Its last prompt failed with the out-of-credit scenario. */
  outOfCredit: boolean
  mode: string
  model: string
  thought: string
  fast: boolean
  /** The MCP servers of its latest `session/new`, `load`, `resume` or `fork`. */
  mcpServers: McpServer[]
}

export interface Turn {
  readonly session: FakeSessionState
  readonly options: ScenarioOptions
  /** The prompt text, without the scenario command. */
  readonly text: string
  /** The prompt's blocks as the client sent them. */
  readonly prompt: readonly ContentBlock[]
  /** The prompt before this one in the session's history, which a fork may have cut. */
  readonly previousPrompt: string | null
  /** Aborted when the client cancels the turn, unless the scenario ignores cancellation. */
  readonly signal: AbortSignal
  readonly supportsSubagents: boolean
  /** Sends a session update and records it for `session/load`; `sessionId` targets a child. */
  send(update: SessionUpdate, sessionId?: string): Promise<void>
  /** Sends an update that is not part of ACP, to check that clients ignore it. */
  sendRaw(update: Record<string, unknown>): Promise<void>
  /** A scaled delay that ends early when the turn is cancelled. */
  sleep(ms: number): Promise<void>
  requestPermission(
    toolCall: ToolCallUpdate,
    options: PermissionOption[],
    request?: { sessionId?: string; withdrawAfterMs?: number | null },
  ): Promise<string | 'cancelled' | 'withdrawn'>
  /** Registers a child session so that `session/cancel` for it aborts `signal`. */
  registerChild(childId: string, cancel: () => void): void
  /** Signs the agent out, as the auth-required scenario does. */
  signOut(): void
  exit(code: number): void
  log(line: string): void
  messageId(): string
}

export type Scenario = (turn: Turn) => Promise<StopReason>
