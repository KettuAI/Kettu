// An account's plan limits are its own, wherever it is signed in: each host reads them for its
// agents, and every view shows the newest of those readings.

import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'

/** A computer's agents, null being this computer. */
export interface HostAgentList {
  hostId: string | null
  agents: readonly AgentStatus[]
}

/** When the limits were read, the latest window's; null while there are none. */
export const readAtOf = (limits: readonly PlanLimit[]): number | null =>
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
  limits: PlanLimit[]
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
      const readAt = readAtOf(agent.limits)
      if (key === null || readAt === null) continue
      const kept = readings.get(key)
      if (kept && kept.readAt >= readAt) continue
      readings.set(key, { hostId, limits: agent.limits, readAt })
    }
  }
  return readings
}

/** The agent's limits as last read of its account on any host; its own when its account cannot be told. */
export function newestLimits(
  readings: ReadonlyMap<string, PlanReading>,
  agent: AgentStatus,
): PlanLimit[] {
  const key = accountKey(agent)
  return (key === null ? undefined : readings.get(key)?.limits) ?? agent.limits
}

/** A key for what is one computer's own, such as an agent whose account cannot be told. */
export const ownKey = (hostId: string | null, id: string): string => `${hostId ?? ''}/${id}`

/** The key of an account's card or read, the same on every computer. */
export const accountCardKey = (account: string): string => `account:${account}`

/** An agent standing for its account among the hosts shown, with the account's newest limits. */
export interface AccountAgent {
  key: string
  hostId: string | null
  /** Every host shown that it is on, in order. */
  hostIds: (string | null)[]
  agent: AgentStatus
  limits: PlanLimit[]
  /** The agent's name, or the account's email when its agents go by different names. */
  name: string
}

/**
 * The agents of `hosts` by account: one signed in on several computers or agents once, the first
 * in order, with its newest reading in `readings`; an agent whose account cannot be told, as itself.
 */
export function accountAgents(
  hosts: readonly HostAgentList[],
  readings: ReadonlyMap<string, PlanReading>,
): AccountAgent[] {
  const found: AccountAgent[] = []
  const names = new Map<string, Set<string>>()
  for (const { hostId, agents } of hosts) {
    for (const agent of agents) {
      const account = accountKey(agent)
      const key = account === null ? ownKey(hostId, agent.id) : accountCardKey(account)
      names.set(key, (names.get(key) ?? new Set()).add(agent.name))
      const same = found.find((other) => other.key === key)
      if (same) {
        if (!same.hostIds.includes(hostId)) same.hostIds.push(hostId)
        continue
      }
      found.push({
        key,
        hostId,
        hostIds: [hostId],
        agent,
        limits: newestLimits(readings, agent),
        name: agent.name,
      })
    }
  }
  for (const entry of found) {
    const email = entry.agent.account?.email?.trim()
    if (email && names.get(entry.key)!.size > 1) entry.name = email
  }
  return found
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
      const key = accountCardKey(account)
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
