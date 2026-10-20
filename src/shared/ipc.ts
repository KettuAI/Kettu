export interface AppInfo {
  name: string
  version: string
  platform: string
}

/** Request/response contract of every `ipcRenderer.invoke` channel, keyed by channel name. */
export interface IpcInvokeContract {
  'app:get-info': { args: []; result: AppInfo }
}

export type IpcInvokeChannel = keyof IpcInvokeContract
export type IpcInvokeArgs<C extends IpcInvokeChannel> = IpcInvokeContract[C]['args']
export type IpcInvokeResult<C extends IpcInvokeChannel> = IpcInvokeContract[C]['result']

/** API the preload script exposes to the renderer as `window.overbench`. */
export interface OverbenchApi {
  platform: string
  app: {
    getInfo(): Promise<AppInfo>
  }
}
