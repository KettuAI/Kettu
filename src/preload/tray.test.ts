import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrayHostAgents, TrayPanelApi } from '@shared/tray'

const exposed = vi.hoisted(() => ({ key: '', api: null as TrayPanelApi | null }))
const ipcInvoke = vi.hoisted(() => vi.fn())
const ipcSend = vi.hoisted(() => vi.fn())
const ipcListeners = vi.hoisted(() => new Map<string, ((...args: unknown[]) => void)[]>())

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: TrayPanelApi) => {
      exposed.key = key
      exposed.api = api
    },
  },
  ipcRenderer: {
    invoke: ipcInvoke,
    send: ipcSend,
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const list = ipcListeners.get(channel) ?? []
      list.push(listener)
      ipcListeners.set(channel, list)
    },
  },
}))

await import('./tray')

describe('tray preload contract', () => {
  beforeEach(() => {
    ipcInvoke.mockReset()
    ipcSend.mockReset()
  })

  it('exposes only the minimal TrayPanelApi without remote RPC ports', () => {
    expect(exposed.key).toBe('kettu')
    const api = exposed.api as unknown as Record<string, unknown>
    expect(Object.keys(api).sort()).toEqual([
      'agents',
      'client',
      'platform',
      'remote',
      'settings',
      'systemLocale',
      'themes',
      'tray',
    ])
    expect(api.hosts).toBeUndefined()
    expect(api.terminals).toBeUndefined()
    expect((api.settings as Record<string, unknown>).update).toBeUndefined()
    expect(ipcListeners.has('host-sessions:port')).toBe(false)
    expect(ipcSend).not.toHaveBeenCalledWith('host-sessions:connect')
  })

  it('wires tray.hostAgents and tray.onHostAgentsChanged to the dedicated read-only channels', async () => {
    const sample: TrayHostAgents[] = [
      {
        hostId: 'host-a',
        agents: [
          {
            id: 'claude-code',
            harnessId: 'claude-code',
            account: { kind: 'account', label: 'Claude Max', email: 'alice@example.com' },
            limits: [],
          },
        ],
      },
    ]
    ipcInvoke.mockResolvedValueOnce(sample)
    await expect(exposed.api!.tray.hostAgents()).resolves.toEqual(sample)
    expect(ipcInvoke).toHaveBeenCalledWith('tray:host-agents')

    const received: TrayHostAgents[][] = []
    const unsub = exposed.api!.tray.onHostAgentsChanged((hosts) => received.push(hosts))
    for (const listener of ipcListeners.get('tray:host-agents-changed') ?? []) {
      listener({}, sample)
    }
    expect(received).toEqual([sample])

    unsub()
    for (const listener of ipcListeners.get('tray:host-agents-changed') ?? []) {
      listener({}, [])
    }
    expect(received).toEqual([sample])
  })
})
