import { app, ipcMain } from 'electron'
import type { IpcInvokeArgs, IpcInvokeChannel, IpcInvokeResult } from '@shared/ipc'
import { isRendererUrl } from './renderer'

type InvokeHandler<C extends IpcInvokeChannel> = (
  ...args: IpcInvokeArgs<C>
) => IpcInvokeResult<C> | Promise<IpcInvokeResult<C>>

function handle<C extends IpcInvokeChannel>(channel: C, handler: InvokeHandler<C>): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isRendererUrl(event.senderFrame?.url)) {
      throw new Error(`Rejected "${channel}" call from untrusted sender`)
    }
    return handler(...(args as IpcInvokeArgs<C>))
  })
}

export function registerIpcHandlers(): void {
  handle('app:get-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }))
}
