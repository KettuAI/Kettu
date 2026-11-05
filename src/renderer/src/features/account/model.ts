import type { AccountStatus } from '@shared/account'
import type { AgentAccount, AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import { planName } from '@renderer/features/tray/model'
import type { UpdateItem } from '@renderer/features/updates/card-model'
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

/** The windows a card draws as rings, from the innermost. */
const RING_WINDOWS = ['five_hour', 'seven_day', 'monthly'] as const
export type RingWindow = (typeof RING_WINDOWS)[number]

/** OpenCode Go's rolling window is its 5-hour one. */
const RING_OF: Readonly<Record<string, RingWindow>> = {
  five_hour: 'five_hour',
  rolling: 'five_hour',
  seven_day: 'seven_day',
  weekly: 'seven_day',
  monthly: 'monthly',
}

export interface CardWindow {
  window: RingWindow
  /** The whole percentage used; null once its reset has passed and it is not read again. */
  percent: number | null
  level: LimitLevel | null
}

/** One account's card in the account menu, an OpenCode provider's included. */
export interface PlanCard {
  key: string
  agentId: AgentId
  name: string
  /** The plan without its brand, such as "Max 5x"; null when it is unknown. */
  tier: string | null
  /** Innermost first. */
  windows: CardWindow[]
}

function cardWindows(limits: readonly PlanLimit[], now: number): CardWindow[] {
  const byRing = new Map<RingWindow, CardWindow>()
  for (const limit of limits) {
    const ring = RING_OF[limit.window]
    if (!ring || byRing.has(ring) || limit.usedPercent === null) continue
    const stale = limit.resetsAt !== null && limit.resetsAt <= now
    byRing.set(ring, {
      window: ring,
      percent: stale ? null : Math.round(limit.usedPercent),
      level: stale ? null : limitLevel(limit),
    })
  }
  return RING_WINDOWS.flatMap((ring) => byRing.get(ring) ?? [])
}

/**
 * A subscription's plan for the badge. Claude Code and Codex name it "<brand> <plan>", such as
 * "Claude Max" or "ChatGPT Plus", and the agent's mark already shows the brand.
 */
function planTier(account: AgentAccount | null): string | null {
  if (account?.kind !== 'account') return null
  const plan = account.label.trim().split(/\s+/).slice(1).join(' ')
  if (!plan) return null
  const tier = account.tier?.trim()
  return tier && !plan.toLowerCase().includes(tier.toLowerCase()) ? `${plan} ${tier}` : plan
}

/**
 * A card per account that reports plan windows, in the agents' order. OpenCode gets one per
 * provider, named without a leading "OpenCode", which its mark shows.
 */
export function planCards(agents: readonly AgentStatus[], now: number): PlanCard[] {
  return agents.flatMap((agent): PlanCard[] => {
    if (agent.harnessId === 'opencode') {
      return (agent.providers ?? []).flatMap((provider) => {
        const windows = cardWindows(provider.usage?.limits ?? [], now)
        if (windows.length === 0) return []
        return [
          {
            key: `${agent.id}:${provider.id}`,
            agentId: agent.id,
            name: planName(agent.harnessName, provider.name),
            tier: null,
            windows,
          },
        ]
      })
    }
    const windows = cardWindows(agent.limits, now)
    if (windows.length === 0) return []
    return [
      {
        key: agent.id,
        agentId: agent.id,
        name: agent.name,
        tier: planTier(agent.account),
        windows,
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
