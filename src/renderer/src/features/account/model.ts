import type { AccountStatus } from '@shared/account'
import type { AgentAccount, PlanLimit, ProviderBalance } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import { planName } from '@shared/session-groups'
import type { UpdateItem } from '@renderer/features/updates/card-model'
import { limitLevel, type LimitLevel } from '@renderer/lib/plan-limit'
import type { AccountAgent, CardResets } from '@renderer/lib/plan-readings'
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
  /** The ring's key: its window, or a per-model window's own id, such as `seven_day_fable`. */
  id: string
  window: RingWindow
  /**
   * The one model or model group a window counts, such as "Fable"; null for the plan's own
   * windows.
   */
  model: string | null
  /** The whole percentage used; 0 once its reset has passed, since the window starts again. */
  percent: number
  level: LimitLevel
  amount?: PlanLimit['amount']
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
  balances: ProviderBalance[]
  account: AgentAccount | null
  /** The account's reset credits; null when it holds none or none could be read. */
  resets: CardResets | null
}

function cardWindows(limits: readonly PlanLimit[], now: number): CardWindow[] {
  const rings: CardWindow[] = []
  for (const limit of limits) {
    const scoped = /^(seven_day|five_hour)_/.exec(limit.window)?.[1] as RingWindow | undefined
    const window = scoped ?? RING_OF[limit.window]
    if (!window || limit.usedPercent === null) continue
    const id = scoped ? limit.window : window
    if (rings.some((ring) => ring.id === id)) continue
    const stale = limit.resetsAt !== null && limit.resetsAt <= now
    rings.push({
      id,
      window,
      model: scoped ? (/^(?:Weekly|5-hour) · (.+)$/.exec(limit.label)?.[1] ?? limit.label) : null,
      percent: stale ? 0 : Math.round(limit.usedPercent),
      level: stale ? 'ok' : limitLevel(limit),
      ...(limit.amount ? { amount: limit.amount } : {}),
    })
  }
  // A window for one model sits inside the ring of the same length it narrows.
  const rank = (ring: CardWindow) => RING_WINDOWS.indexOf(ring.window) * 2 + (ring.model ? 0 : 1)
  return rings.sort((a, b) => rank(a) - rank(b))
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
  return accounts.flatMap(({ key, hostId, hostIds, agent, limits, resets, name }): PlanCard[] => {
    if (agent.harnessId === 'opencode') {
      return (agent.providers ?? []).flatMap((provider) => {
        const limits = provider.usage?.limits ?? []
        const windows = cardWindows(limits, now)
        // A provider with only a balance, such as DeepSeek's, shows it in Settings, not as a card.
        if (windows.length === 0) return []
        const balances = provider.usage?.balances ?? []
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
            balances,
            account: { kind: 'external', label: provider.name, email: null },
            resets: null,
          },
        ]
      })
    }
    const windows = cardWindows(limits, now)
    const balances = agent.balances ?? []
    if (windows.length === 0 && balances.length === 0) return []
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
        balances,
        account: agent.account,
        resets: resets && resets.count > 0 ? resets : null,
      },
    ]
  })
}

const LEVEL_RANK: Record<LimitLevel, number> = { ok: 0, warn: 1, bad: 2 }
const windowRank = (w: CardWindow): number => LEVEL_RANK[w.level] * 1000 + w.percent

/** A card's tightest window, a reached or red one first: what the account row's ring draws. */
export function tightestWindow(card: PlanCard): CardWindow {
  return card.windows.reduce((a, b) => (windowRank(b) > windowRank(a) ? b : a))
}

const cardRank = (card: PlanCard): number =>
  card.windows.length > 0 ? windowRank(tightestWindow(card)) : -1

/**
 * The card of the account `key` names: its own, or for an OpenCode agent the tightest of its
 * providers'. Null when the account reports no plan windows.
 */
export function currentCard(cards: readonly PlanCard[], key: string): PlanCard | null {
  let found: PlanCard | null = null
  for (const card of cards) {
    if (card.key !== key && !card.key.startsWith(`${key}:`)) continue
    if (!found || cardRank(card) > cardRank(found)) found = card
  }
  return found
}

/**
 * Saved cards keep their order. Unplaced cards follow, with the current account first and the
 * rest ordered by their tightest window.
 */
export function popoverCards(
  cards: readonly PlanCard[],
  current: PlanCard | null,
  order: readonly string[],
): PlanCard[] {
  const others = cards.filter((card) => card !== current).sort((a, b) => cardRank(b) - cardRank(a))
  const ranked = current ? [current, ...others] : others
  const positions = new Map(order.map((key, index) => [key, index]))
  return ranked.sort(
    (a, b) => (positions.get(a.key) ?? order.length) - (positions.get(b.key) ?? order.length),
  )
}

/**
 * Whether a card's windows are per model group, two lengths each, as Antigravity's are: their
 * names are too long for half a row, so the card takes the whole row.
 */
export function hasModelGroups(card: PlanCard): boolean {
  return card.windows.some((w) => w.model !== null && w.window === 'five_hour')
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
