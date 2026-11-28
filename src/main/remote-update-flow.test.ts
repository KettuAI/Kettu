import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusySession, BusyTerminal } from '@shared/host-control'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import type { RemoteStatus } from '@shared/remote/status'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import type { UpdateStatus } from '@shared/updates'
import type { AppStateStore } from './app-state'
import type { WindowsInstallOptions, WindowsInstallResult } from './windows-installer'

class FakeCancellationToken extends EventEmitter {
  cancelled = false
  cancel(): void {
    this.cancelled = true
    this.emit('cancel')
  }
  dispose(): void {}
}

class FakeAutoUpdater extends EventEmitter {
  logger: unknown = null
  allowPrerelease = false
  allowDowngrade = false
  autoDownload = true
  autoInstallOnAppQuit = true
  disableDifferentialDownload = false
  disableWebInstaller = false
  netSession = { setProxy: vi.fn(async () => {}) }
  setFeedURL = vi.fn()
  checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.29', files: [] },
  }))
  downloadUpdate = vi.fn<(token?: FakeCancellationToken) => Promise<string[]>>(async () => [])
  quitAndInstall = vi.fn()
  installerPath: string | null = null
  installDirectory: string | null = null
  downloadedUpdateHelper: {
    file?: string | null
    packageFile?: string | null
    downloadedFileInfo?: { isAdminRightsRequired?: boolean } | null
  } | null = null
}

const mockState = vi.hoisted(() => ({
  appEmitter: null as EventEmitter | null,
  squirrel: null as EventEmitter | null,
  autoUpdater: null as FakeAutoUpdater | null,
  quit: vi.fn(),
  relaunch: vi.fn(),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(async () => ({
    response: 1,
  })),
  sendEvent: vi.fn(),
  broadcast: vi.fn(),
  currentWindow: null as unknown,
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const emitter = (mockState.appEmitter ??= new Emitter())
  const squirrel = (mockState.squirrel ??= new Emitter())
  const app = Object.assign(emitter, {
    name: 'Kettu',
    isPackaged: true,
    getVersion: () => '0.1.28',
    getPath: () => '/tmp/kettu-test',
    quit: (...args: unknown[]) => mockState.quit(...args),
    relaunch: (...args: unknown[]) => mockState.relaunch(...args),
    commandLine: {
      hasSwitch: () => false,
      getSwitchValue: () => '',
    },
  })
  return {
    app,
    autoUpdater: squirrel,
    BrowserWindow: {
      getAllWindows: () => [],
      getFocusedWindow: () => null,
    },
    dialog: {
      showMessageBox: (...args: unknown[]) => mockState.showMessageBox(...args),
    },
    shell: {
      openPath: vi.fn(async () => ''),
    },
  }
})

vi.mock('./auto-updater', () => ({
  loadAutoUpdater: async () => ({
    autoUpdater: mockState.autoUpdater!,
    CancellationToken: FakeCancellationToken,
    Provider: class {},
  }),
}))

vi.mock('./update-provider', () => ({
  sourcesProvider: () => class {},
}))

vi.mock('./update-http', () => ({
  guardUpdaterHttpExecutor: vi.fn(),
}))

vi.mock('./events', () => ({
  broadcast: (...args: unknown[]) => mockState.broadcast(...args),
  sendEvent: (...args: unknown[]) => mockState.sendEvent(...args),
}))

vi.mock('./window', () => ({
  currentWindow: () => mockState.currentWindow,
  hideOnClose: vi.fn(),
  hidesOnClose: () => false,
  isHiddenOnClose: () => false,
}))

vi.stubEnv('MAIN_VITE_UPDATE_MODE', 'install')
vi.stubEnv('APPIMAGE', '/tmp/Kettu.AppImage')

const { HostAdmin } = await import('./host-admin')
const { QuitFlow } = await import('./quit')
const { Updater } = await import('./updater')

const DEVICE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DEVICE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const BUSY_SESSION: BusySession = {
  sessionId: 'sess-1',
  agentId: 'codex',
  title: 'Build feature',
  turnStartedAt: 1_700_000_000_000,
  background: null,
}

const BUSY_TERMINAL: BusyTerminal = {
  id: 'term-1',
  projectPath: '/work/app',
  title: 'pnpm test',
}

function makeSettings(overrides?: Partial<SettingsFile['general']>): SettingsFile {
  return {
    ...DEFAULT_SETTINGS,
    general: {
      ...DEFAULT_SETTINGS.general,
      confirmQuitWhileRunning: true,
      ...overrides,
    },
    updates: {
      ...DEFAULT_SETTINGS.updates,
      automatic: 'notify',
    },
  }
}

function makeAppState(): AppStateStore {
  return {
    get: () => ({
      lastRunVersion: '0.1.28',
      dismissedUpdate: null,
      updateAfterMove: null,
      updateSources: null,
      notifiedUpdate: null,
      askedClients: [],
    }),
    update: vi.fn(),
  } as unknown as AppStateStore
}

function makeRemoteStatus(
  devices: { id: string; name: string }[],
  state: RemoteStatus['state'] = 'on',
): RemoteStatus {
  return {
    state,
    hostName: 'Test Host',
    systemName: 'Test-Host',
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      model: 'iPhone',
      kind: 'ios',
      platform: 'iOS 26.1',
      addedAt: 1,
      lastConnectedAt: 1,
      publicKey: 'k',
      account: null,
    })),
    online: devices.map((d) => d.id),
    plainTextKey: false,
    direct: { state: 'off' },
    relay: { state: 'off' },
    ownRelayKeyEnd: null,
    account: null,
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}

function makeFakeWindow() {
  const wc = Object.assign(new EventEmitter(), {
    id: 101,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    isCrashed: () => false,
  })
  return {
    webContents: wc,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
}

interface HarnessOptions {
  platform?: 'darwin' | 'win32' | 'linux'
  sessions?: BusySession[]
  terminals?: BusyTerminal[]
  devices?: { id: string; name: string }[]
  canUpdateDevice?: (deviceId: string) => boolean
  runWindowsInstaller?: (options: WindowsInstallOptions) => Promise<WindowsInstallResult>
  confirmQuitWhileRunning?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const events: { event: HostAdminEvent; deviceId: string | null }[] = []
  const order: string[] = []
  let busySessions = [...(options.sessions ?? [])]
  let busyTerminals = [...(options.terminals ?? [])]
  let remote = makeRemoteStatus(
    options.devices ?? [
      { id: DEVICE_A, name: 'iPhone A' },
      { id: DEVICE_B, name: 'iPhone B' },
    ],
  )
  const settings = makeSettings({
    confirmQuitWhileRunning: options.confirmQuitWhileRunning ?? true,
  })
  const captureUpdateResume = vi.fn(async () => {
    order.push('captureUpdateResume')
  })
  const clearUpdateResume = vi.fn(async () => {
    order.push('clearUpdateResume')
  })
  const shutDown = vi.fn(async () => {
    order.push('shutDown')
  })
  const onCleanExit = vi.fn(() => {
    order.push('onCleanExit')
  })
  const flushRemoteEvents = vi.fn(async () => {
    order.push('flushRemoteEvents')
  })

  const refs: {
    quit?: InstanceType<typeof QuitFlow>
    admin?: InstanceType<typeof HostAdmin>
  } = {}

  const updater = new Updater({
    appState: makeAppState(),
    settings: () => settings,
    platform: options.platform ?? 'darwin',
    requestRestart: (confirmed, resumeAfterUpdate = true, reqOptions) =>
      refs.quit!.request('update', confirmed, resumeAfterUpdate, reqOptions),
    clearUpdateResume,
    waitableSessions: async () => busySessions.filter((s) => s.turnStartedAt !== null).length,
    busyTerminals: async () => busyTerminals.length,
    requestMove: (reqOptions) => refs.quit!.request('move', false, false, reqOptions),
    respondUpdateConfirmation: (requestId, action, by) =>
      refs.quit!.respondUpdate(requestId, action, by),
    cancelPendingUpdateConfirmation: (requestId, code) =>
      refs.quit!.cancelPendingUpdate(requestId, code),
    flushRemoteEvents,
    runWindowsInstaller: options.runWindowsInstaller,
    changed: (status) => {
      refs.admin?.updatesChanged(status)
    },
  })

  const quit = new QuitFlow({
    settings: () => settings,
    busySessions: async () => busySessions,
    busyTerminals: async () => busyTerminals,
    captureUpdateResume,
    clearUpdateResume,
    shutDown,
    onCleanExit,
    installUpdate: async () => {
      order.push('installUpdate')
      await updater.installNow()
    },
    moveApp: () => updater.moveNow(),
    restartWhenIdle: (initiator, requestId, busy) => {
      void updater.restartWhenIdle(initiator, requestId, busy)
    },
    updateVersion: () => updater.targetVersion(),
    onUpdateConfirmation: (confirmation) => updater.handleUpdateConfirmation(confirmation),
    onUpdateCancelled: (info) => updater.handleUpdateCancelled(info),
    onUpdateRestarting: (info) => updater.prepareRestartForInstall(info),
  })
  refs.quit = quit

  const admin = new HostAdmin({
    settings: { get: () => settings, update: vi.fn() } as never,
    agentFolders: {} as never,
    platform: options.platform ?? 'darwin',
    remote: {
      pendingDiscovery: () => null,
      closePairing: vi.fn(),
    } as never,
    remoteStatus: () => remote,
    info: async () => ({}) as never,
    restart: vi.fn(),
    sharing: null,
    updates: updater,
    canUpdateDevice: options.canUpdateDevice,
    themes: {} as never,
    marketKeys: {} as never,
    thumbnail: null,
    png: null,
    send: (event, deviceId) => {
      events.push({ event, deviceId })
    },
  })
  refs.admin = admin

  const updateEvents = (): UpdateStatus[] =>
    events
      .filter((entry) => entry.event.type === 'updates.changed')
      .map((entry) => (entry.event as Extract<HostAdminEvent, { type: 'updates.changed' }>).status)

  return {
    updater,
    quit,
    admin,
    events,
    updateEvents,
    order,
    captureUpdateResume,
    clearUpdateResume,
    shutDown,
    onCleanExit,
    flushRemoteEvents,
    setBusySessions: (next: BusySession[]) => {
      busySessions = next
    },
    setBusyTerminals: (next: BusyTerminal[]) => {
      busyTerminals = next
    },
    setRemoteStatus: (next: RemoteStatus) => {
      remote = next
      admin.remoteChanged(next)
    },
  }
}

async function makeUpdateReady(updater: InstanceType<typeof Updater>, version = '0.1.29') {
  await updater.check()
  mockState.autoUpdater!.emit('update-downloaded', { version, releaseNotes: null })
  mockState.squirrel?.emit('update-downloaded')
  await flushMicrotasks()
}

describe('Remote update lifecycle & authorization flow (#2786)', () => {
  beforeEach(() => {
    mockState.appEmitter?.removeAllListeners()
    mockState.squirrel?.removeAllListeners()
    mockState.autoUpdater = new FakeAutoUpdater()
    mockState.quit.mockReset()
    mockState.relaunch.mockReset()
    mockState.showMessageBox.mockReset()
    mockState.showMessageBox.mockResolvedValue({ response: 1 })
    mockState.sendEvent.mockReset()
    mockState.broadcast.mockReset()
    mockState.currentWindow = null
  })

  it('returns immediate accepted/downloading status from updates.download without racing updateWaiters, then syncs progress and confirmation', async () => {
    const h = createHarness({ sessions: [BUSY_SESSION] })
    await h.updater.check()
    mockState.autoUpdater!.emit('update-available', { version: '0.1.29', files: [] })

    let resolveDownload!: () => void
    mockState.autoUpdater!.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveDownload = () => resolve([])
        }),
    )

    const answer = await h.admin.answer(DEVICE_A, 'updates.download', undefined)
    expect('result' in answer).toBe(true)
    const status = (answer as { result: UpdateStatus }).result
    expect(status.state).toMatchObject({ kind: 'downloading', version: '0.1.29', manual: true })
    expect(status.phase).toBe('downloading')
    expect(status.progress).toBe(0)
    expect(status.requestId).toBeTruthy()
    expect(status.initiator).toEqual({
      kind: 'remote',
      deviceId: DEVICE_A,
      deviceName: 'iPhone A',
    })
    // Accepted was broadcast before download-started transitioned to downloading.
    expect(h.updateEvents().map((s) => s.phase)).toContain('accepted')

    mockState.autoUpdater!.emit('download-progress', { percent: 45 })
    expect(h.updater.getStatus().progress).toBe(45)

    // Download completes -> automatically initiates restart -> enters awaiting_confirmation for DEVICE_A.
    mockState.autoUpdater!.emit('update-downloaded', { version: '0.1.29', releaseNotes: null })
    mockState.squirrel?.emit('update-downloaded')
    resolveDownload()
    await flushMicrotasks()

    const pending = h.updater.getStatus()
    expect(pending.phase).toBe('awaiting_confirmation')
    expect(pending.confirmation).toMatchObject({
      requestId: status.requestId,
      version: '0.1.29',
      initiator: { kind: 'remote', deviceId: DEVICE_A, deviceName: 'iPhone A' },
      busy: { sessions: 1, waitableSessions: 1, terminals: 0, unsavedFiles: 0 },
      choices: ['now', 'whenIdle', 'cancel'],
    })
    // Must not block on a native Electron dialog when triggered remotely with no window.
    expect(mockState.showMessageBox).not.toHaveBeenCalled()
  })

  it('records failed and cancelled outcomes cleanly during download', async () => {
    const h = createHarness()
    await h.updater.check()
    mockState.autoUpdater!.emit('update-available', { version: '0.1.29', files: [] })

    mockState.autoUpdater!.downloadUpdate.mockRejectedValueOnce(new Error('network timeout'))
    const started = await h.admin.answer(DEVICE_A, 'updates.download', undefined)
    expect('result' in started).toBe(true)
    await flushMicrotasks()

    const failed = h.updater.getStatus()
    expect(failed.phase).toBe('failed')
    expect(failed.outcome).toMatchObject({
      kind: 'failed',
      code: 'download_failed',
      message: 'network timeout',
    })

    // Re-offer and cancel via updates.cancel.
    mockState.autoUpdater!.emit('update-available', { version: '0.1.29', files: [] })
    mockState.autoUpdater!.downloadUpdate.mockImplementationOnce(
      (token?: FakeCancellationToken) =>
        new Promise<string[]>((_, reject) => {
          token?.once('cancel', () => reject(new Error('cancelled')))
        }),
    )
    await h.admin.answer(DEVICE_A, 'updates.download', undefined)
    const cancelledAnswer = await h.admin.answer(DEVICE_A, 'updates.cancel', undefined)
    expect('result' in cancelledAnswer).toBe(true)
    await flushMicrotasks()

    const cancelled = h.updater.getStatus()
    expect(cancelled.state).toMatchObject({ kind: 'available', version: '0.1.29' })
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.outcome).toMatchObject({
      kind: 'cancelled',
      code: 'user_cancelled',
      by: 'remote',
    })
  })

  it('enforces strict initiator, requestId, and permission checks on updates.confirm', async () => {
    let deviceAAllowed = true
    const h = createHarness({
      sessions: [BUSY_SESSION],
      canUpdateDevice: (id) => (id === DEVICE_A ? deviceAAllowed : true),
    })
    await makeUpdateReady(h.updater)

    const restartAnswer = await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    expect('result' in restartAnswer).toBe(true)
    expect((restartAnswer as { result: UpdateStatus }).result.phase).toBe('accepted')
    await flushMicrotasks()

    const awaiting = h.updater.getStatus()
    expect(awaiting.phase).toBe('awaiting_confirmation')
    const requestId = awaiting.confirmation!.requestId

    // 1. Different paired device is rejected with forbidden.
    const wrongCaller = await h.admin.answer(DEVICE_B, 'updates.confirm', {
      requestId,
      action: 'now',
    })
    expect(wrongCaller).toEqual({
      error: {
        code: 'forbidden',
        message: expect.any(String),
      },
    })
    // Wrong caller cannot cancel via updates.cancel either.
    const wrongCancel = await h.admin.answer(DEVICE_B, 'updates.cancel', undefined)
    expect(wrongCancel).toEqual({
      error: {
        code: 'forbidden',
        message: expect.any(String),
      },
    })

    // 2. Wrong / stale requestId is rejected with conflict.
    const stale = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId: 'stale-request-id',
      action: 'now',
    })
    expect(stale).toEqual({
      error: {
        code: 'conflict',
        message: expect.any(String),
      },
    })

    // 3. Invalid action is rejected with invalid_params.
    const badAction = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId,
      action: 'later',
    })
    expect(badAction).toEqual({
      error: {
        code: 'invalid_params',
        message: expect.any(String),
      },
    })

    // 4. Revoked update permission rejects the initiating device with forbidden.
    deviceAAllowed = false
    const revoked = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId,
      action: 'now',
    })
    expect(revoked).toEqual({
      error: {
        code: 'forbidden',
        message: expect.any(String),
      },
    })
    expect(h.updater.getStatus().phase).toBe('awaiting_confirmation')

    // 5. Restoring permission lets DEVICE_A confirm "now" and triggers #2802 captureUpdateResume.
    deviceAAllowed = true
    const confirmed = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId,
      action: 'now',
    })
    expect('result' in confirmed).toBe(true)
    await flushMicrotasks()

    expect(h.captureUpdateResume).toHaveBeenCalledTimes(1)
    expect(h.flushRemoteEvents).toHaveBeenCalledTimes(1)
    expect(h.shutDown).toHaveBeenCalledTimes(1)
    expect(mockState.autoUpdater!.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(h.order).toEqual([
      'captureUpdateResume',
      'flushRemoteEvents',
      'shutDown',
      'onCleanExit',
      'installUpdate',
    ])
    expect(h.updateEvents().some((s) => s.phase === 'restarting')).toBe(true)

    // 6. Re-submitting the already-resolved requestId fails cleanly with conflict.
    const replay = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId,
      action: 'now',
    })
    expect(replay).toEqual({
      error: {
        code: 'conflict',
        message: expect.any(String),
      },
    })
  })

  it('cancels pending remote confirmation and dismisses the desktop dialog when the initiating device is removed', async () => {
    const win = makeFakeWindow()
    mockState.currentWindow = win
    const h = createHarness({ sessions: [BUSY_SESSION] })
    await makeUpdateReady(h.updater)

    await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    await flushMicrotasks()
    expect(h.updater.getStatus().phase).toBe('awaiting_confirmation')
    expect(mockState.sendEvent).toHaveBeenCalledWith(
      win.webContents,
      'app:confirm-quit',
      expect.objectContaining({ reason: 'update' }),
    )
    const promptId = (mockState.sendEvent.mock.calls[0]![2] as { id: number }).id

    // Host removes DEVICE_A -> pending confirmation is cancelled and desktop prompt dismissed.
    h.setRemoteStatus(makeRemoteStatus([{ id: DEVICE_B, name: 'iPhone B' }]))
    await flushMicrotasks()

    expect(mockState.sendEvent).toHaveBeenCalledWith(
      win.webContents,
      'app:confirm-quit-resolved',
      promptId,
    )
    const status = h.updater.getStatus()
    expect(status.phase).toBe('cancelled')
    expect(status.confirmation).toBeNull()
    expect(status.outcome).toMatchObject({
      kind: 'cancelled',
      code: 'permission_revoked',
      by: 'host',
    })

    // Removed device attempting to confirm gets forbidden.
    const denied = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId: 'anything',
      action: 'now',
    })
    expect(denied).toEqual({
      error: {
        code: 'forbidden',
        message: expect.any(String),
      },
    })
  })

  it('synchronizes resolution when the desktop user answers while a remote confirmation is pending, and vice versa', async () => {
    const win = makeFakeWindow()
    mockState.currentWindow = win
    const h = createHarness({ sessions: [BUSY_SESSION] })
    await makeUpdateReady(h.updater)

    // Case 1: Desktop user cancels a remotely initiated confirmation.
    await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    await flushMicrotasks()
    const prompt1 = mockState.sendEvent.mock.calls[0]![2] as { id: number }
    const req1 = h.updater.getStatus().confirmation!.requestId

    h.quit.respond(prompt1.id, false)
    await flushMicrotasks()

    const afterDesktopCancel = h.updater.getStatus()
    expect(afterDesktopCancel.phase).toBe('cancelled')
    expect(afterDesktopCancel.confirmation).toBeNull()
    expect(afterDesktopCancel.outcome).toMatchObject({
      kind: 'cancelled',
      code: 'user_cancelled',
      by: 'local',
      requestId: req1,
    })

    // Case 2: Remote user cancels, which dismisses the open desktop confirmation dialog.
    mockState.sendEvent.mockClear()
    await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    await flushMicrotasks()
    const prompt2 = mockState.sendEvent.mock.calls[0]![2] as { id: number }
    const req2 = h.updater.getStatus().confirmation!.requestId

    const cancelResp = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId: req2,
      action: 'cancel',
    })
    expect('result' in cancelResp).toBe(true)
    await flushMicrotasks()

    expect(mockState.sendEvent).toHaveBeenCalledWith(
      win.webContents,
      'app:confirm-quit-resolved',
      prompt2.id,
    )
    expect(h.updater.getStatus().phase).toBe('cancelled')
    expect(h.updater.getStatus().outcome).toMatchObject({
      kind: 'cancelled',
      code: 'user_cancelled',
      by: 'remote',
      requestId: req2,
    })
  })

  it('forbids remote devices from confirming a locally initiated desktop update', async () => {
    const win = makeFakeWindow()
    mockState.currentWindow = win
    const h = createHarness({ sessions: [BUSY_SESSION] })
    await makeUpdateReady(h.updater)

    h.updater.restart()
    await flushMicrotasks()

    const pending = h.updater.getStatus()
    expect(pending.phase).toBe('awaiting_confirmation')
    expect(pending.confirmation!.initiator).toEqual({
      kind: 'local',
      deviceId: null,
      deviceName: null,
    })

    const attempt = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId: pending.confirmation!.requestId,
      action: 'now',
    })
    expect(attempt).toEqual({
      error: {
        code: 'forbidden',
        message: expect.any(String),
      },
    })
  })

  it('supports whenIdle for busy terminals and sessions, restarts when both go idle, and allows cancelling while waiting', async () => {
    vi.useFakeTimers()
    try {
      const h = createHarness({ sessions: [], terminals: [BUSY_TERMINAL] })
      await makeUpdateReady(h.updater)

      await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
      await flushMicrotasks()

      const pending = h.updater.getStatus()
      expect(pending.phase).toBe('awaiting_confirmation')
      expect(pending.confirmation!.busy).toEqual({
        sessions: 0,
        waitableSessions: 0,
        terminals: 1,
        unsavedFiles: 0,
      })
      expect(pending.confirmation!.choices).toEqual(['now', 'whenIdle', 'cancel'])

      // Choose whenIdle from initiating device.
      const waitResp = await h.admin.answer(DEVICE_A, 'updates.confirm', {
        requestId: pending.confirmation!.requestId,
        action: 'whenIdle',
      })
      expect('result' in waitResp).toBe(true)
      await flushMicrotasks()

      expect(h.updater.getStatus().phase).toBe('waiting_for_idle')
      expect(h.updater.getStatus().restartWhenIdle).toEqual({ sessions: 0, terminals: 1 })

      // Another device cannot cancel DEVICE_A's wait.
      const wrongCancel = await h.admin.answer(DEVICE_B, 'updates.cancel', undefined)
      expect(wrongCancel).toEqual({
        error: { code: 'forbidden', message: expect.any(String) },
      })

      // DEVICE_A can cancel while waiting for idle.
      const cancelled = await h.admin.answer(DEVICE_A, 'updates.cancel', undefined)
      expect('result' in cancelled).toBe(true)
      expect(h.updater.getStatus().phase).toBe('cancelled')
      expect(h.updater.getStatus().restartWhenIdle).toBeNull()
      expect(h.updater.getStatus().state.kind).toBe('ready')

      // Restart again and let the busy terminal finish naturally.
      await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
      await flushMicrotasks()
      const req2 = h.updater.getStatus().confirmation!.requestId
      await h.admin.answer(DEVICE_A, 'updates.confirm', { requestId: req2, action: 'whenIdle' })
      await flushMicrotasks()

      // Still busy after one poll -> does not restart.
      await vi.advanceTimersByTimeAsync(3_100)
      expect(h.shutDown).not.toHaveBeenCalled()

      // Terminal finishes -> restarts after two consecutive idle polls, without update-resume.
      h.setBusyTerminals([])
      await vi.advanceTimersByTimeAsync(6_500)
      await flushMicrotasks()

      expect(h.captureUpdateResume).not.toHaveBeenCalled()
      expect(h.shutDown).toHaveBeenCalledTimes(1)
      expect(mockState.autoUpdater!.quitAndInstall).toHaveBeenCalledWith(true, true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects whenIdle when unsaved desktop files exist and only exposes now/cancel choices', async () => {
    const win = makeFakeWindow()
    mockState.currentWindow = win
    const h = createHarness({ sessions: [BUSY_SESSION] })
    h.quit.setUnsaved(win.webContents as never, [{ projectPath: '/work', path: '/work/a.ts' }])
    await makeUpdateReady(h.updater)

    await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    await flushMicrotasks()

    const confirmation = h.updater.getStatus().confirmation!
    expect(confirmation.busy.unsavedFiles).toBe(1)
    expect(confirmation.choices).toEqual(['now', 'cancel'])

    const rejected = await h.admin.answer(DEVICE_A, 'updates.confirm', {
      requestId: confirmation.requestId,
      action: 'whenIdle',
    })
    expect(rejected).toEqual({
      error: {
        code: 'invalid_params',
        message: expect.any(String),
      },
    })
  })

  it('reports Windows host system confirmation before UAC and syncs cancellation without shutting down the host', async () => {
    let finishUac!: (result: WindowsInstallResult) => void
    const runWindowsInstaller = vi.fn(async (opts: WindowsInstallOptions) => {
      await opts.onAwaitingHostConfirmation?.()
      return new Promise<WindowsInstallResult>((resolve) => {
        finishUac = resolve
      })
    })
    const h = createHarness({
      platform: 'win32',
      confirmQuitWhileRunning: false,
      runWindowsInstaller,
    })
    await makeUpdateReady(h.updater)
    mockState.autoUpdater!.installerPath =
      'C:\\Users\\me\\AppData\\Local\\kettu-updater\\pending\\Kettu-0.1.29-x64-setup.exe'
    mockState.autoUpdater!.downloadedUpdateHelper = {
      file: mockState.autoUpdater!.installerPath,
      downloadedFileInfo: { isAdminRightsRequired: true },
    }

    await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    await flushMicrotasks()

    // While waiting on Windows UAC, remote clients see awaiting_host_confirmation and host stays online.
    const awaiting = h.updater.getStatus()
    expect(awaiting.phase).toBe('awaiting_host_confirmation')
    expect(awaiting.hostConfirmation).toMatchObject({
      platform: 'win32',
      kind: 'windows_system',
      version: '0.1.29',
      initiator: { kind: 'remote', deviceId: DEVICE_A, deviceName: 'iPhone A' },
    })
    expect(h.flushRemoteEvents).toHaveBeenCalledTimes(1)
    expect(h.shutDown).not.toHaveBeenCalled()

    // User clicks "No" on Windows UAC -> cancelled outcome synced while host stays running.
    finishUac({
      kind: 'cancelled',
      code: 'host_confirmation_cancelled',
      exitCode: 1223,
      message: 'Windows system confirmation was cancelled on the host',
    })
    await flushMicrotasks()

    const cancelled = h.updater.getStatus()
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.hostConfirmation).toBeNull()
    expect(cancelled.outcome).toMatchObject({
      kind: 'cancelled',
      code: 'host_confirmation_cancelled',
      by: 'host',
    })
    expect(cancelled.state.kind).toBe('ready')
    expect(h.clearUpdateResume).toHaveBeenCalledTimes(1)
    expect(h.shutDown).not.toHaveBeenCalled()
    expect(mockState.quit).not.toHaveBeenCalled()
  })

  it('syncs Windows host system confirmation approval into restarting and exits cleanly without double-launching installer', async () => {
    const runWindowsInstaller = vi.fn(
      async (opts: WindowsInstallOptions): Promise<WindowsInstallResult> => {
        await opts.onAwaitingHostConfirmation?.()
        return { kind: 'launched', elevated: true }
      },
    )
    const h = createHarness({
      platform: 'win32',
      confirmQuitWhileRunning: false,
      runWindowsInstaller,
    })
    await makeUpdateReady(h.updater)
    mockState.autoUpdater!.installerPath = 'C:\\Temp\\Kettu-0.1.29-x64-setup.exe'
    mockState.autoUpdater!.downloadedUpdateHelper = {
      file: mockState.autoUpdater!.installerPath,
      downloadedFileInfo: { isAdminRightsRequired: true },
    }

    await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    await flushMicrotasks()

    const phases = h.updateEvents().map((s) => s.phase)
    expect(phases).toContain('accepted')
    expect(phases).toContain('awaiting_host_confirmation')
    expect(phases).toContain('restarting')
    expect(mockState.autoUpdater!.autoInstallOnAppQuit).toBe(false)
    expect(h.shutDown).toHaveBeenCalledTimes(1)
    expect(h.onCleanExit).toHaveBeenCalledTimes(1)
    expect(mockState.quit).toHaveBeenCalledTimes(1)
    // Because Windows installer was already launched via elevation, quitAndInstall must not run a second time.
    expect(mockState.autoUpdater!.quitAndInstall).not.toHaveBeenCalled()
  })

  it('syncs Windows host system confirmation failure without shutting down the host', async () => {
    const runWindowsInstaller = vi.fn(
      async (opts: WindowsInstallOptions): Promise<WindowsInstallResult> => {
        await opts.onAwaitingHostConfirmation?.()
        return {
          kind: 'failed',
          code: 'host_confirmation_failed',
          exitCode: 5,
          message: 'Windows installer elevation exited with code 5',
        }
      },
    )
    const h = createHarness({
      platform: 'win32',
      confirmQuitWhileRunning: false,
      runWindowsInstaller,
    })
    await makeUpdateReady(h.updater)
    mockState.autoUpdater!.installerPath = 'C:\\Temp\\Kettu-0.1.29-x64-setup.exe'

    await h.admin.answer(DEVICE_A, 'updates.restart', undefined)
    await flushMicrotasks()

    const failed = h.updater.getStatus()
    expect(failed.phase).toBe('failed')
    expect(failed.hostConfirmation).toBeNull()
    expect(failed.outcome).toMatchObject({
      kind: 'failed',
      code: 'host_confirmation_failed',
      message: 'Windows installer elevation exited with code 5',
      by: 'host',
    })
    expect(h.clearUpdateResume).toHaveBeenCalledTimes(1)
    expect(h.shutDown).not.toHaveBeenCalled()
    expect(mockState.quit).not.toHaveBeenCalled()
  })
})
