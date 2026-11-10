import { create } from 'zustand'
import type { AgentOptions, SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { host, hostAt } from '@renderer/lib/host'

export type OptionValues = Record<string, string | boolean>

/** An agent on a host as the maps below key it, since agent ids repeat across hosts. */
export function agentKey(hostId: string | null, agentId: AgentId): string {
  return `${hostId ?? ''}\0${agentId}`
}

/** The window's prepared session: the one New session's first message will use. */
export interface PreparedState {
  /** The agent, host, folder and parent it was asked for. */
  key: string
  hostId: string | null
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

type OptionsById = Partial<Record<AgentId, AgentOptions>>

interface AgentOptionsStore {
  /** Each agent's cached options, for the agents with no prepared session and the first paint. */
  byId: OptionsById
  loaded: boolean
  /** Each other host's cached options, by its id, once read. */
  hosts: Record<string, OptionsById>
  /** Why the last load failed; New session then starts each agent with its own defaults. */
  error: string | null
  /** What New session set for each agent, by `agentKey`, and the agent has not answered yet. */
  picks: Partial<Record<string, OptionValues>>
  prepared: PreparedState | null
  /** By `agentKey`. */
  firstReads: Partial<Record<string, FirstRead>>
}

export const useAgentOptionsStore = create<AgentOptionsStore>()(() => ({
  byId: {},
  loaded: false,
  hosts: {},
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

/** Reads another host's cached options, as when a connection to it opens. */
export async function readHostAgentOptions(hostId: string): Promise<void> {
  let byId: OptionsById | null = null
  try {
    const list = await hostAt(hostId, 'agents.options', undefined)
    byId = Object.fromEntries(list.map((o) => [o.agentId, o]))
  } finally {
    // A failed read still counts as read, so the menu shows each agent's own defaults.
    useAgentOptionsStore.setState((s) => ({
      hosts: { ...s.hosts, [hostId]: byId ?? s.hosts[hostId] ?? {} },
    }))
  }
}

export function forgetHostAgentOptions(hostId: string): void {
  useAgentOptionsStore.setState((s) => {
    if (!(hostId in s.hosts)) return s
    const hosts = { ...s.hosts }
    delete hosts[hostId]
    const own = (key: string) => key.startsWith(`${hostId}\0`)
    const picks = Object.fromEntries(Object.entries(s.picks).filter(([key]) => !own(key)))
    const firstReads = Object.fromEntries(Object.entries(s.firstReads).filter(([key]) => !own(key)))
    return { hosts, picks, firstReads }
  })
}

const NO_OPTIONS: OptionsById = {}

/** The cached options of the host named, null being this computer. */
export function optionsOn(
  s: Pick<AgentOptionsStore, 'byId' | 'hosts'>,
  hostId: string | null,
): OptionsById {
  return hostId === null ? s.byId : (s.hosts[hostId] ?? NO_OPTIONS)
}

/** Whether the host's cached options were read, so a menu stops waiting for them. */
export function optionsLoaded(
  s: Pick<AgentOptionsStore, 'loaded' | 'hosts'>,
  hostId: string | null,
): boolean {
  return hostId === null ? s.loaded : hostId in s.hosts
}

/** What New session set for the agent on the host named, which the agent has not answered yet. */
export function picksOf(
  s: Pick<AgentOptionsStore, 'picks'>,
  hostId: string | null,
  agentId: AgentId,
): OptionValues | undefined {
  return s.picks[agentKey(hostId, agentId)]
}

/** The window's prepared session, when it is for the agent on the host named. */
export function preparedFor(
  s: Pick<AgentOptionsStore, 'prepared'>,
  hostId: string | null,
  agentId: AgentId,
): PreparedState | null {
  const { prepared } = s
  return prepared && prepared.hostId === hostId && prepared.agentId === agentId ? prepared : null
}

export function receiveAgentOptions(options: AgentOptions, hostId: string | null = null): void {
  useAgentOptionsStore.setState((s) => {
    const own = hostId === null ? s.byId : s.hosts[hostId]
    const base =
      hostId === null
        ? { byId: { ...s.byId, [options.agentId]: options } }
        : { hosts: { ...s.hosts, [hostId]: { ...s.hosts[hostId], [options.agentId]: options } } }
    const before = own?.[options.agentId]
    if (!before || before.startMode === options.startMode) return base
    // A new start mode replaces a mode the draft held, whether picked or kept from a prepared session.
    const modeId = options.config.find((o) => o.category === 'mode')?.id
    const key = agentKey(hostId, options.agentId)
    const picks = s.picks[key]
    if (modeId === undefined || picks?.[modeId] === undefined) return base
    const rest = { ...picks }
    delete rest[modeId]
    return { ...base, picks: { ...s.picks, [key]: rest } }
  })
}

export function pickOption(
  hostId: string | null,
  agentId: AgentId,
  optionId: string,
  value: string | boolean,
): void {
  const key = agentKey(hostId, agentId)
  useAgentOptionsStore.setState((s) => ({
    picks: { ...s.picks, [key]: { ...s.picks[key], [optionId]: value } },
  }))
}

/** The agent answered a pick, so its own value shows from now on. */
export function settlePick(
  hostId: string | null,
  agentId: AgentId,
  optionId: string,
  value: string | boolean,
): void {
  const key = agentKey(hostId, agentId)
  useAgentOptionsStore.setState((s) => {
    const picks = s.picks[key]
    if (picks?.[optionId] !== value) return s
    const rest = { ...picks }
    delete rest[optionId]
    return { picks: { ...s.picks, [key]: rest } }
  })
}

/** Once a session started with them, the picks are the agent's remembered values. */
export function clearPicks(hostId: string | null, agentId: AgentId): void {
  const key = agentKey(hostId, agentId)
  useAgentOptionsStore.setState((s) => {
    const picks = { ...s.picks }
    delete picks[key]
    return { picks }
  })
}
