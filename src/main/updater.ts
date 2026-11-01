import { access, constants } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app } from 'electron'
import type { AppUpdater, CancellationToken } from 'electron-updater'
import type { SettingsFile } from '@shared/settings'
import type { UpdateStatus } from '@shared/updates'
import type { AppStateStore } from './app-state'
import { loadAutoUpdater } from './auto-updater'
import { broadcast } from './events'
import { createLogger } from './log'
import { sessionProxy } from './proxy'
import type { SettingsSection } from './settings-schema'
import {
  dismissTarget,
  dmgDownloadUrl,
  errorMessage,
  installOnQuit,
  moveCancelled,
  nextState,
  offReason,
  readOnlyVolume,
  type StartedBy,
  type UpdateMode,
  type UpdaterEvent,
  updatedFrom,
  updateMode,
} from './update-state'

const log = createLogger('updater')

const FIRST_CHECK_MS = 30_000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
// Electron copies the app synchronously, so the window gets a few frames to show the move first.
const MOVE_PAINT_MS = 100

export interface UpdaterDeps {
  appState: AppStateStore
  settings(): SettingsFile
  /** Restarts through the quit flow, which confirms and then calls `installNow`. */
  requestRestart(): void
  /** Moves the app through the quit flow, which confirms and then calls `moveNow`. */
  requestMove(): void
  /** The status changed, which the windows hear too. */
  changed?(status: UpdateStatus): void
}

/** Checks GitHub Releases through electron-updater, which loads only after the window shows. */
export class Updater {
  private status: UpdateStatus
  private readonly mode: UpdateMode
  private updater: Promise<AppUpdater> | null = null
  private manual = false
  private lastCheckedAt: number | null = null
  private lastAvailable: string | null = null
  private lastDownloadUrl: string | null = null
  private checking: Promise<void> | null = null
  private started = false
  private errorEvents = 0
  private startedBy: StartedBy = 'auto'
  /** Set once electron-updater has loaded. */
  private newToken: (() => CancellationToken) | null = null
  /** Stops the download the user started with Update. */
  private cancellation: CancellationToken | null = null
  private shuttingDown = false
  /** Set once the app is known to run from a read-only volume, where Update moves it first. */
  private readOnly = false
  private readonly located: Promise<void>
  /** The version of an Update that moved the app, which this launch carries on with. */
  private afterMove: string | null

  constructor(private readonly deps: UpdaterDeps) {
    const current = app.getVersion()
    const { lastRunVersion, dismissedUpdate, updateAfterMove } = deps.appState.get()
    this.mode = updateMode(process.platform, import.meta.env.MAIN_VITE_UPDATE_MODE)
    this.status = {
      state: offReason(app.isPackaged, process.platform, process.env) ?? {
        kind: 'idle',
        checkedAt: null,
      },
      mode: this.mode,
      readOnly: false,
      current,
      updatedFrom: updatedFrom(lastRunVersion, current),
      dismissed: dismissedUpdate,
    }
    this.afterMove = updateAfterMove
    deps.appState.update({ lastRunVersion: current, updateAfterMove: null })
    this.located = this.locate()
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** Schedules the first check 30 s from now and then one every hour. */
  start(): void {
    if (this.started || this.status.state.kind === 'off') return
    this.started = true
    log.info(`Updates in ${this.mode} mode`)
    if (this.afterMove) void this.continueAfterMove()
    setTimeout(() => {
      void this.automaticCheck()
      setInterval(() => void this.automaticCheck(), CHECK_INTERVAL_MS).unref()
    }, FIRST_CHECK_MS).unref()
  }

  /** A check the user asked for; its errors are shown. Resolves once it has finished. */
  async check(): Promise<UpdateStatus> {
    const { kind } = this.status.state
    if (kind === 'off' || kind === 'ready' || kind === 'downloading' || kind === 'moving') {
      return this.status
    }
    await this.runCheck(true)
    return this.status
  }

  /** Update: downloads the update found, then restarts once it is ready. */
  async download(): Promise<void> {
    const off = this.status.state
    if (off.kind === 'off') {
      throw new Error(
        off.reason === 'development'
          ? 'Updates are off in development builds'
          : 'Updates for this installation come from the package manager',
      )
    }
    if (this.mode === 'link') {
      throw new Error('This build cannot install updates; open the release page to download it')
    }
    const { state } = this.status
    if (state.kind !== 'available') throw new Error('There is no update to download')
    if (this.readOnly) {
      this.deps.requestMove()
      return
    }
    this.manual = true
    await this.startDownload(state.version, 'user')
  }

  /**
   * The first step of Update on a read-only volume, once the quit flow has asked: moves the app
   * to /Applications, after which the flow quits and Electron opens the copy. False when the app
   * stays where it is, with the update on offer or the failure in the state.
   */
  async moveNow(): Promise<boolean> {
    const { state } = this.status
    if (state.kind !== 'available') return false
    // Electron would return true without moving or quitting, and the flow would quit for nothing.
    if (app.isInApplicationsFolder()) {
      this.moveFailed('The app is in an Applications folder on a read-only volume')
      return false
    }
    this.dispatch({ type: 'moving', version: state.version })
    this.deps.appState.update({ updateAfterMove: state.version })
    await new Promise((done) => setTimeout(done, MOVE_PAINT_MS))
    let moved: boolean
    try {
      moved = app.moveToApplicationsFolder()
    } catch (error) {
      if (!moveCancelled(error)) {
        this.deps.appState.update({ updateAfterMove: null })
        this.moveFailed(errorMessage(error))
        return false
      }
      moved = false
    }
    if (moved) return true
    log.info('Moving the app to /Applications was cancelled')
    this.deps.appState.update({ updateAfterMove: null })
    this.dispatch({ type: 'move-cancelled' })
    return false
  }

  /** Stops a download started with Update, which leaves the update available again. */
  cancel(): void {
    if (this.status.state.kind === 'downloading') this.cancellation?.cancel()
  }

  restart(): void {
    if (this.status.state.kind !== 'ready') throw new Error('No update is ready to install')
    this.deps.requestRestart()
  }

  dismiss(): void {
    const target = dismissTarget(this.status)
    if (!target || target === this.status.dismissed) return
    this.deps.appState.update({ dismissedUpdate: target })
    this.publish({ ...this.status, dismissed: target })
  }

  /** The last step of a restart to update, after the hosts stopped and files were flushed. */
  async installNow(): Promise<void> {
    const updater = await this.load()
    // Silent, and start the new version afterwards.
    updater.quitAndInstall(true, true)
  }

  /** The system is shutting down, which could kill an installer halfway. */
  systemShutdown(): void {
    this.shuttingDown = true
    if (!this.updater) return
    void this.updater.then((updater) => {
      updater.autoInstallOnAppQuit = false
      log.info('System shutdown: the update installs at the next quit instead')
    })
  }

  settingsChanged(settings: SettingsFile, changed: Set<SettingsSection>): void {
    if (!this.updater) return
    void this.updater.then((updater) => {
      if (changed.has('proxy')) void this.applyProxy(updater, settings)
      if (!changed.has('updates')) return
      updater.autoDownload = this.autoDownload(settings)
      this.applyInstallOnQuit(updater, settings)
      const { state } = this.status
      if (updater.autoDownload && state.kind === 'available') {
        this.manual = false
        void this.startDownload(state.version, 'auto')
      }
    })
  }

  private autoDownload(settings: SettingsFile): boolean {
    const { automatic } = settings.updates
    // A read-only volume could not install it, and the launch after a move downloads as Update.
    return (
      this.mode === 'install' &&
      !this.readOnly &&
      this.afterMove === null &&
      (automatic === 'download' || automatic === 'restart')
    )
  }

  /**
   * electron-updater adds its quit handler when a download finishes, and only while
   * autoInstallOnAppQuit is on, so it stays on until then; a ready update follows the choice.
   */
  private applyInstallOnQuit(updater: AppUpdater, settings: SettingsFile): void {
    const ready = this.status.state.kind === 'ready'
    updater.autoInstallOnAppQuit =
      this.mode === 'install' &&
      !this.readOnly &&
      !this.shuttingDown &&
      (!ready || installOnQuit({ choice: settings.updates.automatic, startedBy: this.startedBy }))
  }

  /**
   * Squirrel.Mac installs nothing into an app on a read-only volume, so this tests what it tests:
   * the volume, not whether the app sits in an Applications folder. An AppImage always runs from
   * a read-only mount, so Linux is never tested.
   */
  private async locate(): Promise<void> {
    if (process.platform !== 'darwin' || this.mode !== 'install') return
    if (this.status.state.kind === 'off') return
    // The bundle holds the executable in Contents/MacOS.
    const bundle = resolve(process.execPath, '..', '..', '..')
    try {
      await access(bundle, constants.W_OK)
    } catch (error) {
      if (!readOnlyVolume(error)) return
      log.info(`${bundle} is on a read-only volume, so Update moves it to /Applications first`)
      this.readOnly = true
      this.publish({ ...this.status, readOnly: true })
    }
  }

  /** The first launch after Update moved the app: carries on with that Update at once. */
  private async continueAfterMove(): Promise<void> {
    await this.located
    if (this.readOnly) {
      log.warn('Still on a read-only volume after moving to /Applications')
      this.afterMove = null
      return
    }
    log.info(`Moved to /Applications to update to ${this.afterMove}`)
    try {
      await this.runCheck(true)
    } finally {
      this.afterMove = null
      const updater = await this.updater?.catch(() => null)
      if (updater) updater.autoDownload = this.autoDownload(this.deps.settings())
    }
    // A failed download is in the state and the log, as after any Update.
    if (this.status.state.kind === 'available') await this.download().catch(() => undefined)
  }

  private moveFailed(message: string): void {
    log.warn(`Could not move the app to /Applications: ${message}`)
    this.dispatch({ type: 'move-failed', message })
  }

  private load(): Promise<AppUpdater> {
    this.updater ??= loadAutoUpdater().then(async ({ autoUpdater, CancellationToken }) => {
      // Automatic downloads depend on where the app runs.
      await this.located
      this.newToken = () => new CancellationToken()
      const settings = this.deps.settings()
      autoUpdater.logger = {
        info: (message?: unknown) => log.info(String(message)),
        warn: (message?: unknown) => log.warn(String(message)),
        error: (message?: unknown) => log.error(String(message)),
      }
      autoUpdater.allowPrerelease = false
      autoUpdater.allowDowngrade = false
      autoUpdater.autoDownload = this.autoDownload(settings)
      this.applyInstallOnQuit(autoUpdater, settings)
      // Releases carry no NSIS blockmap, so the Windows installer always downloads whole.
      autoUpdater.disableDifferentialDownload = process.platform === 'win32'
      autoUpdater.on('checking-for-update', () =>
        this.dispatch({ type: 'checking', manual: this.manual }),
      )
      autoUpdater.on('update-available', (info) => {
        this.lastAvailable = info.version
        this.lastDownloadUrl =
          this.mode === 'link' ? dmgDownloadUrl(info.version, info.files, process.arch) : null
        // With automatic downloads electron-updater starts one right after this event.
        this.startedBy = 'auto'
        this.dispatch({ type: 'available', version: info.version })
        this.applyInstallOnQuit(autoUpdater, this.deps.settings())
      })
      autoUpdater.on('update-not-available', () => {
        this.lastAvailable = null
        this.lastDownloadUrl = null
        this.lastCheckedAt = Date.now()
        this.dispatch({ type: 'not-available', at: this.lastCheckedAt })
      })
      autoUpdater.on('download-progress', (progress) =>
        this.dispatch({ type: 'progress', percent: progress.percent }),
      )
      autoUpdater.on('update-downloaded', (info) => {
        this.dispatch({ type: 'downloaded', version: info.version })
        // electron-updater adds its quit handler right after this event, so the choice applies
        // once it has.
        queueMicrotask(() => this.applyInstallOnQuit(autoUpdater, this.deps.settings()))
        if (this.startedBy === 'user') this.deps.requestRestart()
      })
      autoUpdater.on('error', (error) => {
        this.errorEvents++
        const message = errorMessage(error)
        log.warn(`${this.manual ? 'Manual' : 'Automatic'} update step failed: ${message}`)
        this.dispatch({ type: 'error', message, manual: this.manual })
      })
      void this.applyProxy(autoUpdater, settings)
      return autoUpdater
    })
    this.updater.catch((error: unknown) => {
      log.error('Could not load electron-updater', error)
      this.updater = null
    })
    return this.updater
  }

  private async applyProxy(updater: AppUpdater, settings: SettingsFile): Promise<void> {
    try {
      await updater.netSession.setProxy(sessionProxy(settings.proxy))
    } catch (error) {
      log.error('Could not apply the proxy to updates', error)
    }
  }

  private async automaticCheck(): Promise<void> {
    if (this.deps.settings().updates.automatic === 'off') return
    const { kind } = this.status.state
    if (kind === 'ready' || kind === 'downloading' || kind === 'checking' || kind === 'moving') {
      return
    }
    await this.runCheck(false)
  }

  private runCheck(manual: boolean): Promise<void> {
    if (this.checking) {
      // A manual check during an automatic one takes over its error reporting.
      if (manual) this.manual = true
      return this.checking
    }
    this.manual = manual
    const errorsBefore = this.errorEvents
    let loaded = false
    this.checking = this.load()
      .then((updater) => {
        loaded = true
        return updater.checkForUpdates()
      })
      .then(
        () => undefined,
        (error: unknown) => {
          const message = errorMessage(error)
          if (!loaded) {
            this.dispatch({ type: 'load-failed', message, manual: this.manual })
          } else if (this.errorEvents === errorsBefore) {
            // electron-updater reports its own failures through 'error' as well; anything else
            // has to reach the state here.
            this.dispatch({ type: 'error', message, manual: this.manual })
          }
        },
      )
      .finally(() => {
        this.checking = null
      })
    return this.checking
  }

  private async startDownload(version: string, startedBy: StartedBy): Promise<void> {
    const errorsBefore = this.errorEvents
    // Before anything waits: a second Update then finds the download started, and the cancel
    // button that shows with it has a token to cancel.
    const token = startedBy === 'user' ? (this.newToken?.() ?? null) : null
    this.startedBy = startedBy
    this.cancellation = token
    this.dispatch({ type: 'download-started', version, manual: startedBy === 'user' })
    try {
      const updater = await this.load()
      this.applyInstallOnQuit(updater, this.deps.settings())
      await updater.downloadUpdate(token ?? undefined)
    } catch (error) {
      // A cancelled download rejects without an 'error' event.
      if (token?.cancelled) {
        this.dispatch({ type: 'download-cancelled' })
        return
      }
      const message = errorMessage(error)
      if (this.errorEvents === errorsBefore) {
        this.dispatch({ type: 'error', message, manual: this.manual })
      }
      if (this.manual) throw new Error(message, { cause: error })
    } finally {
      if (this.cancellation === token) this.cancellation = null
    }
  }

  private dispatch(event: UpdaterEvent): void {
    const state = nextState(this.status.state, event, {
      mode: this.mode,
      autoDownload: this.autoDownload(this.deps.settings()),
      lastCheckedAt: this.lastCheckedAt,
      lastAvailable: this.lastAvailable,
      downloadUrl: this.lastDownloadUrl,
    })
    if (state !== this.status.state) this.publish({ ...this.status, state })
  }

  private publish(status: UpdateStatus): void {
    this.status = status
    broadcast('update:changed', status)
    this.deps.changed?.(status)
  }
}
