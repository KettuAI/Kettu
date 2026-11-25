// The main window's page losing its process, which a fresh process often survives: the page loads
// again once, and when that fails too, a dialog offers to restart Kettu, so the window is never
// left hidden or empty with nothing said.

import { app, BrowserWindow, dialog } from 'electron'
import { t } from './i18n'
import { createLogger } from './log'
import { loadRenderer } from './renderer'
import { RestartPolicy, type RestartPolicyOptions } from './restart-policy'

const log = createLogger('window')

// Losing the page again within a minute of loading it again means another reload will not help.
const PAGE_POLICY: RestartPolicyOptions = {
  initialDelayMs: 0,
  maxDelayMs: 0,
  healthyAfterMs: 60_000,
  maxCrashes: 2,
  crashWindowMs: 60_000,
}

export interface PageRecoveryDeps {
  /** Restarts Kettu as the user's restart does, asking first about work it would stop. */
  restart(): void
  quit(): void
  quitting(): boolean
}

// Plain Electron until startup hands over the quit flow, which asks about running work first.
let deps: PageRecoveryDeps = {
  restart: () => {
    app.relaunch()
    app.quit()
  },
  quit: () => app.quit(),
  quitting: () => false,
}

export function configurePageRecovery(recoveryDeps: PageRecoveryDeps): void {
  deps = recoveryDeps
}

interface Page {
  policy: RestartPolicy
  /** Whether the user expects to see the window: not while Kettu starts in the background. */
  wanted: boolean
  /** The page is gone and is not loading again; showing the window loads it first. */
  failed: boolean
  asking: boolean
}

const pages = new WeakMap<BrowserWindow, Page>()

/** Watches the main window's page; `wanted` is false when the window starts hidden. */
export function watchPage(window: BrowserWindow, wanted: boolean): void {
  const page: Page = {
    policy: new RestartPolicy(PAGE_POLICY),
    wanted,
    failed: false,
    asking: false,
  }
  pages.set(window, page)
  window.webContents.on('render-process-gone', (_event, details) => {
    if (window.isDestroyed() || deps.quitting()) return
    const what = `${details.reason}, exit code ${details.exitCode}`
    if (page.policy.crashed(Date.now()).kind === 'restart') {
      log.warn(`The window's page lost its process (${what}); loading it again`)
      reload(window, page)
      return
    }
    page.failed = true
    if (!page.wanted) {
      log.error(`The window's page lost its process again (${what}); loading it once shown`)
      return
    }
    log.error(`The window's page lost its process again (${what}); asking to restart`)
    void askToRestart(window, page)
  })
}

/**
 * Before the window shows: a page that lost its process loads again, and the window shows once it
 * has drawn, so it never shows empty. True when the window will show, or is asking, by itself.
 */
export function revivePage(window: BrowserWindow): boolean {
  const page = pages.get(window)
  if (!page) return false
  page.wanted = true
  if (page.asking) return true
  if (!page.failed && !window.webContents.isCrashed()) return false
  log.info("Loading the window's page again to show the window")
  page.policy.reset()
  reload(window, page)
  if (window.isVisible()) {
    window.focus()
  } else {
    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
  }
  return true
}

// Not webContents.reload(): a page that died before its first load has no address to reload.
function reload(window: BrowserWindow, page: Page): void {
  page.failed = false
  void loadRenderer(window).catch((error: unknown) =>
    log.error('Could not load the renderer', error),
  )
}

async function askToRestart(window: BrowserWindow, page: Page): Promise<void> {
  page.asking = true
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    message: t('pageGone.title', { name: app.name }),
    detail: t('pageGone.detail', { name: app.name }),
    buttons: [t('pageGone.restart', { name: app.name }), t('pageGone.quit')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  // A hidden window stays hidden: it would only show empty behind the dialog.
  const { response } = window.isVisible()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  page.asking = false
  const restart = response === 0
  log.info(
    restart ? 'Restarting: the window could not load' : 'Quitting: the window could not load',
  )
  if (restart) deps.restart()
  else deps.quit()
}
