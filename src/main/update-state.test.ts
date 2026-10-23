import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/updates'
import {
  compareVersions,
  dismissTarget,
  errorMessage,
  nextState,
  offReason,
  type TransitionContext,
  updatedFrom,
  updateMode,
} from './update-state'

const install: TransitionContext = {
  mode: 'install',
  autoDownload: true,
  lastCheckedAt: 1000,
  lastAvailable: null,
}

describe('updateMode', () => {
  it('links on macOS and installs elsewhere unless the build says otherwise', () => {
    expect(updateMode('darwin', undefined)).toBe('link')
    expect(updateMode('darwin', '')).toBe('link')
    expect(updateMode('win32', undefined)).toBe('install')
    expect(updateMode('linux', undefined)).toBe('install')
    expect(updateMode('darwin', 'install')).toBe('install')
    expect(updateMode('win32', 'link')).toBe('link')
    expect(updateMode('win32', 'bogus')).toBe('install')
  })
})

describe('offReason', () => {
  it('is off in development', () => {
    expect(offReason(false, 'win32', {})).toEqual({ kind: 'off', reason: 'development' })
  })

  it('is off on Linux outside an AppImage', () => {
    expect(offReason(true, 'linux', {})).toEqual({ kind: 'off', reason: 'unsupported' })
    expect(offReason(true, 'linux', { APPIMAGE: '/opt/OverBench.AppImage' })).toBeNull()
  })

  it('is on for packaged Windows and macOS builds', () => {
    expect(offReason(true, 'win32', {})).toBeNull()
    expect(offReason(true, 'darwin', {})).toBeNull()
  })
})

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.2.0', -1],
    ['0.10.0', '0.9.9', 1],
    ['1.0.0', '1.0.0', 0],
    ['v1.2.3', '1.2.3', 0],
    ['1.0.0-beta.2', '1.0.0', -1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0+build.5', '1.0.0', 0],
  ])('compares %s with %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign)
  })

  it('cannot compare what is not a version', () => {
    expect(compareVersions('next', '1.0.0')).toBeNaN()
  })
})

describe('updatedFrom', () => {
  it('names the older version that ran last', () => {
    expect(updatedFrom('0.2.0', '0.3.0')).toBe('0.2.0')
  })

  it('is null on the first launch, the same version, or a downgrade', () => {
    expect(updatedFrom(null, '0.3.0')).toBeNull()
    expect(updatedFrom('0.3.0', '0.3.0')).toBeNull()
    expect(updatedFrom('0.4.0', '0.3.0')).toBeNull()
    expect(updatedFrom('garbage', '0.3.0')).toBeNull()
  })
})

describe('dismissTarget', () => {
  const base = { current: '0.3.0', updatedFrom: null, dismissed: null }

  it('dismisses the version on the notice', () => {
    expect(dismissTarget({ ...base, state: { kind: 'ready', version: '0.4.0' } })).toBe('0.4.0')
    expect(
      dismissTarget({ ...base, state: { kind: 'available', version: '0.4.0', mode: 'link' } }),
    ).toBe('0.4.0')
  })

  it('dismisses the "Updated to" notice with the running version', () => {
    expect(
      dismissTarget({ ...base, updatedFrom: '0.2.0', state: { kind: 'idle', checkedAt: null } }),
    ).toBe('0.3.0')
    expect(dismissTarget({ ...base, state: { kind: 'idle', checkedAt: null } })).toBeNull()
  })
})

describe('nextState', () => {
  const idle: UpdateState = { kind: 'idle', checkedAt: 1000 }

  it('downloads at once in Install mode with automatic downloads', () => {
    const checking = nextState(idle, { type: 'checking', manual: false }, install)
    expect(checking).toEqual({ kind: 'checking', manual: false })
    const downloading = nextState(checking, { type: 'available', version: '0.4.0' }, install)
    expect(downloading).toEqual({ kind: 'downloading', version: '0.4.0', percent: 0 })
    const progressed = nextState(downloading, { type: 'progress', percent: 42.7 }, install)
    expect(progressed).toEqual({ kind: 'downloading', version: '0.4.0', percent: 42 })
    expect(nextState(progressed, { type: 'downloaded', version: '0.4.0' }, install)).toEqual({
      kind: 'ready',
      version: '0.4.0',
    })
  })

  it('stops at available when downloads wait for the user', () => {
    const notify = { ...install, autoDownload: false }
    const available = nextState(
      { kind: 'checking', manual: true },
      { type: 'available', version: '0.4.0' },
      notify,
    )
    expect(available).toEqual({ kind: 'available', version: '0.4.0', mode: 'install' })
    expect(nextState(available, { type: 'download-started', version: '0.4.0' }, notify)).toEqual({
      kind: 'downloading',
      version: '0.4.0',
      percent: 0,
    })
  })

  it('always stops at available in Link mode', () => {
    expect(
      nextState(
        { kind: 'checking', manual: false },
        { type: 'available', version: '0.4.0' },
        { ...install, mode: 'link' },
      ),
    ).toEqual({ kind: 'available', version: '0.4.0', mode: 'link' })
  })

  it('records when a check found nothing', () => {
    expect(
      nextState({ kind: 'checking', manual: true }, { type: 'not-available', at: 5000 }, install),
    ).toEqual({ kind: 'idle', checkedAt: 5000 })
  })

  it('shows errors only for what the user started', () => {
    const checking: UpdateState = { kind: 'checking', manual: true }
    expect(
      nextState(checking, { type: 'error', message: 'offline', manual: true }, install),
    ).toEqual({ kind: 'error', message: 'offline', manual: true })
    expect(
      nextState(
        { kind: 'checking', manual: false },
        { type: 'error', message: 'offline', manual: false },
        install,
      ),
    ).toEqual({ kind: 'idle', checkedAt: 1000 })
  })

  it('shows that electron-updater could not load, even after an automatic check', () => {
    expect(
      nextState(
        { kind: 'idle', checkedAt: null },
        { type: 'load-failed', message: 'no autoUpdater', manual: false },
        install,
      ),
    ).toEqual({ kind: 'error', message: 'no autoUpdater', manual: false })
  })

  it('falls back to the found version after a failed automatic download', () => {
    expect(
      nextState(
        { kind: 'downloading', version: '0.4.0', percent: 30 },
        { type: 'error', message: 'reset', manual: false },
        install,
      ),
    ).toEqual({ kind: 'available', version: '0.4.0', mode: 'install' })
    expect(
      nextState(
        { kind: 'checking', manual: false },
        { type: 'error', message: 'offline', manual: false },
        { ...install, lastAvailable: '0.4.0' },
      ),
    ).toEqual({ kind: 'available', version: '0.4.0', mode: 'install' })
  })

  it('keeps a ready update through a failed automatic event', () => {
    const ready: UpdateState = { kind: 'ready', version: '0.4.0' }
    expect(nextState(ready, { type: 'error', message: 'x', manual: false }, install)).toBe(ready)
  })

  it('ignores progress outside a download and every event while off', () => {
    expect(nextState(idle, { type: 'progress', percent: 50 }, install)).toBe(idle)
    const off: UpdateState = { kind: 'off', reason: 'development' }
    expect(nextState(off, { type: 'checking', manual: true }, install)).toBe(off)
  })
})

describe('errorMessage', () => {
  it('keeps the first line and limits its length', () => {
    expect(errorMessage(new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack'))).toBe(
      'net::ERR_INTERNET_DISCONNECTED',
    )
    expect(errorMessage('x'.repeat(500))).toHaveLength(300)
    expect(errorMessage(new Error(''))).toBe('Unknown error')
  })
})
