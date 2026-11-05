import { useCallback } from 'react'
import type { AgentId } from '@shared/thread'
import { useAgentsStore } from '@renderer/stores/agents'
import { agentColor } from './model'

/** Each agent's series color, by the agents' order, so it stays with the agent. */
export function useAgentColor(): (agentId: AgentId) => string {
  const order = useAgentsStore((s) => s.order)
  return useCallback((agentId: AgentId) => agentColor(agentId, order), [order])
}
