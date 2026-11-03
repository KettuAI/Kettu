import { describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/thread'
import type { DayUsage } from '@shared/usage'
import { agentCost } from './spend'

const WORK = 'claude-code~work' as AgentId
const day = (agentId: string, cost: number | null): DayUsage =>
  ({ agentId, cost, day: 0 }) as unknown as DayUsage

describe('agentCost', () => {
  it("sums the agent's priced days and leaves the others out", () => {
    expect(agentCost([day(WORK, 2.5), day('codex', 9), day(WORK, null), day(WORK, 1)], WORK)).toBe(
      3.5,
    )
  })

  it('is 0 with no days and null when no model it used has a price', () => {
    expect(agentCost([day('codex', 9)], WORK)).toBe(0)
    expect(agentCost([day(WORK, null)], WORK)).toBeNull()
  })
})
