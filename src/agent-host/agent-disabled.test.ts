import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { startTestHost, type TestHost } from './testing/harness'

const hosts: TestHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
})

function settings(disabledAgents: AgentId[]): HostSettings {
  return {
    locale: 'en',
    agents: { 'fake-agent': { enabled: true } },
    addedAgents: [],
    disabledAgents,
    proxy: DEFAULT_SETTINGS.proxy,
    git: DEFAULT_SETTINGS.git,
    mcp: DEFAULT_SETTINGS.mcp,
    marketplace: DEFAULT_SETTINGS.marketplace,
    startModes: {},
    usage: { fromComputer: false },
    sessionTitles: true,
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
  }
}

describe('a turned-off agent', () => {
  it('never starts, and starts again once it is turned on', async () => {
    const host = await startTestHost({ settings: settings(['fake-agent']) })
    hosts.push(host)
    const port = host.connect()
    const create = () =>
      port.request('sessions.create', { agentId: 'fake-agent', projectPath: host.project })

    await expect(create()).rejects.toThrow(/turned off/)
    await expect(host.host.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
    expect(host.host.agents.runtime('fake-agent')).toBeNull()
    const listed = (await host.host.agents.list()).find((s) => s.id === 'fake-agent')
    expect(listed).toMatchObject({ registered: true, disabled: true })

    await host.host.updateSettings(settings([]))
    const session = await create()
    await port.untilStatus(session.id, 'ready')
    expect(host.host.agents.runtime('fake-agent')).not.toBeNull()
  })

  it('stops its process and refuses further messages when it is turned off', async () => {
    const host = await startTestHost({ settings: settings([]) })
    hosts.push(host)
    const port = host.connect()
    const session = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
    })
    await port.untilStatus(session.id, 'ready')
    expect(host.host.agents.runtime('fake-agent')).not.toBeNull()

    await host.host.updateSettings(settings(['fake-agent']))
    expect(host.host.agents.runtime('fake-agent')).toBeNull()
    await expect(
      port.request('sessions.prompt', {
        sessionId: session.id,
        content: [{ type: 'text', text: 'Anyone there?' }],
      }),
    ).rejects.toThrow(/turned off/)
  })
})
