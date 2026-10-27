// Who drives a page: the agent while a call runs, or the user until they hand back.

import type { BrowserControlState } from '@shared/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserControl, CONTROL_BAR_MS } from './control'

function control() {
  const states: { sessionId: string; state: BrowserControlState }[] = []
  const browser = new BrowserControl({
    changed: (sessionId, state) => states.push({ sessionId, state }),
  })
  return { browser, states, last: () => states.at(-1)?.state }
}

describe('BrowserControl', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the agent driving while a call runs, and nobody between calls', () => {
    const { browser, last } = control()
    expect(browser.state('s1')).toEqual({ kind: 'none' })
    browser.begin('s1')
    expect(browser.state('s1')).toEqual({ kind: 'agent' })
    browser.end('s1')
    expect(browser.state('s1')).toEqual({ kind: 'none' })
    expect(last()).toEqual({ kind: 'none' })
  })

  it('refuses the call that starts while the user holds the page', () => {
    const { browser } = control()
    browser.begin('s1')
    browser.take('s1')
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: true })
    expect(() => browser.begin('s1')).toThrow(expect.objectContaining({ code: 'user_has_control' }))
    expect(() => browser.assert('s1')).toThrow(
      expect.objectContaining({ code: 'user_has_control' }),
    )
  })

  it('stops the call in flight when the user takes control', () => {
    const { browser } = control()
    browser.begin('s1')
    browser.take('s1')
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: true })
    expect(browser.userHolds('s1')).toBe(true)
    // The running call's next step sees the user holding the page.
    expect(() => browser.assert('s1')).toThrow(
      expect.objectContaining({ code: 'user_has_control' }),
    )
    browser.end('s1')
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: true })
  })

  it('hands the page back, and lets the next call drive it', () => {
    const { browser } = control()
    browser.begin('s1')
    browser.take('s1')
    browser.end('s1')
    browser.handBack('s1')
    expect(browser.state('s1')).toEqual({ kind: 'none' })
    expect(browser.userHolds('s1')).toBe(false)
    browser.begin('s1')
    expect(browser.state('s1')).toEqual({ kind: 'agent' })
  })

  it('leaves the hand-back bar after 10 s without a call, but keeps their control', () => {
    const { browser } = control()
    browser.begin('s1')
    browser.take('s1')
    browser.end('s1')
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: true })
    vi.advanceTimersByTime(CONTROL_BAR_MS - 1)
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: true })
    vi.advanceTimersByTime(1)
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: false })
    // Control stays until Hand back; the next call brings the bar back to reach it.
    expect(browser.userHolds('s1')).toBe(true)
    expect(() => browser.begin('s1')).toThrow(expect.objectContaining({ code: 'user_has_control' }))
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: true })
  })

  it('the driving bar’s Stop takes control as any input does', () => {
    const { browser } = control()
    browser.begin('s1')
    browser.stop('s1')
    expect(browser.state('s1')).toEqual({ kind: 'user', bar: true })
    expect(browser.userHolds('s1')).toBe(true)
  })

  it('holds each session apart', () => {
    const { browser } = control()
    browser.begin('s1')
    browser.take('s1')
    expect(browser.state('s2')).toEqual({ kind: 'none' })
    browser.begin('s2')
    expect(browser.state('s2')).toEqual({ kind: 'agent' })
  })

  it('forgets a page that is gone', () => {
    const { browser } = control()
    browser.begin('s1')
    browser.take('s1')
    browser.forget('s1')
    expect(browser.state('s1')).toEqual({ kind: 'none' })
    expect(browser.userHolds('s1')).toBe(false)
  })
})
