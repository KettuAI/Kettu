import { useMemo } from 'react'
import type { AgentId, ConfigOption } from '@shared/thread'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { preparedConfig, startConfig } from './start-options'

/**
 * The options a new session with the agent starts with: its prepared session's once it answered,
 * else the cached ones; null while neither is known.
 */
export function useStartConfig(agentId: AgentId | null): ConfigOption[] | null {
  const entry = useAgentOptionsStore((s) => (agentId ? s.byId[agentId] : undefined))
  const picks = useAgentOptionsStore((s) => (agentId ? s.picks[agentId] : undefined))
  const prepared = useAgentOptionsStore((s) =>
    agentId && s.prepared?.agentId === agentId ? s.prepared.summary?.prepared : undefined,
  )
  return useMemo(() => {
    if (prepared) return preparedConfig(prepared.config, entry?.levels ?? {}, picks)
    return entry ? startConfig(entry, picks) : null
  }, [entry, picks, prepared])
}
