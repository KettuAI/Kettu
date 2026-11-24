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

/** Every event a plugin may hear, which the script writes down as it comes. */
const TOLD = [
  'session.started',
  'session.toolFinished',
  'session.turnEnded',
  'session.needsUser',
  'session.pullRequestChanged',
  'task.stepStarted',
  'task.stepEnded',
]

/**
 * A plugin whose script logs every event it is sent, attaches a ticket to each message, and
 * denies the first request that runs `pnpm test` or `touch`, passing the rest to the user.
 */
const SCRIPT = `
console.log('LOADED')
const tell = (name) => (payload) => console.log('EVENT ' + name + ' ' + JSON.stringify(payload))
for (const name of ${JSON.stringify(TOLD)}) kettu.on(name, tell(name))
kettu.on('session.beforeSend', (payload) => {
  tell('session.beforeSend')(payload)
  return { attach: [{ title: 'Ticket', text: 'ABC-1 is open' }] }
})
let denied = false
kettu.on('session.permissionRequested', (payload) => {
  tell('session.permissionRequested')(payload)
  if (denied) return
  denied = true
  return { deny: 'Not now' }
})
`

async function writePlugin(
  dir: string,
  name: string,
  script: string,
  permissions: string[],
  events: string[],
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
        'sh.kettu': { format: 1, script: './sh.kettu/main.js', api: 1, permissions, events },
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
  // What the scripts logged for an event, by plugin.
  const told = (pluginId: string, event: string): unknown[] =>
    host.pluginLogs
      .filter((line) => line.startsWith(`${pluginId} info EVENT ${event} `))
      .map((line) => JSON.parse(line.slice(`${pluginId} info EVENT ${event} `.length)) as unknown)
  return { host, window, install, told }
}

const EVERYTHING = ['sessions.summary', 'sessions.content', 'prompt.attach', 'requests.check']
const ALL_EVENTS = [...TOLD, 'session.beforeSend', 'session.permissionRequested']

async function ready(window: TestPort, agentId: AgentId, project: string): Promise<string> {
  const { id } = await window.request('sessions.create', { agentId, projectPath: project })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return id
}

it('fires each event once for an ACP agent, sends a plugin only what its permissions allow, and loads it only for its events', async () => {
  const { host, window, install, told } = await started()
  const dir = await tempFolder('kettu-plugins-hooks-')
  const full = await install(await writePlugin(dir, 'hooks', SCRIPT, EVERYTHING, ALL_EVENTS))
  // Asks for the events but for the permissions of the first two only, so most never reach it.
  const narrow = await install(
    await writePlugin(dir, 'narrow', SCRIPT, ['sessions.summary'], ALL_EVENTS),
  )
  const quiet = await install(await writePlugin(dir, 'quiet', SCRIPT, EVERYTHING, []))
  expect(host.pluginLogs).toEqual([])

  const id = await ready(window, 'fake-agent', host.project)
  await vi.waitFor(() => expect(told(full, 'session.started')).toHaveLength(1))
  expect(told(full, 'session.started')[0]).toMatchObject({
    session: { id, agent: 'fake-agent', project: host.project },
  })

  // A message: the hook is asked once, with the text, and what it attaches shows under it.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'Fix the clock' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  expect(told(full, 'session.beforeSend')).toEqual([
    { sessionId: id, session: expect.objectContaining({ id }), text: 'Fix the clock' },
  ])
  expect(window.entries(id).find((entry) => entry.kind === 'user')).toMatchObject({
    content: [{ type: 'text', text: 'Fix the clock' }],
    attached: [
      { pluginId: full, plugin: 'hooks', items: [{ title: 'Ticket', text: 'ABC-1 is open' }] },
    ],
  })
  // The fake agent's three reads, two edits and a test run.
  await vi.waitFor(() => expect(told(full, 'session.toolFinished')).toHaveLength(6))
  expect(told(full, 'session.toolFinished')[3]).toMatchObject({
    kind: 'edit',
    status: 'completed',
    title: 'Edit src/clock.ts',
  })
  await vi.waitFor(() => expect(told(full, 'session.turnEnded')).toHaveLength(1))
  expect(told(full, 'session.turnEnded')[0]).toMatchObject({
    session: { id, state: 'ready' },
    outcome: 'end_turn',
  })

  // A request the plugin denies never reaches the user, and the agent is told it was refused.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/permission' }],
  })
  await vi.waitFor(() => expect(told(full, 'session.permissionRequested')).toHaveLength(1))
  expect(told(full, 'session.permissionRequested')[0]).toMatchObject({
    request: {
      tool: 'Run pnpm test --filter login',
      kind: 'execute',
      command: 'pnpm test --filter login',
    },
  })
  await window.until(() => window.entries(id).some((entry) => entry.kind === 'plugin_denial'))
  expect(window.entries(id).find((entry) => entry.kind === 'plugin_denial')).toMatchObject({
    plugin: 'hooks',
    request: 'pnpm test --filter login',
    reason: 'Not now',
  })
  await window.untilStatus(id, 'ready')
  expect(window.summary(id)?.permissionCount).toBe(0)
  expect(
    window
      .entries(id)
      .some((entry) => entry.kind === 'agent' && entry.markdown.includes('`reject-once`')),
  ).toBe(true)
  expect(told(full, 'session.needsUser')).toHaveLength(0)

  // The next one the plugin lets through, so the user is asked, which needs them.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/permission' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 1)
  await vi.waitFor(() => expect(told(full, 'session.needsUser')).toHaveLength(1))
  expect(told(full, 'session.needsUser')[0]).toMatchObject({
    session: { id },
    reason: 'permission',
  })
  expect(told(full, 'session.permissionRequested')).toHaveLength(2)
  const { entries } = await window.request('sessions.requests', { sessionId: id })
  const asked = entries[0]
  if (asked?.kind !== 'tool' || !asked.permission) throw new Error('No request')
  await window.request('permissions.respond', {
    sessionId: id,
    requestId: asked.permission.requestId,
    optionId: 'allow-once',
  })
  await window.untilStatus(id, 'ready')

  // Each event once per thing that happened, and no more.
  expect(told(full, 'session.started')).toHaveLength(1)
  // A command of the agent's own is not a message to attach to.
  expect(told(full, 'session.beforeSend')).toHaveLength(1)
  await vi.waitFor(() => expect(told(full, 'session.turnEnded')).toHaveLength(3))

  // Without the permissions for them, the narrow plugin hears what sessions.summary shows and
  // nothing of the message or the request, and the one that names no event is never loaded.
  await vi.waitFor(() => expect(told(narrow, 'session.turnEnded')).toHaveLength(3))
  expect(told(narrow, 'session.beforeSend')).toEqual([])
  expect(told(narrow, 'session.permissionRequested')).toEqual([])
  expect(told(narrow, 'session.toolFinished')[0]).not.toHaveProperty('title')
  expect(host.pluginLogs.some((line) => line.startsWith(`${quiet} `))).toBe(false)
  for (const entry of window.entries(id)) {
    if (entry.kind !== 'user') continue
    for (const item of entry.attached ?? []) expect(item.pluginId).toBe(full)
  }
})

it('fires the same hooks for Codex, and puts what a plugin attached in the message it sends', async () => {
  const server = new FakeAppServer()
  const inputs: string[] = []
  let approval: Promise<unknown> | null = null
  let asked = false
  server.on('turn/start', (params, self) => {
    for (const item of params.input as { text?: string }[]) inputs.push(item.text ?? '')
    const started = turn(self.nextTurnId())
    // Only the user's message asks for an approval, not the title the host asks for after it.
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
        availableDecisions: ['accept', 'cancel'],
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
  const { host, window, install, told } = await started({ fakeAppServer: server })
  const dir = await tempFolder('kettu-plugins-hooks-')
  const plugin = await install(await writePlugin(dir, 'hooks', SCRIPT, EVERYTHING, ALL_EVENTS))

  const id = await ready(window, 'codex', host.project)
  await vi.waitFor(() => expect(told(plugin, 'session.started')).toHaveLength(1))
  void window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'Fix the clock' }],
  })
  await vi.waitFor(() => expect(told(plugin, 'session.permissionRequested')).toHaveLength(1))
  expect(told(plugin, 'session.beforeSend')).toHaveLength(1)
  expect(told(plugin, 'session.permissionRequested')[0]).toMatchObject({
    request: { kind: 'execute', command: 'touch a' },
  })
  // The agent got the message as written, then the plugin's attachment as a block of its own.
  expect(inputs).toContain('Fix the clock')
  expect(inputs).toContain('[Added by the plugin "hooks": Ticket]\nABC-1 is open')
  expect(inputs.indexOf('Fix the clock')).toBeLessThan(
    inputs.indexOf('[Added by the plugin "hooks": Ticket]\nABC-1 is open'),
  )
  // Denied before the user was asked: Codex got its own decision for a refusal.
  await expect(approval).resolves.toEqual({ decision: 'cancel' })
  await window.until(() => window.entries(id).some((entry) => entry.kind === 'plugin_denial'))
  expect(window.entries(id).find((entry) => entry.kind === 'plugin_denial')).toMatchObject({
    plugin: 'hooks',
    request: 'touch a',
    reason: 'Not now',
  })
  expect(window.summary(id)?.permissionCount).toBe(0)
  await vi.waitFor(() => expect(told(plugin, 'session.turnEnded')).toHaveLength(1))
  expect(told(plugin, 'session.toolFinished')).toHaveLength(1)
  expect(told(plugin, 'session.needsUser')).toHaveLength(0)
})
