import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { useAgentsStore } from '@renderer/stores/agents'

/** The harnesses the install guide offers, which the guide describes by these ids. */
export const GUIDE_HARNESSES = ['claude-code', 'codex', 'opencode', 'pi'] as const
export type GuideHarness = (typeof GUIDE_HARNESSES)[number]

/** Their statuses on this computer; null until its agents and harnesses are read. */
export function useGuideStatuses(): AgentStatus[] | null {
  return useAgentsStore(
    useShallow((s) => {
      if (!s.loaded) return null
      return GUIDE_HARNESSES.flatMap((id) => (s.byId[id] ? [s.byId[id]] : []))
    }),
  )
}
