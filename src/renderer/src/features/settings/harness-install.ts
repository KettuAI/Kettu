// Installing a harness from Kettu: what route it takes and the agent it gives the harness after.

import type { AgentInstallMethod, AgentStatus } from '@shared/agent-host'
import type { SettingsFile, SettingsPatch } from '@shared/settings'
import type { HarnessId } from '@shared/thread'
import { usableAgents, type AgentsStoreHook } from '@renderer/stores/agents'

/** The harness's program is missing, so it installs by one of its vendor's routes. */
function programMissing(status: AgentStatus): boolean {
  return status.state === 'not-installed' && !status.cli?.installed
}

export type InstallKind = 'program' | 'package' | 'setup'

export function installKind(status: AgentStatus): InstallKind | null {
  if (programMissing(status) && status.installMethods.length > 0) return 'program'
  if (status.package && !status.package.installed && status.state === 'available') return 'package'
  if (['not-installed', 'node-missing', 'node-outdated'].includes(status.state)) return 'setup'
  return null
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

/**
 * Installs again, first taking the harness back if it was uninstalled, and gives it its default
 * agent once it is installed.
 */
export async function startInstall(
  agents: AgentsStoreHook,
  settings: SettingsHook,
  harness: HarnessId,
  method?: AgentInstallMethod['id'] | null,
): Promise<void> {
  await settings
    .getState()
    .update({ agents: { [harness]: { uninstalled: false } } })
    .catch(() => {})
  await agents.getState().check(harness)
  const status = agents.getState().byId[harness]
  // A harness whose program is still on the machine is back without installing anything.
  if (!status || status.uninstalled || status.task?.state === 'running') return
  const kind = installKind(status)
  if (kind === 'program' || kind === 'package') {
    await agents.getState().install(harness, method ?? undefined)
  }
  await registerInstalled(agents, settings, harness)
}
