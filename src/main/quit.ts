import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import type { BusySession, BusyTerminal } from '@shared/host-control'
import type { QuitRequest, UnsavedFile } from '@shared/ipc'
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
  /** Update on a read-only volume: moves the app to /Applications; false when it stays. */
  moveApp(): Promise<boolean>
}

type Phase = 'idle' | 'asking' | 'stopping' | 'done'
type QuitReason = Exclude<QuitRequest['reason'], 'close'> | 'move'

interface PendingAnswer {
  request: QuitRequest
  webContents: WebContents | null
  resolve(confirmed: boolean): void
}

/**
 * Every way out of the app, including a restart to update: ask when agents or terminal
 * commands are running or files have unsaved edits, then stop the hosts cleanly and flush state
 * before quitting. On macOS it also asks before a window with unsaved edits closes.
 */
export class QuitFlow {
  private phase: Phase = 'idle'
  private nextId = 1
  private pending: PendingAnswer | null = null
  private systemShuttingDown = false
  /** Each page's files with unsaved edits, as it last said. */
  private readonly unsaved = new Map<number, UnsavedFile[]>()
  /** A window the user agreed to close with its unsaved edits. */
  private closing: BrowserWindow | null = null

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

  request(reason: QuitReason): void {
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

  /**
   * On Windows and Linux, closing the last window quits, so it goes through the flow first. On
   * macOS the app stays, but the page's unsaved edits would go, so that asks first.
   */
  watchWindow(window: BrowserWindow): void {
    if (process.platform === 'darwin') {
      window.on('close', (event) => {
        if (this.phase === 'done' || this.closing === window) return
        if (this.unsaved.get(window.webContents.id)?.length) {
          event.preventDefault()
          void this.confirmClose(window)
        }
      })
      return
    }
    window.on('close', (event) => {
      if (this.phase === 'done') return
      if (BrowserWindow.getAllWindows().filter((other) => !other.isDestroyed()).length > 1) return
      event.preventDefault()
      this.request('quit')
    })
  }

  /** A page's files with unsaved edits; they count until it changes them or goes away. */
  setUnsaved(webContents: WebContents, files: UnsavedFile[]): void {
    if (!this.unsaved.has(webContents.id)) {
      webContents.once('destroyed', () => this.unsaved.delete(webContents.id))
    }
    this.unsaved.set(webContents.id, files)
  }

  private unsavedFiles(): UnsavedFile[] {
    return [...this.unsaved.values()].flat()
  }

  /** The system is going down: no question would get an answer in time. */
  systemShutdown(): void {
    this.systemShuttingDown = true
  }

  private async confirmClose(window: BrowserWindow): Promise<void> {
    if (this.phase !== 'idle') return
    this.phase = 'asking'
    const unsaved = this.unsaved.get(window.webContents.id) ?? []
    const confirmed = await this.ask(
      { id: this.nextId++, reason: 'close', sessions: [], terminals: [], unsaved },
      window,
    )
    this.phase = 'idle'
    if (!confirmed || window.isDestroyed()) return
    this.closing = window
    window.close()
  }

  private async run(reason: QuitReason): Promise<void> {
    this.phase = 'asking'
    if (!this.systemShuttingDown) {
      // Unsaved edits are lost on quitting, so they ask whatever the setting says.
      const unsaved = this.unsavedFiles()
      const [sessions, terminals] = this.deps.settings().general.confirmQuitWhileRunning
        ? await Promise.all([
            this.deps.busySessions(BUSY_TIMEOUT_MS),
            this.deps.busyTerminals(BUSY_TIMEOUT_MS),
          ])
        : [[], []]
      if (sessions.length > 0 || terminals.length > 0 || unsaved.length > 0) {
        const confirmed = await this.ask({
          id: this.nextId++,
          // Moving the app restarts it to update, so it asks the same question.
          reason: reason === 'move' ? 'update' : reason,
          sessions,
          terminals,
          unsaved,
        })
        if (!confirmed) {
          log.info(`${reason === 'quit' ? 'Quit' : 'Restart'} cancelled`)
          this.phase = 'idle'
          return
        }
      }
    }
    this.phase = 'stopping'
    // Before the hosts stop, so a failed move leaves the app as it was. The move fires before-quit,
    // which is held while this runs, and opens the copy once this process has exited.
    if (reason === 'move' && !(await this.deps.moveApp())) {
      this.phase = 'idle'
      return
    }
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

  private ask(request: QuitRequest, target?: BrowserWindow): Promise<boolean> {
    return new Promise((resolve) => {
      const window = target ?? currentWindow()
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
    const { reason, sessions, terminals, unsaved } = pending.request
    const window = currentWindow()
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message:
        reason === 'update'
          ? t('quit.titleUpdate')
          : reason === 'close'
            ? t('quit.titleClose')
            : t('quit.titleQuit', { name: app.name }),
      detail: describeWork(sessions, terminals, reason === 'update', unsaved, reason),
      buttons: [t('quit.cancel'), confirmLabel(reason, unsaved.length > 0)],
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

function confirmLabel(reason: QuitRequest['reason'], unsaved: boolean): string {
  if (reason === 'close') return t('quit.closeWithoutSaving')
  if (reason === 'update') return unsaved ? t('quit.restartWithoutSaving') : t('quit.restart')
  return unsaved ? t('quit.quitWithoutSaving') : t('quit.quit')
}

export function describeWork(
  sessions: BusySession[],
  terminals: BusyTerminal[],
  update: boolean,
  unsaved: UnsavedFile[] = [],
  reason: QuitRequest['reason'] = update ? 'update' : 'quit',
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
  if (lines.length > 0) lines.push(update ? t('quit.stopsForUpdate') : t('quit.stops'))
  if (unsaved.length > 0) {
    const names = unsaved.map((file) => file.path.slice(file.path.lastIndexOf('/') + 1))
    lines.push(t('quit.filesUnsaved', { count: unsaved.length, names: names.join(separator) }))
    lines.push(
      reason === 'close'
        ? t('quit.losesOnClose')
        : reason === 'update'
          ? t('quit.losesOnRestart')
          : t('quit.losesOnQuit'),
    )
  }
  return lines.join('\n')
}
