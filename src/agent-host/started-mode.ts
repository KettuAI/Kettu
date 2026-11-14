// The permission mode of a session another session's agent starts. Modes are ranked across
// harnesses by what runs without asking, and a started session is held to the lower of its
// starter's rank and the rank of the mode its agent would start in, never to full access, so a
// session cannot do through one it starts what it could not do itself without asking.

import type { HarnessId } from '@shared/agents'
import { availableModes, modeDescription, modeName } from './claude/config'
import type { PermissionMode } from './claude/sdk'
import { DEFAULT_MODE as CODEX_DEFAULT, MODES as CODEX_MODES, type ModeId } from './codex/config'
import {
  DEFAULT_PRESET as DSH_DEFAULT,
  MODE_KEYS as DSH_KEYS,
  MODES as DSH_MODES,
  type Mode as DshMode,
} from './dsh/options'
import { tEnglish } from './i18n'

/** What a mode lets an agent do without asking: 1 asks before any change, 4 never asks. */
export type ModeRank = 1 | 2 | 3 | 4

/** The widest rank a started session gets: full access never. */
export const STARTED_MAX: ModeRank = 3

export type RankedHarness = 'claude-code' | 'codex' | 'deepseek'

const RANKS: Record<RankedHarness, Readonly<Record<string, ModeRank>>> = {
  'claude-code': {
    plan: 1,
    default: 1,
    dontAsk: 1,
    acceptEdits: 2,
    auto: 3,
    bypassPermissions: 4,
  } satisfies Record<PermissionMode, ModeRank>,
  codex: {
    'read-only': 1,
    'workspace-write': 2,
    agent: 3,
    'agent-full-access': 4,
  } satisfies Record<ModeId, ModeRank>,
  deepseek: {
    plan: 1,
    'read-only': 1,
    'workspace-write': 2,
    'danger-full-access': 4,
  } satisfies Record<DshMode, ModeRank>,
}

// The modes each harness's mode menu offers, narrow to wide.
const OFFERED: Record<RankedHarness, readonly string[]> = {
  'claude-code': availableModes(true),
  codex: CODEX_MODES.map((mode) => mode.id),
  deepseek: DSH_MODES,
}

// A plan mode ends its turn waiting for the user to approve the plan.
const PLAN_MODE = 'plan'

export function isRanked(harness: HarnessId): harness is RankedHarness {
  return Object.hasOwn(RANKS, harness)
}

/** A mode's rank, or null for one Kettu does not know. */
export function modeRank(harness: RankedHarness, mode: string): ModeRank | null {
  return Object.hasOwn(RANKS[harness], mode) ? RANKS[harness][mode]! : null
}

/**
 * The rank a starter's mode holds the sessions it starts to: planning, a missing mode and one Kettu
 * does not know count as asking. Null for a starter whose modes Kettu cannot rank.
 */
export function starterRank(
  harness: HarnessId,
  mode: string | undefined,
  planning: boolean,
): ModeRank | null {
  if (!isRanked(harness)) return null
  if (planning || mode === undefined) return 1
  return modeRank(harness, mode) ?? 1
}

/**
 * The widest rank a started session may have: the starter's, that of the mode its agent would start
 * in, and never full access. A mode Kettu does not know counts as asking.
 */
export function startedCeiling(
  starter: ModeRank | null,
  harness: RankedHarness,
  agentMode: string | null,
): ModeRank {
  const agent = agentMode === null ? STARTED_MAX : (modeRank(harness, agentMode) ?? 1)
  return Math.min(starter ?? STARTED_MAX, agent, STARTED_MAX) as ModeRank
}

/** The modes a started session may be given under `ceiling`, narrow to wide; never a plan mode. */
export function startableModes(harness: RankedHarness, ceiling: ModeRank): string[] {
  return OFFERED[harness].filter((mode) => {
    const rank = modeRank(harness, mode)
    return mode !== PLAN_MODE && rank !== null && rank <= ceiling
  })
}

/**
 * The mode a started session gets: `wanted` when it is one of the modes under the ceiling, else
 * the widest of them no wider than `wanted`.
 */
export function startedMode(harness: RankedHarness, wanted: string, ceiling: ModeRank): string {
  const modes = startableModes(harness, ceiling)
  if (modes.includes(wanted)) return wanted
  const limit = Math.min(ceiling, modeRank(harness, wanted) ?? 1) as ModeRank
  // Each harness offers a mode of rank 1 that is no plan mode.
  return startableModes(harness, limit).at(-1)!
}

/**
 * The mode a harness's new session starts in when the user set none, where Kettu knows it before
 * the session opens; null for Claude Code, which reads it from its settings files.
 */
export function defaultMode(harness: RankedHarness): string | null {
  switch (harness) {
    case 'codex':
      return CODEX_DEFAULT
    case 'deepseek':
      return DSH_DEFAULT
    case 'claude-code':
      return null
  }
}

export interface ModeLabel {
  name: string
  description: string
}

/** A mode's name and description, in English for agents; the id for a mode Kettu does not know. */
export function modeLabel(harness: RankedHarness, mode: string): ModeLabel {
  switch (harness) {
    case 'claude-code':
      return { name: modeName(mode), description: modeDescription(mode) ?? '' }
    case 'codex':
      return CODEX_MODES.some((known) => known.id === mode)
        ? {
            name: tEnglish(`codex.mode.${mode as ModeId}.name`),
            description: tEnglish(`codex.mode.${mode as ModeId}.description`),
          }
        : { name: mode, description: '' }
    case 'deepseek': {
      if (!Object.hasOwn(DSH_KEYS, mode)) return { name: mode, description: '' }
      const key = DSH_KEYS[mode as DshMode]
      return {
        name: tEnglish(`dsh.mode.${key}`),
        description: tEnglish(`dsh.mode.${key}Description`),
      }
    }
  }
}
