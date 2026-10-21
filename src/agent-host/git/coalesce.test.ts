import { describe, expect, it } from 'vitest'
import { createCoalescer } from './coalesce'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createCoalescer', () => {
  it('runs once for a single request', async () => {
    let runs = 0
    const coalescer = createCoalescer(async () => ++runs)
    expect(await coalescer.request()).toBe(1)
    expect(await coalescer.request()).toBe(2)
  })

  it('gives every request made during a run the same follow-up run', async () => {
    const gates = [deferred<void>(), deferred<void>()]
    let runs = 0
    const coalescer = createCoalescer(async () => {
      const run = runs++
      await gates[run]?.promise
      return run
    })

    const first = coalescer.request()
    const second = coalescer.request()
    const third = coalescer.request()
    gates[0]!.resolve()
    expect(await first).toBe(0)
    gates[1]!.resolve()
    expect(await second).toBe(1)
    expect(await third).toBe(1)
    expect(runs).toBe(2)
  })

  it('never runs two at once', async () => {
    let active = 0
    let peak = 0
    const coalescer = createCoalescer(async () => {
      peak = Math.max(peak, ++active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
    })
    await Promise.all([coalescer.request(), coalescer.request(), coalescer.request()])
    expect(peak).toBe(1)
  })

  it('still runs the follow-up when the current run fails', async () => {
    let runs = 0
    const coalescer = createCoalescer(async () => {
      if (runs++ === 0) throw new Error('first run fails')
      return 'ok'
    })
    const first = coalescer.request()
    const second = coalescer.request()
    await expect(first).rejects.toThrow('first run fails')
    expect(await second).toBe('ok')
  })
})
