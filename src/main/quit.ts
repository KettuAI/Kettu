import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import type { BusySession, BusyTerminal } from '@shared/host-control'
import type { QuitRequest } from '@shared/ipc'
import type { SettingsFile } from '@shared/settings'
import { sendEvent } from './events'
import { t } from './i18n'
import { createLogger } from './log'
import { currentWindow } from './window'

const log = createLogger('quit')

const BUSY_TIMEOUT_MS = 2000
// If installing an update does not quit the app, quit anyway: the hosts are already stopped.
const INSTALL_FALLBACK_MS = 10_000

export interface QuitDeps {
  settings(): SettingsFile
  busySessions(timeoutMs: number): Promise<BusySession[]>
  busyTerminals(timeoutMs: number): Promise<BusyTerminal[]>
  /** Stops both hosts and flushes every pending write. */
  shutDown(): Promise<void>
  installUpdate(): Promise<void>
}

type Phase = 'idle' | 'asking' | 'stopping' | 'done'

interface PendingAnswer {
  request: QuitRequest
  webContents: WebContents | null
  resolve(confirmed: boolean): void
}

/**
 * Every way out of the app, including a restart to update: ask when agents or terminal
 * commands are running, then stop the hosts cleanly and flush state before quitting.
 */
export class QuitFlow {
  private phase: Phase = 'idle'
  private nextId = 1
  private pending: PendingAnswer | null = null
  private systemShuttingDown = false

  constructor(private readonly deps: QuitDeps) {
    app.on('before-quit', (event) => {
      if (this.phase === 'done') return
      event.preventDefault()
      this.request('quit')
    })
  }

  get quitting(): boolean {
    return this.phase === 'done'
  }

  request(reason: QuitRequest['reason']): void {
    if (this.phase !== 'idle') return
    void this.run(reason).catch((error: unknown) => {
      log.error('Quit failed; quitting anyway', error)
      this.phase = 'done'
      app.quit()
    })
  }

  /** The renderer's answer to `app:confirm-quit`. */
  respond(id: number, confirmed: boolean): void {
    if (this.pending?.request.id !== id) return
    this.pending.resolve(confirmed)
  }

  /** The page had no listener for `app:confirm-quit`; ask natively instead. */
  unhandled(id: number, webContents: WebContents): void {
    if (this.pending?.request.id !== id || this.pending.webContents !== webContents) return
    void this.askNatively(this.pending)
  }

  /** On Windows and Linux, closing the last window quits, so it goes through the flow first. */
  watchWindow(window: BrowserWindow): void {
    if (process.platform === 'darwin') return
    window.on('close', (event) => {
      if (this.phase === 'done') return
      if (BrowserWindow.getAllWindows().filter((other) => !other.isDestroyed()).length > 1) return
      event.preventDefault()
      this.request('quit')
    })
  }

  /** The system is going down: no question would get an answer in time. */
  systemShutdown(): void {
    this.systemShuttingDown = true
  }

  private async run(reason: QuitRequest['reason']): Promise<void> {
    this.phase = 'asking'
    if (this.deps.settings().general.confirmQuitWhileRunning && !this.systemShuttingDown) {
      const [sessions, terminals] = await Promise.all([
        this.deps.busySessions(BUSY_TIMEOUT_MS),
        this.deps.busyTerminals(BUSY_TIMEOUT_MS),
      ])
      if (sessions.length > 0 || terminals.length > 0) {
        const confirmed = await this.ask({ id: this.nextId++, reason, sessions, terminals })
        if (!confirmed) {
          log.info(`${reason === 'update' ? 'Restart' : 'Quit'} cancelled`)
          this.phase = 'idle'
          return
        }
      }
    }
    this.phase = 'stopping'
    const started = performance.now()
    await this.deps.shutDown()
    log.info(`Hosts stopped and state flushed in ${(performance.now() - started).toFixed(1)} ms`)
    this.phase = 'done'
    if (reason === 'update') {
      setTimeout(() => app.quit(), INSTALL_FALLBACK_MS).unref()
      await this.deps.installUpdate()
    } else {
      app.quit()
    }
  }

  private ask(request: QuitRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const window = currentWindow()
      const webContents = window && !window.webContents.isDestroyed() ? window.webContents : null
      // A page that goes away mid-question cannot answer; fall back to a native dialog.
      const fallBack = (): void => {
        if (this.pending === pending) void this.askNatively(pending)
      }
      const onNavigation = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ): void => {
        if (details.isMainFrame && !details.isSameDocument) fallBack()
      }
      const pending: PendingAnswer = {
        request,
        webContents,
        resolve: (confirmed) => {
          if (this.pending !== pending) return
          this.pending = null
          if (webContents && !webContents.isDestroyed()) {
            webContents.off('destroyed', fallBack)
            webContents.off('did-start-navigation', onNavigation)
          }
          resolve(confirmed)
        },
      }
      this.pending = pending
      if (!window || !webContents || webContents.isLoadingMainFrame()) {
        void this.askNatively(pending)
        return
      }
      webContents.once('destroyed', fallBack)
      webContents.on('did-start-navigation', onNavigation)
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      sendEvent(webContents, 'app:confirm-quit', request)
    })
  }

  private async askNatively(pending: PendingAnswer): Promise<void> {
    pending.webContents = null
    const { reason, sessions, terminals } = pending.request
    const update = reason === 'update'
    const window = currentWindow()
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: update ? t('quit.titleUpdate') : t('quit.titleQuit', { name: app.name }),
      detail: describeWork(sessions, terminals, update),
      buttons: [t('quit.cancel'), update ? t('quit.restart') : t('quit.quit')],
      cancelId: 0,
      defaultId: 1,
      noLink: true,
    }
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    pending.resolve(response === 1)
  }
}

export function describeWork(
  sessions: BusySession[],
  terminals: BusyTerminal[],
  update: boolean,
): string {
  const lines: string[] = []
  const separator = t('quit.listSeparator')
  if (sessions.length > 0) {
    const names = sessions.map((session) => session.title ?? t('quit.untitledSession'))
    lines.push(t('quit.sessionsWorking', { count: sessions.length, names: names.join(separator) }))
  }
  if (terminals.length > 0) {
    const names = terminals.map((terminal) => terminal.title)
    lines.push(
      t('quit.terminalsRunning', { count: terminals.length, names: names.join(separator) }),
    )
  }
  lines.push(update ? t('quit.stopsForUpdate') : t('quit.stops'))
  return lines.join('\n')
}
