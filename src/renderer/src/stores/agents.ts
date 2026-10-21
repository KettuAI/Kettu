import { create } from 'zustand'
import type { AgentStatus, EnvironmentInfo } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { host } from '@renderer/lib/host'

interface AgentsStore {
  byId: Partial<Record<AgentId, AgentStatus>>
  order: AgentId[]
  environment: EnvironmentInfo | null
  loaded: boolean
  setAll(statuses: AgentStatus[]): void
  setOne(status: AgentStatus): void
  refresh(): Promise<void>
  check(agentId?: AgentId): Promise<void>
  reloadEnvironment(): Promise<void>
}

export const useAgentsStore = create<AgentsStore>()((set, get) => ({
  byId: {},
  order: [],
  environment: null,
  loaded: false,
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
    set({ environment })
  },
  async check(agentId) {
    get().setAll(await host('agents.check', agentId ? { agentId } : {}))
  },
  async reloadEnvironment() {
    get().setAll(await host('agents.reloadEnvironment', undefined))
    set({ environment: await host('agents.environment', undefined) })
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
