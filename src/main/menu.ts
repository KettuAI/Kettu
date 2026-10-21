import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '@shared/ipc'
import { sendCommand, sendEvent } from './events'
import { currentWindow } from './window'

export interface MenuDeps {
  checkForUpdates(): void
}

/** Sends a command to the current window only; without one there is nothing to act on. */
function toCurrentWindow(command: AppCommand): void {
  const window = currentWindow()
  if (window) sendEvent(window.webContents, 'app:command', command)
}

/**
 * macOS gets a real menu, which also makes copy, paste and undo work in text fields. Windows and
 * Linux have none: the window draws its own controls and the renderer handles the shortcuts.
 */
export function installMenu(deps: MenuDeps): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const development: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ]
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: () => {
            sendCommand({ kind: 'open-settings', section: 'about' })
            deps.checkForUpdates()
          },
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => sendCommand({ kind: 'open-settings' }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Project…',
          accelerator: 'Cmd+O',
          click: () => sendCommand({ kind: 'open-project' }),
        },
        {
          label: 'New Session',
          accelerator: 'Cmd+N',
          click: () => sendCommand({ kind: 'new-session' }),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'Cmd+B',
          click: () => toCurrentWindow({ kind: 'toggle-sidebar' }),
        },
        ...development,
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
