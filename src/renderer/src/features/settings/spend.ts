import type { AgentId } from '@shared/thread'
import type { DayUsage } from '@shared/usage'

/** What an agent's days cost: null when it used only models without a price, 0 with no days. */
export function agentCost(days: DayUsage[], agentId: AgentId): number | null {
  const own = days.filter((day) => day.agentId === agentId)
  const priced = own.filter((day) => day.cost !== null)
  if (own.length > 0 && priced.length === 0) return null
  return priced.reduce((sum, day) => sum + (day.cost ?? 0), 0)
}
