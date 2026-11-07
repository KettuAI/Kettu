import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { joinPlanTier, planTier } from '@renderer/features/account/model'
import { planName } from '@renderer/features/tray/model'
import { limitLevel, type LimitLevel } from '@renderer/lib/plan-limit'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long a plan window runs, which orders the rings; null when its id does not say. */
export function windowLength(window: string): number | null {
  if (window === 'five_hour' || window === 'rolling') return 5 * HOUR
  if (window === 'seven_day' || window === 'weekly' || window.startsWith('seven_day_')) {
    return 7 * DAY
  }
  if (window === 'monthly') return 30 * DAY
  if (window === 'annual') return 365 * DAY
  const counted = /^(\d+)_(minute|hour|day)$/.exec(window)
  if (!counted) return null
  return Number(counted[1]) * { minute: MINUTE, hour: HOUR, day: DAY }[counted[2]!]!
}

/** A window that counts one model, such as Claude Code's weekly Fable window. */
const perModel = (window: string): boolean => window.startsWith('seven_day_')

export interface CardRing {
  limit: PlanLimit
  /** The whole percentage used; 0 once its reset has passed, since the window starts again. */
  percent: number
  level: LimitLevel
  /** Used up: the window shows when it comes back instead of its percentage. */
  reached: boolean
}

/**
 * The windows with a percentage, the longest first: the outer ring. A window for one model sits
 * inside the window it narrows, and one of unknown length innermost.
 */
export function cardRings(limits: readonly PlanLimit[], now: number): CardRing[] {
  const rings = limits
    .filter((limit) => limit.usedPercent !== null)
    .map((limit, index) => ({ limit, index, length: windowLength(limit.window) ?? -1 }))
  rings.sort(
    (a, b) =>
      b.length - a.length ||
      Number(perModel(a.limit.window)) - Number(perModel(b.limit.window)) ||
      a.index - b.index,
  )
  return rings.map(({ limit }) => {
    const stale = limit.resetsAt !== null && limit.resetsAt <= now
    const level = stale ? 'ok' : limitLevel(limit)
    return {
      limit,
      percent: stale ? 0 : Math.round(limit.usedPercent!),
      level,
      reached:
        !stale &&
        limit.resetsAt !== null &&
        (limit.state === 'reached' || Math.round(limit.usedPercent!) >= 100),
    }
  })
}

/**
 * What a card shows: its windows; a skeleton while the first read is under way; a line while the
 * agent reports limits but has none yet; or the last read dimmed when reading it failed.
 */
export type CardState = 'ready' | 'reading' | 'notYet' | 'failed'

/** One account's card on the Usage page, an OpenCode provider's included. */
export interface UsageCard {
  key: string
  agentId: AgentId
  name: string
  /** The whole plan, such as "Claude Ultra", for the tooltip; null when unknown. */
  plan: string | null
  /** The plan without the brand its mark shows, such as "Ultra"; null when unknown. */
  tier: string | null
  rings: CardRing[]
  state: CardState
  /** When its windows were last read; null when they never were. */
  readAt: number | null
}

/** How the page's own read of an agent's limits went. */
export type LimitRead = 'reading' | 'failed'

const latest = (limits: readonly PlanLimit[]): number | null =>
  limits.length > 0 ? Math.max(...limits.map((limit) => limit.observedAt)) : null

/**
 * A card per account that reports plan limits, in the agents' order: OpenCode's by provider,
 * named without the "OpenCode" its mark shows. The agents with usage that report none are
 * listed apart, for the line under the cards.
 */
export function usageCards(
  agents: readonly AgentStatus[],
  used: readonly AgentId[],
  reads: Readonly<Partial<Record<AgentId, LimitRead>>>,
  now: number,
): { cards: UsageCard[]; unreported: AgentStatus[] } {
  const cards: UsageCard[] = []
  const unreported: AgentStatus[] = []
  for (const agent of agents) {
    const providers = (agent.providers ?? []).filter(
      (provider) => (provider.usage?.limits.length ?? 0) > 0 || provider.usage?.state === 'error',
    )
    if (agent.harnessId === 'opencode' && providers.length > 0) {
      for (const provider of providers) {
        const limits = provider.usage!.limits
        const rings = cardRings(limits, now)
        cards.push({
          key: `${agent.id}:${provider.id}`,
          agentId: agent.id,
          name: planName(agent.harnessName, provider.name),
          plan: provider.name,
          tier: null,
          rings,
          state:
            provider.usage!.state === 'error' ? 'failed' : rings.length > 0 ? 'ready' : 'notYet',
          readAt: latest(limits),
        })
      }
      continue
    }
    const shown = agent.limits.length > 0 || used.includes(agent.id)
    if (!shown) continue
    if (agent.limits.length === 0 && !agent.capabilities.reports) {
      unreported.push(agent)
      continue
    }
    const rings = cardRings(agent.limits, now)
    const read = reads[agent.id]
    const account = agent.account?.kind === 'account' ? agent.account : null
    cards.push({
      key: agent.id,
      agentId: agent.id,
      name: agent.name,
      plan: account ? joinPlanTier(account.label, account.tier) : null,
      tier: planTier(agent.account),
      rings,
      state:
        read === 'failed'
          ? 'failed'
          : rings.length > 0
            ? 'ready'
            : read === 'reading'
              ? 'reading'
              : 'notYet',
      readAt: latest(agent.limits),
    })
  }
  return { cards, unreported }
}

/**
 * How many cards a row holds: two for one or two, a full row for three or four, and past that
 * three or four, whichever leaves fewer empty places in the last row, four on a tie.
 */
export function planColumns(count: number): 2 | 3 | 4 {
  if (count <= 2) return 2
  if (count <= 4) return count as 3 | 4
  const empty = (columns: number) => (columns - (count % columns)) % columns
  return empty(3) < empty(4) ? 3 : 4
}

/** A ring's width and the room between rings, thinner as more of them share the diagram. */
export function ringStroke(count: number, size: number): { stroke: number; gap: number } {
  for (const [stroke, gap] of [
    [6, 2.5],
    [5, 1.5],
    [4, 1.5],
    [3, 1],
  ] as const) {
    const inner = size / 2 - stroke / 2 - (count - 1) * (stroke + gap)
    if (inner >= stroke) return { stroke, gap }
  }
  return { stroke: 2, gap: 1 }
}
