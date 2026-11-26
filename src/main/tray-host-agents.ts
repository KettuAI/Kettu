// Tracks the agents of other connected hosts for the menu bar panel, keeping only the account and
// plan limit fields needed to pick each account's newest reading. Inactive until the panel asks.

import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import { isAgentId, isHarnessId, type AgentId } from '@shared/agents'
import type { TrayHostAgent, TrayHostAgents } from '@shared/tray'

export interface TrayHostAgentsDeps {
  /** The other hosts whose session is open now. */
  openHosts(): string[]
  /** Calls `agents.list` on a connected host. */
  listAgents(hostId: string): Promise<unknown>
  /** Pushes the updated cross-host snapshot to the menu bar panel. */
  changed(hosts: TrayHostAgents[]): void
  warn(message: string): void
}

type HostAgentDelta =
  { kind: 'status'; agent: TrayHostAgent } | { kind: 'removed'; agentId: AgentId }

const ACCOUNT_KINDS = new Set<AgentAccount['kind']>([
  'account',
  'api_key',
  'external',
  'gateway',
  'none',
])

const LIMIT_STATES = new Set<PlanLimit['state']>(['ok', 'warning', 'reached'])

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseAccount(value: unknown): AgentAccount | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const { kind, label, email, tier } = value as Record<string, unknown>
  if (typeof kind !== 'string' || !ACCOUNT_KINDS.has(kind as AgentAccount['kind'])) return null
  if (typeof label !== 'string') return null
  if (email !== null && typeof email !== 'string') return null
  return {
    kind: kind as AgentAccount['kind'],
    label,
    email,
    ...(typeof tier === 'string' ? { tier } : {}),
  }
}

function parseAmount(value: unknown): PlanLimit['amount'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { used, total, unit } = value as Record<string, unknown>
  if (!isFiniteNumber(used) || !isFiniteNumber(total) || typeof unit !== 'string') return undefined
  return { used, total, unit }
}

function parseLimit(value: unknown): PlanLimit | null {
  if (typeof value !== 'object' || value === null) return null
  const { window, label, usedPercent, resetsAt, state, observedAt, amount, models, extraUsage } =
    value as Record<string, unknown>
  if (typeof window !== 'string' || typeof label !== 'string') return null
  if (usedPercent !== null && !isFiniteNumber(usedPercent)) return null
  if (resetsAt !== null && !isFiniteNumber(resetsAt)) return null
  if (typeof state !== 'string' || !LIMIT_STATES.has(state as PlanLimit['state'])) return null
  if (!isFiniteNumber(observedAt)) return null
  const parsedAmount = parseAmount(amount)
  const parsedModels =
    Array.isArray(models) && models.every((item) => typeof item === 'string')
      ? (models as string[])
      : undefined
  return {
    window,
    label,
    usedPercent,
    resetsAt,
    state: state as PlanLimit['state'],
    observedAt,
    ...(parsedAmount ? { amount: parsedAmount } : {}),
    ...(parsedModels ? { models: parsedModels } : {}),
    ...(extraUsage === true ? { extraUsage: true } : {}),
  }
}

/**
 * Extracts only the fields the menu bar panel needs from an agent status sent by another host,
 * dropping malformed entries so untrusted remote payloads cannot reach the panel unchecked.
 */
export function toTrayHostAgent(value: unknown): TrayHostAgent | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, harnessId, account, limits } = value as Record<string, unknown>
  if (!isAgentId(id) || !isHarnessId(harnessId) || !Array.isArray(limits)) return null
  const parsedLimits: PlanLimit[] = []
  for (const item of limits) {
    const parsed = parseLimit(item)
    if (parsed) parsedLimits.push(parsed)
  }
  return {
    id,
    harnessId,
    account: parseAccount(account),
    limits: parsedLimits,
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

export class TrayHostAgentsFeed {
  private active = false
  private readonly open = new Set<string>()
  private readonly hosts = new Map<string, Map<AgentId, TrayHostAgent>>()
  private readonly loaded = new Set<string>()
  private readonly loading = new Map<string, { generation: number; events: HostAgentDelta[] }>()
  private readonly generation = new Map<string, number>()
  private lastSerialized = '[]'

  constructor(private readonly deps: TrayHostAgentsDeps) {}

  /**
   * Returns the current snapshot immediately without blocking on network reads, activating remote
   * tracking on first call and loading any connected hosts not yet fetched.
   */
  snapshot(): TrayHostAgents[] {
    if (!this.active) {
      this.active = true
      for (const hostId of this.deps.openHosts()) this.open.add(hostId)
    }
    this.ensureLoaded()
    const current = this.buildSnapshot()
    this.lastSerialized = JSON.stringify(current)
    return current
  }

  /** Starts loading any connected hosts that have not completed an initial read yet. */
  ensureLoaded(): void {
    if (!this.active) return
    for (const hostId of this.deps.openHosts()) this.open.add(hostId)
    for (const hostId of this.open) {
      if (!this.loaded.has(hostId) && !this.loading.has(hostId)) this.load(hostId)
    }
  }

  /** A session with another host opened: read its agents while the panel is active. */
  opened(hostId: string): void {
    this.open.add(hostId)
    this.loaded.delete(hostId)
    if (this.active) this.load(hostId)
  }

  /** Another host lost state and asked for a resync: read its agents whole again. */
  resync(hostId: string): void {
    if (!this.active || !this.open.has(hostId)) return
    this.loaded.delete(hostId)
    this.load(hostId)
  }

  /** The session with another host ended: drop its cached agents and fall back cleanly. */
  ended(hostId: string): void {
    this.open.delete(hostId)
    this.bump(hostId)
    this.loading.delete(hostId)
    this.loaded.delete(hostId)
    if (this.hosts.delete(hostId)) this.emitIfChanged()
  }

  /** Drops any hosts no longer listed as known (such as removed or folded hosts). */
  syncHosts(knownHostIds: readonly string[]): void {
    const known = new Set(knownHostIds)
    const stale = new Set<string>()
    for (const hostId of this.open) if (!known.has(hostId)) stale.add(hostId)
    for (const hostId of this.hosts.keys()) if (!known.has(hostId)) stale.add(hostId)
    for (const hostId of stale) this.ended(hostId)
  }

  /** Applies live agent status or removal events from a connected host. */
  event(hostId: string, event: unknown): void {
    if (!this.active || !this.open.has(hostId) || typeof event !== 'object' || event === null) {
      return
    }
    const record = event as Record<string, unknown>
    if (record.type === 'agent.status') {
      const agent = toTrayHostAgent(record.status)
      if (!agent) return
      const pending = this.loading.get(hostId)
      if (pending) pending.events.push({ kind: 'status', agent })
      let agents = this.hosts.get(hostId)
      if (!agents) {
        agents = new Map()
        this.hosts.set(hostId, agents)
      }
      agents.set(agent.id, agent)
      this.emitIfChanged()
      return
    }
    if (record.type === 'agent.removed' && isAgentId(record.agentId)) {
      const pending = this.loading.get(hostId)
      if (pending) pending.events.push({ kind: 'removed', agentId: record.agentId })
      const agents = this.hosts.get(hostId)
      if (agents?.delete(record.agentId)) this.emitIfChanged()
    }
  }

  /** Stops tracking once the menu bar panel window is gone; it activates again on next open. */
  deactivate(): void {
    this.active = false
    for (const hostId of this.loading.keys()) this.bump(hostId)
    this.loading.clear()
    this.loaded.clear()
    this.hosts.clear()
    this.lastSerialized = '[]'
  }

  private bump(hostId: string): number {
    const next = (this.generation.get(hostId) ?? 0) + 1
    this.generation.set(hostId, next)
    return next
  }

  private load(hostId: string): void {
    const generation = this.bump(hostId)
    const pending = { generation, events: [] as HostAgentDelta[] }
    this.loading.set(hostId, pending)
    void this.deps.listAgents(hostId).then(
      (result) => {
        if (!this.active || !this.open.has(hostId) || this.generation.get(hostId) !== generation) {
          return
        }
        this.loading.delete(hostId)
        if (!Array.isArray(result)) {
          this.deps.warn(`Host ${hostId} returned a malformed agents list for the menu bar panel`)
          return
        }
        const agents = new Map<AgentId, TrayHostAgent>()
        for (const item of result) {
          const parsed = toTrayHostAgent(item)
          if (parsed) agents.set(parsed.id, parsed)
        }
        // Replay live events received while `agents.list` was in flight so newer updates win.
        for (const delta of pending.events) {
          if (delta.kind === 'status') agents.set(delta.agent.id, delta.agent)
          else agents.delete(delta.agentId)
        }
        this.hosts.set(hostId, agents)
        this.loaded.add(hostId)
        this.emitIfChanged()
      },
      (error: unknown) => {
        if (this.generation.get(hostId) !== generation) return
        this.loading.delete(hostId)
        this.deps.warn(
          `Could not read the agents of host ${hostId} for the menu bar panel: ${errorMessage(error)}`,
        )
      },
    )
  }

  private buildSnapshot(): TrayHostAgents[] {
    const hostIds = [...this.hosts.keys()].sort((a, b) => a.localeCompare(b))
    const snapshot: TrayHostAgents[] = []
    for (const hostId of hostIds) {
      const agents = [...(this.hosts.get(hostId)?.values() ?? [])].sort((a, b) =>
        a.id.localeCompare(b.id),
      )
      if (agents.length > 0) snapshot.push({ hostId, agents })
    }
    return snapshot
  }

  private emitIfChanged(): void {
    if (!this.active) return
    const next = this.buildSnapshot()
    const serialized = JSON.stringify(next)
    if (serialized === this.lastSerialized) return
    this.lastSerialized = serialized
    this.deps.changed(next)
  }
}
