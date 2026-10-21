import { BrowserWindow, type WebContents } from 'electron'
import type { AppCommand, IpcEventChannel, IpcEventContract } from '@shared/ipc'
import { showMainWindow } from './window'

export function sendEvent<C extends IpcEventChannel>(
  webContents: WebContents,
  channel: C,
  payload: IpcEventContract[C],
): void {
  if (!webContents.isDestroyed()) webContents.send(channel, payload)
}

export function broadcast<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventContract[C],
): void {
  for (const window of BrowserWindow.getAllWindows())
    sendEvent(window.webContents, channel, payload)
}

/** Brings a window forward and sends it a command once its page has loaded. */
export function sendCommand(command: AppCommand): void {
  const { webContents } = showMainWindow()
  if (webContents.isLoadingMainFrame()) {
    webContents.once('did-finish-load', () => sendEvent(webContents, 'app:command', command))
  } else {
    sendEvent(webContents, 'app:command', command)
  }
}
