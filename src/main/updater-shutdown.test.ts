import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { AppStateStore } from './app-state'

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
    isUpdateAvailable: false,
    updateInfo: { version: '0.1.28', files: [] },
  }))
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()
}

const state = vi.hoisted(() => ({
  autoUpdater: null as FakeAutoUpdater | null,
  quit: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    app: {
      isPackaged: true,
      getVersion: () => '0.1.28',
      getPath: () => '/tmp/kettu-test',
      quit: (...args: unknown[]) => state.quit(...args),
      commandLine: {
        hasSwitch: () => false,
        getSwitchValue: () => '',
      },
    },
    autoUpdater: new Emitter(),
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
}))

vi.stubEnv('MAIN_VITE_UPDATE_MODE', 'install')
// Linux runners require APPIMAGE so offReason() does not turn updates off before load().
vi.stubEnv('APPIMAGE', '/tmp/Kettu.AppImage')

const { Updater } = await import('./updater')
const { prepareRelaunch } = await import('./debug-mode')

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

describe('Updater shutdown guards and relaunch arguments', () => {
  beforeEach(() => {
    state.autoUpdater = new FakeAutoUpdater()
    state.quit.mockReset()
  })

  it('disables web installer and synchronously turns off autoInstallOnAppQuit on systemShutdown', async () => {
    const updater = new Updater({
      appState: makeAppState(),
      settings: () => DEFAULT_SETTINGS,
      requestRestart: () => true,
      waitableSessions: async () => 0,
      requestMove: vi.fn(),
    })

    await updater.check()
    expect(state.autoUpdater!.disableWebInstaller).toBe(true)
    expect(state.autoUpdater!.autoInstallOnAppQuit).toBe(true)

    // Must flip synchronously before any microtask so Electron quit handlers see false immediately.
    updater.systemShutdown()
    expect(state.autoUpdater!.autoInstallOnAppQuit).toBe(false)
  })

  it('skips quitAndInstall and quits cleanly if installNow runs during system shutdown', async () => {
    const updater = new Updater({
      appState: makeAppState(),
      settings: () => DEFAULT_SETTINGS,
      requestRestart: () => true,
      waitableSessions: async () => 0,
      requestMove: vi.fn(),
    })

    updater.systemShutdown()
    await updater.installNow()

    expect(state.autoUpdater!.quitAndInstall).not.toHaveBeenCalled()
    expect(state.quit).toHaveBeenCalledTimes(1)
  })

  it('strips --updated from relaunch arguments so normal restarts do not inherit an update launch flag', () => {
    const originalArgv = process.argv
    try {
      process.argv = ['Kettu.exe', '--updated', '--foo=bar']
      expect(prepareRelaunch(false)).toEqual({ args: ['--foo=bar'] })
      expect(prepareRelaunch(true)).toEqual({ args: ['--foo=bar', '--debug'] })
    } finally {
      process.argv = originalArgv
    }
  })
})
