import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

function piStatus(window: TestPort): AgentStatus | undefined {
  return window.events.findLast(
    (event): event is Extract<typeof event, { type: 'agent.status' }> =>
      event.type === 'agent.status' && event.status.id === 'pi',
  )?.status
}

it('asks an agent that reports no account again when a read after its sign-in is forced', async () => {
  const marker = path.join(await tempFolder('kettu-sign-in-'), 'login')
  // Pi, which reports no account: signed out until its provider is set up outside Kettu.
  const host = await startTestHost({
    fakeThroughRouter: { agentIds: ['pi'] },
    agentEnv: { FAKE_AGENT_AUTH: 'required', FAKE_AGENT_LOGIN_MARKER: marker },
  })
  hosts.push(host)
  const window = host.connect()

  await window.request('agents.readFirstOptions', { agentId: 'pi' })
  await window.until(() => piStatus(window)?.signIn === 'required')

  // Set up in its terminal, which Kettu learns of only by asking the agent again.
  await writeFile(marker, '')
  await window.request('agents.refreshAccount', { agentId: 'pi', force: true })
  expect(piStatus(window)?.signIn).toBe('signed-in')
})

it('keeps an agent that reports no account signed out while it still is', async () => {
  const marker = path.join(await tempFolder('kettu-sign-in-'), 'login')
  const host = await startTestHost({
    fakeThroughRouter: { agentIds: ['pi'] },
    agentEnv: { FAKE_AGENT_AUTH: 'required', FAKE_AGENT_LOGIN_MARKER: marker },
  })
  hosts.push(host)
  const window = host.connect()

  await window.request('agents.readFirstOptions', { agentId: 'pi' })
  await window.until(() => piStatus(window)?.signIn === 'required')

  await window.request('agents.refreshAccount', { agentId: 'pi', force: true })
  expect(piStatus(window)?.signIn).toBe('required')
})
