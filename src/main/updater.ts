import { access, constants } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, autoUpdater as squirrel, shell } from 'electron'
import type { AppUpdater, CancellationToken, ProgressInfo, UpdateFileInfo } from 'electron-updater'
import type { SettingsFile } from '@shared/settings'
import type { UpdateStatus } from '@shared/updates'
import type { AppStateStore } from './app-state'
import { loadAutoUpdater } from './auto-updater'
import { broadcast } from './events'
import { t } from './i18n'
import { createLogger } from './log'
import { sessionProxy } from './proxy'
import type { SettingsSection } from './settings-schema'
import { diskImageFor, downloadDiskImage, type DownloadFile } from './update-dmg'
import { guardUpdaterHttpExecutor } from './update-http'
import {
  GITHUB_SOURCE,
  SourceRun,
  SourcesFailed,
  updaterUserAgent,
  type SourceChoice,
} from './update-sources'
import {
  compareVersions,
  dismissTarget,
  errorMessage,
  installOnQuit,
  moveCancelled,
  nextState,
  offReason,
  readOnlyVolume,
  releaseHighlights,
  type StartedBy,
  type UpdateMode,
  type UpdaterEvent,
  updatedFrom,
  updateMode,
} from './update-state'

const log = createLogger('updater')

// electron-updater's code for an installer whose publisher is not the running app's.
const INVALID_PUBLISHER = 'ERR_UPDATER_INVALID_SIGNATURE'

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/** Whether a check failed because GitHub, its only source, could not be reached. */
function githubUnreachable(error: unknown): boolean {
  return error instanceof SourcesFailed && error.githubUnreachable
}

const FIRST_CHECK_MS = 30_000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
// A restart waiting for sessions looks this often, and goes once two looks in a row find none, so a
// turn that ends and wakes another session at once is not cut off between the two.
const WAIT_POLL_MS = 3_000
const IDLE_POLLS = 2
// Electron copies the app synchronously, so the window gets a few frames to show the move first.
const MOVE_PAINT_MS = 100
// Squirrel.Mac unpacks and verifies a downloaded update in seconds; past this, a restart goes on.
const SQUIRREL_PREPARE_MS = 60_000

export interface UpdaterDeps {
  appState: AppStateStore
  settings(): SettingsFile
  /**
   * Restarts through the quit flow, which asks about running work unless `confirmed`, and then
   * calls `installNow`. `resumeAfterUpdate` marks an immediate user-initiated update restart whose
   * interrupted sessions should resume after relaunch. False when another quit or restart is in
   * progress.
   */
  requestRestart(confirmed: boolean, resumeAfterUpdate?: boolean): boolean
  /** Clears any staged update-resume record if installing the update is skipped or fails. */
  clearUpdateResume?(): Promise<void>
  /** How many sessions are working in a way a restart can wait for. */
  waitableSessions(): Promise<number>
  /** Moves the app through the quit flow, which confirms and then calls `moveNow`. */
  requestMove(): void
  /** The status changed, which the windows hear too. */
  changed?(status: UpdateStatus): void
}

/**
 * Checks Kettu's download service and GitHub's releases through electron-updater, which loads only
 * after the window shows.
 */
export class Updater {
  private status: UpdateStatus
  private readonly mode: UpdateMode
  private updater: Promise<AppUpdater> | null = null
  /** Resolved electron-updater instance, so shutdown hooks can update it synchronously. */
  private loadedUpdater: AppUpdater | null = null
  private manual = false
  private lastCheckedAt: number | null = null
  private lastAvailable: string | null = null
  private lastFiles: readonly UpdateFileInfo[] = []
  /** The sources of the last check that found an update; a download moves along them. */
  private run: SourceRun | null = null
  /** Stops the download attempt on a source other than GitHub, while one runs. */
  private leaveSource: (() => void) | null = null
  /** The provider's way to download one file, once electron-updater has loaded. */
  private downloadFile: DownloadFile | null = null
  private checking: Promise<void> | null = null
  private started = false
  private errorEvents = 0
  private startedBy: StartedBy = 'auto'
  /** Set once electron-updater has loaded. */
  private Token: typeof CancellationToken | null = null
  /** While a download runs, its failures are reported once no source is left to move on to. */
  private downloadActive = false
  /** Stops the download the user started with Update. */
  private cancellation: CancellationToken | null = null
  private shuttingDown = false
  /** Set once the app is known to run from a read-only volume, where Update moves it first. */
  private readOnly = false
  private readonly located: Promise<void>
  /** The version of an Update that moved the app, which this launch carries on with. */
  private afterMove: string | null
  /** The next look while a restart waits for sessions to finish. */
  private waitTimer: ReturnType<typeof setTimeout> | null = null
  /** Counts each wait and each end of one, so a look an earlier wait started stops. */
  private waitRun = 0
  /** Looks in a row that found no session to wait for. */
  private idlePolls = 0
  /**
   * macOS: Squirrel.Mac preparing the update just downloaded. Until it has, a restart would install
   * the update it prepared before, as electron-updater only knows that one was prepared.
   */
  private squirrelPreparing: Promise<void> | null = null

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
      restartWhenIdle: null,
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

  /**
   * A check the user asked for; its errors are shown, except while an update is ready, which a
   * failed check leaves as it was. Resolves once it has finished.
   */
  async check(): Promise<UpdateStatus> {
    const { kind } = this.status.state
    if (kind === 'off' || kind === 'downloading' || kind === 'moving') return this.status
    await this.runCheck(true)
    return this.status
  }

  /** Update: downloads the update found, then restarts once it is ready. */
  async download(): Promise<void> {
    const off = this.status.state
    if (off.kind === 'off') {
      throw new Error(
        off.reason === 'development' ? t('updater.offDevelopment') : t('updater.offPackageManager'),
      )
    }
    const { state } = this.status
    if (state.kind !== 'available') throw new Error(t('updater.nothingToDownload'))
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
      this.moveFailed(
        t('updater.readOnlyVolume'),
        'The app is in an Applications folder on a read-only volume',
      )
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
    if (this.status.state.kind !== 'ready') throw new Error(t('updater.nothingReady'))
    this.deps.requestRestart(false, true)
  }

  /** Restart now, from the update dialog, which already showed the work it stops. */
  restartConfirmed(): void {
    if (this.status.state.kind !== 'ready') throw new Error(t('updater.nothingReady'))
    this.stopWaiting()
    this.deps.requestRestart(true, true)
  }

  /**
   * Restarts into the update by itself once no session works in a way that ends by itself, as the
   * user chose; a newer update downloading then is waited for too.
   */
  async restartWhenIdle(): Promise<void> {
    if (this.status.state.kind !== 'ready') throw new Error(t('updater.nothingReady'))
    if (this.status.restartWhenIdle) return
    log.info('The restart to update waits for the working sessions to finish')
    const run = ++this.waitRun
    this.idlePolls = 0
    await this.lookForIdle(run)
  }

  /** Stops waiting to restart; the update stays ready. */
  cancelRestartWhenIdle(): void {
    if (this.status.restartWhenIdle) log.info('The restart to update no longer waits')
    // Also before the first look has answered, when nothing shows the wait yet.
    this.stopWaiting()
  }

  private stopWaiting(): void {
    this.waitRun++
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.waitTimer = null
    this.idlePolls = 0
    if (this.status.restartWhenIdle) this.publish({ ...this.status, restartWhenIdle: null })
  }

  private async lookForIdle(run: number): Promise<void> {
    this.waitTimer = null
    const sessions = await this.deps.waitableSessions()
    // Cancelled, or restarted now, while the agent host answered.
    if (run !== this.waitRun) return
    const { kind } = this.status.state
    if (kind !== 'ready' && kind !== 'downloading') {
      log.info(`The restart to update no longer waits: the update is ${kind}`)
      this.stopWaiting()
      return
    }
    if (this.status.restartWhenIdle?.sessions !== sessions) {
      this.publish({ ...this.status, restartWhenIdle: { sessions } })
    }
    const idle = sessions === 0 && kind === 'ready' && !this.squirrelPreparing
    this.idlePolls = idle ? this.idlePolls + 1 : 0
    if (this.idlePolls >= IDLE_POLLS) {
      // Wait-for-idle restarts only once sessions finish, so it never schedules post-update resume.
      if (this.deps.requestRestart(true, false)) {
        log.info('The working sessions finished: restarting to update')
        this.stopWaiting()
        return
      }
      log.info('Another quit or restart is in progress; the restart to update waits on')
    }
    this.waitTimer = setTimeout(() => void this.lookForIdle(run), WAIT_POLL_MS)
    this.waitTimer.unref()
  }

  dismiss(): void {
    const target = dismissTarget(this.status)
    if (!target || target === this.status.dismissed) return
    this.deps.appState.update({ dismissedUpdate: target })
    this.publish({ ...this.status, dismissed: target })
  }

  /** The last step of a restart to update, after the hosts stopped and files were flushed. */
  async installNow(): Promise<void> {
    if (this.shuttingDown) {
      log.info('System shutdown: skipping update install')
      await this.deps.clearUpdateResume?.()
      app.quit()
      return
    }
    let updater: AppUpdater
    try {
      updater = await this.load()
    } catch (error) {
      await this.deps.clearUpdateResume?.()
      throw error
    }
    if (this.shuttingDown) {
      log.info('System shutdown: skipping update install')
      await this.deps.clearUpdateResume?.()
      app.quit()
      return
    }
    if (this.squirrelPreparing) {
      log.info('Waiting for Squirrel.Mac to prepare the update before restarting')
      await this.squirrelPreparing
    }
    try {
      // Silent, and start the new version afterwards.
      updater.quitAndInstall(true, true)
    } catch (error) {
      await this.deps.clearUpdateResume?.()
      throw error
    }
  }

  /** Follows Squirrel.Mac preparing the update just downloaded, which electron-updater asked for. */
  private followSquirrel(version: string): void {
    const preparing = new Promise<void>((done) => {
      const finish = (message: string): void => {
        clearTimeout(timer)
        squirrel.off('update-downloaded', prepared)
        squirrel.off('error', failed)
        log.info(message)
        if (this.squirrelPreparing === preparing) this.squirrelPreparing = null
        done()
      }
      const prepared = (): void => finish(`Squirrel.Mac prepared ${version}`)
      // electron-updater reports the error itself.
      const failed = (): void => finish(`Squirrel.Mac could not prepare ${version}`)
      const timer = setTimeout(
        () => finish(`Squirrel.Mac did not prepare ${version} in ${SQUIRREL_PREPARE_MS / 1000} s`),
        SQUIRREL_PREPARE_MS,
      )
      squirrel.on('update-downloaded', prepared)
      squirrel.on('error', failed)
    })
    this.squirrelPreparing = preparing
  }

  /** The system is shutting down, which could kill an installer halfway. */
  systemShutdown(): void {
    this.shuttingDown = true
    if (this.loadedUpdater) {
      this.loadedUpdater.autoInstallOnAppQuit = false
      log.info('System shutdown: the update installs at the next quit instead')
      return
    }
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
      if (changed.has('updates') || changed.has('cloud')) this.sourceChanged()
      if (!changed.has('updates')) return
      this.applyInstallOnQuit(updater, settings)
      const { state } = this.status
      if (this.autoDownload(settings) && state.kind === 'available') {
        this.manual = false
        void this.startDownload(state.version, 'auto')
      }
    })
  }

  /** GitHub only, as chosen or because Kettu's services are off on this computer. */
  private sourceChoice(): SourceChoice {
    const { cloud, updates } = this.deps.settings()
    return cloud.enabled ? updates.source : 'github'
  }

  /**
   * Once GitHub only is chosen, an update a check found elsewhere downloads from GitHub, so nothing
   * more goes to another source. Once it is not, a check that GitHub failed runs again.
   */
  private sourceChanged(): void {
    const { state } = this.status
    // A failure on GitHub alone is stale once other sources may be used, so they are asked.
    if (state.kind === 'error' && state.githubUnreachable && this.sourceChoice() === 'auto') {
      void this.check()
      return
    }
    if (this.sourceChoice() !== 'github' || !this.run || this.run.githubOnly) return
    this.run = SourceRun.githubOnly(this.run.stallMs)
    this.leaveSource?.()
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
    }
    // A failed download is in the state and the log, as after any Update.
    if (this.status.state.kind === 'available') await this.download().catch(() => undefined)
  }

  private moveFailed(message: string, logged = message): void {
    log.warn(`Could not move the app to /Applications: ${logged}`)
    this.dispatch({ type: 'move-failed', message })
  }

  private load(): Promise<AppUpdater> {
    this.updater ??= Promise.all([loadAutoUpdater(), import('./update-provider')]).then(
      async ([{ autoUpdater, CancellationToken, Provider }, { sourcesProvider }]) => {
        // Automatic downloads depend on where the app runs.
        await this.located
        this.Token = CancellationToken
        const settings = this.deps.settings()
        const current = app.getVersion()
        guardUpdaterHttpExecutor(autoUpdater, log)
        autoUpdater.logger = {
          info: (message?: unknown) => log.info(String(message)),
          warn: (message?: unknown) => log.warn(String(message)),
          error: (message?: unknown) => log.error(String(message)),
        }
        autoUpdater.setFeedURL({
          provider: 'custom',
          updateProvider: sourcesProvider(Provider, CancellationToken, {
            current,
            userAgent: updaterUserAgent(current, process.platform, process.arch),
            log,
            choice: () => this.sourceChoice(),
            cachedList: () => this.deps.appState.get().updateSources,
            saveList: (list) => this.deps.appState.update({ updateSources: list }),
            checked: (run) => {
              this.run = run
            },
            downloadSource: () => this.run?.current ?? null,
            downloader: (download) => {
              this.downloadFile = download
            },
          }),
        })
        autoUpdater.allowPrerelease = false
        autoUpdater.allowDowngrade = false
        // The updater starts downloads itself, so a failed source hands the download on.
        autoUpdater.autoDownload = false
        autoUpdater.disableWebInstaller = true
        this.loadedUpdater = autoUpdater
        this.applyInstallOnQuit(autoUpdater, settings)
        // Releases carry no NSIS blockmap, so the Windows installer always downloads whole.
        autoUpdater.disableDifferentialDownload = process.platform === 'win32'
        autoUpdater.on('checking-for-update', () =>
          this.dispatch({ type: 'checking', manual: this.manual }),
        )
        autoUpdater.on('update-available', (info) => {
          if (!this.newerThanReady(info.version)) {
            log.info(`${info.version} is downloaded already and waits for a restart`)
            return
          }
          this.lastAvailable = info.version
          this.lastFiles = info.files
          // An automatic download, which the check starts as it ends, is the updater's own.
          this.startedBy = 'auto'
          this.dispatch({ type: 'available', version: info.version })
          this.applyInstallOnQuit(autoUpdater, this.deps.settings())
        })
        autoUpdater.on('update-not-available', () => {
          this.lastAvailable = null
          this.lastCheckedAt = Date.now()
          this.dispatch({ type: 'not-available', at: this.lastCheckedAt })
        })
        autoUpdater.on('download-progress', (progress) =>
          this.dispatch({ type: 'progress', percent: progress.percent }),
        )
        autoUpdater.on('update-downloaded', (info) => {
          // electron-updater hands the file to Squirrel.Mac right after this event while
          // autoInstallOnAppQuit is on, which the microtask below may turn off only afterwards.
          if (process.platform === 'darwin' && autoUpdater.autoInstallOnAppQuit) {
            this.followSquirrel(info.version)
          }
          this.dispatch({
            type: 'downloaded',
            version: info.version,
            notes: releaseHighlights(info.releaseNotes),
          })
          // electron-updater adds its quit handler right after this event, so the choice applies
          // once it has.
          queueMicrotask(() => this.applyInstallOnQuit(autoUpdater, this.deps.settings()))
          if (this.startedBy === 'user') this.deps.requestRestart(false, true)
        })
        autoUpdater.on('error', (error) => {
          if (this.downloadActive) return
          this.errorEvents++
          const message = errorMessage(error)
          const said = error instanceof SourcesFailed ? error.log : message
          if (this.checkPastReady()) {
            log.warn(`Checking past the ready update failed: ${said}`)
            return
          }
          log.warn(`${this.manual ? 'Manual' : 'Automatic'} update step failed: ${said}`)
          this.dispatch({
            type: 'error',
            message,
            manual: this.manual,
            githubUnreachable: githubUnreachable(error),
          })
        })
        void this.applyProxy(autoUpdater, settings)
        return autoUpdater
      },
    )
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
    // A ready update is checked past too, so a newer release replaces it before the restart.
    if (kind === 'downloading' || kind === 'checking' || kind === 'moving') return
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
        (result) => {
          if (!result?.isUpdateAvailable || !this.autoDownload(this.deps.settings())) return
          if (!this.newerThanReady(result.updateInfo.version)) return
          // The download outlives the check; its failures reach the state on their own.
          void this.startDownload(result.updateInfo.version, 'auto').catch(() => undefined)
        },
        (error: unknown) => {
          const message = errorMessage(error)
          if (!loaded) {
            this.dispatch({ type: 'load-failed', message, manual: this.manual })
          } else if (this.checkPastReady()) {
            if (this.errorEvents === errorsBefore) {
              log.warn(`Checking past the ready update failed: ${message}`)
            }
          } else if (this.errorEvents === errorsBefore) {
            // electron-updater reports its own failures through 'error' as well; anything else
            // has to reach the state here.
            this.dispatch({
              type: 'error',
              message,
              manual: this.manual,
              githubUnreachable: githubUnreachable(error),
            })
          }
        },
      )
      .finally(() => {
        this.checking = null
      })
    return this.checking
  }

  private async startDownload(version: string, startedBy: StartedBy): Promise<void> {
    if (this.downloadActive) return
    this.downloadActive = true
    const { state } = this.status
    // A newer release found while an update waited for its restart replaces it.
    const replaces =
      state.kind === 'ready'
        ? state.version
        : state.kind === 'downloading'
          ? state.replaces
          : undefined
    // Before anything waits: a second Update then finds the download started, and the cancel
    // button that shows with it has a token to cancel; so does a download that replaces, whose
    // card stays up.
    const token = (startedBy === 'user' || replaces) && this.Token ? new this.Token() : null
    this.startedBy = startedBy
    this.cancellation = token
    if (replaces)
      log.info(`Downloading ${version} to replace ${replaces}, which waits for a restart`)
    this.dispatch({ type: 'download-started', version, manual: startedBy === 'user', replaces })
    try {
      const updater = await this.load()
      this.applyInstallOnQuit(updater, this.deps.settings())
      if (this.mode === 'link') await this.downloadDiskImage(token)
      else await this.downloadFromSources(updater, token)
    } catch (error) {
      if (token?.cancelled) {
        this.dispatch({ type: 'download-cancelled' })
        return
      }
      const message = errorMessage(error)
      this.dispatch({ type: 'error', message, manual: this.manual })
      if (this.manual) throw new Error(message, { cause: error })
    } finally {
      this.downloadActive = false
      if (this.cancellation === token) this.cancellation = null
    }
  }

  /**
   * Link mode's Update: downloads the release's disk image from the sources, checks it against the
   * checksum of the signed update file and opens it, so the user drags the app into Applications.
   */
  private async downloadDiskImage(cancellation: CancellationToken | null): Promise<void> {
    const { run, downloadFile, lastAvailable: version } = this
    if (!run || !downloadFile || !version) throw new Error(t('updates.checkFirst'))
    const image = diskImageFor(this.lastFiles, process.arch)
    if (!image) throw new Error(t('updater.noDiskImage'))
    const abort = new AbortController()
    const cancel = (): void => abort.abort()
    cancellation?.once('cancel', cancel)
    let file: string
    try {
      file = await downloadDiskImage({
        run: run.again(),
        version,
        image,
        folder: join(app.getPath('userData'), 'updates'),
        download: downloadFile,
        signal: abort.signal,
        githubOnly: () => this.sourceChoice() === 'github',
        setLeave: (leave) => {
          this.leaveSource = leave
        },
        progress: (percent) => this.dispatch({ type: 'progress', percent }),
        log,
      })
    } finally {
      cancellation?.off('cancel', cancel)
    }
    // Cancel pressed while the file was being checked.
    if (abort.signal.aborted) throw new Error('Download cancelled')
    const failure = await shell.openPath(file)
    if (failure) {
      log.warn(`Could not open ${file}: ${failure}`)
      throw new Error(t('updater.openFailed', { reason: failure }))
    }
    log.info(`Opened ${file}`)
    this.dispatch({ type: 'disk-image-opened' })
  }

  /**
   * Downloads the update the check found from the source that served the check, and then from
   * each source after it: one that fails, or makes no progress for the list's stall time, hands
   * the same version on to the next.
   */
  private async downloadFromSources(
    updater: AppUpdater,
    cancellation: CancellationToken | null,
  ): Promise<void> {
    const Token = this.Token
    if (!Token || !this.run) {
      await updater.downloadUpdate(cancellation ?? undefined)
      return
    }
    let run = this.run.again()
    for (;;) {
      // GitHub only, chosen since the check, sends nothing more to any other source.
      if (this.sourceChoice() === 'github' && !run.githubOnly) {
        run = SourceRun.githubOnly(run.stallMs)
      }
      // The provider resolves the files on this run's source.
      this.run = run
      const { current: source, stallMs } = run
      const attempt = new Token(cancellation ?? undefined)
      let stalled = false
      let left = false
      // GitHub only, chosen during the download, stops this source at once.
      if (source !== GITHUB_SOURCE) {
        this.leaveSource = () => {
          left = true
          attempt.cancel()
        }
      }
      let downloaded = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const watch = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          stalled = true
          attempt.cancel()
        }, stallMs)
      }
      // After the last byte come only the local steps: the checksum, the signature, installing.
      const onProgress = (progress: ProgressInfo): void => {
        if (progress.percent >= 100) clearTimeout(timer)
        else watch()
      }
      const onDownloaded = (): void => {
        downloaded = true
        clearTimeout(timer)
      }
      updater.on('download-progress', onProgress)
      updater.on('update-downloaded', onDownloaded)
      log.info(`Downloading the update from ${source.id} (${source.url})`)
      watch()
      try {
        await updater.downloadUpdate(attempt)
        return
      } catch (error) {
        // Squirrel.Mac's and the Windows publisher's checks fail the same on the same bytes.
        if (cancellation?.cancelled || downloaded || errorCode(error) === INVALID_PUBLISHER) {
          throw error
        }
        if (left) {
          log.info(`Moving the download from ${source.id} to GitHub, now the only source`)
          continue
        }
        const reason = stalled ? `no progress for ${stallMs / 1000} s` : errorMessage(error)
        const next = run.next()
        if (!next) {
          log.warn(`Could not download from ${source.id}: ${reason}; no source is left`)
          throw stalled ? new Error(t('updater.stalled', { seconds: stallMs / 1000 })) : error
        }
        log.warn(`Could not download from ${source.id}: ${reason}; moving on to ${next.id}`)
      } finally {
        this.leaveSource = null
        clearTimeout(timer)
        updater.off('download-progress', onProgress)
        updater.off('update-downloaded', onDownloaded)
        attempt.dispose()
      }
    }
  }

  /** Whether a version found is newer than the update waiting for a restart, if one is. */
  private newerThanReady(version: string): boolean {
    const { state } = this.status
    return state.kind !== 'ready' || compareVersions(version, state.version) > 0
  }

  /** A check runs while an update is ready, whose failure leaves the ready update as it was. */
  private checkPastReady(): boolean {
    return this.checking !== null && this.status.state.kind === 'ready'
  }

  private dispatch(event: UpdaterEvent): void {
    const state = nextState(this.status.state, event, {
      mode: this.mode,
      autoDownload: this.autoDownload(this.deps.settings()),
      lastCheckedAt: this.lastCheckedAt,
      lastAvailable: this.lastAvailable,
    })
    if (state !== this.status.state) this.publish({ ...this.status, state })
  }

  private publish(status: UpdateStatus): void {
    this.status = status
    broadcast('update:changed', status)
    this.deps.changed?.(status)
  }
}
