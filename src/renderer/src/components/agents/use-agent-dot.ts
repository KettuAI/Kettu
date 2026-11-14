import { useContext } from 'react'
import { agentColor, type AgentColor } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import { AgentMarkHost } from './agent-mark-host'

/** The dot its host gives an added agent; none for a harness's default agent, or for no agent. */
export function useAgentDot(
  agent: AgentId | null,
  hostId: string | null | undefined,
): AgentColor | null {
  const scoped = useContext(AgentMarkHost)
  const host = hostId === undefined ? scoped : hostId
  const listed = useAgentsStore((s) => {
    if (agent === null) return null
    const status = agentsOn(s, host).byId[agent]
    return status ? (status.color ?? null) : undefined
  })
  // This computer's added agents are in the settings, which load before their statuses.
  const configured = useSettingsStore((s) =>
    agent !== null && listed === undefined && host === null
      ? agentColor(s.settings.addedAgents, agent)
      : null,
  )
  return listed === undefined ? configured : listed
}
