import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@shared/updates'
import { appUpdateNotice, type AppUpdateNotice } from '@renderer/features/updates/app-updates'
import { readJson } from '@renderer/lib/storage'

const UPDATED_NOTICE_KEY = 'updates.updatedNotice'

const stored = new Map<string, string>()
const localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => {
    stored.set(key, value)
  },
  removeItem: (key: string) => {
    stored.delete(key)
  },
}

const bridge = {
  status: null as UpdateStatus | null,
  listener: null as ((status: UpdateStatus) => void) | null,
  check: vi.fn(async (): Promise<UpdateStatus> => {
    if (!bridge.status) throw new Error('no status')
    return bridge.status
  }),
}

function installGlobals(): void {
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', {
    kettu: {
      updates: {
        getStatus: async () => {
          if (!bridge.status) throw new Error('no status')
          return bridge.status
        },
        check: () => bridge.check(),
        onChanged: (listener: (status: UpdateStatus) => void) => {
          bridge.listener = listener
        },
      },
    },
  })
}

type UpdatesModule = typeof import('./updates')

/** A new renderer, sharing the same localStorage as the windows opened before it. */
async function openRenderer(): Promise<UpdatesModule> {
  vi.resetModules()
  installGlobals()
  return import('./updates')
}

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    state: { kind: 'idle', checkedAt: null },
    mode: 'install',
    readOnly: false,
    current: '0.3.0',
    updatedFrom: '0.2.0',
    dismissed: null,
    ...overrides,
  }
}

const updated = { kind: 'updated', version: '0.3.0', from: '0.2.0' } as const

function notice(mod: UpdatesModule): AppUpdateNotice | null {
  const { status: current, updatedDismissed } = mod.useUpdatesStore.getState()
  return appUpdateNotice(current, updatedDismissed)
}

function notedVersion(): unknown {
  return readJson<unknown>(UPDATED_NOTICE_KEY, null)
}

beforeEach(() => {
  stored.clear()
  bridge.status = null
  bridge.listener = null
  bridge.check.mockReset()
  bridge.check.mockImplementation(async () => {
    if (!bridge.status) throw new Error('no status')
    return bridge.status
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllTimers()
})

describe('completion notice', () => {
  it('shows in the first window after an update and records that version', async () => {
    bridge.status = status()
    const mod = await openRenderer()
    await mod.initUpdates()

    expect(notice(mod)).toEqual(updated)
    expect(notedVersion()).toBe('0.3.0')
    expect(mod.useUpdatesStore.getState().updatedDismissed).toBe(false)
  })

  it('stays hidden when another window opens without a dismiss', async () => {
    bridge.status = status()
    const first = await openRenderer()
    await first.initUpdates()
    expect(notice(first)).toEqual(updated)

    const second = await openRenderer()
    await second.initUpdates()
    expect(notice(second)).toBeNull()
    expect(second.useUpdatesStore.getState().updatedDismissed).toBe(true)
    expect(notedVersion()).toBe('0.3.0')
  })

  it('stays in the first window through a status change and a manual check', async () => {
    bridge.status = status()
    const mod = await openRenderer()
    await mod.initUpdates()
    expect(notedVersion()).toBe('0.3.0')

    const refreshed = status({ state: { kind: 'idle', checkedAt: 50 } })
    expect(bridge.listener).toBeTypeOf('function')
    bridge.listener!(refreshed)
    expect(mod.useUpdatesStore.getState().status).toBe(refreshed)
    expect(notice(mod)).toEqual(updated)

    bridge.status = refreshed
    await mod.checkForUpdates()
    expect(notice(mod)).toEqual(updated)
    expect(mod.useUpdatesStore.getState().updatedDismissed).toBe(false)
    expect(notedVersion()).toBe('0.3.0')
  })

  it('shows again after a later update', async () => {
    bridge.status = status()
    const first = await openRenderer()
    await first.initUpdates()

    bridge.status = status({ current: '0.4.0', updatedFrom: '0.3.0' })
    const next = await openRenderer()
    await next.initUpdates()
    expect(notice(next)).toEqual({ kind: 'updated', version: '0.4.0', from: '0.3.0' })
    expect(next.useUpdatesStore.getState().updatedDismissed).toBe(false)
    expect(notedVersion()).toBe('0.4.0')

    const again = await openRenderer()
    await again.initUpdates()
    expect(notice(again)).toBeNull()
  })

  it('shows nothing and records nothing when this launch did not update', async () => {
    bridge.status = status({ current: '0.1.0', updatedFrom: null })
    const installed = await openRenderer()
    await installed.initUpdates()
    expect(notice(installed)).toBeNull()
    expect(notedVersion()).toBeNull()

    stored.set(UPDATED_NOTICE_KEY, JSON.stringify('0.2.0'))
    bridge.status = status({ current: '0.3.0', updatedFrom: null })
    const ordinary = await openRenderer()
    await ordinary.initUpdates()
    expect(notice(ordinary)).toBeNull()
    expect(notedVersion()).toBe('0.2.0')

    bridge.status = status({ current: '0.4.0', updatedFrom: '0.3.0' })
    const next = await openRenderer()
    await next.initUpdates()
    expect(notice(next)).toEqual({ kind: 'updated', version: '0.4.0', from: '0.3.0' })
  })

  it('hides in the first window when the user dismisses it', async () => {
    bridge.status = status()
    const mod = await openRenderer()
    await mod.initUpdates()
    expect(notice(mod)).toEqual(updated)

    mod.useUpdatesStore.setState({ updatedDismissed: true })
    expect(notice(mod)).toBeNull()

    const refreshed = status({ state: { kind: 'idle', checkedAt: 10 } })
    bridge.listener!(refreshed)
    bridge.status = refreshed
    await mod.checkForUpdates()
    expect(notice(mod)).toBeNull()
    expect(notedVersion()).toBe('0.3.0')
  })

  it('still shows a ready, downloading or available update', async () => {
    const ready = status({ state: { kind: 'ready', version: '0.4.0' } })
    bridge.status = ready
    const mod = await openRenderer()
    await mod.initUpdates()
    expect(notice(mod)).toEqual({ kind: 'ready', version: '0.4.0' })

    const downloading = status({
      state: { kind: 'downloading', version: '0.4.0', percent: 40, manual: true },
    })
    bridge.listener!(downloading)
    expect(notice(mod)).toEqual({ kind: 'downloading', version: '0.4.0', percent: 40 })

    const available = status({
      state: { kind: 'available', version: '0.4.0', mode: 'install', downloadUrl: null },
    })
    bridge.listener!(available)
    expect(notice(mod)).toEqual({ kind: 'available', version: '0.4.0', moves: false })
    expect(mod.useUpdatesStore.getState().updatedDismissed).toBe(false)
  })
})
