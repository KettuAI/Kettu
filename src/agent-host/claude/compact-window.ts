// The context window Claude Code runs a model in, as it resolves it: the auto-compact window from
// CLAUDE_CODE_AUTO_COMPACT_WINDOW, else the model's entry in `modelSettings`, else the top-level
// setting, and never wider than the model's own window.

import { canonicalClaudeModel } from '@shared/agents'
import type { Env } from '../find-command'

const ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

/** What the settings and the environment set; `auto` keeps the model's own window. */
export interface CompactWindows {
  env: number | null
  all: number | null
  byModel: ReadonlyMap<string, number | 'auto'>
}

export const NO_COMPACT_WINDOWS: CompactWindows = { env: null, all: null, byModel: new Map() }

function tokens(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The windows in Claude Code's resolved settings and the agent's environment. */
export function compactWindows(settings: Record<string, unknown>, env: Env): CompactWindows {
  const own = isRecord(settings.env) ? settings.env[ENV] : undefined
  const byModel = new Map<string, number | 'auto'>()
  if (isRecord(settings.modelSettings)) {
    for (const [key, entry] of Object.entries(settings.modelSettings)) {
      if (!isRecord(entry)) continue
      const value = entry.autoCompactWindow === 'auto' ? 'auto' : tokens(entry.autoCompactWindow)
      const model = canonicalClaudeModel(key)
      // The exact key wins over another spelling of the same model.
      if (value !== null && (key === model || !byModel.has(model))) byModel.set(model, value)
    }
  }
  return {
    env: tokens(own) ?? tokens(env[ENV]),
    all: tokens(settings.autoCompactWindow),
    byModel,
  }
}

/**
 * The window of `model`, given its own window when Claude Code reported one; null when neither the
 * settings nor Claude Code say.
 */
export function contextWindow(
  windows: CompactWindows,
  model: string,
  own: number | null,
): number | null {
  const entry = windows.byModel.get(canonicalClaudeModel(model))
  const set = windows.env ?? (entry === 'auto' ? null : (entry ?? windows.all))
  if (set === null) return own
  return own === null ? set : Math.min(set, own)
}
