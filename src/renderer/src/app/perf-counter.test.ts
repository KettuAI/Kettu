import { describe, expect, it } from 'vitest'
import { createFrameCounter } from './perf-counter'

describe('createFrameCounter', () => {
  it('counts changes per frame and keeps the largest frame', () => {
    const counter = createFrameCounter()
    expect(counter.count()).toBe(true)
    expect(counter.count()).toBe(false)
    counter.endFrame()
    expect(counter.count()).toBe(true)
    counter.endFrame()
    expect(counter.read()).toEqual({ frames: 2, updates: 3, maxPerFrame: 2 })
  })

  it('ignores frames without changes and starts over on reset', () => {
    const counter = createFrameCounter()
    counter.endFrame()
    expect(counter.read()).toEqual({ frames: 0, updates: 0, maxPerFrame: 0 })
    counter.count()
    counter.reset()
    counter.endFrame()
    expect(counter.read()).toEqual({ frames: 0, updates: 0, maxPerFrame: 0 })
    expect(counter.count()).toBe(true)
  })
})
