import type { AccountStatus } from '@shared/account'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import type { UpdateItem } from '@renderer/features/updates/card-model'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'
import { limitLevel, type LimitLevel } from '@renderer/lib/plan-limit'
import { THIS_COMPUTER } from '@renderer/stores/view'

/** Who the account row and its menu name. */
export interface Identity {
  signedIn: boolean
  /** The account's name, or its email without one; null while signed out. */
  name: string | null
  email: string | null
  /** The letter on the avatar; null shows the person icon. */
  initial: string | null
  avatar: string | null
}

export function identityOf(status: AccountStatus | null): Identity {
  if (status?.state !== 'signed-in') {
    return { signedIn: false, name: null, email: null, initial: null, avatar: null }
  }
  const { account } = status
  const name = account.name?.trim() || account.email
  return {
    signedIn: true,
    name,
    email: account.email,
    initial: name.trim().charAt(0).toUpperCase() || null,
    avatar: account.avatar,
  }
}

/** One plan limit row in the account menu: the agent's fullest window. */
export interface LimitRow {
  agentId: AgentId
  /** "Claude Code · Claude Max", or the agent's name alone when its plan is unknown. */
  label: string
  percent: number
  level: LimitLevel
}

/** The agents' tightest windows that report how full they are, in the agents' order. */
export function limitRows(agents: readonly AgentStatus[], now: number): LimitRow[] {
  return agents.flatMap((agent) => {
    const limit: PlanLimit | null = tightestLimit(agent.limits, now)
    if (!limit || limit.usedPercent === null) return []
    const plan = agent.account && agent.account.kind !== 'none' ? agent.account.label : null
    return [
      {
        agentId: agent.id,
        label: plan ? `${agent.name} · ${plan}` : agent.name,
        percent: Math.round(limit.usedPercent),
        level: limitLevel(limit),
      },
    ]
  })
}

/** The host choice the menu checks: one host by its filter value, or null for every host. */
export function chosenHost(filter: string | null, hostIds: readonly string[]): string | null {
  if (filter === null || filter === THIS_COMPUTER) return filter
  return hostIds.includes(filter) ? filter : null
}

/** "macOS 26.1" from the system as a bug report names it, "macOS 26.1 (arm64)". */
export function systemName(system: string): string {
  return system.replace(/\s*\([^)]*\)\s*$/, '')
}

/**
 * Whether Settings needs you: an agent to sign in, or updates the card was closed on that are still
 * to do, until Settings is opened (`dot`).
 */
export function settingsAttention({
  signIn,
  dot,
  status,
  items,
}: {
  signIn: number
  dot: boolean
  status: UpdateStatus | null
  items: readonly UpdateItem[]
}): boolean {
  if (signIn > 0) return true
  if (!dot) return false
  const state = status?.state
  const appDismissed =
    (state?.kind === 'ready' || state?.kind === 'available') && status?.dismissed === state.version
  return appDismissed || items.some((item) => item.kind === 'harness' && item.skipped)
}
