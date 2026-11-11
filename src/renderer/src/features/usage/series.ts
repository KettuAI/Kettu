import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { agentName, agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { usageHosts } from '@renderer/stores/usage'
import { useWindowHost } from '@renderer/stores/window-host'
import { agentColor } from './model'

/** Each agent's series color, by the order of the shown hosts' agents, so it stays with the agent. */
export function useAgentColor(): (agentId: AgentId) => string {
  // Read again when the window's host changes.
  useWindowHost()
  const order = useAgentsStore(
    useShallow((s) => [...new Set(usageHosts().flatMap((hostId) => agentsOn(s, hostId).order))]),
  )
  return useCallback((agentId: AgentId) => agentColor(agentId, order), [order])
}

/** An agent's name on the first of the shown hosts that has it, or its harness's. */
export function usageAgentName(agentId: AgentId): string {
  const state = useAgentsStore.getState()
  for (const hostId of usageHosts()) {
    const name = agentsOn(state, hostId).byId[agentId]?.name
    if (name) return name
  }
  return agentName(agentId)
}
