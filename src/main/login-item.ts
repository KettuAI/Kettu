// Registers the app to start at login and decides how such a start opens its window.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { LoginItemStatus } from '@shared/ipc'
import { createLogger } from './log'

const log = createLogger('login-item')

export const OPENED_AT_LOGIN_FLAG = '--opened-at-login'

export type StartMode = 'window' | 'minimized' | 'hidden'

/** macOS opens without a window; Windows and Linux start with the window minimized. */
export function startMode(platform: NodeJS.Platform, openedAtLogin: boolean): StartMode {
  if (!openedAtLogin) return 'window'
  return platform === 'darwin' ? 'hidden' : 'minimized'
}

/** macOS reports a login start itself; the other platforms pass the flag in the login item. */
export function isOpenedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  wasOpenedAtLogin: boolean,
): boolean {
  return platform === 'darwin' ? wasOpenedAtLogin : argv.includes(OPENED_AT_LOGIN_FLAG)
}

export function autostartPath(home: string): string {
  return join(home, '.config', 'autostart', 'overbench.desktop')
}

/** The AppImage's own path when running from one: the desktop entry must start that file. */
export function linuxExecPath(execPath: string, appImage: string | undefined): string {
  return appImage && appImage.length > 0 ? appImage : execPath
}

function execArgument(value: string): string {
  const escaped = value.replace(/[\\"`$]/g, (character) => `\\${character}`).replace(/%/g, '%%')
  return `"${escaped}"`
}

/** The desktop entry's text, with the app as its Exec and the flag that marks a login start. */
export function autostartEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OverBench',
    `Exec=${execArgument(execPath)} ${OPENED_AT_LOGIN_FLAG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

export interface LoginItemContext {
  platform: NodeJS.Platform
  packaged: boolean
  execPath: string
  appImage: string | undefined
  home: string
}

function currentContext(): LoginItemContext {
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    execPath: process.execPath,
    appImage: process.env['APPIMAGE'],
    home: app.getPath('home'),
  }
}

/**
 * Writes or removes the login item the setting asks for. A development build registers nothing,
 * since there is no installed app to start.
 */
export async function applyLoginItem(
  openAtLogin: boolean,
  context: LoginItemContext = currentContext(),
): Promise<void> {
  if (!context.packaged) return
  if (context.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin })
    return
  }
  if (context.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin, args: [OPENED_AT_LOGIN_FLAG] })
    return
  }
  if (context.platform !== 'linux') return
  const path = autostartPath(context.home)
  if (!openAtLogin) {
    await rm(path, { force: true })
    return
  }
  const exec = linuxExecPath(context.execPath, context.appImage)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, autostartEntry(exec), 'utf8')
}

/** What Settings › General › Open at login says about the item right now. */
export function loginItemStatus(): LoginItemStatus {
  const available = app.isPackaged
  if (!available || process.platform !== 'darwin') return { available, requiresApproval: false }
  return {
    available,
    requiresApproval: app.getLoginItemSettings().status === 'requires-approval',
  }
}

// Linux writes run one after another, so a quick on and off cannot leave the file written.
let queue: Promise<void> = Promise.resolve()

/** Applies a settings change in the background, so main never blocks on the file system. */
export function syncLoginItem(openAtLogin: boolean): void {
  const context = currentContext()
  const apply = (): Promise<void> => applyLoginItem(openAtLogin, context)
  const fail = (error: unknown): void => log.error('Could not update the login item', error)
  if (context.platform === 'linux') {
    queue = queue.then(apply).catch(fail)
    return
  }
  void apply().catch(fail)
}
