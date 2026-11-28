import { randomUUID } from 'node:crypto'
import { access, constants } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, autoUpdater as squirrel, shell } from 'electron'
import type { AppUpdater, CancellationToken, ProgressInfo, UpdateFileInfo } from 'electron-updater'
import type { Platform } from '@shared/platform'
import type { SettingsFile } from '@shared/settings'
import {
  LOCAL_UPDATE_INITIATOR,
  type UpdateBusySummary,
  type UpdateConfirmationAction,
  type UpdateConfirmationRequest,
  type UpdateHostConfirmation,
  type UpdateInitiator,
  type UpdateOutcome,
  type UpdateOutcomeCode,
  type UpdatePhase,
  type UpdateStatus,
} from '@shared/updates'
import type { AppStateStore } from './app-state'
import { loadAutoUpdater } from './auto-updater'
import { broadcast } from './events'
import { t } from './i18n'
import { createLogger } from './log'
import { sessionProxy } from './proxy'
import type { QuitRequestOptions, UpdateRestartPrepareResult } from './quit'
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
import {
  runWindowsInstaller,
  type WindowsInstallOptions,
  type WindowsInstallResult,
} from './windows-installer'

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

/** Subset of electron-updater's NsisUpdater internals read on Windows for host confirmation flow. */
interface NsisUpdaterInternals {
  installerPath?: string | null
  installDirectory?: string | null
  downloadedUpdateHelper?: {
    file?: string | null
    packageFile?: string | null
    downloadedFileInfo?: { isAdminRightsRequired?: boolean } | null
  } | null
}

type BaseUpdateStatus = Pick<
  UpdateStatus,
  'state' | 'mode' | 'readOnly' | 'current' | 'updatedFrom' | 'dismissed' | 'restartWhenIdle'
>

export interface UpdaterDeps {
  appState: AppStateStore
  settings(): SettingsFile
  /**
   * Restarts through the quit flow, which asks about running work unless `confirmed`, and then
   * calls `installNow`. `resumeAfterUpdate` marks an immediate user-initiated update restart whose
   * interrupted sessions should resume after relaunch. False when another quit or restart is in
   * progress.
   */
  requestRestart(
    confirmed: boolean,
    resumeAfterUpdate?: boolean,
    options?: QuitRequestOptions,
  ): boolean
  /** Clears any staged update-resume record if installing the update is skipped or fails. */
  clearUpdateResume?(): Promise<void>
  /** How many sessions are working in a way a restart can wait for. */
  waitableSessions(): Promise<number>
  /** How many terminals currently have a foreground command running. */
  busyTerminals?(): Promise<number>
  /** Moves the app through the quit flow, which confirms and then calls `moveNow`. */
  requestMove(options?: QuitRequestOptions): void
  /** Resolves a pending update timing confirmation in QuitFlow. */
  respondUpdateConfirmation?(
    requestId: string,
    action: UpdateConfirmationAction,
    by: 'local' | 'remote',
  ): boolean
  /** Cancels a pending update timing confirmation in QuitFlow (for example when device access is revoked). */
  cancelPendingUpdateConfirmation?(requestId: string, code?: UpdateOutcomeCode): boolean
  /** Waits until connected remote devices have received prior `updates.changed` broadcasts. */
  flushRemoteEvents?(): Promise<void>
  /** Test seam for Windows NSIS installer execution and UAC confirmation handling. */
  runWindowsInstaller?: (options: WindowsInstallOptions) => Promise<WindowsInstallResult>
  /** Test seam for host platform; defaults to `process.platform`. */
  platform?: Platform
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
  private readonly platform: Platform
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
  /** The next look while a restart waits for sessions or busy terminals to finish. */
  private waitTimer: ReturnType<typeof setTimeout> | null = null
  /** Counts each wait and each end of one, so a look an earlier wait started stops. */
  private waitRun = 0
  /** Looks in a row that found no session or terminal to wait for. */
  private idlePolls = 0
  /**
   * macOS: Squirrel.Mac preparing the update just downloaded. Until it has, a restart would install
   * the update it prepared before, as electron-updater only knows that one was prepared.
   */
  private squirrelPreparing: Promise<void> | null = null
  /** Active or most recently settled request id for remote/local update tracking. */
  private activeRequestId: string | null = null
  /** Initiator of the current or most recent update operation. */
  private activeInitiator: UpdateInitiator | null = null
  /** True right after an update or restart request is accepted before the next state arrives. */
  private acceptedPhase = false
  /** Pending timing confirmation while QuitFlow waits for a choice. */
  private confirmation: UpdateConfirmationRequest | null = null
  /** Pending native OS confirmation on Windows (UAC/SmartScreen) or macOS (Applications move). */
  private hostConfirmation: UpdateHostConfirmation | null = null
  /** True once the host is stopping and handing off to the installer to restart. */
  private restartingPhase = false
  /** Most recent terminal cancellation or failure outcome until superseded by a new operation. */
  private outcome: UpdateOutcome | null = null
  /** Source of an in-flight manual download cancellation. */
  private cancelSource: 'local' | 'remote' = 'local'
  /** Set on Windows when `prepareRestartForInstall` already launched the installer after confirmation. */
  private alreadyLaunchedInstaller = false

  constructor(private readonly deps: UpdaterDeps) {
    const current = app.getVersion()
    const { lastRunVersion, dismissedUpdate, updateAfterMove } = deps.appState.get()
    this.platform = deps.platform ?? process.platform
    this.mode = updateMode(this.platform, import.meta.env.MAIN_VITE_UPDATE_MODE)
    this.status = this.compose({
      state: offReason(app.isPackaged, this.platform, process.env) ?? {
        kind: 'idle',
        checkedAt: null,
      },
      mode: this.mode,
      readOnly: false,
      current,
      updatedFrom: updatedFrom(lastRunVersion, current),
      dismissed: dismissedUpdate,
      restartWhenIdle: null,
    })
    this.afterMove = updateAfterMove
    deps.appState.update({ lastRunVersion: current, updateAfterMove: null })
    this.located = this.locate()
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** Version currently downloaded or available, for confirmation metadata. */
  targetVersion(): string | null {
    const { state } = this.status
    if (
      state.kind === 'ready' ||
      state.kind === 'available' ||
      state.kind === 'downloading' ||
      state.kind === 'moving'
    ) {
      return state.version
    }
    return this.lastAvailable
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
    this.outcome = null
    await this.runCheck(true)
    return this.status
  }

  /** Update: downloads the update found, then restarts once it is ready. */
  async download(initiator: UpdateInitiator = LOCAL_UPDATE_INITIATOR): Promise<void> {
    const { run } = this.beginDownload(initiator)
    if (run) await run
  }

  /**
   * Remote Update entry point: synchronously validates, records the accepted request and starts
   * downloading or moving without racing on async status waiters, returning the updated status.
   */
  startRemoteDownload(initiator: UpdateInitiator): UpdateStatus {
    if (this.status.state.kind === 'downloading') return this.status
    const { run } = this.beginDownload(initiator)
    run?.catch(() => undefined)
    return this.status
  }

  private beginDownload(initiator: UpdateInitiator): { run: Promise<void> | null } {
    const off = this.status.state
    if (off.kind === 'off') {
      throw new Error(
        off.reason === 'development' ? t('updater.offDevelopment') : t('updater.offPackageManager'),
      )
    }
    const { state } = this.status
    if (state.kind !== 'available') throw new Error(t('updater.nothingToDownload'))
    const requestId = randomUUID()
    this.activeRequestId = requestId
    this.activeInitiator = initiator
    this.outcome = null
    this.acceptedPhase = true
    this.publish()
    if (this.readOnly) {
      this.deps.requestMove(initiator.kind === 'remote' ? { initiator, requestId } : undefined)
      return { run: null }
    }
    this.manual = true
    return { run: this.startDownload(state.version, 'user') }
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
    this.acceptedPhase = false
    this.hostConfirmation = {
      platform: 'darwin',
      kind: 'macos_authorization',
      version: state.version,
      initiator: this.activeInitiator ?? LOCAL_UPDATE_INITIATOR,
      startedAt: Date.now(),
    }
    this.dispatch({ type: 'moving', version: state.version })
    await this.deps.flushRemoteEvents?.()
    this.deps.appState.update({ updateAfterMove: state.version })
    await new Promise((done) => setTimeout(done, MOVE_PAINT_MS))
    let moved: boolean
    try {
      moved = app.moveToApplicationsFolder()
    } catch (error) {
      if (!moveCancelled(error)) {
        this.hostConfirmation = null
        this.deps.appState.update({ updateAfterMove: null })
        this.moveFailed(errorMessage(error))
        return false
      }
      moved = false
    }
    this.hostConfirmation = null
    if (moved) {
      this.restartingPhase = true
      this.publish()
      await this.deps.flushRemoteEvents?.()
      return true
    }
    log.info('Moving the app to /Applications was cancelled')
    this.deps.appState.update({ updateAfterMove: null })
    this.outcome = {
      kind: 'cancelled',
      code: 'host_confirmation_cancelled',
      requestId: this.activeRequestId,
      by: 'host',
      at: Date.now(),
    }
    this.dispatch({ type: 'move-cancelled' })
    return false
  }

  /**
   * Stops a running download, a pending timing confirmation, or an idle wait, returning the
   * resulting status.
   */
  cancel(by: 'local' | 'remote' = 'local'): UpdateStatus {
    if (this.status.state.kind === 'downloading') {
      this.cancelSource = by
      this.cancellation?.cancel()
      return this.status
    }
    if (this.confirmation) {
      this.deps.respondUpdateConfirmation?.(this.confirmation.requestId, 'cancel', by)
      return this.status
    }
    if (this.status.restartWhenIdle) {
      this.cancelRestartWhenIdle(by)
      return this.status
    }
    return this.status
  }

  restart(initiator: UpdateInitiator = LOCAL_UPDATE_INITIATOR): UpdateStatus {
    if (this.status.state.kind !== 'ready') throw new Error(t('updater.nothingReady'))
    if (this.confirmation || this.hostConfirmation || this.restartingPhase) {
      return this.status
    }
    this.stopWaiting(false)
    const requestId = randomUUID()
    this.activeRequestId = requestId
    this.activeInitiator = initiator
    this.outcome = null
    this.acceptedPhase = true
    this.publish()
    const started =
      initiator.kind === 'remote'
        ? this.deps.requestRestart(false, true, { initiator, requestId })
        : this.deps.requestRestart(false, true)
    if (!started) {
      this.acceptedPhase = false
      this.outcome = {
        kind: 'failed',
        code: 'restart_failed',
        message: 'Another quit or restart is already in progress',
        requestId,
        by: 'host',
        at: Date.now(),
      }
      this.publish()
    }
    return this.status
  }

  /** Responds to an active timing confirmation request (`now`, `whenIdle`, or `cancel`). */
  confirm(
    requestId: string,
    action: UpdateConfirmationAction,
    initiator: UpdateInitiator,
  ): UpdateStatus {
    const pending = this.confirmation
    if (!pending || pending.requestId !== requestId) {
      throw new Error('No matching pending update confirmation')
    }
    if (!pending.choices.includes(action)) {
      throw new Error(`Action "${action}" is not allowed for this update confirmation`)
    }
    if (action === 'now') {
      // Keep the transition smooth (awaiting_confirmation -> accepted -> restarting) without flashing back to ready.
      this.acceptedPhase = true
    }
    const answered =
      this.deps.respondUpdateConfirmation?.(requestId, action, initiator.kind) ?? false
    if (!answered) {
      this.acceptedPhase = false
      throw new Error('No matching pending update confirmation')
    }
    return this.status
  }

  /** Cancels a pending remote confirmation if the initiating device lost access. */
  revokeRemoteDevice(deviceId: string): void {
    const pending = this.confirmation
    if (pending && pending.initiator.kind === 'remote' && pending.initiator.deviceId === deviceId) {
      this.deps.cancelPendingUpdateConfirmation?.(pending.requestId, 'permission_revoked')
    }
  }

  /** Called by QuitFlow when a timing confirmation opens or clears. */
  handleUpdateConfirmation(confirmation: UpdateConfirmationRequest | null): void {
    if (confirmation) {
      this.acceptedPhase = false
      this.outcome = null
      this.confirmation = confirmation
      this.activeRequestId = confirmation.requestId
      this.activeInitiator = confirmation.initiator
      this.publish()
      return
    }
    if (!this.confirmation) return
    this.confirmation = null
    this.publish()
  }

  /** Called by QuitFlow when an update confirmation is cancelled. */
  handleUpdateCancelled(info: {
    requestId: string | null
    by: 'local' | 'remote' | 'host'
    code: UpdateOutcomeCode
  }): void {
    this.acceptedPhase = false
    this.confirmation = null
    this.hostConfirmation = null
    this.restartingPhase = false
    this.outcome = {
      kind: 'cancelled',
      code: info.code,
      requestId: info.requestId ?? this.activeRequestId,
      by: info.by,
      at: Date.now(),
    }
    this.publish()
  }

  /**
   * Called by QuitFlow right before `shutDown()` so remote clients receive the restarting state
   * (or Windows native host confirmation state and outcome) while the connection is still alive.
   */
  async prepareRestartForInstall(info: {
    requestId: string | null
    initiator: UpdateInitiator
  }): Promise<UpdateRestartPrepareResult> {
    this.acceptedPhase = false
    this.confirmation = null
    this.stopWaiting(false)
    this.alreadyLaunchedInstaller = false
    if (this.shuttingDown) return 'proceed'

    if (this.platform === 'win32') {
      const updater = this.loadedUpdater ?? (await this.load().catch(() => null))
      const nsis = updater as (AppUpdater & NsisUpdaterInternals) | null
      const installerPath = nsis?.installerPath ?? nsis?.downloadedUpdateHelper?.file ?? null
      if (installerPath) {
        const isAdminRightsRequired =
          nsis?.downloadedUpdateHelper?.downloadedFileInfo?.isAdminRightsRequired === true
        const runner = this.deps.runWindowsInstaller ?? runWindowsInstaller
        const version = this.targetVersion()
        const result = await runner({
          installerPath,
          isSilent: true,
          isForceRunAfter: true,
          isAdminRightsRequired,
          installDirectory: nsis?.installDirectory ?? null,
          packagePath: nsis?.downloadedUpdateHelper?.packageFile ?? null,
          execPath: process.execPath,
          resourcesPath: process.resourcesPath,
          onAwaitingHostConfirmation: async () => {
            this.hostConfirmation = {
              platform: 'win32',
              kind: 'windows_system',
              version,
              initiator: info.initiator,
              startedAt: Date.now(),
            }
            this.publish()
            await this.deps.flushRemoteEvents?.()
          },
        })
        this.hostConfirmation = null
        if (result.kind === 'launched') {
          if (updater) updater.autoInstallOnAppQuit = false
          this.alreadyLaunchedInstaller = true
          this.restartingPhase = true
          this.publish()
          await this.deps.flushRemoteEvents?.()
          return 'launched'
        }
        this.restartingPhase = false
        this.outcome = {
          kind: result.kind === 'cancelled' ? 'cancelled' : 'failed',
          code: result.code,
          message: result.message,
          requestId: info.requestId ?? this.activeRequestId,
          by: 'host',
          at: Date.now(),
        }
        this.publish()
        return 'aborted'
      }
    }

    this.restartingPhase = true
    this.publish()
    await this.deps.flushRemoteEvents?.()
    return 'proceed'
  }

  /** Restart now, from the update dialog, which already showed the work it stops. */
  restartConfirmed(): void {
    if (this.status.state.kind !== 'ready') throw new Error(t('updater.nothingReady'))
    this.stopWaiting(false)
    this.activeRequestId = randomUUID()
    this.activeInitiator = LOCAL_UPDATE_INITIATOR
    this.outcome = null
    this.acceptedPhase = true
    this.publish()
    this.deps.requestRestart(true, true)
  }

  /**
   * Restarts into the update by itself once no session or terminal works in a way that ends by
   * itself, as the user chose; a newer update downloading then is waited for too.
   */
  async restartWhenIdle(
    initiator?: UpdateInitiator,
    requestId?: string,
    initialBusy?: UpdateBusySummary,
  ): Promise<void> {
    if (this.status.state.kind !== 'ready') throw new Error(t('updater.nothingReady'))
    if (this.status.restartWhenIdle) return
    log.info('The restart to update waits for the running work to finish')
    this.acceptedPhase = false
    this.confirmation = null
    this.outcome = null
    if (initiator) this.activeInitiator = initiator
    if (requestId) this.activeRequestId = requestId
    if (initialBusy) {
      this.publish({
        ...this.status,
        restartWhenIdle: {
          sessions: initialBusy.waitableSessions,
          terminals: initialBusy.terminals,
        },
      })
    }
    const run = ++this.waitRun
    this.idlePolls = 0
    await this.lookForIdle(run)
  }

  /** Stops waiting to restart; the update stays ready. */
  cancelRestartWhenIdle(by: 'local' | 'remote' = 'local'): void {
    const wasWaiting = this.status.restartWhenIdle !== null
    if (wasWaiting) log.info('The restart to update no longer waits')
    // Also before the first look has answered, when nothing shows the wait yet.
    this.stopWaiting(false)
    if (wasWaiting) {
      this.outcome = {
        kind: 'cancelled',
        code: 'user_cancelled',
        requestId: this.activeRequestId,
        by,
        at: Date.now(),
      }
      this.publish()
    }
  }

  private stopWaiting(publishNow = true): void {
    this.waitRun++
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.waitTimer = null
    this.idlePolls = 0
    if (this.status.restartWhenIdle) {
      this.status = this.compose({ ...this.status, restartWhenIdle: null })
      if (publishNow) this.emitStatus(this.status)
    }
  }

  private async lookForIdle(run: number): Promise<void> {
    this.waitTimer = null
    const [sessions, terminals] = await Promise.all([
      this.deps.waitableSessions(),
      this.deps.busyTerminals ? this.deps.busyTerminals() : Promise.resolve(0),
    ])
    // Cancelled, or restarted now, while the hosts answered.
    if (run !== this.waitRun) return
    const { kind } = this.status.state
    if (kind !== 'ready' && kind !== 'downloading') {
      log.info(`The restart to update no longer waits: the update is ${kind}`)
      this.stopWaiting()
      return
    }
    const currentWait = this.status.restartWhenIdle
    if (currentWait?.sessions !== sessions || (currentWait?.terminals ?? 0) !== terminals) {
      this.publish({
        ...this.status,
        restartWhenIdle: terminals > 0 ? { sessions, terminals } : { sessions },
      })
    }
    const idle = sessions === 0 && terminals === 0 && kind === 'ready' && !this.squirrelPreparing
    this.idlePolls = idle ? this.idlePolls + 1 : 0
    if (this.idlePolls >= IDLE_POLLS) {
      // Wait-for-idle restarts only once running work finishes, so it never schedules post-update resume.
      const initiator = this.activeInitiator
      const requestId = this.activeRequestId ?? undefined
      const started =
        initiator?.kind === 'remote'
          ? this.deps.requestRestart(true, false, { initiator, requestId })
          : this.deps.requestRestart(true, false)
      if (started) {
        log.info('The running work finished: restarting to update')
        this.acceptedPhase = true
        this.stopWaiting(false)
        this.publish()
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
    if (this.alreadyLaunchedInstaller) {
      app.quit()
      return
    }
    let updater: AppUpdater
    try {
      updater = await this.load()
    } catch (error) {
      this.restartingPhase = false
      this.outcome = {
        kind: 'failed',
        code: 'install_failed',
        message: errorMessage(error),
        requestId: this.activeRequestId,
        by: 'host',
        at: Date.now(),
      }
      this.publish()
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
      this.restartingPhase = false
      this.outcome = {
        kind: 'failed',
        code: 'install_failed',
        message: errorMessage(error),
        requestId: this.activeRequestId,
        by: 'host',
        at: Date.now(),
      }
      this.publish()
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
    if (this.platform !== 'darwin' || this.mode !== 'install') return
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
        autoUpdater.disableDifferentialDownload = this.platform === 'win32'
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
          if (this.platform === 'darwin' && autoUpdater.autoInstallOnAppQuit) {
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
          if (this.startedBy === 'user') {
            const initiator = this.activeInitiator
            const requestId = this.activeRequestId ?? undefined
            this.acceptedPhase = true
            this.publish()
            const started =
              initiator?.kind === 'remote'
                ? this.deps.requestRestart(false, true, { initiator, requestId })
                : this.deps.requestRestart(false, true)
            if (!started) {
              this.acceptedPhase = false
              this.outcome = {
                kind: 'failed',
                code: 'restart_failed',
                message: 'Another quit or restart is already in progress',
                requestId: requestId ?? null,
                by: 'host',
                at: Date.now(),
              }
              this.publish()
            }
          }
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
    let lifecycleChanged = false
    switch (event.type) {
      case 'download-started':
        if (this.acceptedPhase || this.outcome !== null) lifecycleChanged = true
        this.acceptedPhase = false
        this.outcome = null
        break
      case 'downloaded':
        if (this.acceptedPhase || this.outcome !== null) lifecycleChanged = true
        this.acceptedPhase = false
        this.outcome = null
        break
      case 'download-cancelled':
        this.acceptedPhase = false
        this.outcome = {
          kind: 'cancelled',
          code: 'user_cancelled',
          requestId: this.activeRequestId,
          by: this.cancelSource,
          at: Date.now(),
        }
        this.cancelSource = 'local'
        lifecycleChanged = true
        break
      case 'move-failed':
        this.acceptedPhase = false
        this.hostConfirmation = null
        this.restartingPhase = false
        this.outcome = {
          kind: 'failed',
          code: 'move_failed',
          message: event.message,
          requestId: this.activeRequestId,
          by: 'host',
          at: Date.now(),
        }
        lifecycleChanged = true
        break
      case 'error':
      case 'load-failed':
        if (event.manual || state.kind === 'error') {
          this.acceptedPhase = false
          this.hostConfirmation = null
          this.restartingPhase = false
          this.outcome = {
            kind: 'failed',
            code: this.downloadActive ? 'download_failed' : 'check_failed',
            message: event.message,
            requestId: this.activeRequestId,
            by: 'host',
            at: Date.now(),
          }
          lifecycleChanged = true
        }
        break
      case 'checking':
        if (event.manual && this.outcome !== null) {
          this.outcome = null
          lifecycleChanged = true
        }
        break
      case 'moving':
        if (this.acceptedPhase) {
          this.acceptedPhase = false
          lifecycleChanged = true
        }
        break
      default:
        break
    }
    if (state !== this.status.state || lifecycleChanged) {
      this.publish({ ...this.status, state })
    }
  }

  private compose(base: BaseUpdateStatus): UpdateStatus {
    const { state } = base
    let outcome = this.outcome
    if (!outcome && state.kind === 'error') {
      outcome = {
        kind: 'failed',
        code: state.move ? 'move_failed' : 'unknown',
        message: state.message,
        requestId: this.activeRequestId,
        by: 'host',
        at: Date.now(),
      }
    }
    let phase: UpdatePhase
    if (state.kind === 'off') phase = 'off'
    else if (this.hostConfirmation) phase = 'awaiting_host_confirmation'
    else if (this.restartingPhase) phase = 'restarting'
    else if (this.confirmation) phase = 'awaiting_confirmation'
    else if (base.restartWhenIdle) phase = 'waiting_for_idle'
    else if (this.acceptedPhase) phase = 'accepted'
    else if (outcome) phase = outcome.kind === 'failed' ? 'failed' : 'cancelled'
    else if (state.kind === 'error') phase = 'failed'
    else phase = state.kind

    return {
      state: base.state,
      mode: base.mode,
      readOnly: base.readOnly,
      current: base.current,
      updatedFrom: base.updatedFrom,
      dismissed: base.dismissed,
      restartWhenIdle: base.restartWhenIdle,
      phase,
      requestId: this.confirmation?.requestId ?? this.activeRequestId,
      initiator:
        this.confirmation?.initiator ?? this.hostConfirmation?.initiator ?? this.activeInitiator,
      confirmation: this.confirmation,
      hostConfirmation: this.hostConfirmation,
      outcome,
      progress: state.kind === 'downloading' ? state.percent : null,
    }
  }

  private publish(base: BaseUpdateStatus = this.status): void {
    const status = this.compose(base)
    this.status = status
    this.emitStatus(status)
  }

  private emitStatus(status: UpdateStatus): void {
    broadcast('update:changed', status)
    this.deps.changed?.(status)
  }
}
