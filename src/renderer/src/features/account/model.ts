import type { AccountStatus } from '@shared/account'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import { planName } from '@renderer/features/tray/model'
import type { UpdateItem } from '@renderer/features/updates/card-model'
import { limitLevel, type LimitLevel } from '@renderer/lib/plan-limit'
import type { AccountAgent } from '@renderer/lib/plan-readings'
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
  /** The whole percentage used; 0 once its reset has passed, since the window starts again. */
  percent: number
  level: LimitLevel
}

/** One account's card in the account menu, an OpenCode provider's included. */
export interface PlanCard {
  key: string
  /** The host of `agentId`, null being this computer. */
  hostId: string | null
  /** Every host shown that the account is on. */
  hostIds: (string | null)[]
  agentId: AgentId
  agentName: string
  /** The agent's name, or for OpenCode the provider's. */
  name: string
  /** The plan without its brand, such as "Ultra"; null when it is unknown. */
  tier: string | null
  /** Innermost first. */
  windows: CardWindow[]
  /** Every window and the plan, for the card's details. */
  limits: PlanLimit[]
  account: AgentAccount | null
}

function cardWindows(limits: readonly PlanLimit[], now: number): CardWindow[] {
  const byRing = new Map<RingWindow, CardWindow>()
  for (const limit of limits) {
    const ring = RING_OF[limit.window]
    if (!ring || byRing.has(ring) || limit.usedPercent === null) continue
    const stale = limit.resetsAt !== null && limit.resetsAt <= now
    byRing.set(ring, {
      window: ring,
      percent: stale ? 0 : Math.round(limit.usedPercent),
      level: stale ? 'ok' : limitLevel(limit),
    })
  }
  return RING_WINDOWS.flatMap((ring) => byRing.get(ring) ?? [])
}

const MAX_PLAN = /^(.*\b)max(?:\s+(\d+x))?$/i
const MAX_TIER_NAMES: Record<string, string> = { '5x': 'Max', '10x': 'Ultra', '20x': 'Ultra' }

/**
 * A plan with its tier once. Claude's Max is named by its tier: 5x is "Max" and 10x is "Ultra",
 * and so is 20x, which older data still reports for it. A plan that already names its tier is
 * left as it is.
 */
export function joinPlanTier(plan: string, tier: string | undefined): string {
  const extra = tier?.trim().toLowerCase()
  const max = MAX_PLAN.exec(plan)
  const named = MAX_TIER_NAMES[max?.[2]?.toLowerCase() ?? extra ?? '']
  if (max && named) return `${max[1]}${named}`
  if (!extra || plan.toLowerCase().includes(extra) || /\bultra$/i.test(plan)) return plan
  return `${plan} ${tier!.trim()}`
}

/**
 * A subscription's plan for the badge. Claude Code and Codex name it "<brand> <plan>", such as
 * "Claude Max" or "ChatGPT Plus", and the agent's mark already shows the brand.
 */
export function planTier(account: AgentAccount | null): string | null {
  if (account?.kind !== 'account') return null
  const plan = account.label.trim().split(/\s+/).slice(1).join(' ')
  if (!plan) return null
  return joinPlanTier(plan, account.tier)
}

/**
 * A card per account that reports plan windows, in the accounts' order, at the account's newest
 * reading. OpenCode gets one per provider, named without a leading "OpenCode", which its mark shows.
 */
export function planCards(accounts: readonly AccountAgent[], now: number): PlanCard[] {
  return accounts.flatMap(({ key, hostId, hostIds, agent, limits, name }): PlanCard[] => {
    if (agent.harnessId === 'opencode') {
      return (agent.providers ?? []).flatMap((provider) => {
        const limits = provider.usage?.limits ?? []
        const windows = cardWindows(limits, now)
        if (windows.length === 0) return []
        return [
          {
            key: `${key}:${provider.id}`,
            hostId,
            hostIds,
            agentId: agent.id,
            agentName: agent.name,
            name: planName(agent.harnessName, provider.name),
            tier: null,
            windows,
            limits,
            account: { kind: 'external', label: provider.name, email: null },
          },
        ]
      })
    }
    const windows = cardWindows(limits, now)
    if (windows.length === 0) return []
    return [
      {
        key,
        hostId,
        hostIds,
        agentId: agent.id,
        agentName: agent.name,
        name,
        tier: planTier(agent.account),
        windows,
        limits,
        account: agent.account,
      },
    ]
  })
}

/** Two rows of cards at most, so the menu stays within the window. */
const MAX_CARDS = 4

/**
 * The cards the menu shows and how many more there are. When they do not all fit, those near a
 * limit come first, so a hidden card is never the one that needs attention.
 */
export function shownCards(cards: readonly PlanCard[]): { shown: PlanCard[]; more: number } {
  if (cards.length <= MAX_CARDS) return { shown: [...cards], more: 0 }
  const near = (card: PlanCard): boolean => card.windows.some((w) => w.level && w.level !== 'ok')
  const ordered = [...cards.filter(near), ...cards.filter((card) => !near(card))]
  return { shown: ordered.slice(0, MAX_CARDS), more: cards.length - MAX_CARDS }
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
