import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRefreshTurn, turnRemaining } from './refresh'

describe('turnRemaining', () => {
  it.each([
    [0, 1000],
    [300, 700],
    [1000, 1000],
    [2300, 700],
  ])('%i ms elapsed leaves %i ms of the turn', (elapsed, left) => {
    expect(turnRemaining(elapsed)).toBe(left)
  })
})

describe('a refresh run', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles after a turn, then holds the check for two seconds', async () => {
    vi.useFakeTimers()
    const turn = createRefreshTurn()
    const phases: string[] = []
    turn.subscribe(() => phases.push(turn.getPhase()))

    const done = turn.run(async () => 'fresh')
    await vi.advanceTimersByTimeAsync(0)
    expect(turn.getPhase()).toBe('turning')

    await vi.advanceTimersByTimeAsync(999)
    expect(turn.getPhase()).toBe('turning')

    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBe('fresh')
    expect(turn.getPhase()).toBe('done')

    await vi.advanceTimersByTimeAsync(1999)
    expect(turn.getPhase()).toBe('done')

    await vi.advanceTimersByTimeAsync(1)
    expect(turn.getPhase()).toBe('idle')
    expect(phases).toEqual(['turning', 'done', 'idle'])
  })

  it('rejects a failure only at the end of the turn, with no check', async () => {
    vi.useFakeTimers()
    const turn = createRefreshTurn()
    const failed = turn.run(
      () =>
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('no answer')), 300)
        }),
    )
    const settled = vi.fn()
    failed.catch(settled)

    await vi.advanceTimersByTimeAsync(300)
    expect(settled).not.toHaveBeenCalled()
    expect(turn.getPhase()).toBe('turning')

    await vi.advanceTimersByTimeAsync(699)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(failed).rejects.toThrow('no answer')
    expect(turn.getPhase()).toBe('idle')
  })
})
