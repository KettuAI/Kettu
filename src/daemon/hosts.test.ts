import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { ForkedHostConfig } from './forked-host'
import { Hosts } from './hosts'

const configs: ForkedHostConfig<unknown, { type: string }>[] = []

vi.mock('./forked-host', () => ({
  ForkedHost: class {
    constructor(config: ForkedHostConfig<unknown, { type: string }>) {
      configs.push(config)
    }
  },
}))

function hostConfig(bundle: string): ForkedHostConfig<unknown, { type: string }> {
  new Hosts({
    bundleDir: '/kettu/daemon',
    dataPath: '/kettu/data',
    version: '1.0.0',
    systemLocale: 'en',
    settings: () => DEFAULT_SETTINGS,
    privateKey: '',
    hostName: 'devbox',
    env: {},
  })
  return configs.find((config) => config.modulePath.endsWith(bundle))!
}

afterEach(() => {
  configs.length = 0
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
})
