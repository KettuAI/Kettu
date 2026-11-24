import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentId } from '@shared/agents'
import { FakeAppServer } from './testing/fake-app-server'
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
const SECRET = 'sk-test-SECRET-0123456789'

const TOOLS = [
  {
    name: 'lookup',
    description: 'Looks a word up.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description: 'Keeps a note.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  },
  { name: 'recall', description: 'Gives the note back.' },
  { name: 'token', description: 'Tells whether the secret reached it.' },
  { name: 'boom', description: 'Always fails.' },
  { name: 'spin', description: 'Never ends.' },
]

const SETTINGS = [
  {
    key: 'mode',
    type: 'select',
    title: 'Mode',
    options: [
      { value: 'fast', title: 'Fast' },
      { value: 'deep', title: 'Deep' },
    ],
  },
  { key: 'verbose', type: 'boolean', title: 'Verbose logging' },
  { key: 'token', type: 'secret', title: 'Access token' },
]

/** A plugin whose tools use its settings, its secret and its storage, and one that fails. */
const SCRIPT = `
kettu.on('settings.changed', (payload) => console.log('EVENT settings.changed ' + JSON.stringify(payload)))
exports.lookup = async ({ query }) => 'Found ' + query + ' in ' + (await kettu.call('settings.get', 'mode')) + ' mode'
exports.remember = async ({ note }) => { await kettu.call('storage.set', 'note', note); return 'kept' }
exports.recall = async () => (await kettu.call('storage.get', 'note')) ?? 'nothing'
exports.token = async () => {
  const token = await kettu.call('settings.secret', 'token')
  return token === null ? 'no secret' : 'secret of ' + token.length + ' characters'
}
exports.boom = () => { throw new Error('the script broke') }
exports.spin = () => { for (;;) {} }
`

async function writePlugin(dir: string, name: string, permissions = ['tools']): Promise<string> {
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
          tools: TOOLS,
          settings: SETTINGS,
        },
      },
    }),
  )
  await writeFile(path.join(folder, 'sh.kettu', 'main.js'), SCRIPT)
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
  const told = (pluginId: string): unknown[] =>
    host.pluginLogs
      .filter((line) => line.startsWith(`${pluginId} info EVENT settings.changed `))
      .map((line) => JSON.parse(line.slice(`${pluginId} info EVENT settings.changed `.length)))
  return { host, window, install, told }
}

async function ready(window: TestPort, agentId: AgentId, project: string): Promise<string> {
  const { id } = await window.request('sessions.create', { agentId, projectPath: project })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return id
}

/** What the fake agent's last reply said, after it called one of Kettu's tools as an agent does. */
async function viaAgent(
  window: TestPort,
  id: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const before = window.entries(id).filter((entry) => entry.kind === 'agent').length
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: `/device ${tool} ${JSON.stringify(args)}` }],
  })
  await window.until(
    () => window.entries(id).filter((entry) => entry.kind === 'agent').length > before,
  )
  await window.untilStatus(id, 'ready')
  const replies = window.entries(id).filter((entry) => entry.kind === 'agent')
  const last = replies.at(-1)
  return last?.kind === 'agent' ? last.markdown : ''
}

it("gives an ACP agent a plugin's tools, which use the plugin's settings, secret and storage", async () => {
  const { host, window, install, told } = await started()
  const dir = await tempFolder('kettu-plugin-tools-')
  const plugin = await install(await writePlugin(dir, 'acme'))
  const id = await ready(window, 'fake-agent', host.project)

  // The tool is on Kettu's service under the plugin's name, and the script is woken for the call.
  expect(host.pluginLogs).toEqual([])
  expect(await viaAgent(window, id, 'acme__lookup', { query: 'clock' })).toContain(
    'Found clock in fast mode',
  )
  // A setting changed in Settings reaches the script, which is told of it and reads it afresh.
  await window.request('plugins.setSetting', { pluginId: plugin, key: 'mode', value: 'deep' })
  await vi.waitFor(() =>
    expect(told(plugin)).toEqual([{ key: 'mode', secret: false, value: 'deep' }]),
  )
  expect(await viaAgent(window, id, 'acme__lookup', { query: 'clock' })).toContain(
    'Found clock in deep mode',
  )

  // Storage is the plugin's own and lasts between calls.
  expect(await viaAgent(window, id, 'acme__recall')).toContain('nothing')
  expect(await viaAgent(window, id, 'acme__remember', { note: 'buy milk' })).toContain('kept')
  expect(await viaAgent(window, id, 'acme__recall')).toContain('buy milk')

  // A secret is stored with the key store, is read by the script alone, and shows only as set.
  expect(await viaAgent(window, id, 'acme__token')).toContain('no secret')
  const set = await window.request('plugins.setSecret', {
    pluginId: plugin,
    key: 'token',
    value: SECRET,
  })
  expect(set.secretsSet).toEqual(['token'])
  expect(host.sent).toContainEqual(
    expect.objectContaining({ type: 'host:plugin-secret', pluginId: plugin, key: 'token' }),
  )
  expect(await viaAgent(window, id, 'acme__token')).toContain(
    `secret of ${SECRET.length} characters`,
  )
  const { plugins } = await window.request('plugins.list', undefined)
  expect(plugins[0]?.secretsSet).toEqual(['token'])
  expect(JSON.stringify(plugins)).not.toContain(SECRET)

  // Agents find the settings, with a secret only as set, and never see its value.
  const found = await viaAgent(window, id, 'find_settings', { query: 'acme' })
  expect(found).toContain('Verbose logging')
  expect(found).toContain('Access token')
  expect(found).not.toContain(SECRET)
  expect(JSON.stringify(window.entries(id))).not.toContain(SECRET)
  expect(host.pluginLogs.join('\n')).not.toContain(SECRET)
})

it('answers a failing, a never-ending and a missing tool with an error, and a tool of a plugin that is off or removed', async () => {
  const { host, window, install } = await started()
  const dir = await tempFolder('kettu-plugin-tools-')
  const plugin = await install(await writePlugin(dir, 'acme'))
  const id = await ready(window, 'fake-agent', host.project)

  // The script's own message, with neither a code nor the name of a plain Error.
  expect(await viaAgent(window, id, 'acme__boom')).toContain('acme__boom failed: the script broke')
  // The call ends at its deadline, with the plugin stopped, instead of leaving the agent waiting.
  expect(await viaAgent(window, id, 'acme__spin')).toContain(
    'acme__spin failed: the plugin was stopped for using too much time or memory',
  )
  // Arguments the manifest does not take are refused before the script runs.
  expect(await viaAgent(window, id, 'acme__lookup', { query: 3 })).toContain(
    'The argument "query" must be a string',
  )

  await window.request('plugins.setEnabled', { pluginId: plugin, enabled: false })
  expect(await viaAgent(window, id, 'acme__lookup', { query: 'x' })).toContain('off or removed')
  await window.request('plugins.setEnabled', { pluginId: plugin, enabled: true })
  expect(await viaAgent(window, id, 'acme__lookup', { query: 'x' })).toContain('Found x')
  // Removing the plugin takes its secrets with it.
  await window.request('plugins.setSecret', { pluginId: plugin, key: 'token', value: SECRET })
  await window.request('plugins.uninstall', { pluginId: plugin })
  expect(await viaAgent(window, id, 'acme__lookup', { query: 'x' })).toContain('off or removed')
  expect(host.sent).toContainEqual(
    expect.objectContaining({ type: 'host:plugin-secret', pluginId: plugin, key: null }),
  )
})

it('refuses a setting or a secret the plugin does not declare, a value it does not take, and a tool without the permission', async () => {
  const { window, install } = await started()
  const dir = await tempFolder('kettu-plugin-tools-')
  const plugin = await install(await writePlugin(dir, 'acme'))
  const bare = await install(await writePlugin(dir, 'bare', []))
  const bad = (method: 'plugins.setSetting' | 'plugins.setSecret', params: object) =>
    expect(
      (window.request as (m: string, p: object) => Promise<unknown>)(method, params),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  await bad('plugins.setSetting', { pluginId: plugin, key: 'nothing', value: 'x' })
  await bad('plugins.setSetting', { pluginId: plugin, key: 'mode', value: 'slow' })
  await bad('plugins.setSetting', { pluginId: plugin, key: 'verbose', value: 'yes' })
  // A secret goes to the key store alone.
  await bad('plugins.setSetting', { pluginId: plugin, key: 'token', value: SECRET })
  await bad('plugins.setSecret', { pluginId: plugin, key: 'mode', value: SECRET })
  await bad('plugins.setSecret', { pluginId: plugin, key: 'token', value: '' })
  // The tools of a plugin that never asked for the permission are not declared at all.
  expect(await window.request('plugins.list', undefined)).toMatchObject({
    plugins: expect.arrayContaining([
      expect.objectContaining({ id: bare, contents: expect.objectContaining({ tools: [] }) }),
    ]),
  })
})

it("gives Codex the plugin's tools on Kettu's service, not allowed without asking", async () => {
  const server = new FakeAppServer()
  const { host, window, install } = await started({ fakeAppServer: server })
  const dir = await tempFolder('kettu-plugin-tools-')
  await install(await writePlugin(dir, 'acme'))
  await ready(window, 'codex', host.project)

  const kettu = (
    server.sent('thread/start')[0]!.config as {
      mcp_servers: Record<
        string,
        { url: string; http_headers: Record<string, string>; tools: Record<string, unknown> }
      >
    }
  ).mcp_servers.kettu!
  // Codex asks about every tool but the ones listed here.
  expect(Object.keys(kettu.tools)).toContain('set_plan')
  expect(Object.keys(kettu.tools).filter((tool) => tool.startsWith('acme__'))).toEqual([])

  const client = new Client({ name: 'codex', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(kettu.url), {
      requestInit: { headers: kettu.http_headers },
    }),
  )
  try {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('acme__lookup')
    const result = await client.callTool({ name: 'acme__lookup', arguments: { query: 'clock' } })
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'Found clock in fast mode' }] })
    const refused = await client.callTool({ name: 'acme__lookup', arguments: {} })
    expect(refused.isError).toBe(true)
  } finally {
    await client.close()
  }
})
