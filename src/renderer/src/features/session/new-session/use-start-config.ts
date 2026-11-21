import { useMemo } from 'react'
import type { AgentOptions } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'
import {
  optionsOn,
  preparedFor,
  picksOf,
  useAgentOptionsStore,
  type OptionValues,
} from '@renderer/stores/agent-options'
import { isSelect } from '@renderer/features/session/composer/options'
import { preparedConfig, startConfig } from './start-options'

/** The prepared session's config once its agent answered, else the cached options. */
function resolveStartConfig(
  entry: AgentOptions | undefined,
  picks: OptionValues | undefined,
  prepared: { config: readonly ConfigOption[] } | undefined,
): ConfigOption[] | null {
  if (prepared) return preparedConfig(prepared.config, entry?.levels ?? {}, picks)
  return entry ? startConfig(entry, picks, { startMode: true }) : null
}

/**
 * The options a new session with the agent on the host named starts with: its prepared session's
 * once it answered, else the cached ones with the agent's start mode; null while neither is
 * known.
 */
export function useStartConfig(
  agentId: AgentId | null,
  values?: OptionValues,
  hostId: string | null = null,
): ConfigOption[] | null {
  const entry = useAgentOptionsStore((s) => (agentId ? optionsOn(s, hostId)[agentId] : undefined))
  const picks = useAgentOptionsStore((s) => (agentId ? picksOf(s, hostId, agentId) : undefined))
  const prepared = useAgentOptionsStore((s) =>
    agentId ? preparedFor(s, hostId, agentId)?.summary?.prepared : undefined,
  )
  return useMemo(
    () => resolveStartConfig(entry, values ?? picks, prepared),
    [entry, picks, prepared, values],
  )
}

/** The model each of the agents on the host named starts a new session with, as the options say. */
export function useStartModels(
  hostId: string | null,
  agentIds: readonly AgentId[],
): ReadonlyMap<AgentId, ConfigOption | undefined> {
  const entries = useAgentOptionsStore((s) => optionsOn(s, hostId))
  const allPicks = useAgentOptionsStore((s) => s.picks)
  const prepared = useAgentOptionsStore((s) => s.prepared)
  return useMemo(
    () =>
      new Map(
        agentIds.map((id) => {
          const config = resolveStartConfig(
            entries[id],
            picksOf({ picks: allPicks }, hostId, id),
            preparedFor({ prepared }, hostId, id)?.summary?.prepared,
          )
          return [id, config?.find((o) => o.category === 'model' && isSelect(o))]
        }),
      ),
    [entries, allPicks, prepared, hostId, agentIds],
  )
}
