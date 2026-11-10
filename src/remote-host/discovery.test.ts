import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveryRequestEvent } from '@shared/remote/discovery'
import { DiscoveryRequests, type DiscoveryOutcome, type DiscoverySlot } from './discovery'

const DEVICE = {
  name: 'Laptop',
  model: 'MacBook Air',
  kind: 'desktop',
  platform: 'macOS',
  known: false,
}

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  vi.useFakeTimers()
  const events: DiscoveryRequestEvent[] = []
  const requests = new DiscoveryRequests({
    send: (event) => events.push(event),
    now: () => Date.now(),
    askMs: 1000,
    cooldownMs: 5000,
    strikes: 3,
  })
  requests.setEnabled(true)
  /** Claims the request and asks the owner; its outcome once it settles. */
  const ask = (): { slot: DiscoverySlot; outcome: () => DiscoveryOutcome | null } => {
    const slot = requests.claim()
    if (typeof slot === 'string') throw new Error(`Refused: ${slot}`)
    let settled: DiscoveryOutcome | null = null
    void requests.ask(slot, DEVICE, '001133').then((outcome) => (settled = outcome))
    return { slot, outcome: () => settled }
  }
  const last = () => events.at(-1)!
  return { requests, events, ask, last }
}

describe('discovery requests', () => {
  it('takes one at a time, and turns away another while it is open', async () => {
    const t = setup()
    const first = t.ask()
    expect(t.requests.claim()).toBe('busy')
    expect(t.last()).toMatchObject({ requestId: 1, request: { state: 'confirm', code: '001133' } })
    expect(t.requests.pending()?.requestId).toBe(1)
    t.requests.release(first.slot)
    await Promise.resolve()
    expect(first.outcome()).toEqual({ add: false, reason: 'cancelled' })
    expect(t.last()).toEqual({ requestId: 1, request: { state: 'closed', reason: 'cancelled' } })
    expect(t.requests.pending()).toBeNull()
    expect(typeof t.requests.claim()).toBe('object')
  })

  it('adds the device only once both the owner and the device said yes, in either order', async () => {
    const t = setup()
    const first = t.ask()
    t.requests.answer(1, true, 'Work laptop')
    await Promise.resolve()
    expect(first.outcome()).toBeNull()
    t.requests.confirm(first.slot)
    await Promise.resolve()
    expect(first.outcome()).toEqual({ add: true, name: 'Work laptop' })
    t.requests.added(first.slot)
    expect(t.last()).toEqual({ requestId: 1, request: { state: 'closed', reason: 'added' } })

    const second = t.ask()
    t.requests.confirm(second.slot)
    await Promise.resolve()
    expect(second.outcome()).toBeNull()
    // An answer to another request changes nothing.
    t.requests.answer(1, true, 'Other')
    t.requests.answer(2, true, 'Desk')
    await Promise.resolve()
    expect(second.outcome()).toEqual({ add: true, name: 'Desk' })
  })

  it('ends a request the owner rejects, or nobody answers in time', async () => {
    const t = setup()
    const rejected = t.ask()
    t.requests.confirm(rejected.slot)
    t.requests.answer(1, false, '')
    await Promise.resolve()
    expect(rejected.outcome()).toEqual({ add: false, reason: 'rejected' })

    const expired = t.ask()
    t.requests.answer(2, true, 'Desk')
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(expired.outcome()).toEqual({ add: false, reason: 'expired' })
    expect(t.last()).toEqual({ requestId: 2, request: { state: 'closed', reason: 'expired' } })
  })

  it('counts only requests in a row that end without a device, an add clearing them', async () => {
    const t = setup()
    t.ask()
    t.requests.answer(1, false, '')
    const cancelled = t.ask()
    t.requests.release(cancelled.slot)
    const added = t.ask()
    t.requests.answer(3, true, 'Desk')
    t.requests.confirm(added.slot)
    await Promise.resolve()
    t.requests.added(added.slot)
    t.ask()
    vi.advanceTimersByTime(1000)
    t.ask()
    t.requests.answer(5, false, '')
    expect(typeof t.requests.claim()).toBe('object')
  })

  it('takes none during the cooldown, and again after it', () => {
    const t = setup()
    for (let i = 1; i <= 3; i++) {
      t.ask()
      t.requests.answer(i, false, '')
    }
    expect(t.requests.claim()).toBe('cooling_down')
    vi.advanceTimersByTime(4999)
    expect(t.requests.claim()).toBe('cooling_down')
    vi.advanceTimersByTime(1)
    expect(typeof t.requests.claim()).toBe('object')
  })

  it('frees a slot never asked about without a word or a strike', () => {
    const t = setup()
    for (let i = 0; i < 5; i++) {
      const slot = t.requests.claim()
      if (typeof slot === 'string') throw new Error(slot)
      t.requests.release(slot)
    }
    expect(t.events).toEqual([])
    expect(typeof t.requests.claim()).toBe('object')
  })

  it('ends the open request as stopped, without a strike, once turned off', async () => {
    const t = setup()
    const first = t.ask()
    t.requests.setEnabled(false)
    await Promise.resolve()
    expect(first.outcome()).toEqual({ add: false, reason: 'stopped' })
    expect(t.requests.on).toBe(false)
    t.requests.setEnabled(true)
    for (let i = 2; i <= 3; i++) {
      t.ask()
      t.requests.answer(i, false, '')
    }
    expect(typeof t.requests.claim()).toBe('object')
  })
})
