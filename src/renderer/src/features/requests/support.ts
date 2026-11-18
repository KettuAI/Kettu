import { harnessOf, type AgentId } from '@shared/thread'

/** Whether Kettu reads this agent's requests to its model, for the Requests pane. */
export function readsModelRequests(agentId: AgentId | undefined): boolean {
  // DeepSeek Harness speaks its own SDK and keeps no record Kettu reads; every other agent has
  // its own record or speaks ACP.
  return agentId !== undefined && harnessOf(agentId) !== 'deepseek'
}
