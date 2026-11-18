import { harnessOf, type AgentId } from '@shared/thread'

/** Whether Kettu reads this agent's requests to its model, for the Requests pane. */
export function readsModelRequests(agentId: AgentId | undefined): boolean {
  return agentId !== undefined && harnessOf(agentId) === 'claude-code'
}
