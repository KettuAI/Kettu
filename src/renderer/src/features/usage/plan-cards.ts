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

/** A computer a card is on, null being this computer, and what its agent there is called. */
export interface CardPlace {
  hostId: string | null
  agentId: AgentId
  agentName: string
}

/** One account's card on the Usage page, an OpenCode provider's included. */
export interface UsageCard {
  key: string
  agentId: AgentId
  /** The computer of `agentId`: the first shown that the card is on. */
  hostId: string | null
  /**
   * The agent's name, or the account's email when its computers call it by different names, the
   * one thing they agree on.
   */
  name: string
  /** The whole plan, such as "Claude Ultra", for the tooltip; null when unknown. */
  plan: string | null
  /** The plan without the brand its mark shows, such as "Ultra"; null when unknown. */
  tier: string | null
  rings: CardRing[]
  state: CardState
  /** When its windows were last read; null when they never were. */
  readAt: number | null
  /** The computers shown that it is on, in their order. */
  places: CardPlace[]
}

/** How the page's own read of a card's limits went, by the card's key. */
export type LimitRead = 'reading' | 'failed'

/** A computer's agents, null being this computer. */
export interface HostAgentList {
  hostId: string | null
  agents: readonly AgentStatus[]
}

const latest = (limits: readonly PlanLimit[]): number | null =>
  limits.length > 0 ? Math.max(...limits.map((limit) => limit.observedAt)) : null

/**
 * What tells one subscription account on any computer: the harness, the email, the plan and its
 * tier. Null when the agent signs in some other way or reports no email, so its account cannot be
 * told.
 */
export function accountKey(agent: AgentStatus): string | null {
  const account = agent.account
  if (account?.kind !== 'account') return null
  const email = account.email?.trim().toLowerCase()
  if (!email) return null
  return [agent.harnessId, email, account.label, account.tier ?? ''].join('\n')
}

/** An account's newest reading, kept whole. */
export interface PlanReading {
  hostId: string | null
  limits: readonly PlanLimit[]
  readAt: number
}

/**
 * The newest reading of each account on any of `hosts`. Limits belong to the account, so one
 * signed in on several computers shows one reading everywhere; windows of two readings are never
 * mixed, so a window only an older one has does not come back.
 */
export function newestReadings(hosts: readonly HostAgentList[]): Map<string, PlanReading> {
  const readings = new Map<string, PlanReading>()
  for (const { hostId, agents } of hosts) {
    for (const agent of agents) {
      const key = accountKey(agent)
      const readAt = latest(agent.limits)
      if (key === null || readAt === null) continue
      const kept = readings.get(key)
      if (kept && kept.readAt >= readAt) continue
      readings.set(key, { hostId, limits: agent.limits, readAt })
    }
  }
  return readings
}

const ACCOUNT = 'account:'

/** A card's key for what is one computer's own. */
export const ownKey = (hostId: string | null, id: string): string => `${hostId ?? ''}/${id}`

/**
 * A card per account that reports plan limits, in the computers' order and their agents': an
 * account is one card however many computers and agents it is signed in on, with its newest
 * reading in `readings`; what cannot be told to be one account stays each computer's own, and
 * OpenCode's go by provider, named without the "OpenCode" its mark shows. The agents with usage
 * that report none are listed apart, each name once, for the line under the cards.
 */
export function usageCards(
  hosts: readonly HostAgentList[],
  readings: ReadonlyMap<string, PlanReading>,
  /** Each host's agents with usage, by host id, '' for this computer. */
  used: Readonly<Record<string, readonly AgentId[]>>,
  reads: Readonly<Partial<Record<string, LimitRead>>>,
  now: number,
): { cards: UsageCard[]; unreported: AgentStatus[] } {
  const cards: UsageCard[] = []
  const unreported: AgentStatus[] = []
  for (const { hostId, agents } of hosts) {
    const usedHere = used[hostId ?? ''] ?? []
    for (const agent of agents) {
      const place = { hostId, agentId: agent.id, agentName: agent.name }
      const providers = (agent.providers ?? []).filter(
        (provider) => (provider.usage?.limits.length ?? 0) > 0 || provider.usage?.state === 'error',
      )
      if (agent.harnessId === 'opencode' && providers.length > 0) {
        for (const provider of providers) {
          const limits = provider.usage!.limits
          const rings = cardRings(limits, now)
          cards.push({
            key: ownKey(hostId, `${agent.id}:${provider.id}`),
            agentId: agent.id,
            hostId,
            name: planName(agent.harnessName, provider.name),
            plan: provider.name,
            tier: null,
            rings,
            state:
              provider.usage!.state === 'error' ? 'failed' : rings.length > 0 ? 'ready' : 'notYet',
            readAt: latest(limits),
            places: [place],
          })
        }
        continue
      }
      const account = accountKey(agent)
      const limits = (account === null ? undefined : readings.get(account)?.limits) ?? agent.limits
      const shown = limits.length > 0 || usedHere.includes(agent.id)
      if (!shown) continue
      if (limits.length === 0 && !agent.capabilities.reports) {
        if (!unreported.some((other) => other.name === agent.name)) unreported.push(agent)
        continue
      }
      const key = account === null ? ownKey(hostId, agent.id) : ACCOUNT + account
      const same = cards.find((card) => card.key === key)
      if (same) {
        same.places.push(place)
        continue
      }
      const rings = cardRings(limits, now)
      const read = reads[key]
      const signedIn = agent.account?.kind === 'account' ? agent.account : null
      cards.push({
        key,
        agentId: agent.id,
        hostId,
        name: agent.name,
        plan: signedIn ? joinPlanTier(signedIn.label, signedIn.tier) : null,
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
        readAt: latest(limits),
        places: [place],
      })
    }
  }
  for (const card of cards) {
    const email = card.key.startsWith(ACCOUNT) ? card.key.split('\n')[1] : undefined
    if (email && new Set(card.places.map((place) => place.agentName)).size > 1) card.name = email
  }
  return { cards, unreported }
}

/** A computer's agent a refresh can read a card's limits through. */
export interface LimitWay {
  hostId: string | null
  agentId: AgentId
}

/**
 * What a refresh reads, by card key: an account once, through its computers in turn, an agent
 * that runs before one only installed; an OpenCode agent's providers and any other agent with
 * limits on their own computer. `reachable` says which computers answer now.
 */
export function limitWays(
  hosts: readonly HostAgentList[],
  reachable: (hostId: string | null) => boolean,
): Map<string, LimitWay[]> {
  const ways = new Map<string, (LimitWay & { running: boolean })[]>()
  for (const { hostId, agents } of hosts) {
    if (!reachable(hostId)) continue
    for (const agent of agents) {
      if (agent.disabled || agent.registered === false) continue
      const running = agent.state === 'ready'
      const account = accountKey(agent)
      if (agent.providers !== undefined || account === null) {
        if (agent.providers !== undefined || (running && agent.limits.length > 0)) {
          ways.set(ownKey(hostId, agent.id), [{ hostId, agentId: agent.id, running }])
        }
        continue
      }
      if (!running && agent.state !== 'available') continue
      if (agent.limits.length === 0 && !agent.capabilities.reports) continue
      const key = ACCOUNT + account
      ways.set(key, [...(ways.get(key) ?? []), { hostId, agentId: agent.id, running }])
    }
  }
  return new Map(
    [...ways].map(([key, list]) => [
      key,
      [...list.filter((way) => way.running), ...list.filter((way) => !way.running)].map(
        ({ hostId, agentId }) => ({ hostId, agentId }),
      ),
    ]),
  )
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
