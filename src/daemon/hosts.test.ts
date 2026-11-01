import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostStatus } from '@shared/host-control'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { ForkedHostConfig } from './forked-host'
import { Hosts, type HostsOptions } from './hosts'

type Config = ForkedHostConfig<unknown, { type: string }>

interface FakeHost {
  config: Config
  posted: { type: string; requestId?: number }[]
  renewals: number
}

const made: FakeHost[] = []

vi.mock('./forked-host', () => ({
  ForkedHost: class implements FakeHost {
    posted: { type: string; requestId?: number }[] = []
    renewals = 0
    constructor(readonly config: Config) {
      made.push(this)
    }
    post(message: { type: string }): boolean {
      this.posted.push(message)
      return true
    }
    async renew(): Promise<void> {
      this.renewals++
    }
  },
}))

function hosts(options: Partial<HostsOptions> = {}): Hosts {
  return new Hosts({
    bundleDir: '/kettu/daemon',
    dataPath: '/kettu/data',
    version: '1.0.0',
    systemLocale: 'en',
    settings: () => DEFAULT_SETTINGS,
    privateKey: '',
    hostName: 'devbox',
    env: {},
    newIdentity: async () => '',
    ...options,
  })
}

function fake(bundle: string): FakeHost {
  return made.find((host) => host.config.modulePath.endsWith(bundle))!
}

function hostConfig(bundle: string): Config {
  hosts()
  return fake(bundle).config
}

const STATUS: RemoteHostStatus = {
  publicKey: 'old key',
  plainTextKey: true,
  devices: [],
  online: [],
  refused: 0,
  direct: { state: 'off' },
}

afterEach(() => {
  made.length = 0
  vi.restoreAllMocks()
})

describe('Hosts', () => {
  it("labels the remote host's lines as its own", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hostConfig('remote-host.cjs').onMessage({
      type: 'remote-host:log',
      level: 'warn',
      message: 'Direct connections cannot listen on port 4600: EADDRINUSE',
    } as { type: string })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toMatch(
      / \[remote-host\] Direct connections cannot listen on port 4600: EADDRINUSE$/,
    )
  })

  it("labels the agent host's lines as its own", () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {})
    hostConfig('agent-host.cjs').onMessage({
      type: 'host:log',
      level: 'info',
      message: 'Loaded 3 projects',
    } as { type: string })
    expect(info).toHaveBeenCalledOnce()
    expect(info.mock.calls[0]![0]).toMatch(/ \[agent-host\] Loaded 3 projects$/)
  })

  it('resets remote access: every device goes, then the remote host renews on a new key', async () => {
    const order: string[] = []
    const running = hosts({
      privateKey: 'old',
      newIdentity: async () => {
        order.push('new identity')
        return 'new'
      },
    })
    const remote = fake('remote-host.cjs')
    expect((remote.config.initMessage(null) as { privateKey: string }).privateKey).toBe('old')
    await expect(running.resetRemote()).rejects.toMatchObject({ code: 'unavailable' })

    remote.config.onMessage({ type: 'remote-host:status', status: STATUS } as { type: string })
    const reset = running.resetRemote()
    // One reset at a time.
    expect(running.resetRemote()).toBe(reset)
    const asked = remote.posted.find((message) => message.type === 'remote-host:reset')!
    expect(asked).toEqual({ type: 'remote-host:reset', requestId: expect.any(Number) })
    await Promise.resolve()
    expect(order).toEqual([])
    expect(remote.renewals).toBe(0)
    remote.config.onMessage({ type: 'remote-host:reset', requestId: asked.requestId } as {
      type: string
    })
    await reset
    expect(order).toEqual(['new identity'])
    expect(remote.renewals).toBe(1)
    expect((remote.config.initMessage(null) as { privateKey: string }).privateKey).toBe('new')
  })

  it('keeps the identity when the remote host does not reset', async () => {
    vi.useFakeTimers()
    try {
      const newIdentity = vi.fn(async () => 'new')
      const running = hosts({ newIdentity })
      const remote = fake('remote-host.cjs')
      remote.config.onMessage({ type: 'remote-host:status', status: STATUS } as { type: string })
      const reset = running.resetRemote()
      const failed = expect(reset).rejects.toThrow('The remote host did not reset')
      await vi.advanceTimersByTimeAsync(10_000)
      await failed
      expect(newIdentity).not.toHaveBeenCalled()
      expect(remote.renewals).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
