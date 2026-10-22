import { create } from 'zustand'
import type { AgentDetails, AgentStatus, EnvironmentInfo } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'

interface AgentsStore {
  byId: Partial<Record<AgentId, AgentStatus>>
  order: AgentId[]
  environment: EnvironmentInfo | null
  /** Each agent's page in Settings, read when it shows; kept so it does not flash empty. */
  details: Partial<Record<AgentId, AgentDetails>>
  loaded: boolean
  /** The update check the user started in Settings › Agents, and its outcome. */
  updateCheck: { running: boolean; finishedAt: number | null; error: string | null }
  /** Agents updated in this run, so their row can say so until the app restarts. */
  updated: Partial<Record<AgentId, true>>
  setAll(statuses: AgentStatus[]): void
  setOne(status: AgentStatus): void
  refresh(): Promise<void>
  check(agentId?: AgentId): Promise<void>
  reloadEnvironment(): Promise<void>
  loadDetails(agentId: AgentId): Promise<void>
  checkUpdates(): Promise<void>
  update(agentId: AgentId): Promise<void>
}

/** A reply can land after a newer `environment.changed` event, so the later reading wins. */
function laterEnvironment(current: EnvironmentInfo | null, next: EnvironmentInfo): EnvironmentInfo {
  if (current?.resolvedAt == null) return next
  return next.resolvedAt != null && next.resolvedAt >= current.resolvedAt ? next : current
}

export const useAgentsStore = create<AgentsStore>()((set, get) => ({
  byId: {},
  order: [],
  environment: null,
  details: {},
  loaded: false,
  updateCheck: { running: false, finishedAt: null, error: null },
  updated: {},
  setAll(statuses) {
    set({
      byId: Object.fromEntries(statuses.map((s) => [s.id, s])),
      order: statuses.map((s) => s.id),
      loaded: true,
    })
  },
  setOne(status) {
    set((state) => ({
      byId: { ...state.byId, [status.id]: status },
      order: state.order.includes(status.id) ? state.order : [...state.order, status.id],
    }))
  },
  async refresh() {
    const [statuses, environment] = await Promise.all([
      host('agents.list', undefined),
      host('agents.environment', undefined),
    ])
    get().setAll(statuses)
    set((state) => ({ environment: laterEnvironment(state.environment, environment) }))
  },
  async check(agentId) {
    get().setAll(await host('agents.check', agentId ? { agentId } : {}))
  },
  async reloadEnvironment() {
    get().setAll(await host('agents.reloadEnvironment', undefined))
    const environment = await host('agents.environment', undefined)
    set((state) => ({ environment: laterEnvironment(state.environment, environment) }))
  },
  async loadDetails(agentId) {
    const details = await host('agents.details', { agentId })
    set((state) => ({ details: { ...state.details, [agentId]: details } }))
  },
  async checkUpdates() {
    if (get().updateCheck.running) return
    set({ updateCheck: { running: true, finishedAt: null, error: null } })
    try {
      get().setAll(await host('agents.checkUpdates', undefined))
      set({ updateCheck: { running: false, finishedAt: Date.now(), error: null } })
    } catch (e) {
      set({ updateCheck: { running: false, finishedAt: null, error: errorMessage(e) } })
    }
  },
  async update(agentId) {
    await host('agents.update', { agentId })
    // The request also resolves when cancelled; then the update is still on offer.
    const status = get().byId[agentId]
    if (status && !status.task && !status.update) {
      set((state) => ({ updated: { ...state.updated, [agentId]: true } }))
    }
    await get().loadDetails(agentId)
  },
}))

export function agentName(agentId: AgentId): string {
  return useAgentsStore.getState().byId[agentId]?.name ?? AGENT_NAMES[agentId]
}

export const AGENT_NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'fake-agent': 'Fake agent',
}

/** Agents the user can start a session with, in catalog order. */
export function usableAgents(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return order.map((id) => byId[id]).filter((s): s is AgentStatus => !!s)
}

export function isInstalled(status: AgentStatus): boolean {
  return !['not-installed', 'node-missing', 'node-outdated'].includes(status.state)
}
