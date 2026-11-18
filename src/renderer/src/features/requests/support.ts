import { harnessOf, type AgentId } from '@shared/thread'

/** Whether Kettu reads this agent's requests to its model, for the Requests pane. */
export function readsModelRequests(agentId: AgentId | undefined): boolean {
  if (agentId === undefined) return false
  const harness = harnessOf(agentId)
  return harness === 'claude-code' || harness === 'codex'
}
