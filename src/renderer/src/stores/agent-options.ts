import { create } from 'zustand'
import type { AgentOptions } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { host } from '@renderer/lib/host'

export type OptionValues = Record<string, string | boolean>

interface AgentOptionsStore {
  /** Each agent's options from its last new session; missing for one that never ran a session. */
  byId: Partial<Record<AgentId, AgentOptions>>
  loaded: boolean
  /** Why the last load failed; New session then starts each agent with its own defaults. */
  error: string | null
  /** What New session set for each agent this run, over the remembered values. */
  picks: Partial<Record<AgentId, OptionValues>>
  /** Starts New session asked for, still running: each reads the agent's options if none are known. */
  starting: Partial<Record<AgentId, number>>
  /** Agents a start New session asked for has finished for, this run. */
  started: Partial<Record<AgentId, true>>
}

export const useAgentOptionsStore = create<AgentOptionsStore>()(() => ({
  byId: {},
  loaded: false,
  error: null,
  picks: {},
  starting: {},
  started: {},
}))

export async function loadAgentOptions(): Promise<void> {
  try {
    const list = await host('agents.options', undefined)
    useAgentOptionsStore.setState({
      byId: Object.fromEntries(list.map((o) => [o.agentId, o])),
      loaded: true,
      error: null,
    })
  } catch (error) {
    useAgentOptionsStore.setState({ loaded: true, error: String(error) })
    throw error
  }
}

export function receiveAgentOptions(options: AgentOptions): void {
  useAgentOptionsStore.setState((s) => ({ byId: { ...s.byId, [options.agentId]: options } }))
}

/** Counts a start New session asked for while it runs, and notes when one has finished. */
export function noteStarting(agentId: AgentId, delta: 1 | -1): void {
  useAgentOptionsStore.setState((s) => ({
    starting: { ...s.starting, [agentId]: Math.max(0, (s.starting[agentId] ?? 0) + delta) },
    ...(delta < 0 ? { started: { ...s.started, [agentId]: true as const } } : {}),
  }))
}

export function pickOption(agentId: AgentId, optionId: string, value: string | boolean): void {
  useAgentOptionsStore.setState((s) => ({
    picks: { ...s.picks, [agentId]: { ...s.picks[agentId], [optionId]: value } },
  }))
}

/** Once a session started with them, the picks are the agent's remembered values. */
export function clearPicks(agentId: AgentId): void {
  useAgentOptionsStore.setState((s) => {
    const picks = { ...s.picks }
    delete picks[agentId]
    return { picks }
  })
}
