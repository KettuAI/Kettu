import { create } from 'zustand'
import type {
  AgentDetails,
  AgentInstallMethod,
  AgentStatus,
  AgentTask,
  EnvironmentInfo,
} from '@shared/agent-host'
import { harnessOf, sortAgentIds, type AgentId, type HarnessId } from '@shared/thread'
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

export const useAgentsStore = create<AgentsStore>()((set, get) => ({
  byId: {},
  order: [],
  environment: null,
  details: {},
  loaded: false,
  updateCheck: { running: false, finishedAt: null, error: null },
  updated: {},
  taskErrors: {},
  setAll(statuses) {
    set({
      byId: Object.fromEntries(statuses.map((s) => [s.id, s])),
      order: sortAgentIds(statuses.map((s) => s.id)),
      loaded: true,
    })
  },
  remove(agentId) {
    set((state) => ({
      byId: without(state.byId, agentId),
      order: state.order.filter((id) => id !== agentId),
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
    const done = await taskRequest(agentId, 'update', () => host('agents.update', { agentId }))
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
    const done = await taskRequest(agentId, 'update', () => host('agents.updateCli', { agentId }))
    if (done && !get().byId[agentId]?.task) {
      set((state) => ({ updated: { ...state.updated, [agentId]: true } }))
    }
  },
  async install(agentId, method) {
    await taskRequest(agentId, 'install', () =>
      host('agents.install', method ? { agentId, method } : { agentId }),
    )
  },
  async cancelTask(agentId) {
    set((state) => ({ taskErrors: without(state.taskErrors, agentId) }))
    await host('agents.cancelTask', { agentId }).catch((e: unknown) =>
      console.warn(`Could not cancel the task: ${errorMessage(e)}`),
    )
  },
}))

function without<T>(
  record: Partial<Record<AgentId, T>>,
  agentId: AgentId,
): Partial<Record<AgentId, T>> {
  if (!(agentId in record)) return record
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== agentId))
}

/** Runs an install or update request; true when it finished, false when it failed. */
async function taskRequest(
  agentId: AgentId,
  kind: AgentTask['kind'],
  request: () => Promise<unknown>,
): Promise<boolean> {
  const { setState, getState } = useAgentsStore
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

/** The agent's name; a removed agent's sessions name its harness. */
export function agentName(agentId: AgentId): string {
  return useAgentsStore.getState().byId[agentId]?.name ?? AGENT_NAMES[harnessOf(agentId)]
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

/** Every agent the host reports, in its order: by harness, each harness's default agent first. */
export function usableAgents(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return order.map((id) => byId[id]).filter((s): s is AgentStatus => !!s)
}

/** One status per harness, its default agent's, which carries the harness's install and updates. */
export function harnessStatuses(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return usableAgents(order, byId).filter((s) => s.isDefault)
}

/** The agents the agent menu lists: those on installed harnesses, but no hidden default agent. */
export function menuAgents(order: AgentId[], byId: AgentsStore['byId']): AgentStatus[] {
  return usableAgents(order, byId).filter((s) => isInstalled(s) && !s.hidden)
}

export function isInstalled(status: AgentStatus): boolean {
  return !['not-installed', 'node-missing', 'node-outdated'].includes(status.state)
}

/** Its harness's program is on the machine, even one that cannot run yet, such as a too old one. */
export function hasProgram(status: AgentStatus): boolean {
  return isInstalled(status) || !!status.cli?.installed
}
