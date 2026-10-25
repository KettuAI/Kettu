// Messages between the usage manager in the host and the usage worker that owns the database
// and reads the agents' logs.

import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import type { ScanProgress } from '@shared/usage'
import type { SourceMap, UsageDbStatus } from './db'
import type { UsageRow } from './model'

export interface ScanRequest {
  agents: AgentId[]
  // Each agent's own environment, which carries the configuration folder picked for it.
  envs: Partial<Record<AgentId, Record<string, string | undefined>>>
  home: string
  platform: Platform
}

/** How one agent's part of a scan went; `found` is false when its logs are not there. */
export interface ScanResult {
  agentId: AgentId
  found: boolean
  error: string | null
}

export type UsageRequest =
  | { id: number; op: 'write'; rows: UsageRow[] }
  | { id: number; op: 'summary'; dayStarts: number[]; from: number; to: number; sources: SourceMap }
  | { id: number; op: 'totals'; from: number; to: number; sources: SourceMap }
  | { id: number; op: 'stats' }
  | ({ id: number; op: 'scan' } & ScanRequest)
  | { id: number; op: 'cancel' }
  | { id: number; op: 'removeLogs'; agentId: AgentId }
  | { id: number; op: 'clearRecord' }
  | { id: number; op: 'close' }

export type UsageReply =
  | { type: 'ready'; status: UsageDbStatus }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** The scan's progress, at most every 200 ms; null once it ends. */
  | { type: 'progress'; progress: ScanProgress | null }
  /** Rows were added or changed, at most every 200 ms. */
  | { type: 'changed' }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string }
