import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { withFreshModels } from './agent-options'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const models = (host: TestHost, list: string[]): Promise<void> =>
  writeFile(path.join(host.project, '.fake-agent.json'), JSON.stringify({ models: list }))

const modelOption = (window: TestPort, id: string): ConfigOption | undefined =>
  window.thread(id).session.config.find((o) => o.category === 'model')

const listed = (window: TestPort, id: string): string[] =>
  (modelOption(window, id)?.choices ?? []).map((c) => c.value)

/** A session that holds its agent and has been sent a message, so it is saved. */
async function session(window: TestPort, host: TestHost): Promise<string> {
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'hi' }],
  })
  await window.until(() => window.entries(id).some((e) => e.kind === 'agent'))
  await window.untilStatus(id, 'ready')
  return id
}

it('lists the models the agent offers now in a session opened before they changed', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  await models(host, ['aurora', 'comet'])
  const old = await session(window, host)
  expect(listed(window, old)).toEqual(['swift', 'balanced', 'deep', 'aurora', 'comet'])

  await models(host, ['aurora', 'borealis'])
  const fresh = await session(window, host)
  expect(listed(window, fresh)).toContain('borealis')
  // The older session still has the list it started with, and refuses the new model.
  expect(listed(window, old)).not.toContain('borealis')
  await expect(
    window.request('sessions.setConfigOption', {
      sessionId: old,
      optionId: 'model',
      value: 'borealis',
    }),
  ).rejects.toThrow('not a choice')

  await window.request('sessions.refreshModels', { sessionId: old })
  await window.until(() => listed(window, old).includes('borealis'))
  expect(listed(window, old)).toEqual(['swift', 'balanced', 'deep', 'aurora', 'borealis'])
  expect(modelOption(window, old)?.value).toBe('balanced')

  // Its agent process listed the new model only after the session attached again.
  await window.request('sessions.setConfigOption', {
    sessionId: old,
    optionId: 'model',
    value: 'borealis',
  })
  await window.until(() => modelOption(window, old)?.value === 'borealis')
})

it("keeps the session's own model listed when the agent no longer offers it", async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  await models(host, ['aurora', 'comet', 'dune'])
  const id = await session(window, host)
  await window.request('sessions.setConfigOption', {
    sessionId: id,
    optionId: 'model',
    value: 'comet',
  })
  await window.until(() => modelOption(window, id)?.value === 'comet')

  await models(host, ['aurora'])
  await window.request('sessions.refreshModels', { sessionId: id })
  await window.until(() => !listed(window, id).includes('dune'))
  expect(listed(window, id)).toEqual(['swift', 'balanced', 'deep', 'aurora', 'comet'])
  expect(modelOption(window, id)?.value).toBe('comet')
})

it('lists them in a session whose agent was let go, which then takes the new model', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  await models(host, ['aurora'])
  const id = await session(window, host)
  await window.request('sessions.close', { sessionId: id })
  await models(host, ['aurora', 'borealis'])
  await window.open(id)
  await window.untilStatus(id, 'closed')
  expect(listed(window, id)).not.toContain('borealis')

  await window.request('sessions.refreshModels', { sessionId: id })
  await window.until(() => listed(window, id).includes('borealis'))
  await window.request('sessions.setConfigOption', {
    sessionId: id,
    optionId: 'model',
    value: 'borealis',
  })
  await window.until(() => modelOption(window, id)?.value === 'borealis')
})

it('changes nothing for a list that did not change', () => {
  const option: ConfigOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: 'a',
    choices: [
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
    ],
  }
  expect(withFreshModels([option], [{ ...option, value: 'b' }])).toBeNull()
})
