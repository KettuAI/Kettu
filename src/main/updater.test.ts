import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import type { AppState, AppStateStore } from './app-state'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1', isPackaged: true } }))
vi.mock('./events', () => ({ broadcast: vi.fn() }))
const autoUpdater = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('./auto-updater', () => ({ loadAutoUpdater: autoUpdater.load }))

const { Updater } = await import('./updater')

/** Like builder-util-runtime's: a handler added after the cancel runs at once. */
class FakeToken {
  cancelled = false
  private readonly handlers: (() => void)[] = []
  cancel(): void {
    this.cancelled = true
    for (const handler of this.handlers) handler()
  }
  onCancel(handler: () => void): void {
    if (this.cancelled) handler()
    else this.handlers.push(handler)
  }
}

/** Fires events in electron-updater 6.8's order; one download runs at a time. */
class FakeAutoUpdater extends EventEmitter {
  logger: unknown = null
  allowPrerelease = true
  allowDowngrade = true
  autoDownload = true
  autoInstallOnAppQuit = true
  disableDifferentialDownload = false
  netSession = { setProxy: () => Promise.resolve() }
  downloads = 0
  private quitHandlerAdded = false
  private finish: (() => void) | null = null

  checkForUpdates(): Promise<unknown> {
    this.emit('checking-for-update')
    this.emit('update-available', { version: '0.4.0', files: [] })
    if (this.autoDownload) void this.downloadUpdate()
    return Promise.resolve({})
  }

  downloadUpdate(token?: FakeToken): Promise<string[]> {
    this.downloads++
    return new Promise((resolve, reject) => {
      this.finish = () => {
        this.emit('update-downloaded', { version: '0.4.0' })
        // BaseUpdater adds its quit handler right after the event, while the switch is on.
        if (this.autoInstallOnAppQuit) this.quitHandlerAdded = true
        resolve([])
      }
      token?.onCancel(() => reject(new Error('cancelled')))
    })
  }

  finishDownload(): void {
    this.finish?.()
  }

  /** What the quit handler would do on a quit without a restart for the update. */
  get installsOnQuit(): boolean {
    return this.quitHandlerAdded && this.autoInstallOnAppQuit
  }
}

let fake: FakeAutoUpdater
let settings: SettingsFile
let restarts: number

function choose(automatic: SettingsFile['updates']['automatic']): void {
  settings = { ...DEFAULT_SETTINGS, updates: { automatic } }
}

function newUpdater() {
  let state: AppState = { lastRunVersion: '0.0.1', dismissedUpdate: null }
  const appState = {
    get: () => state,
    update: (changes: Partial<AppState>) => (state = { ...state, ...changes }),
  } as unknown as AppStateStore
  return new Updater({ appState, settings: () => settings, requestRestart: () => restarts++ })
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  fake = new FakeAutoUpdater()
  autoUpdater.load.mockImplementation(() =>
    Promise.resolve({ autoUpdater: fake, CancellationToken: FakeToken }),
  )
  restarts = 0
  vi.stubEnv('MAIN_VITE_UPDATE_MODE', 'install')
  // Linux builds update only as an AppImage.
  vi.stubEnv('APPIMAGE', '/opt/OverBench.AppImage')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('shows an automatic check that could not load electron-updater as failed', async () => {
  vi.useFakeTimers()
  autoUpdater.load.mockImplementation(() =>
    Promise.reject(new TypeError("Cannot set properties of undefined (setting 'logger')")),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  choose('download')
  const updater = newUpdater()
  updater.start()
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(() =>
    expect(updater.getStatus().state).toEqual({
      kind: 'error',
      message: "Cannot set properties of undefined (setting 'logger')",
      manual: false,
    }),
  )
})

it('installs a download it started under restart only on restart, until the choice changes', async () => {
  choose('restart')
  const updater = newUpdater()
  await updater.check()
  expect(updater.getStatus().state).toMatchObject({ kind: 'downloading', manual: false })
  fake.finishDownload()
  await settled()
  expect(updater.getStatus().state).toEqual({ kind: 'ready', version: '0.4.0' })
  expect(fake.installsOnQuit).toBe(false)
  expect(restarts).toBe(0)

  choose('download')
  updater.settingsChanged(settings, new Set(['updates']))
  await settled()
  expect(fake.installsOnQuit).toBe(true)
})

it('restarts once a download started with Update is ready, or installs it on quit', async () => {
  choose('notify')
  const updater = newUpdater()
  await updater.check()
  expect(updater.getStatus().state).toMatchObject({ kind: 'available', mode: 'install' })
  const download = updater.download()
  await settled()
  expect(updater.getStatus().state).toMatchObject({ kind: 'downloading', manual: true })
  fake.finishDownload()
  await download
  await settled()
  expect(restarts).toBe(1)
  // A restart cancelled while agents work leaves the update to the next quit.
  expect(fake.installsOnQuit).toBe(true)
})

it('starts one download for a double click on Update', async () => {
  choose('notify')
  const updater = newUpdater()
  await updater.check()
  const first = updater.download()
  await expect(updater.download()).rejects.toThrow('There is no update to download')
  await settled()
  expect(fake.downloads).toBe(1)
  fake.finishDownload()
  await first
})

it('cancels a download started with Update and offers the update again', async () => {
  choose('off')
  const updater = newUpdater()
  await updater.check()
  const download = updater.download()
  // At once: the cancel button shows with the download.
  updater.cancel()
  await expect(download).resolves.toBeUndefined()
  expect(updater.getStatus().state).toEqual({
    kind: 'available',
    version: '0.4.0',
    mode: 'install',
    downloadUrl: null,
  })
  expect(restarts).toBe(0)
})

it('skips the install during a system shutdown whatever the choice says next', async () => {
  choose('download')
  const updater = newUpdater()
  await updater.check()
  fake.finishDownload()
  await settled()
  expect(fake.installsOnQuit).toBe(true)
  updater.systemShutdown()
  updater.settingsChanged(settings, new Set(['updates']))
  await settled()
  expect(fake.installsOnQuit).toBe(false)
})
