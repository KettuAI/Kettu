// Usage read from several hosts with the same days and clock, added up as one host's.

import type { TokenParts, UsageSummary } from '@shared/usage'

const COUNTS = [
  'requests',
  'turns',
  'unpricedTokens',
  'cacheSaved',
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
] as const

/** Dollars of two sums; null only while neither had a priced model. */
export function addCost(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : a + b
}

function addParts(a: TokenParts, b: TokenParts): TokenParts {
  const sum = { cost: addCost(a.cost, b.cost) } as TokenParts
  for (const key of COUNTS) sum[key] = a[key] + b[key]
  return sum
}

function mergeRows<T extends TokenParts>(lists: readonly T[][], key: (row: T) => string): T[] {
  const rows = new Map<string, T>()
  for (const list of lists) {
    for (const row of list) {
      const id = key(row)
      const was = rows.get(id)
      rows.set(id, was ? { ...was, ...addParts(was, row) } : row)
    }
  }
  return [...rows.values()]
}

/**
 * The hosts' summaries as one. Agents of the same id on two hosts, as each one's default Claude
 * Code, count as one agent; another host's projects already name their host in their path.
 */
export function mergeSummaries(summaries: readonly UsageSummary[]): UsageSummary {
  if (summaries.length === 1) return summaries[0]!
  const firsts = summaries.map((s) => s.first).filter((first): first is number => first !== null)
  const sources: UsageSummary['sources'] = {}
  for (const summary of summaries) {
    for (const [agentId, source] of Object.entries(summary.sources)) {
      sources[agentId as keyof typeof sources] ??= source
    }
  }
  return {
    days: mergeRows(
      summaries.map((s) => s.days),
      (row) => `${row.day}\n${row.agentId}`,
    ),
    clock: mergeRows(
      summaries.map((s) => s.clock),
      (row) => `${row.hour}\n${row.agentId}`,
    ),
    models: mergeRows(
      summaries.map((s) => s.models),
      (row) => JSON.stringify([row.agentId, row.model]),
    ),
    projects: mergeRows(
      summaries.map((s) => s.projects),
      (row) => JSON.stringify([row.agentId, row.project]),
    ),
    sources,
    first: firsts.length > 0 ? Math.min(...firsts) : null,
    agents: [...new Set(summaries.flatMap((s) => s.agents))],
    pricesAsOf: summaries[0]!.pricesAsOf,
  }
}
