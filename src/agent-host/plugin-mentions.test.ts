import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentId } from '@shared/agents'
import type { UserContent } from '@shared/thread'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

const SCRIPT = `
const issues = [
  { id: 'T-1', title: 'Sync drops', subtitle: 'T-1', end: 'open', word: 'T-1' },
  { id: 'T-2', title: 'Slow start', subtitle: 'T-2', end: 'closed', word: 'T-2' },
  { id: 'T-9', title: 'Gone', subtitle: 'T-9', word: 'T-9' },
]
kettu.on('mention.search', ({ query }) => ({
  items: issues.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())),
}))
kettu.on('mention.content', ({ item }) => {
  if (item === 'T-9') throw new Error('The tracker has no T-9')
  if (item.startsWith('big')) return { text: 'y'.repeat(16000) }
  return { title: 'Issue ' + item, text: 'Body of ' + item }
})
kettu.on('link.card', ({ match }) => ({
  label: match.key,
  title: 'Issue ' + match.key,
  badges: [{ text: 'open', tone: 'success' }],
}))
`

async function writeTracker(dir: string): Promise<string> {
  const folder = path.join(dir, 'tracker')
  await mkdir(path.join(folder, 'sh.kettu'), { recursive: true })
  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify({
      $schema: SCHEMA,
      name: 'tracker',
      version: '1.0.0',
      extensions: {
        'sh.kettu': {
          format: 1,
          script: './sh.kettu/main.js',
          api: 1,
          permissions: ['prompt.attach', 'network:tracker.example.com'],
          mentions: [{ id: 'issues', title: { en: 'Issues' }, icon: 'bug' }],
          links: [{ id: 'issue', patterns: ['https://tracker.example.com/issues/{key}'] }],
        },
      },
    }),
  )
  await writeFile(path.join(folder, 'sh.kettu', 'main.js'), SCRIPT)
  return folder
}

async function started(options: { fakeAppServer?: FakeAppServer } = {}) {
  const host = await startTestHost({ pluginHost: true, ...options })
  hosts.push(host)
  const window = host.connect()
  const dir = await tempFolder('kettu-plugins-mentions-')
  const folder = await writeTracker(dir)
  const plan = await window.request('plugins.inspect', { source: { kind: 'local', path: folder } })
  const { id: pluginId } = await window.request('plugins.install', { token: plan.token })
  return { host, window, pluginId }
}

async function ready(window: TestPort, agentId: AgentId, project: string): Promise<string> {
  const { id } = await window.request('sessions.create', { agentId, projectPath: project })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return id
}

const mention = (pluginId: string, item: string, word: string, name: string): UserContent => ({
  type: 'ref',
  ref: { kind: 'plugin', pluginId, source: 'issues', item, word, name },
})

it('offers a plugin’s sources and cards to a window, and checks what it asks', async () => {
  const { window, pluginId } = await started()
  const { plugins } = await window.request('plugins.refs', undefined)
  expect(plugins).toEqual([
    expect.objectContaining({
      pluginId,
      title: 'tracker',
      mentions: [{ id: 'issues', title: { en: 'Issues' }, icon: 'bug' }],
      links: [{ id: 'issue', patterns: ['https://tracker.example.com/issues/{key}'] }],
    }),
  ])
  expect(
    await window.request('plugins.mentionSearch', { pluginId, source: 'issues', query: 'sync' }),
  ).toEqual({
    ok: true,
    items: [{ id: 'T-1', title: 'Sync drops', subtitle: 'T-1', end: 'open', word: 'T-1' }],
  })
  expect(
    await window.request('plugins.mentionSearch', { pluginId, source: 'nowhere', query: '' }),
  ).toEqual({ ok: false, error: { code: 'not_found' } })
  expect(
    await window.request('plugins.linkCard', {
      pluginId,
      link: 'issue',
      url: 'https://tracker.example.com/issues/T-7',
    }),
  ).toEqual({
    ok: true,
    card: { label: 'T-7', title: 'Issue T-7', badges: [{ text: 'open', tone: 'success' }] },
  })
  // An address the pattern does not name is never put to the script, whatever a window asks.
  expect(
    await window.request('plugins.linkCard', {
      pluginId,
      link: 'issue',
      url: 'https://evil.example.net/issues/T-7',
    }),
  ).toEqual({ ok: false, error: { code: 'not_found' } })
  await expect(
    window.request('plugins.mentionSearch', { pluginId, source: 'Not An Id', query: '' }),
  ).rejects.toMatchObject({ code: 'invalid_params' })
})

it('gives the agent what a mentioned item adds, and says in the thread what was added and what was not', async () => {
  const { host, window, pluginId } = await started()
  const id = await ready(window, 'fake-agent', host.project)
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [
      { type: 'text', text: 'Look at @T-1 and @T-9' },
      mention(pluginId, 'T-1', 'T-1', 'Sync drops'),
      mention(pluginId, 'T-9', 'T-9', 'Gone'),
    ],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  expect(window.entries(id).find((entry) => entry.kind === 'user')).toMatchObject({
    content: [
      { type: 'text', text: 'Look at @T-1 and @T-9' },
      { type: 'ref', ref: { kind: 'plugin', item: 'T-1' } },
      { type: 'ref', ref: { kind: 'plugin', item: 'T-9' } },
    ],
    attached: [
      {
        pluginId,
        plugin: 'tracker',
        items: [
          { title: 'Issue T-1', text: 'Body of T-1' },
          { title: 'Gone', text: '', failed: 'failed', detail: 'The tracker has no T-9' },
        ],
      },
    ],
  })

  // The fake agent recalls what it was sent: the text, then a block for each item.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/recall' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  const recalled = window
    .entries(id)
    .flatMap((entry) => (entry.kind === 'agent' ? [entry.markdown] : []))
    .find((markdown) => markdown.startsWith('Your last message was:'))
  expect(recalled).toContain('Look at @T-1 and @T-9')
  expect(recalled).toContain('[Added by the plugin "tracker": Issue T-1]\nBody of T-1')
  expect(recalled).toContain(
    '[The plugin "tracker" could not add Gone the user mentioned: it could not give it.]',
  )
})

it('adds no more than a message may hold, and says so for what was left out', async () => {
  const { host, window, pluginId } = await started()
  const id = await ready(window, 'fake-agent', host.project)
  const items = ['big-1', 'big-2', 'big-3', 'big-4']
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [
      { type: 'text', text: items.map((item) => `@${item}`).join(' ') },
      ...items.map((item) => mention(pluginId, item, item, item)),
    ],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  const user = window.entries(id).find((entry) => entry.kind === 'user')
  if (user?.kind !== 'user') throw new Error('No message')
  const added = user.attached?.[0]?.items ?? []
  expect(added.map((item) => item.failed)).toEqual([undefined, undefined, undefined, 'too_large'])
  expect(added.reduce((sum, item) => sum + item.text.length, 0)).toBe(48_000)
})

it('refuses a message with more mentions than it may hold', async () => {
  const { host, window, pluginId } = await started()
  const id = await ready(window, 'fake-agent', host.project)
  const many = Array.from({ length: 11 }, (_, i) => mention(pluginId, `T-${i}`, `T-${i}`, `T-${i}`))
  await expect(
    window.request('sessions.prompt', {
      sessionId: id,
      content: [{ type: 'text', text: 'All of them' }, ...many],
    }),
  ).rejects.toMatchObject({ code: 'invalid_params' })
})

it('sends Codex what a mentioned item adds as a block after the message', async () => {
  const server = new FakeAppServer()
  const inputs: string[] = []
  server.on('turn/start', (params, self) => {
    for (const item of params.input as { text?: string }[]) inputs.push(item.text ?? '')
    const started = turn(self.nextTurnId())
    setTimeout(() => {
      self.notify('turn/started', { threadId: 'thread-1', turn: started })
      self.notify('turn/completed', { threadId: 'thread-1', turn: turn(started.id, 'completed') })
    }, 0)
    return { turn: started }
  })
  const { host, window, pluginId } = await started({ fakeAppServer: server })
  const id = await ready(window, 'codex', host.project)
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'Fix @T-2' }, mention(pluginId, 'T-2', 'T-2', 'Slow start')],
  })
  await vi.waitFor(() =>
    expect(inputs).toContain('[Added by the plugin "tracker": Issue T-2]\nBody of T-2'),
  )
  expect(inputs).toContain('Fix @T-2')
  expect(inputs.indexOf('Fix @T-2')).toBeLessThan(
    inputs.indexOf('[Added by the plugin "tracker": Issue T-2]\nBody of T-2'),
  )
  await vi.waitFor(() =>
    expect(window.entries(id).find((entry) => entry.kind === 'user')).toMatchObject({
      attached: [{ pluginId, items: [{ title: 'Issue T-2', text: 'Body of T-2' }] }],
    }),
  )
})
