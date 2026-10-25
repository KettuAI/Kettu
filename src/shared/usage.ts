// The usage page's data, as the agent host serves it.

import type { AgentId } from './thread'

export type UsageSource = 'overbench' | 'log'

/** Which numbers the page counts: the logs where they are on, or OverBench's record alone. */
export type UsageScope = 'computer' | 'overbench'

/** What a token sum carries beside the tokens: how many rows, turns, and what they cost. */
export interface UsageFigures {
  /** The rows summed: one per request in an agent's log, or OverBench's rows. */
  requests: number
  /** OverBench's turns, one per turn whatever its models; 0 for imported logs. */
  turns: number
  /** Dollars over the models with a price; null when none of them is priced. */
  cost: number | null
  /** Tokens of the models without a price, which no cost counts. */
  unpricedTokens: number
  /** Dollars the cache reads saved: cache reads times the input price less the cache read price. */
  cacheSaved: number
}

/** Token counts; `reasoning` is 0 for agents whose output already includes it. */
export interface TokenParts extends UsageFigures {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface DayUsage extends TokenParts {
  /** Index into the request's days. */
  day: number
  agentId: AgentId
}

export interface ModelUsage extends TokenParts {
  agentId: AgentId
  model: string
}

export interface ProjectUsage extends TokenParts {
  agentId: AgentId
  /** The working folder, or null when the agent recorded none. */
  project: string | null
  /** The folder is one of OverBench's No project folders. */
  scratch: boolean
}

export interface UsageSummary {
  days: DayUsage[]
  models: ModelUsage[]
  projects: ProjectUsage[]
  /** The source each agent counted from; an agent left out has nothing to count. */
  sources: Partial<Record<AgentId, UsageSource>>
  /** The first quarter hour with usage under those sources, or null with none. */
  first: number | null
  /** The agents with usage under either scope, at any time, so both offer the same agent filter. */
  agents: AgentId[]
  /** The date of the price list the cost was computed with. */
  pricesAsOf: string
}

export interface UsageTotal extends UsageFigures {
  total: number
  byAgent: Partial<Record<AgentId, number>>
}

export interface ScanProgress {
  files: number
  bytes: number
  doneFiles: number
  doneBytes: number
}

/** One agent's logs, as Settings shows them. */
export interface UsageLogStatus {
  agentId: AgentId
  /** The folders or files its reader looks at. */
  locations: string[]
  /** null until a scan this run has looked. */
  found: boolean | null
  /** Requests imported, and the first and last moments they cover. */
  rows: number
  first: number | null
  last: number | null
  syncedAt: number | null
  error: string | null
}

export interface UsageStatus {
  fromComputer: boolean
  /** The scan running now, or null. */
  scanning: ScanProgress | null
  /** When OverBench's own record starts, or null while it is empty. */
  recordSince: number | null
  logs: UsageLogStatus[]
  /** The database could not be opened, or a newer app wrote it. */
  unavailable: boolean
}

/** A row's total, counting reasoning only where it is reported apart from output. */
export function partsTotal(parts: TokenParts): number {
  return parts.input + parts.output + parts.reasoning + parts.cacheRead + parts.cacheWrite
}
