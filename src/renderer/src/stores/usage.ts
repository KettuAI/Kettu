import { create } from 'zustand'
import type { ContextBreakdown } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'

export interface ContextReport {
  /** The context it was read for, as `used/size`; another one means it is out of date. */
  key: string
  breakdown: ContextBreakdown | null
  loading: boolean
  error: string | null
}

interface UsageStore {
  /** Each session's last context breakdown. */
  context: Record<string, ContextReport>
}

export const useUsageStore = create<UsageStore>()(() => ({ context: {} }))

function setReport(sessionId: string, report: ContextReport): void {
  useUsageStore.setState((s) => ({ context: { ...s.context, [sessionId]: report } }))
}

/**
 * Reads what fills the session's context unless it was read for the same context already. Each
 * read forks the session in the agent, so a breakdown holds until the context changes.
 */
export function loadContext(sessionId: string, key: string): void {
  const current = useUsageStore.getState().context[sessionId]
  if (current && (current.loading || (current.key === key && !current.error))) return
  setReport(sessionId, {
    key,
    breakdown: current?.breakdown ?? null,
    loading: true,
    error: null,
  })
  host('sessions.context', { sessionId })
    .then((breakdown) => setReport(sessionId, { key, breakdown, loading: false, error: null }))
    .catch((error: unknown) =>
      setReport(sessionId, {
        key,
        breakdown: current?.breakdown ?? null,
        loading: false,
        error: errorMessage(error),
      }),
    )
}

/** Asks the agent for the current use of its plan limits; they arrive in its status. */
export function refreshLimits(agentId: AgentId): Promise<void> {
  return host('agents.refreshLimits', { agentId })
}
