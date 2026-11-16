import { describe, expect, it } from 'vitest'
import { addSpeedSample, SPEED_RECENT, timeRequest, type OutputSpeed } from './output-speed'

const sample = (tokens: number, ms: number, approx = false) => ({
  tokens,
  ms,
  approx,
  firstTokenMs: null,
})

describe('output speed', () => {
  it('times streamed output from its first token, else from sending', () => {
    expect(timeRequest(300, 1_000, 2_000, 4_000)).toEqual({
      tokens: 300,
      ms: 2_000,
      approx: false,
      firstTokenMs: 1_000,
    })
    // Output that came at once times nothing, so the request is timed from when it went out.
    expect(timeRequest(300, 1_000, 3_990, 4_000)).toEqual({
      tokens: 300,
      ms: 3_000,
      approx: true,
      firstTokenMs: null,
    })
    expect(timeRequest(300, null, null, 4_000)).toBeNull()
  })

  it('starts the turn over when a request of a new turn counts', () => {
    const first = addSpeedSample(null, sample(100, 1_000), 1)!
    const second = addSpeedSample(first, sample(300, 1_000, true), 2)!
    expect(second.turn).toEqual({ since: 2, tokens: 300, ms: 1_000, requests: 1, approx: 1 })
    expect(second.session).toEqual({ tokens: 400, ms: 2_000, requests: 2, approx: 1 })
    expect(second.recent).toEqual([
      { rate: 100, approx: false },
      { rate: 300, approx: true },
    ])
  })

  it('keeps the latest readings only', () => {
    let speed: OutputSpeed | null = null
    for (let i = 1; i <= SPEED_RECENT + 3; i++) {
      speed = addSpeedSample(speed, sample(i * 100, 1_000), 1)
    }
    expect(speed!.recent).toHaveLength(SPEED_RECENT)
    expect(speed!.recent.at(-1)!.rate).toBe((SPEED_RECENT + 3) * 100)
    expect(speed!.session.requests).toBe(SPEED_RECENT + 3)
  })

  it('skips a request too short to time', () => {
    expect(addSpeedSample(null, sample(49, 1_000), 1)).toBeNull()
    expect(addSpeedSample(null, sample(400, 499), 1)).toBeNull()
  })
})
