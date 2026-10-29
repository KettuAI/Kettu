import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import type { AppState, AppStateStore } from './app-state'

const electronApp = vi.hoisted(() => ({
  getVersion: () => '0.0.1',
  isPackaged: true,
  isInApplicationsFolder: vi.fn(() => false),
  moveToApplicationsFolder: vi.fn(() => true),
}))
vi.mock('electron', () => ({ app: electronApp }))
vi.mock('./events', () => ({ broadcast: vi.fn() }))
const autoUpdater = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('./auto-updater', () => ({ loadAutoUpdater: autoUpdater.load }))
const fs = vi.hoisted(() => ({ access: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: fs.access,
}))

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
let moves: number
let appStateNow: AppState
const platform = process.platform

function choose(automatic: SettingsFile['updates']['automatic']): void {
  settings = { ...DEFAULT_SETTINGS, updates: { automatic } }
}

function newUpdater(saved: Partial<AppState> = {}) {
  appStateNow = { lastRunVersion: '0.0.1', dismissedUpdate: null, updateAfterMove: null, ...saved }
  const appState = {
    get: () => appStateNow,
    update: (changes: Partial<AppState>) => (appStateNow = { ...appStateNow, ...changes }),
  } as unknown as AppStateStore
  return new Updater({
    appState,
    settings: () => settings,
    requestRestart: () => restarts++,
    requestMove: () => moves++,
  })
}

/** A Mac whose app volume is mounted read-only, as the disk image is, or writable. */
function onMac(volume: 'read-only' | 'writable'): void {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  if (volume === 'read-only') {
    fs.access.mockRejectedValue(Object.assign(new Error('read-only'), { code: 'EROFS' }))
  }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  fake = new FakeAutoUpdater()
  autoUpdater.load.mockImplementation(() =>
    Promise.resolve({ autoUpdater: fake, CancellationToken: FakeToken }),
  )
  restarts = 0
  moves = 0
  fs.access.mockReset().mockResolvedValue(undefined)
  electronApp.isInApplicationsFolder.mockReset().mockReturnValue(false)
  electronApp.moveToApplicationsFolder.mockReset().mockReturnValue(true)
  vi.stubEnv('MAIN_VITE_UPDATE_MODE', 'install')
  // Linux builds update only as an AppImage.
  vi.stubEnv('APPIMAGE', '/opt/Kettu.AppImage')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
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

it('leaves an update on a read-only volume to Update, which moves the app first', async () => {
  onMac('read-only')
  choose('download')
  const updater = newUpdater()
  await updater.check()
  expect(updater.getStatus().readOnly).toBe(true)
  expect(updater.getStatus().state).toEqual({
    kind: 'available',
    version: '0.4.0',
    mode: 'install',
    downloadUrl: null,
  })
  expect(fake.downloads).toBe(0)
  expect(fake.autoInstallOnAppQuit).toBe(false)

  await updater.download()
  expect(moves).toBe(1)
  expect(fake.downloads).toBe(0)
})

it('updates in place from a writable volume and never checks off macOS or in Link mode', async () => {
  onMac('writable')
  choose('download')
  const writable = newUpdater()
  await writable.check()
  expect(writable.getStatus().readOnly).toBe(false)
  expect(writable.getStatus().state).toMatchObject({ kind: 'downloading', manual: false })

  // An AppImage always runs from a read-only mount and updates by replacing its file.
  Object.defineProperty(process, 'platform', { value: 'linux' })
  fs.access.mockClear()
  fs.access.mockRejectedValue(Object.assign(new Error('read-only'), { code: 'EROFS' }))
  const linux = newUpdater()
  await settled()
  expect(fs.access).not.toHaveBeenCalled()
  expect(linux.getStatus().readOnly).toBe(false)

  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.stubEnv('MAIN_VITE_UPDATE_MODE', 'link')
  const link = newUpdater()
  await settled()
  expect(fs.access).not.toHaveBeenCalled()
  expect(link.getStatus().readOnly).toBe(false)
})

it('moves the app once the quit flow asks, and records the update for the next launch', async () => {
  onMac('read-only')
  choose('download')
  const updater = newUpdater()
  await updater.check()
  const moved = updater.moveNow()
  expect(updater.getStatus().state).toEqual({ kind: 'moving', version: '0.4.0' })
  expect(appStateNow.updateAfterMove).toBe('0.4.0')
  await expect(moved).resolves.toBe(true)
  expect(electronApp.moveToApplicationsFolder).toHaveBeenCalledOnce()
})

it('stays where it is when the move fails or is cancelled', async () => {
  onMac('read-only')
  choose('download')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const updater = newUpdater()
  await updater.check()
  const available = updater.getStatus().state

  electronApp.moveToApplicationsFolder.mockImplementationOnce(() => {
    throw new Error('User rejected the authorization request')
  })
  await expect(updater.moveNow()).resolves.toBe(false)
  expect(updater.getStatus().state).toEqual(available)
  expect(appStateNow.updateAfterMove).toBeNull()

  electronApp.moveToApplicationsFolder.mockReturnValueOnce(false)
  await expect(updater.moveNow()).resolves.toBe(false)
  expect(updater.getStatus().state).toEqual(available)

  electronApp.moveToApplicationsFolder.mockImplementationOnce(() => {
    throw new Error('Failed to copy current bundle to the applications folder')
  })
  await expect(updater.moveNow()).resolves.toBe(false)
  expect(updater.getStatus().state).toEqual({
    kind: 'error',
    message: 'Failed to copy current bundle to the applications folder',
    manual: true,
    move: true,
  })
  expect(appStateNow.updateAfterMove).toBeNull()
})

it('does not move an app that Electron would leave in place', async () => {
  onMac('read-only')
  choose('download')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const updater = newUpdater()
  await updater.check()
  // A read-only volume with an Applications folder in its path: Electron returns true and quits.
  electronApp.isInApplicationsFolder.mockReturnValue(true)
  await expect(updater.moveNow()).resolves.toBe(false)
  expect(electronApp.moveToApplicationsFolder).not.toHaveBeenCalled()
  expect(updater.getStatus().state).toMatchObject({ kind: 'error', move: true })
})

it('carries on with the Update at the launch after the move', async () => {
  vi.useFakeTimers()
  onMac('writable')
  choose('download')
  const updater = newUpdater({ updateAfterMove: '0.4.0' })
  expect(appStateNow.updateAfterMove).toBeNull()
  updater.start()
  // At once, not 30 s later, and as Update: no automatic download, but one with progress.
  await vi.advanceTimersByTimeAsync(1000)
  expect(updater.getStatus().state).toMatchObject({ kind: 'downloading', manual: true })
  expect(fake.downloads).toBe(1)
  expect(fake.autoDownload).toBe(true)
  fake.finishDownload()
  await vi.advanceTimersByTimeAsync(0)
  expect(restarts).toBe(1)
})

it('drops the record of a move when the app is still on a read-only volume', async () => {
  vi.useFakeTimers()
  onMac('read-only')
  choose('download')
  const checks = vi.spyOn(fake, 'checkForUpdates')
  const updater = newUpdater({ updateAfterMove: '0.4.0' })
  expect(appStateNow.updateAfterMove).toBeNull()
  updater.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(checks).not.toHaveBeenCalled()
  expect(updater.getStatus().state).toEqual({ kind: 'idle', checkedAt: null })
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
