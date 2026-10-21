import { describe, expect, it } from 'vitest'
import { RestartPolicy } from './restart-policy'

const SECOND = 1000

describe('RestartPolicy', () => {
  it('backs off from 0.5 s, doubling up to 30 s', () => {
    const policy = new RestartPolicy({
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      healthyAfterMs: 60_000,
      maxCrashes: 100,
      crashWindowMs: 120_000,
    })
    const delays = Array.from({ length: 9 }, (_, i) => {
      const decision = policy.crashed(i * 200 * SECOND)
      return decision.kind === 'restart' ? decision.delayMs : null
    })
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
  })

  it('resets the delay after 60 s of healthy running', () => {
    const policy = new RestartPolicy()
    expect(policy.crashed(0)).toEqual({ kind: 'restart', delayMs: 500 })
    policy.ready(1 * SECOND)
    expect(policy.crashed(10 * SECOND)).toEqual({ kind: 'restart', delayMs: 1000 })
    policy.ready(11 * SECOND)
    expect(policy.crashed(71 * SECOND)).toEqual({ kind: 'restart', delayMs: 500 })
  })

  it('does not count a process that never became ready as healthy', () => {
    const policy = new RestartPolicy()
    policy.crashed(0)
    expect(policy.crashed(90 * SECOND)).toEqual({ kind: 'restart', delayMs: 1000 })
  })

  it('gives up at the fifth crash within two minutes', () => {
    const policy = new RestartPolicy()
    for (let i = 0; i < 4; i++) expect(policy.crashed(i * 10 * SECOND).kind).toBe('restart')
    expect(policy.crashed(50 * SECOND)).toEqual({ kind: 'give-up' })
  })

  it('forgets crashes older than two minutes', () => {
    const policy = new RestartPolicy()
    for (let i = 0; i < 4; i++) policy.crashed(i * SECOND)
    expect(policy.crashed(125 * SECOND).kind).toBe('restart')
  })

  it('starts over after a reset', () => {
    const policy = new RestartPolicy()
    for (let i = 0; i < 4; i++) policy.crashed(i * SECOND)
    policy.reset()
    expect(policy.crashed(5 * SECOND)).toEqual({ kind: 'restart', delayMs: 500 })
  })
})
