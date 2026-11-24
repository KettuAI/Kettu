import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

type Files = Record<string, string>

/** A plugin with no script that holds only the files it is given under `sh.kettu/templates`. */
async function writePlugin(dir: string, name: string, files: Files): Promise<string> {
  const folder = path.join(dir, name)
  await mkdir(folder, { recursive: true })
  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify({
      $schema: SCHEMA,
      name,
      version: '1.0.0',
      extensions: { 'sh.kettu': { format: 1 } },
    }),
  )
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true })
    await writeFile(path.join(folder, file), text)
  }
  return folder
}

const WEEKLY = {
  'sh.kettu/templates/weekly/template.json': JSON.stringify({
    name: 'Weekly report',
    description: 'A weekly status report',
    type: 'document',
    guidance: 'Fill each heading with what happened this week.',
  }),
  'sh.kettu/templates/weekly/document.md': '# Weekly report\n\n## Done\n\n## Next\n',
  // A deck outline is only a description: the agent writes its files.
  'sh.kettu/templates/outline.json': JSON.stringify({
    name: 'Outline',
    description: 'A short deck outline',
    type: 'slides',
  }),
}

const SNEAKY = {
  // Code beside the content, a type of its own and a link out of the folder are all refused.
  'sh.kettu/templates/with-code/template.json': JSON.stringify({ name: 'Code', type: 'document' }),
  'sh.kettu/templates/with-code/document.md': '# Code\n',
  'sh.kettu/templates/with-code/viewer.js': 'alert(1)',
  'sh.kettu/templates/own-type/template.json': JSON.stringify({ name: 'Own', type: 'viewer' }),
  'sh.kettu/templates/own-type/document.md': '# Own\n',
}

async function started() {
  const host = await startTestHost({ pluginHost: true })
  hosts.push(host)
  const window = host.connect()
  const install = async (folder: string): Promise<string> => {
    const plan = await window.request('plugins.inspect', {
      source: { kind: 'local', path: folder },
    })
    return (await window.request('plugins.install', { token: plan.token })).id
  }
  return { host, window, install }
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
  const last = window
    .entries(id)
    .filter((entry) => entry.kind === 'agent')
    .at(-1)
  return last?.kind === 'agent' ? last.markdown : ''
}

it("lists a plugin's templates beside the types, reads one and makes an artifact from it", async () => {
  const { host, window, install } = await started()
  const dir = await tempFolder('kettu-plugin-templates-')
  const plugin = await install(await writePlugin(dir, 'acme', { ...WEEKLY, ...SNEAKY }))
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  // Marked with the plugin, beside the built-in types; the ones that add code or a type are left out.
  const listed = await viaAgent(window, id, 'list_artifact_types')
  expect(listed).toContain('document:')
  expect(listed).toContain('Template acme:weekly of the plugin acme, a document')
  expect(listed).toContain('Template acme:outline of the plugin acme, a slides')
  expect(listed).not.toContain('with-code')
  expect(listed).not.toContain('own-type')

  const read = await viaAgent(window, id, 'read_artifact_type', {
    type: 'document',
    template: 'acme:weekly',
  })
  expect(read).toContain('Fill each heading with what happened this week.')
  expect(read).toContain('It begins from document.md')
  expect(
    await viaAgent(window, id, 'read_artifact_type', { type: 'slides', template: 'acme:weekly' }),
  ).toContain('makes a document')

  // From its starter files alone, and from them with one replaced.
  const made = await viaAgent(window, id, 'create_artifact_from_type', {
    type: 'document',
    template: 'acme:weekly',
    title: 'Week 12',
  })
  expect(made).toContain('from the document type and the template acme:weekly')
  const first = /art_[0-9A-Z]{26}/.exec(made)?.[0]
  if (!first) throw new Error(`No artifact in: ${made}`)
  const text = async (artifact: string): Promise<string> => {
    const { bytes } = await window.request('artifacts.file', {
      id: artifact,
      version: 1,
      path: 'document.md',
    })
    return new TextDecoder().decode(bytes)
  }
  expect(await text(first)).toBe('# Weekly report\n\n## Done\n\n## Next\n')
  expect((await window.request('artifacts.read', { id: first })).type).toEqual({
    name: 'document',
    format: 1,
  })

  const changed = await viaAgent(window, id, 'create_artifact_from_type', {
    type: 'document',
    template: 'acme:weekly',
    title: 'Week 13',
    files: [{ path: 'document.md', content: '# Week 13\n\n## Done\n\nShipped it.\n' }],
  })
  const second = /art_[0-9A-Z]{26}/.exec(changed)?.[0]
  if (!second) throw new Error(`No artifact in: ${changed}`)
  expect(await text(second)).toBe('# Week 13\n\n## Done\n\nShipped it.\n')

  // A template that has no files of its own still wants the content from the agent.
  expect(
    await viaAgent(window, id, 'create_artifact_from_type', {
      type: 'slides',
      template: 'acme:outline',
      title: 'Deck',
    }),
  ).toContain('slides.json is missing')
  expect(
    await viaAgent(window, id, 'create_artifact_from_type', {
      type: 'document',
      template: 'acme:with-code',
      title: 'Nope',
    }),
  ).toContain('There is no template')

  // A plugin turned off takes its templates with it, and back on they return.
  await window.request('plugins.setEnabled', { pluginId: plugin, enabled: false })
  expect(await viaAgent(window, id, 'list_artifact_types')).not.toContain('acme:weekly')
  expect(
    await viaAgent(window, id, 'create_artifact_from_type', {
      type: 'document',
      template: 'acme:weekly',
      title: 'Week 14',
    }),
  ).toContain('There is no template')
  await window.request('plugins.setEnabled', { pluginId: plugin, enabled: true })
  expect(await viaAgent(window, id, 'list_artifact_types')).toContain('acme:weekly')
})
