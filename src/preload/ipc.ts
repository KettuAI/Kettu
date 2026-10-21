import { ipcRenderer } from 'electron'
import type {
  IpcEventChannel,
  IpcEventContract,
  IpcInvokeArgs,
  IpcInvokeChannel,
  IpcInvokeResult,
  IpcSendContract,
  PreloadEventContract,
} from '@shared/ipc'
import type { ClientPort, PortTransport } from './port-client'

const REMOTE_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

/** Calls main. Rejections carry main's own message, without Electron's wrapper text. */
export async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInvokeArgs<C>
): Promise<IpcInvokeResult<C>> {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(REMOTE_PREFIX, ''), { cause: error })
  }
}

export function send<C extends keyof IpcSendContract>(
  channel: C,
  ...args: IpcSendContract[C]
): void {
  ipcRenderer.send(channel, ...args)
}

/**
 * Fans one IPC channel out to the page's listeners. One `ipcRenderer` listener per channel, so
 * subscribing many times never trips Node's listener limit.
 */
export function subscribe<C extends IpcEventChannel>(
  channel: C,
): (listener: (payload: IpcEventContract[C]) => void) => () => void {
  const listeners = new Set<(payload: IpcEventContract[C]) => void>()
  ipcRenderer.on(channel, (_, payload: IpcEventContract[C]) => {
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch (error) {
        console.error(`A "${channel}" listener failed`, error)
      }
    }
  })
  return (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

/** The IPC side of a host port: `<channel>:connect`, `<channel>:port` and `<channel>:reset`. */
export function hostTransport(channel: 'agent-host' | 'terminal-host'): PortTransport {
  const portChannel = `${channel}:port` satisfies keyof PreloadEventContract
  const resetChannel = `${channel}:reset` satisfies keyof PreloadEventContract
  return {
    requestPort: () => ipcRenderer.send(`${channel}:connect`),
    onPort: (listener) => {
      ipcRenderer.on(portChannel, (event) => {
        const [port] = event.ports as unknown as ClientPort[]
        if (port) listener(port)
      })
    },
    onReset: (listener) => {
      ipcRenderer.on(resetChannel, (_, event: PreloadEventContract[typeof resetChannel]) => {
        listener({ failed: event?.failed === true })
      })
    },
  }
}
