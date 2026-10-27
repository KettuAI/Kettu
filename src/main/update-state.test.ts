import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/updates'
import {
  compareVersions,
  dismissTarget,
  dmgDownloadUrl,
  errorMessage,
  installOnQuit,
  moveCancelled,
  nextState,
  offReason,
  readOnlyVolume,
  type TransitionContext,
  updatedFrom,
  updateMode,
} from './update-state'

const install: TransitionContext = {
  mode: 'install',
  autoDownload: true,
  lastCheckedAt: 1000,
  lastAvailable: null,
  downloadUrl: null,
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

describe('installOnQuit', () => {
  it('waits for a restart only when the choice says so and the updater started the download', () => {
    expect(installOnQuit({ choice: 'restart', startedBy: 'auto' })).toBe(false)
    expect(installOnQuit({ choice: 'restart', startedBy: 'user' })).toBe(true)
  })

  it.each(['download', 'notify', 'off'] as const)('installs on quit under %s', (choice) => {
    expect(installOnQuit({ choice, startedBy: 'auto' })).toBe(true)
    expect(installOnQuit({ choice, startedBy: 'user' })).toBe(true)
  })
})

describe('dmgDownloadUrl', () => {
  const files = [{ url: 'OverBench-0.4.0-x64.dmg' }, { url: 'OverBench-0.4.0-arm64.dmg' }]

  it("picks the .dmg for the Mac's architecture", () => {
    expect(dmgDownloadUrl('0.4.0', files, 'arm64')).toBe(
      'https://github.com/overbench/overbench/releases/download/v0.4.0/OverBench-0.4.0-arm64.dmg',
    )
    expect(dmgDownloadUrl('0.4.0', files, 'x64')).toBe(
      'https://github.com/overbench/overbench/releases/download/v0.4.0/OverBench-0.4.0-x64.dmg',
    )
  })

  it('finds none for another architecture or a release without one', () => {
    expect(dmgDownloadUrl('0.4.0', files, 'ia32')).toBeNull()
    expect(dmgDownloadUrl('0.4.0', [{ url: 'OverBench-0.4.0-arm64-mac.zip' }], 'arm64')).toBeNull()
    expect(dmgDownloadUrl('0.4.0', [], 'arm64')).toBeNull()
  })
})

describe('dismissTarget', () => {
  const base = {
    mode: 'install' as const,
    readOnly: false,
    current: '0.3.0',
    updatedFrom: null,
    dismissed: null,
  }

  it('dismisses the version on the notice', () => {
    expect(dismissTarget({ ...base, state: { kind: 'ready', version: '0.4.0' } })).toBe('0.4.0')
    expect(
      dismissTarget({
        ...base,
        state: { kind: 'available', version: '0.4.0', mode: 'link', downloadUrl: null },
      }),
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

  it('keeps an available update through an automatic check', () => {
    const available: UpdateState = {
      kind: 'available',
      version: '0.4.0',
      mode: 'link',
      downloadUrl: null,
    }
    expect(nextState(available, { type: 'checking', manual: false }, install)).toBe(available)
    const notify = { ...install, autoDownload: false }
    expect(nextState(available, { type: 'checking', manual: false }, notify)).toBe(available)
    expect(
      nextState(available, { type: 'not-available', at: 5000 }, { ...install, mode: 'link' }),
    ).toEqual({ kind: 'idle', checkedAt: 5000 })
    expect(
      nextState(available, { type: 'available', version: '0.5.0' }, { ...install, mode: 'link' }),
    ).toEqual({ kind: 'available', version: '0.5.0', mode: 'link', downloadUrl: null })
    expect(
      nextState(
        { kind: 'available', version: '0.4.0', mode: 'install', downloadUrl: null },
        { type: 'available', version: '0.5.0' },
        notify,
      ),
    ).toEqual({ kind: 'available', version: '0.5.0', mode: 'install', downloadUrl: null })
    expect(
      nextState(available, { type: 'error', message: 'offline', manual: false }, install),
    ).toBe(available)
    expect(nextState(available, { type: 'checking', manual: true }, install)).toEqual({
      kind: 'checking',
      manual: true,
    })
  })

  it('downloads at once in Install mode with automatic downloads', () => {
    const checking = nextState(idle, { type: 'checking', manual: false }, install)
    expect(checking).toEqual({ kind: 'checking', manual: false })
    const downloading = nextState(checking, { type: 'available', version: '0.4.0' }, install)
    expect(downloading).toEqual({
      kind: 'downloading',
      version: '0.4.0',
      percent: 0,
      manual: false,
    })
    const progressed = nextState(downloading, { type: 'progress', percent: 42.7 }, install)
    expect(progressed).toEqual({
      kind: 'downloading',
      version: '0.4.0',
      percent: 42,
      manual: false,
    })
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
    expect(available).toEqual({
      kind: 'available',
      version: '0.4.0',
      mode: 'install',
      downloadUrl: null,
    })
    expect(
      nextState(available, { type: 'download-started', version: '0.4.0', manual: true }, notify),
    ).toEqual({ kind: 'downloading', version: '0.4.0', percent: 0, manual: true })
  })

  it('goes back to available when a download is cancelled', () => {
    const downloading: UpdateState = {
      kind: 'downloading',
      version: '0.4.0',
      percent: 30,
      manual: true,
    }
    expect(nextState(downloading, { type: 'download-cancelled' }, install)).toEqual({
      kind: 'available',
      version: '0.4.0',
      mode: 'install',
      downloadUrl: null,
    })
    const ready: UpdateState = { kind: 'ready', version: '0.4.0' }
    expect(nextState(ready, { type: 'download-cancelled' }, install)).toBe(ready)
  })

  it('always stops at available in Link mode, with the .dmg found for this Mac', () => {
    const url = 'https://github.com/overbench/overbench/releases/download/v0.4.0/x-arm64.dmg'
    const link = { ...install, mode: 'link' as const, lastAvailable: '0.4.0', downloadUrl: url }
    expect(
      nextState({ kind: 'checking', manual: false }, { type: 'available', version: '0.4.0' }, link),
    ).toEqual({ kind: 'available', version: '0.4.0', mode: 'link', downloadUrl: url })
    expect(
      nextState(
        { kind: 'checking', manual: false },
        { type: 'error', message: 'offline', manual: false },
        link,
      ),
    ).toEqual({ kind: 'available', version: '0.4.0', mode: 'link', downloadUrl: url })
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

  it('stays not checked after failed automatic checks until one found nothing', () => {
    const check = { type: 'checking', manual: false } as const
    const failed = { type: 'error', message: 'offline', manual: false } as const
    const first = { ...install, lastCheckedAt: null }
    let state: UpdateState = { kind: 'idle', checkedAt: null }
    state = nextState(nextState(state, check, first), failed, first)
    expect(state).toEqual({ kind: 'idle', checkedAt: null })
    state = nextState(nextState(state, check, first), { type: 'not-available', at: 5000 }, first)
    const later = { ...install, lastCheckedAt: 5000 }
    state = nextState(nextState(state, check, later), failed, later)
    expect(state).toEqual({ kind: 'idle', checkedAt: 5000 })
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
        { kind: 'downloading', version: '0.4.0', percent: 30, manual: false },
        { type: 'error', message: 'reset', manual: false },
        install,
      ),
    ).toEqual({ kind: 'available', version: '0.4.0', mode: 'install', downloadUrl: null })
    expect(
      nextState(
        { kind: 'checking', manual: false },
        { type: 'error', message: 'offline', manual: false },
        { ...install, lastAvailable: '0.4.0' },
      ),
    ).toEqual({ kind: 'available', version: '0.4.0', mode: 'install', downloadUrl: null })
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

  it('moves the app for Update, and offers the update again when it stays', () => {
    const notify = { ...install, autoDownload: false }
    const available: UpdateState = {
      kind: 'available',
      version: '0.4.0',
      mode: 'install',
      downloadUrl: null,
    }
    const moving = nextState(available, { type: 'moving', version: '0.4.0' }, notify)
    expect(moving).toEqual({ kind: 'moving', version: '0.4.0' })
    expect(nextState(moving, { type: 'move-cancelled' }, notify)).toEqual(available)
    expect(nextState(idle, { type: 'move-cancelled' }, notify)).toBe(idle)
    expect(nextState(moving, { type: 'move-failed', message: 'disk full' }, notify)).toEqual({
      kind: 'error',
      message: 'disk full',
      manual: true,
      move: true,
    })
  })
})

describe('readOnlyVolume', () => {
  it('tells a read-only volume from other reasons the app is not writable', () => {
    const error = (code: string) => Object.assign(new Error(code), { code })
    expect(readOnlyVolume(error('EROFS'))).toBe(true)
    expect(readOnlyVolume(error('EACCES'))).toBe(false)
    expect(readOnlyVolume(error('ENOENT'))).toBe(false)
    expect(readOnlyVolume('EROFS')).toBe(false)
    expect(readOnlyVolume(null)).toBe(false)
  })
})

describe('moveCancelled', () => {
  it("knows Electron's refused password prompt from a failed move", () => {
    expect(moveCancelled(new Error('User rejected the authorization request'))).toBe(true)
    expect(
      moveCancelled(new Error('Failed to copy current bundle to the applications folder')),
    ).toBe(false)
    expect(moveCancelled('User rejected the authorization request')).toBe(false)
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
