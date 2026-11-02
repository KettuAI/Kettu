import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Keepalive, keepaliveMessage } from './keepalive'

function watch() {
  const ping = vi.fn()
  const silent = vi.fn()
  const keepalive = new Keepalive({ quietMs: 10_000, answerMs: 5_000, ping, silent })
  return { keepalive, ping, silent }
}

describe('Keepalive', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('pings after a quiet spell and gives up when nothing answers', () => {
    const { ping, silent } = watch()
    vi.advanceTimersByTime(9_999)
    expect(ping).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ping).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(4_999)
    expect(silent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(silent).toHaveBeenCalledTimes(1)
  })

  it('keeps a connection that answers, and pings only once it is quiet again', () => {
    const { keepalive, ping, silent } = watch()
    vi.advanceTimersByTime(10_000)
    vi.advanceTimersByTime(200)
    keepalive.heard()
    vi.advanceTimersByTime(4_800)
    expect(silent).not.toHaveBeenCalled()
    expect(ping).toHaveBeenCalledTimes(1)
    // Ten seconds after what it heard, not after the check.
    vi.advanceTimersByTime(5_199)
    expect(ping).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('sends nothing while messages keep coming', () => {
    const { keepalive, ping } = watch()
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(3_000)
      keepalive.heard()
    }
    expect(ping).not.toHaveBeenCalled()
  })

  it('never gives up on an answer that came before a late check', () => {
    const { keepalive, ping, silent } = watch()
    vi.advanceTimersByTime(10_000)
    expect(ping).toHaveBeenCalledTimes(1)
    keepalive.heard()
    // A background tab runs the check a minute late.
    vi.setSystemTime(Date.now() + 60_000)
    vi.advanceTimersByTime(5_000)
    expect(silent).not.toHaveBeenCalled()
  })

  it('does nothing once stopped', () => {
    const { keepalive, ping, silent } = watch()
    keepalive.stop()
    vi.advanceTimersByTime(60_000)
    expect(ping).not.toHaveBeenCalled()
    expect(silent).not.toHaveBeenCalled()
  })

  it('tells the connection its own messages from the session', () => {
    expect(keepaliveMessage({ type: 'ping' })).toBe('ping')
    expect(keepaliveMessage({ type: 'pong' })).toBe('pong')
    expect(keepaliveMessage({ type: 'event' })).toBeNull()
    expect(keepaliveMessage(null)).toBeNull()
  })
})
