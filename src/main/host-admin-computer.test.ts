import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseStatus } from '@shared/computer-use'
import type { HostAdminEvent, HostSettingsPart } from '@shared/remote/host-admin'
import { HostAdmin } from './host-admin'
import { SettingsStore } from './settings'

const DEVICE_ID = '0123456789abcdef0123456789abcdef'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-host-admin-computer-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function createAdmin(
  settings: SettingsStore,
  options: { computerStatus?: (() => Promise<ComputerUseStatus>) | null } = {},
) {
  const events: { event: HostAdminEvent; deviceId: string | null }[] = []
  const admin = new HostAdmin({
    settings,
    agentFolders: {} as never,
    platform: 'darwin',
    remote: {
      pendingDiscovery: () => null,
      closePairing: vi.fn(),
    } as never,
    remoteStatus: () => ({
      state: 'on',
      hostName: 'Studio Mac',
      systemName: 'Studio Mac',
      devices: [
        {
          id: DEVICE_ID,
          publicKey: 'pk',
          name: 'Phone',
          kind: 'ios',
          platform: 'iOS 26.1',
          model: 'iPhone',
          addedAt: 0,
          lastConnectedAt: null,
          account: null,
        },
      ],
      online: [DEVICE_ID],
      plainTextKey: false,
      direct: { state: 'off' },
      relay: { state: 'off' },
    }),
    info: async () => ({}) as never,
    restart: vi.fn(),
    sharing: null,
    updates: null,
    computerStatus: options.computerStatus ?? null,
    themes: {} as never,
    marketKeys: {} as never,
    thumbnail: null,
    png: null,
    send: (event, deviceId) => {
      events.push({ event, deviceId })
    },
  })
  return { admin, events }
}

describe('HostAdmin computer use read-only exposure', () => {
  it('exposes computerUse settings in settings.get and broadcasts live settings.changed on desktop host', async () => {
    const settings = await SettingsStore.load(dir)
    const status: ComputerUseStatus = {
      driver: true,
      accessibility: 'granted',
      screenRecording: 'not-determined',
      sessionType: null,
      desktop: null,
    }
    const { admin, events } = createAdmin(settings, { computerStatus: async () => status })
    settings.onChange((next) => admin.settingsChanged(next))

    const initial = await admin.answer(DEVICE_ID, 'settings.get', undefined)
    expect('result' in initial && (initial.result as HostSettingsPart).computerUse).toEqual({
      enabled: false,
      allowedApps: [],
      pauseOnUse: true,
      stopShortcut: '',
    })

    settings.update({
      computerUse: {
        enabled: true,
        allowedApps: [{ id: 'com.apple.Safari', name: 'Safari' }],
        pauseOnUse: false,
        stopShortcut: 'Control+Alt+Command+K',
      },
    })

    const updated = await admin.answer(DEVICE_ID, 'settings.get', undefined)
    expect('result' in updated && (updated.result as HostSettingsPart).computerUse).toEqual({
      enabled: true,
      allowedApps: [{ id: 'com.apple.Safari', name: 'Safari' }],
      pauseOnUse: false,
      stopShortcut: 'Control+Alt+Command+K',
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.deviceId).toBeNull()
    expect(events[0]?.event.type).toBe('settings.changed')
    if (events[0]?.event.type === 'settings.changed') {
      expect(events[0].event.settings.computerUse).toEqual({
        enabled: true,
        allowedApps: [{ id: 'com.apple.Safari', name: 'Safari' }],
        pauseOnUse: false,
        stopShortcut: 'Control+Alt+Command+K',
      })
    }

    // Re-notifying with the same state does not emit a duplicate broadcast.
    admin.settingsChanged(settings.get())
    expect(events).toHaveLength(1)
  })

  it('rejects remote settings.update attempts that touch computerUse without modifying host settings', async () => {
    const settings = await SettingsStore.load(dir)
    const { admin } = createAdmin(settings, {
      computerStatus: async () => ({
        driver: true,
        accessibility: 'granted',
        screenRecording: 'granted',
        sessionType: null,
        desktop: null,
      }),
    })

    const direct = await admin.answer(DEVICE_ID, 'settings.update', {
      patch: { computerUse: { enabled: true } },
    })
    expect(direct).toEqual({
      error: {
        code: 'invalid_params',
        message: 'Only the host itself can change these settings: computerUse',
      },
    })
    expect(settings.get().computerUse.enabled).toBe(false)

    const mixed = await admin.answer(DEVICE_ID, 'settings.update', {
      patch: {
        git: { backgroundFetch: true },
        computerUse: { allowedApps: [{ id: 'com.apple.TextEdit', name: 'TextEdit' }] },
      },
    })
    expect(mixed).toMatchObject({ error: { code: 'invalid_params' } })
    expect(settings.get().computerUse.allowedApps).toEqual([])
    expect(settings.get().git.backgroundFetch).toBe(false)
  })

  it('serves read-only computer.status on desktop host and rejects mutation RPCs', async () => {
    const settings = await SettingsStore.load(dir)
    let current: ComputerUseStatus = {
      driver: true,
      accessibility: 'granted',
      screenRecording: 'denied',
      sessionType: null,
      desktop: null,
    }
    const { admin } = createAdmin(settings, { computerStatus: async () => current })

    const first = await admin.answer(DEVICE_ID, 'computer.status', undefined)
    expect(first).toEqual({ result: current })

    current = { ...current, screenRecording: 'granted' }
    const second = await admin.answer(DEVICE_ID, 'computer.status', undefined)
    expect(second).toEqual({ result: current })

    // Permission grant / mutation RPCs stay strictly local and are never exposed remotely.
    const requestPerm = await admin.answer(DEVICE_ID, 'computer.requestPermission', {
      kind: 'accessibility',
    })
    expect(requestPerm).toMatchObject({ error: { code: 'unknown_method' } })
  })

  it('omits computerUse from settings.get and returns unavailable for computer.status on daemon host', async () => {
    const settings = await SettingsStore.load(dir)
    settings.update({ computerUse: { enabled: true } })
    const { admin, events } = createAdmin(settings, { computerStatus: null })

    const part = await admin.answer(DEVICE_ID, 'settings.get', undefined)
    expect('result' in part && (part.result as HostSettingsPart).computerUse).toBeUndefined()

    const status = await admin.answer(DEVICE_ID, 'computer.status', undefined)
    expect(status).toMatchObject({ error: { code: 'unavailable' } })

    // Changing unused computerUse in daemon settings does not emit settings.changed.
    settings.update({ computerUse: { enabled: false } })
    admin.settingsChanged(settings.get())
    expect(events).toHaveLength(0)

    // Remote writes to computerUse are still rejected with invalid_params on daemon hosts.
    const writeAttempt = await admin.answer(DEVICE_ID, 'settings.update', {
      patch: { computerUse: { enabled: true } },
    })
    expect(writeAttempt).toMatchObject({ error: { code: 'invalid_params' } })
  })
})
