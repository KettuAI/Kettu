import type { AgentStatus } from '@shared/agent-host'

/**
 * The adapter an update brings when that is all it changes: the user's own CLI runs and keeps
 * running, so the update is named after the adapter, not the agent.
 */
export function adapterOnlyUpdate(status: AgentStatus): { name: string; version: string } | null {
  if (status.cli?.runs !== 'installed' || !status.package || status.update?.cliVersion !== null) {
    return null
  }
  return status.package
}
