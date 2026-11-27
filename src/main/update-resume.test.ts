import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import {
  isFreshUpdateResume,
  parseUpdateResumeFile,
  UPDATE_RESUME_MAX_AGE_MS,
} from '@shared/update-resume'

class FakeAutoUpdater {
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
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
    isUpdateAvailable: false,
    updateInfo: { version: '0.1.29', files: [] },
  }))
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(
      event,
      list.filter((fn) => fn !== listener),
    )
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

const state = vi.hoisted(() => ({
  appEmitter: null as EventEmitter | null,
  squirrel: null as EventEmitter | null,
  autoUpdater: null as FakeAutoUpdater | null,
  quit: vi.fn(),
  relaunch: vi.fn(),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(async () => ({
    response: 1,
  })),
  sendEvent: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const emitter = (state.appEmitter ??= new Emitter())
  const squirrel = (state.squirrel ??= new Emitter())
  const app = Object.assign(emitter, {
    name: 'Kettu',
    isPackaged: true,
    getVersion: () => '0.1.28',
    getPath: () => '/tmp/kettu-test',
    quit: (...args: unknown[]) => state.quit(...args),
    relaunch: (...args: unknown[]) => state.relaunch(...args),
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
      showMessageBox: (...args: unknown[]) => state.showMessageBox(...args),
    },
    shell: {
      openPath: vi.fn(async () => ''),
    },
  }
})

vi.mock('./auto-updater', () => ({
  loadAutoUpdater: async () => ({
    autoUpdater: state.autoUpdater!,
    CancellationToken: class {},
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
  broadcast: vi.fn(),
  sendEvent: (...args: unknown[]) => state.sendEvent(...args),
}))

vi.mock('./window', () => ({
  currentWindow: () => null,
  hideOnClose: vi.fn(),
  hidesOnClose: () => false,
  isHiddenOnClose: () => false,
}))

vi.stubEnv('MAIN_VITE_UPDATE_MODE', 'install')
vi.stubEnv('APPIMAGE', '/tmp/Kettu.AppImage')

const { clearUpdateResume, saveUpdateResume, updateResumePath } = await import('./update-resume')
const { QuitFlow } = await import('./quit')
const { Updater } = await import('./updater')
import type { AppStateStore } from './app-state'

function makeSettings(overrides?: Partial<SettingsFile['general']>): SettingsFile {
  return {
    ...DEFAULT_SETTINGS,
    general: {
      ...DEFAULT_SETTINGS.general,
      ...overrides,
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

const BUSY_SESSION = {
  sessionId: 's1',
  agentId: 'codex' as const,
  title: 'Working',
  turnStartedAt: 1,
  background: null,
}

describe('update-resume manifest storage', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function makeDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kettu-update-resume-'))
    dirs.push(dir)
    return dir
  }

  it('writes normalized deduplicated sessions atomically and clears when empty', async () => {
    const dir = await makeDir()
    const now = Date.UTC(2026, 10, 27, 12, 0, 0)
    const saved = await saveUpdateResume(dir, {
      fromVersion: '0.1.28',
      now,
      sessions: [
        { sessionId: 's1', waitingForUser: false },
        { sessionId: 's2', waitingForUser: false },
        { sessionId: 's2', waitingForUser: true },
      ],
    })
    expect(saved).toBe(true)
    const raw = JSON.parse(await readFile(updateResumePath(dir), 'utf8')) as unknown
    const parsed = parseUpdateResumeFile(raw)
    expect(parsed).toEqual({
      version: 1,
      createdAt: now,
      fromVersion: '0.1.28',
      sessions: [
        { sessionId: 's1', waitingForUser: false },
        { sessionId: 's2', waitingForUser: true },
      ],
    })
    expect(isFreshUpdateResume(parsed!, now + UPDATE_RESUME_MAX_AGE_MS)).toBe(true)
    expect(isFreshUpdateResume(parsed!, now + UPDATE_RESUME_MAX_AGE_MS + 1)).toBe(false)

    // Saving an empty list removes any previously staged manifest.
    const savedEmpty = await saveUpdateResume(dir, { fromVersion: '0.1.28', sessions: [] })
    expect(savedEmpty).toBe(false)
    expect(await exists(updateResumePath(dir))).toBe(false)
  })

  it('clearUpdateResume removes an existing file and ignores missing files', async () => {
    const dir = await makeDir()
    await saveUpdateResume(dir, {
      fromVersion: '0.1.28',
      sessions: [{ sessionId: 's1', waitingForUser: false }],
    })
    expect(await exists(updateResumePath(dir))).toBe(true)

    await clearUpdateResume(dir)
    expect(await exists(updateResumePath(dir))).toBe(false)

    // Calling again on a missing file succeeds silently.
    await expect(clearUpdateResume(dir)).resolves.toBeUndefined()
  })
})

describe('QuitFlow and Updater update-resume gating', () => {
  beforeEach(() => {
    state.appEmitter?.removeAllListeners()
    state.squirrel?.removeAllListeners()
    state.autoUpdater = new FakeAutoUpdater()
    state.quit.mockReset()
    state.relaunch.mockReset()
    state.showMessageBox.mockReset()
    state.sendEvent.mockReset()
  })

  it('captures update resume sessions before shutDown on immediate update restart', async () => {
    const order: string[] = []
    const captureUpdateResume = vi.fn(async () => {
      order.push('captureUpdateResume')
    })
    const clearUpdateResume = vi.fn(async () => {
      order.push('clearUpdateResume')
    })
    const flow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: false }),
      busySessions: async () => [],
      busyTerminals: async () => [],
      captureUpdateResume,
      clearUpdateResume,
      shutDown: async () => {
        order.push('shutDown')
      },
      onCleanExit: () => {
        order.push('onCleanExit')
      },
      installUpdate: async () => {
        order.push('installUpdate')
      },
      moveApp: async () => false,
      restartWhenIdle: vi.fn(),
    })

    expect(flow.request('update', true, true)).toBe(true)
    await flushMicrotasks()

    expect(captureUpdateResume).toHaveBeenCalledTimes(1)
    expect(clearUpdateResume).not.toHaveBeenCalled()
    expect(order).toEqual(['captureUpdateResume', 'shutDown', 'onCleanExit', 'installUpdate'])
  })

  it('does not capture update resume sessions on normal quit, restart, wait-for-idle, or cancel', async () => {
    const captureUpdateResume = vi.fn(async () => {})
    const clearUpdateResume = vi.fn(async () => {})
    const restartWhenIdle = vi.fn()

    // 1. User cancels update restart dialog.
    state.showMessageBox.mockResolvedValue({ response: 0 })
    const cancelFlow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: true }),
      busySessions: async () => [BUSY_SESSION],
      busyTerminals: async () => [],
      captureUpdateResume,
      clearUpdateResume,
      shutDown: vi.fn(async () => {}),
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle,
    })
    cancelFlow.request('update', false, true)
    await flushMicrotasks()
    expect(captureUpdateResume).not.toHaveBeenCalled()

    // 2. User chooses "Restart when they finish" in the update confirm dialog.
    state.showMessageBox.mockResolvedValue({ response: 2 })
    const waitFlow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: true }),
      busySessions: async () => [BUSY_SESSION],
      busyTerminals: async () => [],
      captureUpdateResume,
      clearUpdateResume,
      shutDown: vi.fn(async () => {}),
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle,
    })
    waitFlow.request('update', false, true)
    await flushMicrotasks()
    expect(restartWhenIdle).toHaveBeenCalledTimes(1)
    expect(captureUpdateResume).not.toHaveBeenCalled()

    // 3. Wait-for-idle restart (resumeAfterUpdate = false) clears rather than captures.
    const idleUpdateFlow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: false }),
      busySessions: async () => [],
      busyTerminals: async () => [],
      captureUpdateResume,
      clearUpdateResume,
      shutDown: async () => {},
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle,
    })
    idleUpdateFlow.request('update', true, false)
    await flushMicrotasks()
    expect(captureUpdateResume).not.toHaveBeenCalled()
    expect(clearUpdateResume).toHaveBeenCalledTimes(1)

    // 4. Normal quit clears rather than captures.
    clearUpdateResume.mockClear()
    const quitFlow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: false }),
      busySessions: async () => [],
      busyTerminals: async () => [],
      captureUpdateResume,
      clearUpdateResume,
      shutDown: async () => {},
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle,
    })
    quitFlow.request('quit')
    await flushMicrotasks()
    expect(captureUpdateResume).not.toHaveBeenCalled()
    expect(clearUpdateResume).toHaveBeenCalledTimes(1)
  })

  it('clears the staged manifest when installUpdate fails', async () => {
    const captureUpdateResume = vi.fn(async () => {})
    const clearUpdateResume = vi.fn(async () => {})
    const flow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: false }),
      busySessions: async () => [],
      busyTerminals: async () => [],
      captureUpdateResume,
      clearUpdateResume,
      shutDown: async () => {},
      installUpdate: async () => {
        throw new Error('installer failed')
      },
      moveApp: async () => false,
      restartWhenIdle: vi.fn(),
    })

    flow.request('update', true, true)
    await flushMicrotasks()

    expect(captureUpdateResume).toHaveBeenCalledTimes(1)
    expect(clearUpdateResume).toHaveBeenCalled()
    expect(state.quit).toHaveBeenCalledTimes(1)
  })

  it('clears the staged manifest if installUpdate hangs until the fallback quit fires', async () => {
    vi.useFakeTimers()
    try {
      const captureUpdateResume = vi.fn(async () => {})
      const clearUpdateResume = vi.fn(async () => {})
      const flow = new QuitFlow({
        settings: () => makeSettings({ confirmQuitWhileRunning: false }),
        busySessions: async () => [],
        busyTerminals: async () => [],
        captureUpdateResume,
        clearUpdateResume,
        shutDown: async () => {},
        installUpdate: async () => {},
        moveApp: async () => false,
        restartWhenIdle: vi.fn(),
      })

      flow.request('update', true, true)
      await flushMicrotasks()
      expect(captureUpdateResume).toHaveBeenCalledTimes(1)
      expect(clearUpdateResume).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_500)
      expect(clearUpdateResume).toHaveBeenCalledTimes(1)
      expect(state.quit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Updater passes resumeAfterUpdate=true for immediate restarts, false for wait-for-idle, and clears on shutdown/error', async () => {
    vi.useFakeTimers()
    try {
      const requestRestart = vi.fn(() => true)
      const clearUpdateResume = vi.fn(async () => {})
      const updater = new Updater({
        appState: makeAppState(),
        settings: () => DEFAULT_SETTINGS,
        requestRestart,
        clearUpdateResume,
        waitableSessions: async () => 0,
        requestMove: vi.fn(),
      })

      await updater.check()
      state.autoUpdater!.emit('update-downloaded', { version: '0.1.29', releaseNotes: null })
      // On macOS, Squirrel.Mac emits update-downloaded once the package finishes preparing.
      state.squirrel?.emit('update-downloaded')

      updater.restart()
      expect(requestRestart).toHaveBeenLastCalledWith(false, true)

      updater.restartConfirmed()
      expect(requestRestart).toHaveBeenLastCalledWith(true, true)

      // Wait-for-idle requires two consecutive idle polls, then restarts with resumeAfterUpdate=false.
      requestRestart.mockClear()
      await updater.restartWhenIdle()
      await vi.advanceTimersByTimeAsync(3_500)
      expect(requestRestart).toHaveBeenCalledWith(true, false)

      // If quitAndInstall throws, clearUpdateResume cleans up the staged file.
      state.autoUpdater!.quitAndInstall.mockImplementationOnce(() => {
        throw new Error('boom')
      })
      await expect(updater.installNow()).rejects.toThrow('boom')
      expect(clearUpdateResume).toHaveBeenCalledTimes(1)

      // During system shutdown, installNow skips quitAndInstall and clears the staged file.
      clearUpdateResume.mockClear()
      updater.systemShutdown()
      await updater.installNow()
      expect(clearUpdateResume).toHaveBeenCalledTimes(1)
      expect(state.quit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
