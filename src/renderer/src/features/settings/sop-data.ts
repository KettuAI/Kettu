// The host's SOP settings as Settings › Agents changes them.

import type { SopSettings, SopSettingsChange } from '@shared/sop'
import type { AgentId } from '@shared/thread'
import type { HostScope } from '@renderer/stores/host-scope'
import { sopsKey, useSopsStore } from '@renderer/stores/sops'

/** Writes a change to the host and shows the settings it answers with. */
export async function changeSopSettings(scope: HostScope, patch: SopSettingsChange): Promise<void> {
  const settings = await scope.request('sops.setSettings', patch)
  const key = sopsKey(scope.hostId)
  // The host sends no event for its SOP settings, so its answer is kept here.
  useSopsStore.setState((s) => {
    const own = s.byHost[key]
    if (!own) return s
    return { byHost: { ...s.byHost, [key]: { ...own, settings } } }
  })
}

/** The agents whose choice differs from the default: subscriptions on, API keys off. */
export function changedAgents(settings: SopSettings | null): AgentId[] {
  return (settings?.agents ?? []).filter((a) => a.allowed !== a.byDefault).map((a) => a.agentId)
}
