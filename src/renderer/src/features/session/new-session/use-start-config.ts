import { useMemo } from 'react'
import type { AgentId, ConfigOption } from '@shared/thread'
import { useAgentOptionsStore, type OptionValues } from '@renderer/stores/agent-options'
import { preparedConfig, startConfig } from './start-options'

/**
 * The options a new session with the agent starts with: its prepared session's once it answered,
 * else the cached ones; null while neither is known.
 */
export function useStartConfig(
  agentId: AgentId | null,
  values?: OptionValues,
): ConfigOption[] | null {
  const entry = useAgentOptionsStore((s) => (agentId ? s.byId[agentId] : undefined))
  const picks = useAgentOptionsStore((s) => (agentId ? s.picks[agentId] : undefined))
  const prepared = useAgentOptionsStore((s) =>
    agentId && s.prepared?.agentId === agentId ? s.prepared.summary?.prepared : undefined,
  )
  return useMemo(() => {
    const shown = values ?? picks
    if (prepared) return preparedConfig(prepared.config, entry?.levels ?? {}, shown)
    return entry ? startConfig(entry, shown) : null
  }, [entry, picks, prepared, values])
}
