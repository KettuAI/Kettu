import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '@shared/ipc'
import type { ZoomStep } from '@shared/settings'
import { isDebugRun } from './debug-mode'
import { sendCommand, sendEvent } from './events'
import { t } from './i18n'
import { currentWindow } from './window'

export interface MenuDeps {
  checkForUpdates(): void
  /** Whether a session's page holds the keyboard focus, which the renderer cannot see. */
  browserFocused(): boolean
  zoom(step: ZoomStep): void
  reportProblem(): void
}

// A second Cmd+Q within this long quits; the first only shows a hint.
const QUIT_PRESS_MS = 2000
let lastQuitPress = 0

/** Quits at once when the key press cannot be seen to be answered, else on the second press. */
function quitFromMenu(event: Electron.KeyboardEvent): void {
  const window = currentWindow()
  const now = Date.now()
  const seen = !!window && window.isVisible() && !window.isMinimized()
  if (!event.triggeredByAccelerator || !seen || now - lastQuitPress <= QUIT_PRESS_MS) {
    app.quit()
    return
  }
  lastQuitPress = now
  sendEvent(window.webContents, 'app:command', { kind: 'quit-hint' })
}

/** Sends a command to the current window only; without one there is nothing to act on. */
function toCurrentWindow(command: AppCommand): void {
  const window = currentWindow()
  if (window) sendEvent(window.webContents, 'app:command', command)
}

/**
 * macOS gets a real menu, which also makes copy, paste and undo work in text fields. Windows and
 * Linux have none: the window draws its own controls and the renderer handles the shortcuts.
 * Every item carries a label, because Electron's role labels are English only; call it again when
 * the language changes.
 */
export function installMenu(deps: MenuDeps): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const name = app.name
  // An installed build opens developer tools only in a debug run, and reloads in none.
  const development: MenuItemConstructorOptions[] = !app.isPackaged
    ? [
        { type: 'separator' },
        { role: 'reload', label: t('menu.reload') },
        { role: 'forceReload', label: t('menu.forceReload') },
        { role: 'toggleDevTools', label: t('menu.toggleDevTools') },
      ]
    : isDebugRun()
      ? [{ type: 'separator' }, { role: 'toggleDevTools', label: t('menu.toggleDevTools') }]
      : []
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: t('menu.about', { name }) },
        {
          label: t('menu.checkForUpdates'),
          click: () => {
            sendCommand({ kind: 'open-settings', section: 'about' })
            deps.checkForUpdates()
          },
        },
        { type: 'separator' },
        {
          label: t('menu.settings'),
          accelerator: 'Cmd+,',
          click: () => sendCommand({ kind: 'open-settings' }),
        },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide', { name }) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        {
          label: t('menu.quit', { name }),
          accelerator: 'Cmd+Q',
          click: (_item, _window, event) => quitFromMenu(event),
        },
      ],
    },
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.openProject'),
          accelerator: 'Cmd+O',
          click: () => sendCommand({ kind: 'open-project' }),
        },
        {
          label: t('menu.newSession'),
          accelerator: 'Cmd+N',
          click: () => sendCommand({ kind: 'new-session' }),
        },
        { type: 'separator' },
        {
          label: t('menu.close'),
          accelerator: 'Cmd+W',
          click: () =>
            toCurrentWindow(
              deps.browserFocused() ? { kind: 'close', browser: true } : { kind: 'close' },
            ),
        },
      ],
    },
    {
      // The items of Electron's editMenu role on macOS.
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'pasteAndMatchStyle', label: t('menu.pasteAndMatchStyle') },
        { role: 'delete', label: t('menu.delete') },
        { role: 'selectAll', label: t('menu.selectAll') },
        { type: 'separator' },
        {
          label: t('menu.speech'),
          submenu: [
            { role: 'startSpeaking', label: t('menu.startSpeaking') },
            { role: 'stopSpeaking', label: t('menu.stopSpeaking') },
          ],
        },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.toggleSidebar'),
          accelerator: 'Cmd+B',
          click: () => toCurrentWindow({ kind: 'toggle-sidebar' }),
        },
        { type: 'separator' },
        { label: t('menu.resetZoom'), accelerator: 'Cmd+0', click: () => deps.zoom(0) },
        { label: t('menu.zoomIn'), accelerator: 'Cmd+=', click: () => deps.zoom(1) },
        { label: t('menu.zoomOut'), accelerator: 'Cmd+-', click: () => deps.zoom(-1) },
        // Hidden twins, so each key zooms with Shift and without, as in Chrome.
        {
          label: t('menu.zoomIn'),
          accelerator: 'Cmd+Plus',
          visible: false,
          click: () => deps.zoom(1),
        },
        {
          label: t('menu.zoomOut'),
          accelerator: 'Cmd+_',
          visible: false,
          click: () => deps.zoom(-1),
        },
        ...development,
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.toggleFullScreen') },
      ],
    },
    {
      // The page takes Cmd+[ and Cmd+] first, so these fire only for keys it leaves, and clicks.
      label: t('menu.history'),
      submenu: [
        {
          label: t('menu.back'),
          accelerator: 'Cmd+[',
          click: () => toCurrentWindow({ kind: 'go-back' }),
        },
        {
          label: t('menu.forward'),
          accelerator: 'Cmd+]',
          click: () => toCurrentWindow({ kind: 'go-forward' }),
        },
        { type: 'separator' },
        {
          label: t('menu.showAllHistory'),
          accelerator: 'Cmd+Y',
          click: () => toCurrentWindow({ kind: 'show-history' }),
        },
      ],
    },
    {
      // The items of Electron's windowMenu role on macOS; the role keeps the window list.
      role: 'windowMenu',
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        { type: 'separator' },
        { role: 'front', label: t('menu.bringAllToFront') },
      ],
    },
    {
      // The role puts macOS's search field for the menus at the top.
      role: 'help',
      label: t('menu.help'),
      submenu: [{ label: t('menu.reportProblem'), click: () => deps.reportProblem() }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
