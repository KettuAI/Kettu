import { useMemo } from 'react'
import type { AgentId, ConfigOption } from '@shared/thread'
import { optionsOn, useAgentOptionsStore, type OptionValues } from '@renderer/stores/agent-options'
import { preparedConfig, startConfig } from './start-options'

/**
 * The options a new session with the agent on the host named starts with: its prepared session's
 * once it answered, else the cached ones; null while neither is known.
 */
export function useStartConfig(
  agentId: AgentId | null,
  values?: OptionValues,
  hostId: string | null = null,
): ConfigOption[] | null {
  const entry = useAgentOptionsStore((s) => (agentId ? optionsOn(s, hostId)[agentId] : undefined))
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
