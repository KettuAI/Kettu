import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentId } from '@shared/agents'
import { FakeAppServer, turn } from './testing/fake-app-server'
import {
  startTestHost,
  type TestHost,
  type TestHostOptions,
  type TestPort,
} from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/**
 * A chat bridge: it logs each notice it is told of, remembers the request the last one named and
 * relays the answer it is given as the setting `reply`, saying what the host made of it.
 */
const BRIDGE = `
let last = null
kettu.on('channel.notice', (notice) => {
  console.log('NOTICE ' + JSON.stringify(notice))
  if (notice.request) last = notice.request.id
})
kettu.on('settings.changed', async ({ key, value }) => {
  if (key !== 'reply') return
  const [decision, request] = value.split(' ')
  try {
    const out = await kettu.call('requests.answer', {
      request: request || last,
      decision,
      from: 'Team chat',
    })
    console.log('ANSWERED ' + JSON.stringify(out))
  } catch (error) {
    console.log('REFUSED ' + error.message)
  }
})
`

const SETTINGS = [{ key: 'reply', type: 'string', title: 'Reply' }]
const CHANNELS = [{ id: 'chat', title: { en: 'Chat' } }]

async function writePlugin(
  dir: string,
  name: string,
  permissions: string[],
  script = BRIDGE,
): Promise<string> {
  const folder = path.join(dir, name)
  await mkdir(path.join(folder, 'sh.kettu'), { recursive: true })
  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify({
      $schema: SCHEMA,
      name,
      version: '1.0.0',
      extensions: {
        'sh.kettu': {
          format: 1,
          script: './sh.kettu/main.js',
          api: 1,
          permissions,
          channels: CHANNELS,
          settings: SETTINGS,
        },
      },
    }),
  )
  await writeFile(path.join(folder, 'sh.kettu', 'main.js'), script)
  return folder
}

async function started(options: TestHostOptions = {}) {
  const host = await startTestHost({ pluginHost: true, ...options })
  hosts.push(host)
  const window = host.connect()
  const install = async (folder: string): Promise<string> => {
    const plan = await window.request('plugins.inspect', {
      source: { kind: 'local', path: folder },
    })
    return (await window.request('plugins.install', { token: plan.token })).id
  }
  const logged = (pluginId: string, word: string): string[] =>
    host.pluginLogs
      .filter((line) => line.startsWith(`${pluginId} info ${word} `))
      .map((line) => line.slice(`${pluginId} info ${word} `.length))
  const notices = (pluginId: string): Record<string, unknown>[] =>
    logged(pluginId, 'NOTICE').map((line) => JSON.parse(line) as Record<string, unknown>)
  const reply = (pluginId: string, value: string): Promise<unknown> =>
    window.request('plugins.setSetting', { pluginId, key: 'reply', value })
  return { host, window, install, logged, notices, reply }
}

async function ready(window: TestPort, agentId: AgentId, project: string): Promise<string> {
  const { id } = await window.request('sessions.create', { agentId, projectPath: project })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return id
}

it('tells a channel only the notices the user picked, and lets a relayed answer lead an ACP session on', async () => {
  const { host, window, install, logged, notices, reply } = await started()
  const dir = await tempFolder('kettu-plugin-channels-')
  const bridge = await install(
    await writePlugin(dir, 'bridge', ['requests.answer', 'sessions.content']),
  )
  // One that reads the conversation but may not answer, one that may answer but not read the
  // conversation, and one with neither.
  const watcher = await install(await writePlugin(dir, 'watcher', ['sessions.content']))
  const shown = await install(await writePlugin(dir, 'shown', ['requests.answer']))
  const bare = await install(await writePlugin(dir, 'bare', []))
  // May answer, but is sent no permission request, so it is never told of one.
  const deaf = await install(await writePlugin(dir, 'deaf', ['requests.answer']))
  const kinds = (pluginId: string, picked: string[]) =>
    window.request('plugins.setChannelKinds', {
      pluginId,
      channel: 'chat',
      kinds: picked as never,
    })

  // Its turn's end wakes the plugin, which is all the notices it is sent.
  await kinds(deaf, ['turnEnded'])

  const id = await ready(window, 'fake-agent', host.project)
  // None by default: a request that waits reaches no channel.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/permission' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 1)
  expect(host.pluginLogs.filter((line) => line.includes('NOTICE'))).toEqual([])
  const first = await window.request('sessions.requests', { sessionId: id })
  const firstRequest = first.entries[0]
  if (firstRequest?.kind !== 'tool' || !firstRequest.permission) throw new Error('No request')
  await window.request('permissions.respond', {
    sessionId: id,
    requestId: firstRequest.permission.requestId,
    optionId: 'reject-once',
  })
  await window.untilStatus(id, 'ready')
  await vi.waitFor(() => expect(notices(deaf)).toHaveLength(1))

  expect(await kinds(bridge, ['permission'])).toMatchObject({
    channelKinds: { chat: ['permission'] },
  })
  await kinds(watcher, ['permission', 'turnEnded'])
  await kinds(shown, ['permission'])
  await kinds(bare, ['permission'])
  await expect(kinds(bridge, ['updates'])).rejects.toThrow()
  await expect(
    window.request('plugins.setChannelKinds', {
      pluginId: bridge,
      channel: 'nowhere',
      kinds: [],
    }),
  ).rejects.toThrow(/no channel/)

  // The next request reaches the channels that were picked, each with what it may read.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/permission' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 1)
  await vi.waitFor(() => expect(notices(bridge)).toHaveLength(1))
  const waiting = await window.request('sessions.requests', { sessionId: id })
  const asked = waiting.entries[0]
  if (asked?.kind !== 'tool' || !asked.permission) throw new Error('No request')
  const requestId = asked.permission.requestId
  expect(notices(bridge)[0]).toMatchObject({
    channel: 'chat',
    kind: 'permission',
    text: expect.stringContaining('pnpm test --filter login'),
    request: { id: requestId },
  })
  await vi.waitFor(() => expect(notices(watcher)).toHaveLength(1))
  expect(notices(watcher)[0]).toMatchObject({ kind: 'permission', channel: 'chat' })
  expect(notices(watcher)[0]).not.toHaveProperty('request')
  // With the right to answer, what is asked and the session's title come without the
  // conversation's text, so nobody allows what they were not shown.
  await vi.waitFor(() => expect(notices(shown)).toHaveLength(1))
  expect(notices(shown)[0]).toEqual({
    channel: 'chat',
    kind: 'permission',
    title: window.summary(id)?.title,
    request: {
      id: requestId,
      tool: 'Run pnpm test --filter login',
      kind: 'execute',
      command: 'pnpm test --filter login',
      paths: [],
    },
  })
  expect(notices(shown)[0]).not.toHaveProperty('text')
  // Neither permission: the kind and nothing else.
  await vi.waitFor(() => expect(notices(bare)).toHaveLength(1))
  expect(notices(bare)[0]).toEqual({
    channel: 'chat',
    kind: 'permission',
    title: 'A request needs your answer',
  })

  // Always allow is not a thing a relay can give, and a plugin that was never told of the
  // request cannot answer it.
  await reply(bridge, 'allow_always')
  await vi.waitFor(() => expect(logged(bridge, 'REFUSED')).toHaveLength(1))
  expect(logged(bridge, 'REFUSED')[0]).toContain('allow_once or deny')
  await reply(watcher, `allow_once ${requestId}`)
  await vi.waitFor(() => expect(logged(watcher, 'REFUSED')).toHaveLength(1))
  expect(logged(watcher, 'REFUSED')[0]).toContain('needs the permission')
  await reply(deaf, `allow_once ${requestId}`)
  await vi.waitFor(() => expect(logged(deaf, 'REFUSED')).toHaveLength(1))
  expect(logged(deaf, 'REFUSED')[0]).toContain('was not told of that request')
  expect(window.summary(id)?.permissionCount).toBe(1)

  // Allow once, from the channel: the session goes on as if the user had clicked.
  await reply(bridge, 'allow_once')
  await vi.waitFor(() => expect(logged(bridge, 'ANSWERED')).toHaveLength(1))
  await window.untilStatus(id, 'ready')
  expect(window.summary(id)?.permissionCount).toBe(0)
  expect(
    window
      .entries(id)
      .some((entry) => entry.kind === 'agent' && entry.markdown.includes('`allow-once`')),
  ).toBe(true)
  const tool = window.entries(id).find((entry) => entry.kind === 'tool' && entry.id === asked.id)
  expect(tool).toMatchObject({
    permissionResult: {
      optionId: 'allow-once',
      kind: 'allow_once',
      relayed: { plugin: 'bridge', from: 'Team chat' },
    },
  })

  // The request is settled, so it is stale for the one that was told of it.
  await reply(bridge, `deny ${requestId}`)
  await vi.waitFor(() => expect(logged(bridge, 'REFUSED')).toHaveLength(2))
  expect(logged(bridge, 'REFUSED')[1]).toContain('was not told of that request')

  // A command of several steps needs more than a yes, so no notice offers it for an answer.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/approvals' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 1)
  await vi.waitFor(() => expect(notices(bridge)).toHaveLength(2))
  expect(notices(bridge)[1]).toMatchObject({ kind: 'permission' })
  expect(notices(bridge)[1]).not.toHaveProperty('request')
  const several = (await window.request('sessions.requests', { sessionId: id })).entries.find(
    (entry) => entry.kind === 'tool' && entry.permission,
  )
  if (several?.kind !== 'tool' || !several.permission) throw new Error('No request')
  await reply(bridge, `allow_once ${several.permission.requestId}`)
  await vi.waitFor(() => expect(logged(bridge, 'REFUSED')).toHaveLength(3))
  expect(logged(bridge, 'REFUSED')[2]).toContain('was not told of that request')
  expect(window.summary(id)?.permissionCount).toBe(1)
})

it('relays a deny to Codex as the user answering it would', async () => {
  const server = new FakeAppServer()
  let approval: Promise<unknown> | null = null
  let asked = false
  server.on('turn/start', (_params, self) => {
    const started = turn(self.nextTurnId())
    // Only the user's message asks, not the title the host asks for after it.
    if (asked) return { turn: started }
    asked = true
    const at = { threadId: 'thread-1', turnId: started.id }
    setTimeout(() => {
      self.notify('turn/started', { threadId: 'thread-1', turn: started })
      const command = {
        type: 'commandExecution',
        id: 'exec-1',
        command: "/bin/zsh -lc 'touch a'",
        cwd: '/project',
        status: 'inProgress',
        commandActions: [{ type: 'unknown', command: 'touch a' }],
        aggregatedOutput: null,
        exitCode: null,
      }
      self.notify('item/started', { ...at, item: command })
      approval = self.request('item/commandExecution/requestApproval', {
        ...at,
        itemId: 'exec-1',
        command: command.command,
        cwd: '/project',
        commandActions: command.commandActions,
        availableDecisions: ['accept', 'decline'],
      }).answer
      void approval.then(() => {
        self.notify('item/completed', {
          ...at,
          item: { ...command, status: 'completed', aggregatedOutput: '', exitCode: 0 },
        })
        self.notify('turn/completed', { threadId: 'thread-1', turn: turn(started.id, 'completed') })
      })
    }, 0)
    return { turn: started }
  })
  const { host, window, install, logged, notices, reply } = await started({
    fakeAppServer: server,
  })
  const dir = await tempFolder('kettu-plugin-channels-')
  const bridge = await install(
    await writePlugin(dir, 'bridge', ['requests.answer', 'sessions.content']),
  )
  await window.request('plugins.setChannelKinds', {
    pluginId: bridge,
    channel: 'chat',
    kinds: ['permission'],
  })

  const id = await ready(window, 'codex', host.project)
  void window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'Touch a' }],
  })
  await vi.waitFor(() => expect(notices(bridge)).toHaveLength(1))
  expect(notices(bridge)[0]).toMatchObject({
    kind: 'permission',
    text: expect.stringContaining('touch a'),
    request: { id: expect.any(String) },
  })
  await reply(bridge, 'deny')
  await vi.waitFor(() => expect(logged(bridge, 'ANSWERED')).toHaveLength(1))
  await expect(approval).resolves.toEqual({ decision: 'decline' })
  await window.until(() => window.summary(id)?.permissionCount === 0)
  const tool = window
    .entries(id)
    .find((entry) => entry.kind === 'tool' && entry.permissionResult !== null)
  expect(tool).toMatchObject({
    permissionResult: { kind: 'reject_once', relayed: { plugin: 'bridge', from: 'Team chat' } },
  })
})

it('never lets a notice wait for a stuck channel', async () => {
  const { host, window, install, notices } = await started()
  const dir = await tempFolder('kettu-plugin-channels-')
  const stuck = await install(
    await writePlugin(
      dir,
      'stuck',
      ['sessions.content'],
      `kettu.on('channel.notice', () => { for (;;) {} })`,
    ),
  )
  const fine = await install(await writePlugin(dir, 'fine', ['sessions.content']))
  for (const pluginId of [stuck, fine]) {
    await window.request('plugins.setChannelKinds', {
      pluginId,
      channel: 'chat',
      kinds: ['turnEnded'],
    })
  }
  const id = await ready(window, 'fake-agent', host.project)
  const before = host.sent.length
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'Fix the clock' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  // Kettu's own notice went out without waiting for the plugin that never answers.
  expect(
    host.sent
      .slice(before)
      .filter((message) => message.type === 'host:attention' && message.kind === 'turn-ended'),
  ).toHaveLength(1)
  // The plugin host runs in this process, so the stuck loop holds every timer until it is stopped
  // at its deadline; wait for the notice itself, not for a second of wall time.
  await vi.waitFor(() => expect(notices(fine)).toHaveLength(1), { timeout: 15_000 })
  expect(notices(fine)[0]).toMatchObject({ kind: 'turnEnded' })
})
