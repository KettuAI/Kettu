import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/updates'
import { nextState, type TransitionContext, type UpdaterEvent } from './update-state'

const context: TransitionContext = {
  mode: 'install',
  autoDownload: true,
  lastCheckedAt: null,
  lastAvailable: null,
}

const READY: UpdateState = { kind: 'ready', version: '0.1.22' }

function run(state: UpdateState, events: UpdaterEvent[], over: Partial<TransitionContext> = {}) {
  return events.reduce((s, event) => nextState(s, event, { ...context, ...over }), state)
}

describe('a check while an update waits for its restart', () => {
  it('keeps the ready update through a manual or automatic check', () => {
    expect(run(READY, [{ type: 'checking', manual: true }])).toBe(READY)
    expect(run(READY, [{ type: 'checking', manual: false }])).toBe(READY)
  })

  it('keeps the ready update when the check finds it again, an older one or none', () => {
    const found = (version: string): UpdaterEvent[] => [
      { type: 'checking', manual: true },
      { type: 'available', version },
    ]
    expect(run(READY, found('0.1.22'))).toBe(READY)
    expect(run(READY, found('0.1.21'))).toBe(READY)
    expect(run(READY, [{ type: 'not-available', at: 1 }])).toBe(READY)
  })

  it('downloads a newer release in its place, which is ready once downloaded', () => {
    const downloading = run(READY, [
      { type: 'checking', manual: true },
      { type: 'available', version: '0.1.23' },
    ])
    expect(downloading).toEqual({
      kind: 'downloading',
      version: '0.1.23',
      percent: 0,
      manual: false,
      replaces: '0.1.22',
    })
    const started = run(downloading, [
      { type: 'download-started', version: '0.1.23', manual: false, replaces: '0.1.22' },
      { type: 'progress', percent: 40 },
    ])
    expect(started).toMatchObject({ kind: 'downloading', percent: 40, replaces: '0.1.22' })
    expect(run(started, [{ type: 'downloaded', version: '0.1.23' }])).toEqual({
      kind: 'ready',
      version: '0.1.23',
    })
  })

  it('offers a newer release without downloading it when downloads are not automatic', () => {
    const state = run(READY, [{ type: 'available', version: '0.1.23' }], { autoDownload: false })
    expect(state).toEqual({ kind: 'available', version: '0.1.23', mode: 'install' })
  })

  // electron-updater empties its download folder for the newer file, so the ready one is gone.
  it('offers the newer release again when its download fails or is cancelled', () => {
    const downloading = run(READY, [
      { type: 'available', version: '0.1.23' },
      { type: 'download-started', version: '0.1.23', manual: false, replaces: '0.1.22' },
    ])
    const offered = { kind: 'available', version: '0.1.23', mode: 'install' }
    expect(run(downloading, [{ type: 'error', message: 'offline', manual: false }])).toEqual(
      offered,
    )
    expect(run(downloading, [{ type: 'download-cancelled' }])).toEqual(offered)
  })
})
