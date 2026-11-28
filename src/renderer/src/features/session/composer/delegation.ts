// Manual task delegation state and pure helpers for the session composer:
// stores the selected recipient agent per session draft (in memory and localStorage),
// mirrors host `toolAgentStatus` availability rules for `+` menu gating, and filters
// delegation targets by search query.

import { create } from 'zustand'
import type { AgentStatus, DelegateTargetAgent } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { foldForMatch } from '@renderer/features/artifacts/model'
import { readDraftDelegateTarget, writeDraftDelegateTarget, type DelegateTarget } from './drafts'

export type { DelegateTarget }

interface DelegateTargetStore {
  /** Selected recipient agent by draft key (sessionId). */
  byDraft: Record<string, DelegateTarget | undefined>
}

const useDelegateTargetStore = create<DelegateTargetStore>()(() => ({ byDraft: {} }))

/** Reads the selected delegation recipient for `draft`, or null when sending normally. */
export function draftDelegateTarget(draft: string): DelegateTarget | null {
  return useDelegateTargetStore.getState().byDraft[draft] ?? null
}

/** Subscribes to the selected delegation recipient for `draft`. */
export function useDraftDelegateTarget(draft: string): DelegateTarget | null {
  return useDelegateTargetStore((s) => s.byDraft[draft] ?? null)
}

/** Sets or clears the delegation recipient for `draft` and persists it with the draft. */
export function setDraftDelegateTarget(draft: string, target: DelegateTarget | null): void {
  useDelegateTargetStore.setState((s) => {
    const byDraft = { ...s.byDraft }
    if (target) byDraft[draft] = target
    else delete byDraft[draft]
    return { byDraft }
  })
  writeDraftDelegateTarget(draft, target)
}

/** Hydrates a persisted delegation recipient once when a session's composer opens. */
export function hydrateDraftDelegateTarget(draft: string): void {
  if (draft in useDelegateTargetStore.getState().byDraft) return
  const saved = readDraftDelegateTarget(draft)
  if (saved) {
    useDelegateTargetStore.setState((s) => ({
      byDraft: { ...s.byDraft, [draft]: saved },
    }))
  }
}

/**
 * Restores a delegation recipient after a failed send unless the user has already picked a new
 * recipient in the meantime.
 */
export function restoreDraftDelegateTarget(draft: string, target: DelegateTarget | null): void {
  if (!target) return
  if (draftDelegateTarget(draft) !== null) return
  setDraftDelegateTarget(draft, target)
}

/**
 * Whether an agent status on the session's host can be offered as a delegation target.
 * Mirrors the host's `toolAgentStatus` rules (registered, enabled, visible, installed).
 */
export function isDelegatableAgentStatus(status: AgentStatus): boolean {
  if (status.registered === false || status.disabled || status.hidden) return false
  if (
    status.state === 'not-installed' ||
    status.state === 'node-missing' ||
    status.state === 'node-outdated'
  ) {
    return false
  }
  if (status.uninstalled || (status.package && !status.package.installed && !status.cli)) {
    return false
  }
  return true
}

/**
 * Whether a delegation target row in the picker can be selected right now.
 * Agents actively installing cannot start a child session until installation finishes.
 */
export function isSelectableDelegateAgent(agent: Pick<DelegateTargetAgent, 'status'>): boolean {
  return agent.status !== 'installing'
}

export interface DelegationOfferContext {
  sessionId: string | null
  parentId: string | null
  origin: SessionView['origin']
  mustSwitch: boolean
  heldOutside: boolean
}

/**
 * Whether the composer's `+` menu should offer "Delegate to agent" for this session.
 * Restricted to active top-level user sessions that are not externally held or forced to switch.
 */
export function canOfferDelegation(context: DelegationOfferContext): boolean {
  return (
    context.sessionId !== null &&
    context.parentId === null &&
    context.origin === 'user' &&
    !context.mustSwitch &&
    !context.heldOutside
  )
}

/**
 * Filters delegation target agents by free-text query against agent name, harness name, and id,
 * ignoring case and diacritics.
 */
export function filterDelegateAgents(
  agents: readonly DelegateTargetAgent[],
  query: string,
): DelegateTargetAgent[] {
  const wanted = foldForMatch(query.trim())
  if (!wanted) return [...agents]
  return agents.filter(
    (agent) =>
      foldForMatch(agent.name).includes(wanted) ||
      foldForMatch(agent.harnessName).includes(wanted) ||
      foldForMatch(agent.id).includes(wanted),
  )
}

/** First selectable index in `rows`, or -1 when every row is disabled. */
export function firstSelectableIndex(rows: readonly DelegateTargetAgent[]): number {
  return rows.findIndex(isSelectableDelegateAgent)
}

/** Moves highlight to the next selectable row in `direction`, wrapping around the list. */
export function moveSelectableHighlight(
  rows: readonly DelegateTargetAgent[],
  current: number,
  key: 'ArrowDown' | 'ArrowUp',
): number {
  const count = rows.length
  if (count === 0) return -1
  const delta = key === 'ArrowDown' ? 1 : -1
  const start = current < 0 || current >= count ? (delta > 0 ? -1 : 0) : current
  for (let step = 1; step <= count; step++) {
    const next = (start + delta * step + count * 2) % count
    if (isSelectableDelegateAgent(rows[next]!)) return next
  }
  return -1
}
