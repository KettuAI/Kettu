// What the usage database stores and what the log readers hand it: one row per request (a log
// message) or per turn and model (Kettu's record), and a cursor per log file read.

import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import type { UsageSource } from '@shared/usage'
import prices from './prices.json'

export type { UsageSource }

export interface UsageRow {
  /** Unique across sources; importing the same request again changes nothing. */
  key: string
  source: UsageSource
  agentId: AgentId
  /** The agent's own session id. */
  sessionId: string | null
  /** The working folder, when known. */
  project: string | null
  /** Normalized with `normalizeModel`; '' when unknown. */
  model: string
  /** ms since the epoch: the request's time, or the turn's end. */
  at: number
  /** Input tokens without the cached part. */
  input: number
  output: number
  /** Only where the agent reports it apart from output. */
  reasoning: number | null
  cacheRead: number
  /** All cache writes; the hour's part is also counted in `cacheWrite1h`. */
  cacheWrite: number
  cacheWrite1h: number
  /** 1 on one row of each of Kettu's turns, else 0. */
  turn: number
  /** Confirmed USD cost reported by the agent's own log; null or omitted to estimate from PRICES. */
  cost?: number | null
}

/** How far a log file, or a reader's database, has been read. */
export interface FileCursor {
  /** The file's path, or a name that survives the file moving (Codex rollouts). */
  id: string
  agentId: AgentId
  size: number
  mtimeNs: bigint
  /** Bytes of complete lines read. */
  offset: number
  /** 32 bits of a hash of the 4 KB before `offset`; null at offset 0. */
  tail: number | null
  /** A reader's own state, such as Codex's running totals. */
  state: string | null
}

/** What a reader is given for one scan. Everything it writes goes through `commit`. */
export interface ScanContext {
  /** The environment the agents run with, so CLAUDE_CONFIG_DIR and the like are honored. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: Platform
  readonly signal: AbortSignal
  cursor(id: string): FileCursor | null
  /** Stores a file's new rows and its cursor in one transaction. */
  commit(rows: UsageRow[], cursor: FileCursor): void
  /** Announces how much this scan will read, once the files are listed. */
  plan(files: number, bytes: number): void
  /** Reports a file done, with the bytes it accounted for in `plan`. */
  done(bytes: number): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface LogReader {
  readonly agentId: AgentId
  /** The folders or files it reads, for Settings. */
  locations(env: ScanContext['env'], home: string): string[]
  /** Reads what changed since the cursors; resolves false when the agent's logs were not found. */
  scan(context: ScanContext): Promise<boolean>
}

/** A row's total, counting reasoning only where it is reported apart from output. */
export function rowTotal(
  row: Pick<UsageRow, 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite'>,
): number {
  return row.input + row.output + (row.reasoning ?? 0) + row.cacheRead + row.cacheWrite
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'])

/**
 * One name per model across agents: lower-cased, without a provider prefix (`openai/`), a
 * reasoning effort (`/high`), a context tag (`[1m]`) or a date suffix (`-20250929`, `-2026-03-05`).
 */
export function normalizeModel(name: string | null | undefined): string {
  let model = (name ?? '').trim().toLowerCase()
  model = model.replace(/\[[^\]]*\]$/, '')
  const parts = model.split('/').filter(Boolean)
  if (parts.length > 1 && EFFORTS.has(parts[parts.length - 1]!)) parts.pop()
  model = parts[parts.length - 1] ?? ''
  return model.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

/** One model's prices, in dollars per token. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The hour's cache writes, where LiteLLM prices them apart. */
  cacheWrite1h?: number
}

/** LiteLLM's chat models, cut by `tools/usage/update-prices.mjs` and keyed by `normalizeModel`. */
export interface PriceList {
  /** The date the snapshot was taken. */
  asOf: string
  models: Record<string, ModelPrice>
}

export const PRICES: PriceList = prices

const TRAILING_VARIANT = /-(?:extra-high|minimal|low|medium|high|xhigh|max|thinking|tiered|[a-z])$/

/**
 * Finds the public API pricing for a normalized model name: tries exact match, strips trailing
 * date, strips reasoning effort / thinking / routing suffixes, and finally falls back to `-preview`.
 * Returns null for any model not listed in `PRICES`.
 */
export function priceFor(model: string): ModelPrice | null {
  if (!model) return null
  const exact = PRICES.models[model]
  if (exact) return exact

  const dated = model.replace(/-\d{8}$/, '')
  if (dated !== model && PRICES.models[dated]) return PRICES.models[dated]!

  // Strip trailing reasoning effort, thinking, or internal routing suffixes (e.g. -high, -n).
  let base = dated
  for (let i = 0; i < 3; i++) {
    const next = base.replace(TRAILING_VARIANT, '')
    if (next === base) break
    base = next
    if (PRICES.models[base]) return PRICES.models[base]!
  }

  if (PRICES.models[`${base}-preview`]) return PRICES.models[`${base}-preview`]!
  return null
}

/**
 * Estimates a single usage row's USD cost using reported log cost when present, otherwise API list
 * prices from `PRICES`. Returns null when the model is unpriced (never fabricates $0.00).
 */
export function estimateRowCost(
  row: Pick<
    UsageRow,
    | 'model'
    | 'input'
    | 'output'
    | 'reasoning'
    | 'cacheRead'
    | 'cacheWrite'
    | 'cacheWrite1h'
    | 'cost'
  >,
): { costUsd: number | null; fromPriceList: boolean } {
  if (typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0) {
    return { costUsd: row.cost, fromPriceList: false }
  }
  const price = priceFor(row.model)
  if (!price) return { costUsd: null, fromPriceList: false }
  const reasoning = row.reasoning ?? 0
  const write1h = Math.min(Math.max(0, row.cacheWrite1h), Math.max(0, row.cacheWrite))
  const write5m = Math.max(0, row.cacheWrite - write1h)
  const hourPrice = price.cacheWrite1h ?? price.cacheWrite
  const cost =
    row.input * price.input +
    (row.output + reasoning) * price.output +
    row.cacheRead * price.cacheRead +
    write5m * price.cacheWrite +
    write1h * hourPrice
  return Number.isFinite(cost) && cost >= 0
    ? { costUsd: cost, fromPriceList: true }
    : { costUsd: null, fromPriceList: false }
}
