import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAdminEvent, HostSettingsPart } from '@shared/remote/host-admin'
import { HostAdmin } from './host-admin'
import { SettingsStore } from './settings'

const DEVICE_ID = '0123456789abcdef0123456789abcdef'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-host-admin-cloud-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function createAdmin(settings: SettingsStore, options: { cloudAlwaysOn?: boolean } = {}) {
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
      hostName: 'Host',
      systemName: 'Host',
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
    themes: {} as never,
    marketKeys: {} as never,
    thumbnail: null,
    png: null,
    cloudAlwaysOn: options.cloudAlwaysOn,
    send: (event, deviceId) => {
      events.push({ event, deviceId })
    },
  })
  return { admin, events }
}

describe('HostAdmin cloud.enabled exposure', () => {
  it('exposes cloud.enabled in settings.get for both on and off states', async () => {
    const settings = await SettingsStore.load(dir)
    const { admin } = createAdmin(settings)

    const initial = await admin.answer(DEVICE_ID, 'settings.get', undefined)
    expect('result' in initial && (initial.result as HostSettingsPart).cloud).toEqual({
      enabled: true,
    })

    settings.update({ cloud: { enabled: false } })
    const afterOff = await admin.answer(DEVICE_ID, 'settings.get', undefined)
    expect('result' in afterOff && (afterOff.result as HostSettingsPart).cloud).toEqual({
      enabled: false,
    })
  })

  it('broadcasts live settings.changed events when the host toggles cloud.enabled', async () => {
    const settings = await SettingsStore.load(dir)
    const { admin, events } = createAdmin(settings)
    settings.onChange((next) => admin.settingsChanged(next))

    settings.update({ cloud: { enabled: false } })
    expect(events).toHaveLength(1)
    expect(events[0]?.deviceId).toBeNull()
    expect(events[0]?.event.type).toBe('settings.changed')
    if (events[0]?.event.type === 'settings.changed') {
      expect(events[0].event.settings.cloud).toEqual({ enabled: false })
    }

    // Re-notifying with the same state does not emit a duplicate broadcast.
    admin.settingsChanged(settings.get())
    expect(events).toHaveLength(1)

    settings.update({ cloud: { enabled: true } })
    expect(events).toHaveLength(2)
    if (events[1]?.event.type === 'settings.changed') {
      expect(events[1].event.settings.cloud).toEqual({ enabled: true })
    }
  })

  it('rejects remote settings.update attempts that touch cloud without modifying host settings', async () => {
    const settings = await SettingsStore.load(dir)
    const { admin } = createAdmin(settings)

    const direct = await admin.answer(DEVICE_ID, 'settings.update', {
      patch: { cloud: { enabled: false } },
    })
    expect(direct).toEqual({
      error: {
        code: 'invalid_params',
        message: 'Only the host itself can change these settings: cloud',
      },
    })
    expect(settings.get().cloud.enabled).toBe(true)

    const mixed = await admin.answer(DEVICE_ID, 'settings.update', {
      patch: { git: { backgroundFetch: true }, cloud: { enabled: false } },
    })
    expect(mixed).toMatchObject({ error: { code: 'invalid_params' } })
    expect(settings.get().cloud.enabled).toBe(true)
    expect(settings.get().git.backgroundFetch).toBe(false)
  })

  it('reports cloud.enabled as true when cloudAlwaysOn is set (daemon host)', async () => {
    const settings = await SettingsStore.load(dir)
    settings.update({ cloud: { enabled: false } })
    const { admin, events } = createAdmin(settings, { cloudAlwaysOn: true })

    const answer = await admin.answer(DEVICE_ID, 'settings.get', undefined)
    expect('result' in answer && (answer.result as HostSettingsPart).cloud).toEqual({
      enabled: true,
    })

    // Toggling the unused file key on a cloudAlwaysOn host does not flip what devices read.
    settings.update({ cloud: { enabled: true } })
    admin.settingsChanged(settings.get())
    expect(events).toHaveLength(0)
  })
})
