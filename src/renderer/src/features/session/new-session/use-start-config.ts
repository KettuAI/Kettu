import { useMemo } from 'react'
import type { AgentId, ConfigOption } from '@shared/thread'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { startConfig } from './start-options'

/** The options a new session with the agent starts with; null while they are unknown. */
export function useStartConfig(agentId: AgentId | null): ConfigOption[] | null {
  const entry = useAgentOptionsStore((s) => (agentId ? s.byId[agentId] : undefined))
  const picks = useAgentOptionsStore((s) => (agentId ? s.picks[agentId] : undefined))
  return useMemo(() => (entry ? startConfig(entry, picks) : null), [entry, picks])
}
