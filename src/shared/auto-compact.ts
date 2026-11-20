// When each harness compacts a conversation on its own, as its agent page sets it: in the unit the
// harness's own setting takes, never converted, since the context window changes with the model.

import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, harnessOf } from './agents'
import type { AgentId, HarnessId } from './thread'

/**
 * `window`: the context size in tokens the harness works within, compacting near it (Claude
 * Code's `autoCompactWindow`). `trigger`: the token count at which it compacts. `percent`: the
 * share of the context window at which it compacts. `reserve`: tokens kept free of the window.
 */
export type CompactUnit = 'window' | 'trigger' | 'percent' | 'reserve'

export interface CompactSpec {
  unit: CompactUnit
  /** Inclusive range; tokens for every unit but `percent`, which is in percent. */
  min: number
  max: number
  /** Set when a value can be set per model, from the harness version `since` when it names one. */
  perModel?: { since?: string }
}

const TOKENS = { min: 10_000, max: 1_000_000 }
const PERCENT = { min: 10, max: 100 }
const RESERVE = { min: 1_000, max: 500_000 }

export const COMPACT_SPECS: Readonly<Partial<Record<HarnessId, CompactSpec>>> = {
  'claude-code': {
    unit: 'window',
    min: AUTO_COMPACT_MIN,
    max: AUTO_COMPACT_MAX,
    perModel: {},
  },
  codebuddy: { unit: 'window', min: 100_000, max: 1_000_000 },
  codex: { unit: 'trigger', ...TOKENS },
  droid: { unit: 'trigger', ...TOKENS },
  'mistral-vibe': { unit: 'trigger', ...TOKENS },
  vtcode: { unit: 'trigger', ...TOKENS },
  devin: { unit: 'trigger', ...TOKENS },
  'crow-cli': { unit: 'trigger', ...TOKENS },
  omp: { unit: 'trigger', ...TOKENS },
  gemini: { unit: 'percent', ...PERCENT },
  qwen: { unit: 'percent', ...PERCENT },
  // Kimi Code's schema takes 0.5 to 0.99.
  kimi: { unit: 'percent', min: 50, max: 99 },
  grok: { unit: 'percent', ...PERCENT },
  hermes: { unit: 'percent', ...PERCENT },
  goose: { unit: 'percent', ...PERCENT },
  kilo: { unit: 'percent', ...PERCENT },
  // dsh rejects a threshold at or under the 0.16 of the conversation it keeps.
  deepseek: { unit: 'percent', min: 20, max: 100 },
  codewhale: { unit: 'percent', ...PERCENT },
  opencode: { unit: 'reserve', ...RESERVE },
  pi: { unit: 'reserve', ...RESERVE, perModel: { since: '0.86.0' } },
}

export function compactSpec(harness: HarnessId): CompactSpec | null {
  return COMPACT_SPECS[harness] ?? null
}

/** Whether the agent's page sets when its harness compacts. */
export function takesAutoCompact(id: AgentId): boolean {
  return compactSpec(harnessOf(id)) !== null
}

const TOKEN_STEPS = [
  100_000, 128_000, 200_000, 256_000, 272_000, 300_000, 400_000, 500_000, 750_000, 1_000_000,
]
const PERCENT_STEPS = [50, 60, 70, 75, 80, 85, 90, 95]
const RESERVE_STEPS = [8_000, 16_000, 32_000, 64_000, 100_000]

/** The values Settings offers beside Auto and a typed one, within the spec's range. */
export function compactSteps(spec: CompactSpec): number[] {
  const steps =
    spec.unit === 'percent' ? PERCENT_STEPS : spec.unit === 'reserve' ? RESERVE_STEPS : TOKEN_STEPS
  return steps.filter((value) => value >= spec.min && value <= spec.max)
}

export function inCompactRange(spec: CompactSpec, value: number): boolean {
  return Number.isInteger(value) && value >= spec.min && value <= spec.max
}

/**
 * What the user typed as a value of the unit: `272K`, `272k`, `1M`, `1.5m` or `272000` for tokens,
 * `85` or `85%` for a whole percent. Null when it reads as none; the range is checked apart.
 */
export function parseCompactValue(unit: CompactUnit, text: string): number | null {
  const typed = text.trim().replace(/[,_\s]/g, '')
  if (unit === 'percent') {
    const match = /^(\d+)%?$/.exec(typed)
    return match ? Number(match[1]) : null
  }
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(typed)
  if (!match) return null
  const scale = match[2] ? (match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1
  return Math.round(Number(match[1]) * scale)
}

/** A value as Settings writes it: 272K, 1M, 1.5M, 85%. */
export function compactLabel(unit: CompactUnit, value: number): string {
  if (unit === 'percent') return `${Math.round(value * 10) / 10}%`
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}
