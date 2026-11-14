import { useMemo } from 'react'
import type { ControlAgent } from '@shared/control'
import type { AgentId } from '@shared/thread'
import { useAgentDot } from '@renderer/components/agents/use-agent-dot'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'

/**
 * The agent a surface's label and pill name and mark, with its name and dot as its host knows them;
 * the same object while they stay the same.
 */
export function useControlAgent(
  agentId: AgentId | null,
  hostId: string | null,
): ControlAgent | null {
  const dot = useAgentDot(agentId, hostId)
  // The name comes from the host's agents, or this computer's settings before they load: either
  // changing renders again.
  useAgentsStore(() => agentId && agentName(agentId, hostId))
  useSettingsStore(() => agentId && agentName(agentId, hostId))
  const name = agentId && agentName(agentId, hostId)
  return useMemo(() => (agentId && name ? { id: agentId, name, dot } : null), [agentId, name, dot])
}
