// The permission mode of a session another session's agent starts. Modes are ranked across
// harnesses by what runs without asking:
// - Within the same host and same project, a child session directly inherits its verified parent
//   session's current effective permission rank (including Full access when granted to the parent)
//   as both its ceiling and default, while still allowing a narrower mode to be chosen and never
//   escalating above the parent.
// - Across projects or hosts (or without a verified ranked parent session, such as plugins,
//   workflows, or unranked harnesses), Full access is never inherited automatically and the child
//   stays capped to STARTED_MAX (3) and the target agent's configured start mode.

import { ANTIGRAVITY_FULL_ACCESS, type HarnessId } from '@shared/agents'
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

/** The rank of Full access modes across all ranked harnesses. */
export const FULL_ACCESS_RANK: ModeRank = 4

/** The widest rank a started session gets outside same-scope parent inheritance: full access never. */
export const STARTED_MAX: ModeRank = 3

/**
 * Server-verified scope relationship between a starter (parent) session and a target child session.
 * Full-access inheritance applies only under `'same-scope'` (same host and same project).
 */
export type StartedScope = 'same-scope' | 'cross-scope'

/** Server-verified identities used to decide whether a child inherits its parent's scope. */
export interface StartedScopeContext {
  verifiedParent: boolean
  parentHostId: string | null
  targetHostId: string | null
  parentProject: string | null
  targetProject: string | null
}

/**
 * Resolves the permission inheritance scope strictly from server-verified parent, host, and project
 * identities. Fails closed to `'cross-scope'` whenever any identity is missing or differs.
 */
export function resolveStartedScope(
  context: StartedScopeContext,
  sameProject: (a: string, b: string) => boolean,
): StartedScope {
  if (!context.verifiedParent) return 'cross-scope'
  if (context.parentHostId === null || context.targetHostId === null) return 'cross-scope'
  if (context.parentHostId !== context.targetHostId) return 'cross-scope'
  if (context.parentProject === null || context.targetProject === null) return 'cross-scope'
  return sameProject(context.parentProject, context.targetProject) ? 'same-scope' : 'cross-scope'
}

export type RankedHarness = 'claude-code' | 'codex' | 'deepseek' | 'antigravity'

// agy's own modes, then Kettu's full access over its `--dangerously-skip-permissions`.
const AGY_MODES = ['default', 'accept-edits', 'auto', 'plan', ANTIGRAVITY_FULL_ACCESS] as const
type AgyMode = (typeof AGY_MODES)[number]
const AGY_KEYS: Record<AgyMode, 'default' | 'acceptEdits' | 'auto' | 'plan' | 'fullAccess'> = {
  default: 'default',
  'accept-edits': 'acceptEdits',
  auto: 'auto',
  plan: 'plan',
  [ANTIGRAVITY_FULL_ACCESS]: 'fullAccess',
}

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
  antigravity: {
    default: 1,
    plan: 1,
    'accept-edits': 2,
    auto: 3,
    [ANTIGRAVITY_FULL_ACCESS]: 4,
  } satisfies Record<AgyMode, ModeRank>,
}

// The modes each harness's mode menu offers, narrow to wide.
const OFFERED: Record<RankedHarness, readonly string[]> = {
  'claude-code': availableModes(true),
  codex: CODEX_MODES.map((mode) => mode.id),
  deepseek: DSH_MODES,
  antigravity: AGY_MODES,
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
 * The widest rank a started session may have:
 * - Under `'same-scope'` with a ranked starter (`starter !== null`), the child inherits the
 *   parent's current effective rank directly (including Full access rank 4).
 * - Under `'cross-scope'` or an unranked starter (`starter === null`), the child is bounded by the
 *   target agent's configured/default mode, the starter's rank (when known), and `STARTED_MAX` (3),
 *   so Full access never carries over across projects, hosts, or unverified scopes.
 */
export function startedCeiling(
  starter: ModeRank | null,
  harness: RankedHarness,
  agentMode: string | null,
  scope: StartedScope = 'cross-scope',
): ModeRank {
  if (scope === 'same-scope' && starter !== null) return starter
  const effective = agentMode ?? defaultMode(harness)
  const agent = modeRank(harness, effective) ?? 1
  return Math.min(starter ?? STARTED_MAX, agent, STARTED_MAX) as ModeRank
}

/**
 * The modes a started session may be given under `ceiling`, narrow to wide; never a plan mode.
 * Set `allowFullAccess: false` when the host environment cannot offer Full access for `harness`.
 */
export function startableModes(
  harness: RankedHarness,
  ceiling: ModeRank,
  options?: { allowFullAccess?: boolean },
): string[] {
  const allowFull = options?.allowFullAccess ?? true
  return OFFERED[harness].filter((mode) => {
    const rank = modeRank(harness, mode)
    if (mode === PLAN_MODE || rank === null || rank > ceiling) return false
    if (!allowFull && rank === FULL_ACCESS_RANK) return false
    return true
  })
}

/**
 * The default mode a same-scope child session inherits for `harness` given its parent's effective
 * rank `ceiling`: the widest startable mode of `harness` that does not exceed `ceiling`.
 */
export function inheritedMode(
  harness: RankedHarness,
  ceiling: ModeRank,
  options?: { allowFullAccess?: boolean },
): string {
  return startableModes(harness, ceiling, options).at(-1)!
}

/**
 * The mode a started session gets: `wanted` when it is one of the modes under the ceiling, else
 * the widest of them no wider than `wanted`.
 */
export function startedMode(
  harness: RankedHarness,
  wanted: string,
  ceiling: ModeRank,
  options?: { allowFullAccess?: boolean },
): string {
  const modes = startableModes(harness, ceiling, options)
  if (modes.includes(wanted)) return wanted
  const limit = Math.min(ceiling, modeRank(harness, wanted) ?? 1) as ModeRank
  // Each harness offers a mode of rank 1 that is no plan mode.
  return startableModes(harness, limit, options).at(-1)!
}

/**
 * The mode a harness's new session starts in when the user set none and its own settings files set
 * none. Callers that can resolve Claude Code's settings files should pass that resolved mode.
 */
export function defaultMode(harness: RankedHarness): string {
  switch (harness) {
    case 'codex':
      return CODEX_DEFAULT
    case 'deepseek':
      return DSH_DEFAULT
    case 'antigravity':
      return 'default'
    case 'claude-code':
      return 'default'
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
      return {
        name: modeName(mode, tEnglish),
        description: modeDescription(mode, tEnglish) ?? '',
      }
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
    case 'antigravity': {
      if (!Object.hasOwn(AGY_KEYS, mode)) return { name: mode, description: '' }
      const key = AGY_KEYS[mode as AgyMode]
      return {
        name: tEnglish(`antigravity.mode.${key}.name`),
        description: tEnglish(`antigravity.mode.${key}.description`),
      }
    }
  }
}
