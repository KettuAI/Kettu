import {
  isActivelyRunning,
  isWaitingBackground,
  type SessionSummary,
  type SessionUsageItem,
} from '@shared/agent-host'
import type { SessionUsage } from '@shared/thread'
import { hostAt } from '@renderer/lib/host'
import { hostOfSession } from '@renderer/stores/sessions'

export type FamilyMemberStatus =
  'waiting' | 'error' | 'auth' | 'running' | 'background' | 'starting' | 'unread' | 'idle'

export interface SessionFamilyMember {
  summary: SessionSummary
  /** Nesting depth under the family root (0 for root, 1 for direct children, etc.). */
  depth: number
  isRoot: boolean
  isCurrent: boolean
  isDirectParent: boolean
  status: FamilyMemberStatus
}

export interface FamilyActivity {
  waitingCount: number
  errorCount: number
  runningCount: number
  backgroundCount: number
  startingCount: number
  hasActive: boolean
}

export interface SessionFamily {
  root: SessionSummary
  current: SessionSummary
  /** Direct parent of `current` when present in the store; null for root sessions. */
  parent: SessionSummary | null
  members: SessionFamilyMember[]
  /** Number of descendants under the family root (`members.length - 1`). */
  childCount: number
  activity: FamilyActivity
}

export type UsageLoadState = 'ready' | 'loading' | 'error'

export interface MemberUsageState {
  loadState: UsageLoadState
  usage: SessionUsage | null
}

export interface CurrencyAmount {
  currency: string
  amount: number
}

export interface FamilyUsageRollup {
  memberCount: number
  loadingCount: number
  errorCount: number
  tokens: {
    /** Sum of known `tokens.total`, or null when no member has known token data. */
    total: number | null
    /** Sum of known total input (`input + cacheRead + cacheWrite`), or null when none. */
    input: number | null
    /** Sum of known `tokens.output`, or null when none. */
    output: number | null
    /** Sum of known `tokens.cacheRead`, or null when no member reported cache reads. */
    cacheRead: number | null
    /** Sum of known `tokens.cacheWrite`, or null when no member reported cache writes. */
    cacheWrite: number | null
    knownCount: number
    missingCount: number
    partial: boolean
  }
  cost: {
    /** Known cost sums grouped by ISO currency (USD first, then alphabetical); empty when none. */
    totals: CurrencyAmount[]
    knownCount: number
    missingCount: number
    partial: boolean
  }
  /** Settled members missing both token totals and cost data. */
  missingBothCount: number
  /** True when the exact same settled subset is missing both tokens and cost. */
  sameMissingSet: boolean
}

/** Derives a member's live status in the same priority order as the sidebar status indicator. */
export function familyMemberStatus(
  summary: Pick<
    SessionSummary,
    'status' | 'attention' | 'permissionCount' | 'phase' | 'stillRunning'
  >,
  isCurrent: boolean,
): FamilyMemberStatus {
  if (
    summary.permissionCount > 0 ||
    summary.status === 'awaiting_permission' ||
    summary.attention === 'permission'
  ) {
    return 'waiting'
  }
  if (summary.status === 'failed' || summary.attention === 'error') return 'error'
  if (summary.status === 'auth_required') return 'auth'
  if (isActivelyRunning(summary)) return 'running'
  if (isWaitingBackground(summary) || Boolean(summary.stillRunning)) return 'background'
  if (summary.status === 'starting') return 'starting'
  if (!isCurrent && summary.attention === 'unread') return 'unread'
  return 'idle'
}

/** Aggregates active/waiting/error counts across family members. */
export function summarizeFamilyActivity(
  members: readonly Pick<SessionFamilyMember, 'status'>[],
): FamilyActivity {
  let waitingCount = 0
  let errorCount = 0
  let runningCount = 0
  let backgroundCount = 0
  let startingCount = 0
  for (const member of members) {
    switch (member.status) {
      case 'waiting':
        waitingCount++
        break
      case 'error':
        errorCount++
        break
      case 'running':
        runningCount++
        break
      case 'background':
        backgroundCount++
        break
      case 'starting':
        startingCount++
        break
      default:
        break
    }
  }
  return {
    waitingCount,
    errorCount,
    runningCount,
    backgroundCount,
    startingCount,
    hasActive: waitingCount > 0 || runningCount > 0 || backgroundCount > 0 || startingCount > 0,
  }
}

function compareSiblingOrder(a: SessionSummary, b: SessionSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id.localeCompare(b.id)
}

/**
 * Resolves the session family containing `currentId`: walks up `parentId` to the root, then lists
 * the root and its descendants in creation order (DFS). Returns null for standalone sessions.
 */
export function resolveSessionFamily(
  byId: Readonly<Record<string, SessionSummary>>,
  currentId: string,
): SessionFamily | null {
  const current = byId[currentId]
  if (!current) return null

  const ancestors = new Set<string>([current.id])
  let root = current
  while (root.parentId && byId[root.parentId] && !ancestors.has(root.parentId)) {
    root = byId[root.parentId]!
    ancestors.add(root.id)
  }

  const rootArchived = root.archivedAt !== null
  const includeMember = (candidate: SessionSummary): boolean => {
    if (candidate.prepared && candidate.id !== current.id) return false
    if (!rootArchived && candidate.archivedAt !== null && !ancestors.has(candidate.id)) {
      return false
    }
    return true
  }

  const childrenByParent = new Map<string, SessionSummary[]>()
  for (const candidate of Object.values(byId)) {
    if (!candidate.parentId || !includeMember(candidate)) continue
    let list = childrenByParent.get(candidate.parentId)
    if (!list) {
      list = []
      childrenByParent.set(candidate.parentId, list)
    }
    list.push(candidate)
  }
  for (const list of childrenByParent.values()) {
    list.sort(compareSiblingOrder)
  }

  const members: SessionFamilyMember[] = []
  const visited = new Set<string>()
  const visit = (node: SessionSummary, depth: number): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    const isCurrent = node.id === current.id
    members.push({
      summary: node,
      depth,
      isRoot: node.id === root.id,
      isCurrent,
      isDirectParent: current.parentId === node.id,
      status: familyMemberStatus(node, isCurrent),
    })
    const kids = childrenByParent.get(node.id)
    if (!kids) return
    for (const child of kids) {
      visit(child, depth + 1)
    }
  }
  visit(root, 0)

  if (members.length <= 1) return null

  const parent = current.parentId ? (byId[current.parentId] ?? null) : null
  return {
    root,
    current,
    parent,
    members,
    childCount: members.length - 1,
    activity: summarizeFamilyActivity(members),
  }
}

/** Whether `usage` carries valid numeric token totals (explicit `0` counts as known). */
export function hasKnownTokens(usage: SessionUsage | null | undefined): boolean {
  const tok = usage?.tokens
  return (
    tok !== null &&
    tok !== undefined &&
    Number.isFinite(tok.total) &&
    Number.isFinite(tok.input) &&
    Number.isFinite(tok.output)
  )
}

/** Whether `usage` carries a valid cost figure (explicit `0` counts as known). */
export function hasKnownCost(usage: SessionUsage | null | undefined): boolean {
  const cost = usage?.cost
  return (
    cost !== null &&
    cost !== undefined &&
    Number.isFinite(cost.amount) &&
    typeof cost.currency === 'string' &&
    cost.currency.trim().length > 0
  )
}

/** Total input tokens of a session (`input + cacheRead + cacheWrite`), matching per-session UI. */
export function sessionTotalInput(usage: SessionUsage): number | null {
  if (!hasKnownTokens(usage) || !usage.tokens) return null
  return usage.tokens.input + (usage.tokens.cacheRead ?? 0) + (usage.tokens.cacheWrite ?? 0)
}

function compareCurrencies(a: CurrencyAmount, b: CurrencyAmount): number {
  if (a.currency === b.currency) return 0
  if (a.currency === 'USD') return -1
  if (b.currency === 'USD') return 1
  return a.currency.localeCompare(b.currency)
}

/**
 * Rolls up verifiable tokens and cost across all members of a session family.
 * Missing or failed member data is tracked explicitly and NEVER treated as zero.
 */
export function rollupFamilyUsage(
  members: readonly Pick<SessionFamilyMember, 'summary'>[],
  usageById: Readonly<Record<string, MemberUsageState>>,
): FamilyUsageRollup {
  let loadingCount = 0
  let errorCount = 0

  let tokensKnown = 0
  let tokensMissing = 0
  let totalTokens = 0
  let totalInput = 0
  let totalOutput = 0
  let cacheReadKnown = 0
  let totalCacheRead = 0
  let cacheWriteKnown = 0
  let totalCacheWrite = 0

  let costKnown = 0
  let costMissing = 0
  const costByCurrency = new Map<string, number>()

  let missingBoth = 0

  for (const member of members) {
    const entry = usageById[member.summary.id] ?? { loadState: 'ready', usage: null }
    if (entry.loadState === 'loading') {
      loadingCount++
      continue
    }
    if (entry.loadState === 'error') {
      errorCount++
      tokensMissing++
      costMissing++
      missingBoth++
      continue
    }

    const usage = entry.usage
    const tokOk = hasKnownTokens(usage)
    const costOk = hasKnownCost(usage)

    if (tokOk && usage?.tokens) {
      const tok = usage.tokens
      tokensKnown++
      totalTokens += tok.total
      totalInput += tok.input + (tok.cacheRead ?? 0) + (tok.cacheWrite ?? 0)
      totalOutput += tok.output
      if (tok.cacheRead !== null && Number.isFinite(tok.cacheRead)) {
        cacheReadKnown++
        totalCacheRead += tok.cacheRead
      }
      if (tok.cacheWrite !== null && Number.isFinite(tok.cacheWrite)) {
        cacheWriteKnown++
        totalCacheWrite += tok.cacheWrite
      }
    } else {
      tokensMissing++
    }

    if (costOk && usage?.cost) {
      costKnown++
      const code = usage.cost.currency.trim().toUpperCase()
      costByCurrency.set(code, (costByCurrency.get(code) ?? 0) + usage.cost.amount)
    } else {
      costMissing++
    }

    if (!tokOk && !costOk) {
      missingBoth++
    }
  }

  const totals: CurrencyAmount[] = [...costByCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort(compareCurrencies)

  return {
    memberCount: members.length,
    loadingCount,
    errorCount,
    tokens: {
      total: tokensKnown > 0 ? totalTokens : null,
      input: tokensKnown > 0 ? totalInput : null,
      output: tokensKnown > 0 ? totalOutput : null,
      cacheRead: cacheReadKnown > 0 ? totalCacheRead : null,
      cacheWrite: cacheWriteKnown > 0 ? totalCacheWrite : null,
      knownCount: tokensKnown,
      missingCount: tokensMissing,
      partial: tokensKnown > 0 && tokensMissing > 0,
    },
    cost: {
      totals,
      knownCount: costKnown,
      missingCount: costMissing,
      partial: costKnown > 0 && costMissing > 0,
    },
    missingBothCount: missingBoth,
    sameMissingSet: tokensMissing === costMissing && tokensMissing === missingBoth,
  }
}

export type FamilyUsageFetcher = (
  hostId: string | null,
  sessionIds: string[],
) => Promise<{ sessions: SessionUsageItem[] }>

const defaultFetcher: FamilyUsageFetcher = (hostId, sessionIds) =>
  hostAt(hostId, 'sessions.usages', { sessionIds })

/**
 * Fetches live or stored usages for every member in the family, grouped by host so both local and
 * remote hosts work. Any host failure marks only that host's members as `error` rather than zero.
 */
export async function fetchFamilyUsages(
  members: readonly Pick<SessionFamilyMember, 'summary'>[],
  fetcher: FamilyUsageFetcher = defaultFetcher,
): Promise<Record<string, MemberUsageState>> {
  const byHost = new Map<string | null, string[]>()
  for (const member of members) {
    const hostId = hostOfSession(member.summary)
    let list = byHost.get(hostId)
    if (!list) {
      list = []
      byHost.set(hostId, list)
    }
    list.push(member.summary.id)
  }

  const out: Record<string, MemberUsageState> = {}
  await Promise.all(
    [...byHost].map(async ([hostId, sessionIds]) => {
      try {
        const { sessions } = await fetcher(hostId, sessionIds)
        const returned = new Map<string, SessionUsage | null>()
        for (const item of sessions) {
          returned.set(item.sessionId, item.usage)
        }
        for (const id of sessionIds) {
          out[id] = { loadState: 'ready', usage: returned.get(id) ?? null }
        }
      } catch {
        for (const id of sessionIds) {
          out[id] = { loadState: 'error', usage: null }
        }
      }
    }),
  )
  return out
}

/** Navigates to a clicked family member (using `backTo` for the direct parent) and closes the popover. */
export function selectFamilyMember(
  member: SessionFamilyMember,
  actions: {
    onClose: () => void
    backTo: (view: { kind: 'session'; sessionId: string }, open: () => void) => void
    openSession: (sessionId: string, projectPath: string) => void
  },
): void {
  actions.onClose()
  if (member.isCurrent) return
  const target = member.summary
  if (member.isDirectParent) {
    actions.backTo({ kind: 'session', sessionId: target.id }, () =>
      actions.openSession(target.id, target.projectPath),
    )
    return
  }
  actions.openSession(target.id, target.projectPath)
}

/**
 * Merges freshly loaded in-memory replica usages with fetched host usages so the active session
 * (and any other watched session) stays live while unloaded siblings use host-fetched data.
 */
export function mergeFamilyUsageSources(
  members: readonly Pick<SessionFamilyMember, 'summary'>[],
  liveById: Readonly<Record<string, SessionUsage | null>>,
  fetchedById: Readonly<Record<string, MemberUsageState>>,
  loading: boolean,
): Record<string, MemberUsageState> {
  const merged: Record<string, MemberUsageState> = {}
  for (const member of members) {
    const id = member.summary.id
    if (Object.hasOwn(liveById, id)) {
      merged[id] = { loadState: 'ready', usage: liveById[id] ?? null }
    } else if (Object.hasOwn(fetchedById, id)) {
      merged[id] = fetchedById[id]!
    } else if (loading) {
      merged[id] = { loadState: 'loading', usage: null }
    } else {
      merged[id] = { loadState: 'ready', usage: null }
    }
  }
  return merged
}
