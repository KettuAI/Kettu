import { useMemo } from 'react'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type {
  AgentDetails,
  AgentInstallMethod,
  AgentStatus,
  AgentTask,
  EnvironmentInfo,
} from '@shared/agent-host'
import {
  harnessOf,
  MULTI_AGENT_HARNESSES,
  sortAgentIds,
  type AgentId,
  type HarnessId,
} from '@shared/thread'
import { errorMessage, host, hostAt, type HostRequest } from '@renderer/lib/host'
import { newestReadings, type PlanReading } from '@renderer/lib/plan-readings'
import { useSettingsStore } from '@renderer/stores/settings'

/** One host's agents, in the order the menus list them. */
export interface HostAgents {
  byId: Partial<Record<AgentId, AgentStatus>>
  order: AgentId[]
}

export interface AgentsStore extends HostAgents {
  /** The agents of each other host this computer connects to, by its id; the rest is this computer's. */
  hosts: Record<string, HostAgents>
  environment: EnvironmentInfo | null
  /** Each agent's page in Settings, read when it shows; kept so it does not flash empty. */
  details: Partial<Record<AgentId, AgentDetails>>
  loaded: boolean
  /** The update check the user started in Settings › Agents, and its outcome. */
  updateCheck: { running: boolean; finishedAt: number | null; error: string | null }
  /** Agents updated in this run, so their row can say so until the app restarts. */
  updated: Partial<Record<AgentId, true>>
  /**
   * Why an install or update the user asked for did not run, when no failed task says why: a retry
   * that no longer applies, another task running, npm missing.
   */
  taskErrors: Partial<Record<AgentId, { kind: AgentTask['kind']; message: string }>>
  setAll(statuses: AgentStatus[]): void
  setOne(status: AgentStatus): void
  /** An added agent the user removed; its sessions stay. */
  remove(agentId: AgentId): void
  refresh(): Promise<void>
  check(agentId?: AgentId): Promise<void>
  reloadEnvironment(): Promise<void>
  /** Detects again and names the harnesses whose user program is found, in the order to add them. */
  detectedPrograms(): Promise<HarnessId[]>
  loadDetails(agentId: AgentId): Promise<void>
  checkUpdates(): Promise<void>
  /** These four never reject: a failure shows as the agent's failed task or in `taskErrors`. */
  update(agentId: AgentId): Promise<void>
  /** Updates the user's own program the way it was installed. */
  updateCli(agentId: AgentId): Promise<void>
  install(agentId: AgentId, method?: AgentInstallMethod['id']): Promise<void>
  /** Stops a running install or update, or dismisses one that failed. */
  cancelTask(agentId: AgentId): Promise<void>
}

/** A reply can land after a newer `environment.changed` event, so the later reading wins. */
function laterEnvironment(current: EnvironmentInfo | null, next: EnvironmentInfo): EnvironmentInfo {
  if (current?.resolvedAt == null) return next
  return next.resolvedAt != null && next.resolvedAt >= current.resolvedAt ? next : current
}

export type AgentsStoreHook = UseBoundStore<StoreApi<AgentsStore>>

/** The agents of the host `request` reaches: this computer's, or another host's for Settings. */
export function createAgentsStore(request: HostRequest): AgentsStoreHook {
  const store: AgentsStoreHook = create<AgentsStore>()((set, get) => ({
    byId: {},
    order: [],
    hosts: {},
    environment: null,
    details: {},
    loaded: false,
    updateCheck: { running: false, finishedAt: null, error: null },
    updated: {},
    taskErrors: {},
    setAll(statuses) {
      set({ ...listOf(statuses), loaded: true })
    },
    remove(agentId) {
      set((state) => ({
        ...withoutAgent(state, agentId),
        details: without(state.details, agentId),
      }))
    },
    setOne(status) {
      set((state) => ({
        byId: { ...state.byId, [status.id]: status },
        // An agent added since takes its place beside its harness's other agents.
        order: state.order.includes(status.id)
          ? state.order
          : sortAgentIds([...state.order, status.id]),
        // A task the host reports says more than a request's error.
        taskErrors: status.task ? without(state.taskErrors, status.id) : state.taskErrors,
      }))
    },
    async refresh() {
      const [statuses, environment] = await Promise.all([
        request('agents.list', undefined),
        request('agents.environment', undefined),
      ])
      get().setAll(statuses)
      set((state) => ({ environment: laterEnvironment(state.environment, environment) }))
    },
    async check(agentId) {
      get().setAll(await request('agents.check', agentId ? { agentId } : {}))
    },
    async reloadEnvironment() {
      get().setAll(await request('agents.reloadEnvironment', undefined))
      const environment = await request('agents.environment', undefined)
      set((state) => ({ environment: laterEnvironment(state.environment, environment) }))
    },
    detectedPrograms: () => request('agents.detectedPrograms', undefined),
    async loadDetails(agentId) {
      const details = await request('agents.details', { agentId })
      set((state) => ({ details: { ...state.details, [agentId]: details } }))
    },
    async checkUpdates() {
      if (get().updateCheck.running) return
      set({ updateCheck: { running: true, finishedAt: null, error: null } })
      try {
        get().setAll(await request('agents.checkUpdates', undefined))
        set({ updateCheck: { running: false, finishedAt: Date.now(), error: null } })
      } catch (e) {
        set({ updateCheck: { running: false, finishedAt: null, error: errorMessage(e) } })
      }
    },
    async update(agentId) {
      const done = await taskRequest(store, agentId, 'update', () =>
        request('agents.update', { agentId }),
      )
      // The request also resolves when cancelled; then the update is still on offer.
      const status = get().byId[agentId]
      if (done && status && !status.task && !status.update) {
        set((state) => ({ updated: { ...state.updated, [agentId]: true } }))
      }
      await get()
        .loadDetails(agentId)
        .catch((e: unknown) => console.warn(`Could not read the agent details: ${errorMessage(e)}`))
    },
    async updateCli(agentId) {
      const done = await taskRequest(store, agentId, 'update', () =>
        request('agents.updateCli', { agentId }),
      )
      if (done && !get().byId[agentId]?.task) {
        set((state) => ({ updated: { ...state.updated, [agentId]: true } }))
      }
    },
    async install(agentId, method) {
      await taskRequest(store, agentId, 'install', () =>
        request('agents.install', method ? { agentId, method } : { agentId }),
      )
    },
    async cancelTask(agentId) {
      set((state) => ({ taskErrors: without(state.taskErrors, agentId) }))
      await request('agents.cancelTask', { agentId }).catch((e: unknown) =>
        console.warn(`Could not cancel the task: ${errorMessage(e)}`),
      )
    },
  }))
  return store
}

export const useAgentsStore = createAgentsStore(host)

function listOf(statuses: AgentStatus[]): HostAgents {
  return {
    byId: Object.fromEntries(statuses.map((s) => [s.id, s])),
    order: sortAgentIds(statuses.map((s) => s.id)),
  }
}

const NO_AGENTS: HostAgents = { byId: {}, order: [] }

/** The agents of a host's list that menus and pages show: added ones that are not turned off. */
export function listedAgents(agents: HostAgents): AgentStatus[] {
  return agents.order
    .map((id) => agents.byId[id])
    .filter((a): a is AgentStatus => !!a && a.registered !== false && !a.disabled)
}

function readingsOf(
  byId: HostAgents['byId'],
  hosts: AgentsStore['hosts'],
): Map<string, PlanReading> {
  const all = (agents: HostAgents['byId']) =>
    Object.values(agents).filter((a): a is AgentStatus => !!a)
  return newestReadings([
    { hostId: null, agents: all(byId) },
    ...Object.entries(hosts).map(([hostId, agents]) => ({ hostId, agents: all(agents.byId) })),
  ])
}

/** The newest plan limits read of each account on any host this window knows. */
export function planReadingsOf(
  state: Pick<AgentsStore, 'byId' | 'hosts'>,
): Map<string, PlanReading> {
  return readingsOf(state.byId, state.hosts)
}

export function usePlanReadings(): ReadonlyMap<string, PlanReading> {
  const { byId, hosts } = useAgentsStore(useShallow((s) => ({ byId: s.byId, hosts: s.hosts })))
  return useMemo(() => readingsOf(byId, hosts), [byId, hosts])
}

/** The agents of the host named, null being this computer; none while another's are unread. */
export function agentsOn(
  state: Pick<AgentsStore, 'byId' | 'order' | 'hosts'>,
  hostId: string | null,
): HostAgents {
  return hostId === null ? state : (state.hosts[hostId] ?? NO_AGENTS)
}

function setHost(hostId: string, change: (agents: HostAgents) => HostAgents): void {
  useAgentsStore.setState((state) => ({
    hosts: { ...state.hosts, [hostId]: change(state.hosts[hostId] ?? NO_AGENTS) },
  }))
}

/** Reads another host's agents, as when a connection to it opens. */
export async function readHostAgents(hostId: string): Promise<void> {
  const statuses = await hostAt(hostId, 'agents.list', undefined)
  setHost(hostId, () => listOf(statuses))
}

export function hostAgentChanged(hostId: string, status: AgentStatus): void {
  setHost(hostId, (agents) => ({
    byId: { ...agents.byId, [status.id]: status },
    order: agents.order.includes(status.id)
      ? agents.order
      : sortAgentIds([...agents.order, status.id]),
  }))
}

export function hostAgentRemoved(hostId: string, agentId: AgentId): void {
  setHost(hostId, (agents) => withoutAgent(agents, agentId))
}

function withoutAgent(agents: HostAgents, agentId: AgentId): HostAgents {
  const status = agents.byId[agentId]
  if (status?.isDefault) {
    return {
      byId: { ...agents.byId, [agentId]: { ...status, registered: false } },
      order: agents.order,
    }
  }
  return {
    byId: without(agents.byId, agentId),
    order: agents.order.filter((id) => id !== agentId),
  }
}

/** Forgets the agents of a host this computer no longer connects to. */
export function forgetHostAgents(hostId: string): void {
  useAgentsStore.setState((state) => {
    if (!(hostId in state.hosts)) return state
    const hosts = { ...state.hosts }
    delete hosts[hostId]
    return { hosts }
  })
}

function without<T>(
  record: Partial<Record<AgentId, T>>,
  agentId: AgentId,
): Partial<Record<AgentId, T>> {
  if (!(agentId in record)) return record
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== agentId))
}

/** Runs an install or update request; true when it finished, false when it failed. */
async function taskRequest(
  store: AgentsStoreHook,
  agentId: AgentId,
  kind: AgentTask['kind'],
  request: () => Promise<unknown>,
): Promise<boolean> {
  const { setState, getState } = store
  setState((state) => ({ taskErrors: without(state.taskErrors, agentId) }))
  try {
    await request()
    return true
  } catch (e) {
    if (getState().byId[agentId]?.task?.state !== 'failed') {
      const message = errorMessage(e)
      setState((state) => ({ taskErrors: { ...state.taskErrors, [agentId]: { kind, message } } }))
    }
    return false
  }
}

/** The agent's name on the host named; a removed agent's sessions name its harness. */
export function agentName(agentId: AgentId, hostId: string | null = null): string {
  return (
    agentsOn(useAgentsStore.getState(), hostId).byId[agentId]?.name ??
    // This computer's added agents are in the settings, which load before their statuses.
    (hostId === null ? addedAgentName(agentId) : undefined) ??
    AGENT_NAMES[harnessOf(agentId)]
  )
}

function addedAgentName(agentId: AgentId): string | undefined {
  return useSettingsStore.getState().settings.addedAgents.find((agent) => agent.id === agentId)
    ?.name
}

export const AGENT_NAMES: Record<HarnessId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  auggie: 'Auggie CLI',
  codebuddy: 'Codebuddy Code',
  deepagents: 'DeepAgents',
  dimcode: 'DimCode',
  dirac: 'Dirac',
  glm: 'GLM Agent',
  nova: 'Nova',
  qoder: 'Qoder CLI',
  sigit: 'siGit Code',
  agoragentic: 'Agoragentic',
  autohand: 'Autohand Code',
  bob: 'Bob',
  minimax: 'MiniMax Code',
  cursor: 'Cursor',
  kimi: 'Kimi Code CLI',
  amp: 'Amp',
  goose: 'goose',
  kilo: 'Kilo Code',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  qwen: 'Qwen Code',
  grok: 'Grok',
  cline: 'Cline',
  droid: 'Factory Droid',
  omp: 'OMP',
  hermes: 'Hermes Agent',
  muse: 'Muse Code',
  codewhale: 'CodeWhale',
  deepseek: 'DeepSeek Harness',
  harn: 'Harn',
  kimchi: 'Kimchi',
  antigravity: 'Google Antigravity',
  devin: 'Devin',
  'cortex-code': 'Cortex Code',
  'corust-agent': 'Corust Agent',
  'crow-cli': 'crow-cli',
  junie: 'Junie',
  'mistral-vibe': 'Mistral Vibe',
  poolside: 'Poolside',
  stakpak: 'Stakpak',
  vtcode: 'VT Code',
  'fast-agent': 'fast-agent',
  minion: 'Minion Code',
  'fake-agent': 'Fake agent',
}

/** Registered agents, including those from older hosts that do not report registration. */
export function usableAgents(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return order.map((id) => byId[id]).filter((s): s is AgentStatus => !!s && s.registered !== false)
}

/** The catalog stays available when its default configuration has no registered agent. */
export function harnessStatuses(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return order.map((id) => byId[id]).filter((s): s is AgentStatus => !!s?.isDefault)
}

export function addableHarnesses(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return harnessStatuses(order, byId).filter(
    (s) =>
      s.uninstalled !== true &&
      hasProgram(s) &&
      !awaitsPackage(s) &&
      (s.registered === false || MULTI_AGENT_HARNESSES.includes(s.harnessId)),
  )
}

/** The agents the agent menu lists: those on installed harnesses, but no hidden or turned-off agent. */
export function menuAgents(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return usableAgents(order, byId).filter((s) => isInstalled(s) && !s.hidden && !s.disabled)
}

export function isInstalled(status: AgentStatus): boolean {
  return !['not-installed', 'node-missing', 'node-outdated'].includes(status.state)
}

/** Its harness's program is on the machine, even one that cannot run yet, such as a too old one. */
export function hasProgram(status: AgentStatus): boolean {
  return isInstalled(status) || !!status.cli?.installed
}

/**
 * Ready to install but not installed: the adapter Kettu installs into its data folder, or the SDK
 * while the user's own CLI is missing too.
 */
export function awaitsPackage(status: AgentStatus): boolean {
  const pkg = status.package
  return (
    !!pkg && !pkg.installed && status.state === 'available' && !(pkg.isSdk && status.cli?.installed)
  )
}
