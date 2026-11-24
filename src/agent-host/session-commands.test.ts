import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { MarketSkill } from '@shared/marketplace'
import type { HostSettings } from '@shared/settings'
import { USER_COMMANDS_DIR } from './commands/service'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const GREET = `---
description: Greet someone
arguments:
  - name: who
---
Say hello to {{who}}.
`

const NEEDY = `---
skills: [code-review]
---
Review it.
`

/** A data folder with the user's commands in it, which the host started in it reads. */
async function dataWithCommands(): Promise<string> {
  const dir = await tempFolder('kettu-session-commands-')
  const folder = path.join(dir, USER_COMMANDS_DIR)
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, 'greet.md'), GREET)
  await writeFile(path.join(folder, 'needy.md'), NEEDY)
  return dir
}

it('sends a command to an ACP agent as the plain message, and shows what the user typed', async () => {
  const host = await startTestHost({ userDataPath: await dataWithCommands() })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  expect((await window.request('commands.list', undefined)).commands.map((c) => c.name)).toEqual([
    'greet',
    'needy',
  ])
  // Kettu's guide goes ahead of the first message, so the command is the second.
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'Hello' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: '/greet world' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  const entries = window.entries(id)
  const sent = entries.filter((entry) => entry.kind === 'user')[1]
  expect(sent).toMatchObject({
    content: [
      {
        type: 'text',
        text: '/greet world',
        command: { name: 'greet', origin: { kind: 'user' }, sent: 'Say hello to world.' },
      },
    ],
  })
  // The fake agent quotes the first line of what it was sent.
  expect(
    entries.some(
      (entry) => entry.kind === 'agent' && entry.markdown.includes('> Say hello to world.'),
    ),
  ).toBe(true)
})

it('sends the same message to Codex', async () => {
  const server = new FakeAppServer()
  const inputs: string[] = []
  server.on('turn/start', (params, self) => {
    for (const item of params.input as { text?: string }[]) inputs.push(item.text ?? '')
    return { turn: turn(self.nextTurnId()) }
  })
  const host = await startTestHost({
    userDataPath: await dataWithCommands(),
    fakeAppServer: server,
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  void window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: '/greet world' }],
  })
  await vi.waitFor(() => expect(inputs).toContain('Say hello to world.'))
  expect(inputs).not.toContain('/greet world')
})

it('does not send a command whose skill is not installed, and says which', async () => {
  const host = await startTestHost({ userDataPath: await dataWithCommands() })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await expect(
    window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: '/needy' }],
    }),
  ).rejects.toThrow(/code-review/)
  expect(window.entries(id).some((entry) => entry.kind === 'user')).toBe(false)
})

it('leaves a message that is no command as it is', async () => {
  const host = await startTestHost({ userDataPath: await dataWithCommands() })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'greet is not at the start: /greet world' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  const sent = window.entries(id).find((entry) => entry.kind === 'user')
  expect(sent).toMatchObject({
    content: [{ type: 'text', text: 'greet is not at the start: /greet world' }],
  })
  expect(JSON.stringify(sent)).not.toContain('command')
})

/** A skill the user kept for Codex alone. */
const REVIEW_SKILL: MarketSkill = {
  id: 'local:11111111-1111-4111-8111-111111111111',
  name: 'code-review',
  description: 'Reviews code',
  source: 'local',
  origin: '/skills/code-review',
  version: null,
  agents: ['codex'],
  on: true,
}

it('gives a session the skill a command names that its agent is not handed anyway', async () => {
  const host = await startTestHost({ userDataPath: await dataWithCommands() })
  hosts.push(host)
  const current = (host.host as unknown as { settings: HostSettings }).settings
  await host.host.updateSettings({
    ...current,
    marketplace: { mcp: [], skills: [REVIEW_SKILL] },
  })
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'Hello' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: '/needy' }],
  })
  await vi.waitFor(() =>
    expect(
      window
        .entries(id)
        .some((entry) => entry.kind === 'agent' && entry.markdown.includes('> Review it.')),
    ).toBe(true),
  )
  expect(window.entries(id)).toContainEqual(
    expect.objectContaining({
      kind: 'notice',
      title: 'Added for /needy',
      description: 'the skill code-review',
    }),
  )
})
