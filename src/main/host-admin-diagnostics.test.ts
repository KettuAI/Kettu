import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEBUG_OFF, type DebugStatus } from '@shared/debug'
import type {
  DiagnosticsStatus,
  DiagnosticsStopRecordingResult,
  HostAdminEvent,
  HostSettingsPart,
} from '@shared/remote/host-admin'
import { HostAdmin, type AdminDiagnostics } from './host-admin'
import { SettingsStore } from './settings'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/kettu-test',
  },
  dialog: {
    showSaveDialog: vi.fn(),
  },
}))

const DEVICE_ID = '0123456789abcdef0123456789abcdef'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-host-admin-diagnostics-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function createAdmin(
  settings: SettingsStore,
  options: { diagnostics?: AdminDiagnostics | null } = {},
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
    diagnostics: options.diagnostics ?? null,
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

describe('HostAdmin diagnostics exposure', () => {
  it('exposes diagnostics.verboseUntil in settings.get, accepts valid updates, rejects invalid ones, and broadcasts settings.changed', async () => {
    const settings = await SettingsStore.load(dir)
    const { admin, events } = createAdmin(settings)
    settings.onChange((next) => admin.settingsChanged(next))

    const initial = await admin.answer(DEVICE_ID, 'settings.get', undefined)
    expect('result' in initial && (initial.result as HostSettingsPart).diagnostics).toEqual({
      verboseUntil: null,
    })

    const until = Date.now() + 6 * 60 * 60 * 1000
    const turnedOn = await admin.answer(DEVICE_ID, 'settings.update', {
      patch: { diagnostics: { verboseUntil: until } },
    })
    expect('result' in turnedOn && (turnedOn.result as HostSettingsPart).diagnostics).toEqual({
      verboseUntil: until,
    })
    expect(settings.get().diagnostics.verboseUntil).toBe(until)
    expect(events).toHaveLength(1)
    expect(events[0]?.deviceId).toBeNull()
    expect(events[0]?.event).toMatchObject({
      type: 'settings.changed',
      settings: { diagnostics: { verboseUntil: until } },
    })

    // Invalid timestamps are rejected without changing host settings.
    for (const bad of [-10, Date.now() + 36 * 60 * 60 * 1000, 'tomorrow', true]) {
      const rejected = await admin.answer(DEVICE_ID, 'settings.update', {
        patch: { diagnostics: { verboseUntil: bad } },
      })
      expect(rejected).toMatchObject({ error: { code: 'invalid_params' } })
    }
    expect(settings.get().diagnostics.verboseUntil).toBe(until)
    expect(events).toHaveLength(1)

    // Turning detailed records off clears verboseUntil and broadcasts again.
    const turnedOff = await admin.answer(DEVICE_ID, 'settings.update', {
      patch: { diagnostics: { verboseUntil: null } },
    })
    expect('result' in turnedOff && (turnedOff.result as HostSettingsPart).diagnostics).toEqual({
      verboseUntil: null,
    })
    expect(settings.get().diagnostics.verboseUntil).toBeNull()
    expect(events).toHaveLength(2)
  })

  it('serves desktop diagnostics status, recording start/stop, verbose cleanup, normal restart, and deduplicated diagnostics.changed events', async () => {
    const settings = await SettingsStore.load(dir)
    let recording: DiagnosticsStatus['recording'] = null
    let debug: DebugStatus = {
      on: true,
      cdp: 9222,
      inspectors: [{ name: 'main', url: 'ws://127.0.0.1:9229/main' }],
      file: '/tmp/logs/debug-ports.json',
    }
    const clearVerbose = vi.fn(async () => {})
    const restartNormally = vi.fn()
    const snapshot = (): DiagnosticsStatus => ({
      recording,
      debug,
      canRecord: true,
      canClearVerbose: true,
      canRestartNormally: true,
    })

    const { admin, events } = createAdmin(settings, {
      diagnostics: {
        status: snapshot,
        startRecording: () => {
          recording = { startedAt: 1_000, endsAt: 1_801_000 }
          const next = snapshot()
          admin.diagnosticsChanged(next)
          return next
        },
        stopRecording: (): DiagnosticsStopRecordingResult => {
          const span = recording ? { from: recording.startedAt, to: 5_000 } : null
          recording = null
          const next = snapshot()
          admin.diagnosticsChanged(next)
          return { status: next, span }
        },
        clearVerbose,
        restartNormally,
      },
    })

    const initial = await admin.answer(DEVICE_ID, 'diagnostics.status', undefined)
    expect(initial).toEqual({ result: snapshot() })

    // Starting recording updates state and emits diagnostics.changed.
    const started = await admin.answer(DEVICE_ID, 'diagnostics.startRecording', undefined)
    expect(started).toEqual({ result: snapshot() })
    expect(recording).toEqual({ startedAt: 1_000, endsAt: 1_801_000 })
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toEqual({ type: 'diagnostics.changed', status: snapshot() })

    // Re-notifying with the identical snapshot does not emit a duplicate broadcast.
    admin.diagnosticsChanged(snapshot())
    expect(events).toHaveLength(1)

    // Stopping recording returns the span and emits diagnostics.changed.
    const stopped = await admin.answer(DEVICE_ID, 'diagnostics.stopRecording', undefined)
    expect(stopped).toEqual({
      result: { status: snapshot(), span: { from: 1_000, to: 5_000 } },
    })
    expect(events).toHaveLength(2)

    // clearVerbose is refused while detailed records are on, and succeeds once off.
    settings.update({ diagnostics: { verboseUntil: Date.now() + 60_000 } })
    const blockedClear = await admin.answer(DEVICE_ID, 'diagnostics.clearVerbose', undefined)
    expect(blockedClear).toMatchObject({ error: { code: 'invalid_params' } })
    expect(clearVerbose).not.toHaveBeenCalled()

    settings.update({ diagnostics: { verboseUntil: null } })
    const cleared = await admin.answer(DEVICE_ID, 'diagnostics.clearVerbose', undefined)
    expect(cleared).toEqual({ result: null })
    expect(clearVerbose).toHaveBeenCalledTimes(1)

    // Normal restart succeeds with no arguments.
    const restarted = await admin.answer(DEVICE_ID, 'diagnostics.restartNormally', undefined)
    expect(restarted).toEqual({ result: null })
    expect(restartNormally).toHaveBeenCalledTimes(1)

    // Debug status transitions emit diagnostics.changed.
    debug = DEBUG_OFF
    admin.diagnosticsChanged(snapshot())
    expect(events).toHaveLength(3)
    expect(events[2]?.event).toEqual({ type: 'diagnostics.changed', status: snapshot() })
  })

  it('never allows paired devices to enable debug mode remotely', async () => {
    const settings = await SettingsStore.load(dir)
    const restartNormally = vi.fn()
    const { admin } = createAdmin(settings, {
      diagnostics: {
        status: () => ({
          recording: null,
          debug: DEBUG_OFF,
          canRecord: true,
          canClearVerbose: true,
          canRestartNormally: true,
        }),
        restartNormally,
      },
    })

    // No RPC exists to enable debug mode or pass a debug flag.
    for (const method of ['debug.restart', 'diagnostics.restart', 'diagnostics.enableDebug']) {
      const answer = await admin.answer(DEVICE_ID, method, { debug: true })
      expect(answer).toMatchObject({ error: { code: 'unknown_method' } })
    }

    // Passing arguments (such as { debug: true }) to diagnostics.restartNormally is rejected.
    const withDebugFlag = await admin.answer(DEVICE_ID, 'diagnostics.restartNormally', {
      debug: true,
    })
    expect(withDebugFlag).toMatchObject({ error: { code: 'invalid_params' } })
    const withBoolean = await admin.answer(DEVICE_ID, 'diagnostics.restartNormally', true)
    expect(withBoolean).toMatchObject({ error: { code: 'invalid_params' } })
    expect(restartNormally).not.toHaveBeenCalled()
  })

  it('degrades cleanly on daemon hosts without desktop recording or normal restart, and when diagnostics are absent', async () => {
    const settings = await SettingsStore.load(dir)
    const clearVerbose = vi.fn(async () => {})
    const daemonStatus: DiagnosticsStatus = {
      recording: null,
      debug: {
        on: true,
        cdp: null,
        inspectors: [{ name: 'daemon', url: 'ws://127.0.0.1:9230/daemon' }],
        file: '/var/log/kettu/debug-ports.json',
      },
      canRecord: false,
      canClearVerbose: true,
      canRestartNormally: false,
    }
    const { admin: daemonAdmin } = createAdmin(settings, {
      diagnostics: {
        status: () => daemonStatus,
        clearVerbose,
      },
    })

    expect(await daemonAdmin.answer(DEVICE_ID, 'diagnostics.status', undefined)).toEqual({
      result: daemonStatus,
    })
    expect(await daemonAdmin.answer(DEVICE_ID, 'diagnostics.clearVerbose', undefined)).toEqual({
      result: null,
    })
    expect(clearVerbose).toHaveBeenCalledTimes(1)

    // Desktop-only operations return unavailable on the daemon.
    expect(
      await daemonAdmin.answer(DEVICE_ID, 'diagnostics.startRecording', undefined),
    ).toMatchObject({ error: { code: 'unavailable' } })
    expect(
      await daemonAdmin.answer(DEVICE_ID, 'diagnostics.stopRecording', undefined),
    ).toMatchObject({ error: { code: 'unavailable' } })
    expect(
      await daemonAdmin.answer(DEVICE_ID, 'diagnostics.restartNormally', undefined),
    ).toMatchObject({ error: { code: 'unavailable' } })

    // When diagnostics are completely unavailable, all diagnostics RPCs return unavailable.
    const { admin: noDiagAdmin } = createAdmin(settings, { diagnostics: null })
    for (const method of [
      'diagnostics.status',
      'diagnostics.startRecording',
      'diagnostics.stopRecording',
      'diagnostics.clearVerbose',
      'diagnostics.restartNormally',
    ]) {
      expect(await noDiagAdmin.answer(DEVICE_ID, method, undefined)).toMatchObject({
        error: { code: 'unavailable' },
      })
    }
  })

  it('Reports.startRecording/stopRecording restores verboseUntil and skips local dialog for remote stops', async () => {
    const { Reports } = await import('./report')
    const settings = await SettingsStore.load(dir)
    const onRecording = vi.fn()
    const onRecorded = vi.fn()
    const reports = new Reports(
      {
        build: vi.fn(),
        parent: () => ({}),
        settings: () => settings.get(),
        setVerbose: (until) => void settings.update({ diagnostics: { verboseUntil: until } }),
        verboseUntil: () => settings.get().diagnostics.verboseUntil,
        onRecording,
        onRecorded,
        submit: vi.fn(),
        about: async () => ({ version: '0.1.34', system: 'macOS 15 arm64' }),
      },
      join(dir, 'reports'),
    )

    // Remote start turns verbose on; remote stop restores it to null, returns span, and does not pop a local dialog.
    const started = reports.startRecording('remote')
    expect(started.endsAt).toBeGreaterThan(started.startedAt)
    expect(settings.get().diagnostics.verboseUntil).toBe(started.endsAt)
    expect(onRecording).toHaveBeenLastCalledWith(started)

    const remoteSpan = reports.stopRecording('remote')
    expect(remoteSpan).not.toBeNull()
    expect(remoteSpan!.from).toBe(started.startedAt)
    expect(remoteSpan!.to).toBeGreaterThanOrEqual(started.startedAt)
    expect(settings.get().diagnostics.verboseUntil).toBeNull()
    expect(onRecording).toHaveBeenLastCalledWith(null)
    expect(onRecorded).not.toHaveBeenCalled()

    // Stopping while idle returns null without opening the dialog.
    expect(reports.stopRecording('remote')).toBeNull()

    // Local stop opens the local report dialog and preserves a longer prior verboseUntil window.
    const longVerbose = Date.now() + 6 * 60 * 60 * 1000
    settings.update({ diagnostics: { verboseUntil: longVerbose } })
    reports.startRecording('local')
    expect(settings.get().diagnostics.verboseUntil).toBe(longVerbose)
    const localSpan = reports.stopRecording('local')
    expect(localSpan).not.toBeNull()
    expect(settings.get().diagnostics.verboseUntil).toBe(longVerbose)
    expect(onRecorded).toHaveBeenCalledTimes(1)
    expect(onRecorded).toHaveBeenCalledWith(localSpan)
  })
})
