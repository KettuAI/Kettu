import { create } from 'zustand'
import type { AgentOptions, SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { host } from '@renderer/lib/host'

export type OptionValues = Record<string, string | boolean>

/** The window's prepared session: the one New session's first message will use. */
export interface PreparedState {
  /** The agent, folder and parent it was asked for. */
  key: string
  agentId: AgentId
  /** Its summary once its agent has answered; null while it opens. */
  summary: SessionSummary | null
  /** A prepare is on its way, for this key: the first, or a replacement. */
  opening: boolean
  /** Why the last prepare for this key failed. */
  error: string | null
}

/** A first read of an agent's options, while none are cached and New session has no folder. */
export interface FirstRead {
  reading: boolean
  /** Why it failed, shown until a retry. */
  error: string | null
}

interface AgentOptionsStore {
  /** Each agent's cached options, for the agents with no prepared session and the first paint. */
  byId: Partial<Record<AgentId, AgentOptions>>
  loaded: boolean
  /** Why the last load failed; New session then starts each agent with its own defaults. */
  error: string | null
  /** What New session set for each agent and the agent has not answered yet. */
  picks: Partial<Record<AgentId, OptionValues>>
  prepared: PreparedState | null
  firstReads: Partial<Record<AgentId, FirstRead>>
}

export const useAgentOptionsStore = create<AgentOptionsStore>()(() => ({
  byId: {},
  loaded: false,
  error: null,
  picks: {},
  prepared: null,
  firstReads: {},
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

export function pickOption(agentId: AgentId, optionId: string, value: string | boolean): void {
  useAgentOptionsStore.setState((s) => ({
    picks: { ...s.picks, [agentId]: { ...s.picks[agentId], [optionId]: value } },
  }))
}

/** The agent answered a pick, so its own value shows from now on. */
export function settlePick(agentId: AgentId, optionId: string, value: string | boolean): void {
  useAgentOptionsStore.setState((s) => {
    const picks = s.picks[agentId]
    if (picks?.[optionId] !== value) return s
    const rest = { ...picks }
    delete rest[optionId]
    return { picks: { ...s.picks, [agentId]: rest } }
  })
}

/** Once a session started with them, the picks are the agent's remembered values. */
export function clearPicks(agentId: AgentId): void {
  useAgentOptionsStore.setState((s) => {
    const picks = { ...s.picks }
    delete picks[agentId]
    return { picks }
  })
}
