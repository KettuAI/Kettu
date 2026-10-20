import { contextBridge, ipcRenderer } from 'electron'
import type { IpcInvokeArgs, IpcInvokeChannel, IpcInvokeResult, OverbenchApi } from '@shared/ipc'

function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInvokeArgs<C>
): Promise<IpcInvokeResult<C>> {
  return ipcRenderer.invoke(channel, ...args)
}

const api: OverbenchApi = {
  platform: process.platform,
  app: {
    getInfo: () => invoke('app:get-info'),
  },
}

contextBridge.exposeInMainWorld('overbench', api)
