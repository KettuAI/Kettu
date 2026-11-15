// The host's workflow settings as Settings › Agents changes them.

import type { WorkflowSettings, WorkflowSettingsChange } from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import type { HostScope } from '@renderer/stores/host-scope'
import { workflowsKey, useWorkflowsStore } from '@renderer/stores/workflows'

/** Writes a change to the host and shows the settings it answers with. */
export async function changeWorkflowSettings(
  scope: HostScope,
  patch: WorkflowSettingsChange,
): Promise<void> {
  const settings = await scope.request('workflows.setSettings', patch)
  const key = workflowsKey(scope.hostId)
  // The host sends no event for its workflow settings, so its answer is kept here.
  useWorkflowsStore.setState((s) => {
    const own = s.byHost[key]
    if (!own) return s
    return { byHost: { ...s.byHost, [key]: { ...own, settings } } }
  })
}

/** The agents whose choice differs from the default: subscriptions on, API keys off. */
export function changedAgents(settings: WorkflowSettings | null): AgentId[] {
  return (settings?.agents ?? []).filter((a) => a.allowed !== a.byDefault).map((a) => a.agentId)
}
