import { describe, expect, it } from 'vitest'
import { composerRunState } from './composer-state'

describe('composerRunState (#2855)', () => {
  it('presents waitingBackground as an idle composer with no Stop button or Esc cancellation', () => {
    expect(composerRunState({ status: 'running', waitingBackground: true })).toEqual({
      starting: false,
      waitingBackground: true,
      activeRunning: false,
      awaiting: false,
      idle: false,
      escapeCancels: false,
      showStopWhenEmpty: false,
    })
  })

  it('restores active running controls once waitingBackground clears on wakeup or new prompt', () => {
    expect(composerRunState({ status: 'running', waitingBackground: false })).toEqual({
      starting: false,
      waitingBackground: false,
      activeRunning: true,
      awaiting: false,
      idle: false,
      escapeCancels: true,
      showStopWhenEmpty: true,
    })
  })

  it('keeps permission waits actively running even if waitingBackground was stale', () => {
    expect(composerRunState({ status: 'awaiting_permission', waitingBackground: true })).toEqual({
      starting: false,
      waitingBackground: false,
      activeRunning: true,
      awaiting: true,
      idle: false,
      escapeCancels: true,
      showStopWhenEmpty: true,
    })
  })
})
