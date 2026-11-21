// Installing a harness from Kettu: the install window every surface's Install opens first, the
// route the window's Install takes and the agent it gives the harness after.

import { create } from 'zustand'
import type { AgentInstallMethod, AgentStatus, AgentTask, InstallRoute } from '@shared/agent-host'
import type { SettingsFile, SettingsPatch } from '@shared/settings'
import type { AgentId, HarnessId } from '@shared/thread'
import { cliOutdated } from '@renderer/features/agents/readiness'
import {
  agentsOn,
  useAgentsStore,
  usableAgents,
  type AgentsStoreHook,
} from '@renderer/stores/agents'
import { hostScope, LOCAL_SCOPE } from '@renderer/stores/host-scope'

/** The harness's program is missing, so it installs by one of its vendor's routes. */
function programMissing(status: AgentStatus): boolean {
  return status.state === 'not-installed' && !status.cli?.installed
}

export type InstallKind = 'program' | 'package' | 'setup'

export function installKind(status: AgentStatus): InstallKind | null {
  // The program is on the machine and only needs updating.
  if (cliOutdated(status) !== null) return null
  if (programMissing(status) && status.installMethods.length > 0) return 'program'
  if (status.package && !status.package.installed && status.state === 'available') return 'package'
  if (['not-installed', 'node-missing', 'node-outdated'].includes(status.state)) return 'setup'
  return null
}

/** The route a failed install took, to retry it the same way; null for an update's. */
export function installRoute(task: AgentTask | null | undefined): AgentInstallMethod['id'] | null {
  const method = task?.kind === 'install' ? task.method : null
  return method === 'pnpm' || method === 'bun' || method === 'yarn' ? null : method
}

export type SettingsHook = {
  getState(): { settings: SettingsFile; update(patch: SettingsPatch): Promise<void> }
}

/**
 * The patch that adds these harnesses' default agents. On a host with no agent and no default
 * agent chosen, the first becomes the default agent, so New session can start at once.
 */
export function addDefaultAgents(
  agents: AgentsStoreHook,
  settings: SettingsHook,
  harnesses: HarnessId[],
): SettingsPatch {
  const patch: SettingsPatch = {
    agents: Object.fromEntries(harnesses.map((id) => [id, { enabled: true }])),
  }
  const { order, byId } = agents.getState()
  if (
    harnesses.length > 0 &&
    settings.getState().settings.general.defaultAgent === null &&
    usableAgents(order, byId).length === 0
  ) {
    patch.general = { defaultAgent: harnesses[0]! }
  }
  return patch
}

/** A harness installed from Kettu gets its default agent, unless it has one already. */
async function registerInstalled(
  agents: AgentsStoreHook,
  settings: SettingsHook,
  harness: HarnessId,
): Promise<void> {
  await agents.getState().check(harness)
  const status = agents.getState().byId[harness]
  if (
    !status ||
    status.registered !== false ||
    status.uninstalled ||
    status.task ||
    agents.getState().taskErrors[harness] ||
    status.state !== 'available'
  ) {
    return
  }
  await settings
    .getState()
    .update(addDefaultAgents(agents, settings, [harness]))
    .catch(() => {})
}

/** Takes an uninstalled harness back, so it is detected again. */
async function takeBack(
  agents: AgentsStoreHook,
  settings: SettingsHook,
  harness: HarnessId,
): Promise<void> {
  await settings
    .getState()
    .update({ agents: { [harness]: { uninstalled: false } } })
    .catch(() => {})
  await agents.getState().check(harness)
}

/**
 * Installs by the route the user picked in the install window, or for a retry the route the
 * failed install took, first taking the harness back if it was uninstalled, and gives it its
 * default agent once it is installed. `copy` and no route install Kettu's own copy of a package,
 * or a program by the route the host prefers.
 */
export async function startInstall(
  agents: AgentsStoreHook,
  settings: SettingsHook,
  harness: HarnessId,
  route?: InstallRoute['id'] | null,
): Promise<void> {
  await takeBack(agents, settings, harness)
  const status = agents.getState().byId[harness]
  // A harness whose program is still on the machine is back without installing anything.
  if (!status || status.uninstalled || status.task?.state === 'running') return
  const kind = installKind(status)
  if (route && route !== 'copy') await agents.getState().install(harness, route)
  else if (route === 'copy' || kind === 'program' || kind === 'package') {
    await agents.getState().install(harness)
  }
  await registerInstalled(agents, settings, harness)
}

/** The harness the install window shows and the host it is on; `mounted` once it first opened. */
export const useInstallWindow = create<{
  target: { harness: HarnessId; hostId: string | null } | null
  mounted: boolean
}>(() => ({ target: null, mounted: false }))

/**
 * The Install of every surface. A harness uninstalled from Kettu whose program is still on the
 * machine comes back at once; anything else opens the install window, which says what an install
 * brings before it runs.
 */
export async function openInstall(harness: HarnessId, hostId: string | null = null): Promise<void> {
  const scope = hostId ? hostScope(hostId) : LOCAL_SCOPE
  const agents = scope.useAgentsStore
  if (agents.getState().byId[harness]?.uninstalled) {
    await takeBack(agents, scope.useSettingsStore, harness)
    const status = agents.getState().byId[harness]
    if (status && !status.uninstalled && !installKind(status)) {
      await registerInstalled(agents, scope.useSettingsStore, harness)
      return
    }
  }
  useInstallWindow.setState({ target: { harness, hostId }, mounted: true })
}

export function closeInstall(): void {
  useInstallWindow.setState({ target: null })
}

/** The harness of an agent whose copy Kettu installs is missing, and whether it installs now. */
export interface MissingCopy {
  harness: HarnessId
  installing: boolean
}

/**
 * The harness whose copy Kettu installs is missing for the agent on this computer, which a start
 * does not install by itself, and whether an install of it runs; null otherwise. Claude Code's SDK
 * installs on its first start.
 */
export function useMissingCopy(agentId: AgentId, hostId: string | null): MissingCopy | null {
  const status = useAgentsStore((s) => agentsOn(s, hostId).byId[agentId])
  const pkg = status?.package
  if (!status || hostId !== null || !pkg || pkg.installed || pkg.isSdk) return null
  const installing = status.state === 'installing' || status.task?.state === 'running'
  if (!installing && status.state !== 'available') return null
  return { harness: status.harnessId, installing }
}
