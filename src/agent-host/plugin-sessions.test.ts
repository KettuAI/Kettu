import { afterEach, expect, it, vi } from 'vitest'
import { pluginStarter } from '@shared/plugins'
import { startTestHost, type TestHost } from './testing/harness'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const PLUGIN = 'p0123456789ab'

async function started() {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const id = await host.host.sessions.startFromPlugin(PLUGIN, {
    prompt: 'Look at it',
    projectPath: host.project,
    agentId: 'fake-agent',
    title: 'Looking',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return { host, window, id }
}

it("marks a session a plugin starts as the plugin's, in the plugin's own count", async () => {
  const { host, id } = await started()
  const sessions = host.host.sessions
  expect(sessions.startedBy(pluginStarter(PLUGIN)).map((session) => session.id)).toEqual([id])
  expect(sessions.startedBy(pluginStarter('p00000000000a'))).toEqual([])
  expect(sessions.startedBy(PLUGIN)).toEqual([])
})

it('lets a plugin message the sessions it started and no other', async () => {
  const { host, window, id } = await started()
  const sessions = host.host.sessions
  await expect(sessions.sendFromPlugin(PLUGIN, id, 'And the tests?')).resolves.toMatchObject({
    delivered: 'sent',
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')

  // Another plugin's session, one the user made and one that does not exist are all out of reach.
  await expect(sessions.sendFromPlugin('p00000000000a', id, 'x')).rejects.toMatchObject({
    code: 'restricted',
  })
  const user = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(user.id)
  await window.untilStatus(user.id, 'ready')
  await expect(sessions.sendFromPlugin(PLUGIN, user.id, 'x')).rejects.toMatchObject({
    code: 'restricted',
  })
  await expect(sessions.sendFromPlugin(PLUGIN, 'ghost', 'x')).rejects.toThrow()
  expect(window.entries(user.id).some((entry) => entry.kind === 'user')).toBe(false)
})
