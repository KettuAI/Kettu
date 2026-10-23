import { app } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { SettingsFile } from '@shared/settings'
import type { UpdateStatus } from '@shared/updates'
import type { AppStateStore } from './app-state'
import { broadcast } from './events'
import { createLogger } from './log'
import type { SettingsSection } from './settings-schema'
import {
  dismissTarget,
  errorMessage,
  nextState,
  offReason,
  type UpdateMode,
  type UpdaterEvent,
  updatedFrom,
  updateMode,
} from './update-state'

const log = createLogger('updater')

const FIRST_CHECK_MS = 30_000
const CHECK_INTERVAL_MS = 60 * 60 * 1000

export interface UpdaterDeps {
  appState: AppStateStore
  settings(): SettingsFile
  /** Restarts through the quit flow, which confirms and then calls `installNow`. */
  requestRestart(): void
}

/** Checks GitHub Releases through electron-updater, which loads only after the window shows. */
export class Updater {
  private status: UpdateStatus
  private readonly mode: UpdateMode
  private updater: Promise<AppUpdater> | null = null
  private manual = false
  private lastCheckedAt: number | null = null
  private lastAvailable: string | null = null
  private checking: Promise<void> | null = null
  private started = false
  private errorEvents = 0

  constructor(private readonly deps: UpdaterDeps) {
    const current = app.getVersion()
    const { lastRunVersion, dismissedUpdate } = deps.appState.get()
    this.mode = updateMode(process.platform, import.meta.env.MAIN_VITE_UPDATE_MODE)
    this.status = {
      state: offReason(app.isPackaged, process.platform, process.env) ?? {
        kind: 'idle',
        checkedAt: null,
      },
      current,
      updatedFrom: updatedFrom(lastRunVersion, current),
      dismissed: dismissedUpdate,
    }
    deps.appState.update({ lastRunVersion: current })
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** Schedules the first check 30 s from now and then one every hour. */
  start(): void {
    if (this.started || this.status.state.kind === 'off') return
    this.started = true
    log.info(`Updates in ${this.mode} mode`)
    setTimeout(() => {
      void this.automaticCheck()
      setInterval(() => void this.automaticCheck(), CHECK_INTERVAL_MS).unref()
    }, FIRST_CHECK_MS).unref()
  }

  /** A check the user asked for; its errors are shown. Resolves once it has finished. */
  async check(): Promise<UpdateStatus> {
    const { kind } = this.status.state
    if (kind === 'off' || kind === 'ready' || kind === 'downloading') return this.status
    await this.runCheck(true)
    return this.status
  }

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
    this.manual = true
    await this.startDownload(state.version)
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
      const { state } = this.status
      if (updater.autoDownload && state.kind === 'available') {
        this.manual = false
        void this.startDownload(state.version)
      }
    })
  }

  private autoDownload(settings: SettingsFile): boolean {
    return this.mode === 'install' && settings.updates.automatic === 'download'
  }

  private load(): Promise<AppUpdater> {
    this.updater ??= import('electron-updater').then(({ autoUpdater }) => {
      const settings = this.deps.settings()
      autoUpdater.logger = {
        info: (message?: unknown) => log.info(String(message)),
        warn: (message?: unknown) => log.warn(String(message)),
        error: (message?: unknown) => log.error(String(message)),
      }
      autoUpdater.allowPrerelease = false
      autoUpdater.allowDowngrade = false
      autoUpdater.autoDownload = this.autoDownload(settings)
      autoUpdater.autoInstallOnAppQuit = this.mode === 'install'
      // Releases carry no NSIS blockmap, so the Windows installer always downloads whole.
      autoUpdater.disableDifferentialDownload = process.platform === 'win32'
      autoUpdater.on('checking-for-update', () =>
        this.dispatch({ type: 'checking', manual: this.manual }),
      )
      autoUpdater.on('update-available', (info) => {
        this.lastAvailable = info.version
        this.dispatch({ type: 'available', version: info.version })
      })
      autoUpdater.on('update-not-available', () => {
        this.lastAvailable = null
        this.lastCheckedAt = Date.now()
        this.dispatch({ type: 'not-available', at: this.lastCheckedAt })
      })
      autoUpdater.on('download-progress', (progress) =>
        this.dispatch({ type: 'progress', percent: progress.percent }),
      )
      autoUpdater.on('update-downloaded', (info) =>
        this.dispatch({ type: 'downloaded', version: info.version }),
      )
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
    const { proxy } = settings
    try {
      if (proxy.mode === 'custom') {
        // Chromium wants scheme://host:port, without a path or credentials.
        const url = new URL(proxy.url)
        await updater.netSession.setProxy({
          proxyRules: `${url.protocol}//${url.host}`,
          proxyBypassRules: proxy.noProxy,
        })
      } else {
        await updater.netSession.setProxy({ mode: 'system' })
      }
    } catch (error) {
      log.error('Could not apply the proxy to updates', error)
    }
  }

  private async automaticCheck(): Promise<void> {
    if (this.deps.settings().updates.automatic === 'off') return
    const { kind } = this.status.state
    if (kind === 'ready' || kind === 'downloading' || kind === 'checking') return
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
    this.checking = this.load()
      .then((updater) => updater.checkForUpdates())
      .then(
        () => undefined,
        (error: unknown) => {
          // electron-updater reports its own failures through 'error' as well; anything else,
          // such as failing to load it, has to reach the state here.
          if (this.errorEvents === errorsBefore) {
            this.dispatch({ type: 'error', message: errorMessage(error), manual: this.manual })
          }
        },
      )
      .finally(() => {
        this.checking = null
      })
    return this.checking
  }

  private async startDownload(version: string): Promise<void> {
    const errorsBefore = this.errorEvents
    try {
      const updater = await this.load()
      this.dispatch({ type: 'download-started', version })
      await updater.downloadUpdate()
    } catch (error) {
      const message = errorMessage(error)
      if (this.errorEvents === errorsBefore) {
        this.dispatch({ type: 'error', message, manual: this.manual })
      }
      if (this.manual) throw new Error(message, { cause: error })
    }
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
  }
}
