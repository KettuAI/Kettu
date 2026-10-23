import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { adapterOnlyUpdate } from './updates'

const adapter = {
  name: '@agentclientprotocol/claude-agent-acp',
  version: '0.94.0',
  installed: true,
}
const installedCli = {
  command: 'claude',
  runs: 'installed' as const,
  installed: { path: '/usr/local/bin/claude', version: '2.1.304', variable: null, problem: null },
}
const status = (overrides: Partial<AgentStatus>): AgentStatus =>
  ({
    package: adapter,
    update: { adapterVersion: '0.95.0', cliVersion: null },
    cli: installedCli,
    ...overrides,
  }) as AgentStatus

describe('adapterOnlyUpdate', () => {
  it('names the adapter when the user CLI runs and the update brings no CLI', () => {
    expect(adapterOnlyUpdate(status({}))).toEqual(adapter)
  })

  it('leaves the agent named when the update brings a CLI, or the bundled one runs', () => {
    expect(
      adapterOnlyUpdate(status({ update: { adapterVersion: '0.95.0', cliVersion: '2.1.310' } })),
    ).toBeNull()
    expect(adapterOnlyUpdate(status({ cli: { ...installedCli, runs: 'bundled' } }))).toBeNull()
    expect(adapterOnlyUpdate(status({ cli: null }))).toBeNull()
  })

  it('names nothing without an update or an adapter', () => {
    expect(adapterOnlyUpdate(status({ update: null }))).toBeNull()
    expect(adapterOnlyUpdate(status({ package: null }))).toBeNull()
  })
})
