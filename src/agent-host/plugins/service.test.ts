import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommunityListing } from '@shared/market-community'
import type { MarketListing } from '@shared/market-publish'
import type { MarketServer, MarketSkill } from '@shared/marketplace'
import { pluginItemId } from '@shared/plugins'
import { applyListEdit } from '@shared/settings'
import { usableWorkflow } from '@shared/workflow'
import { MarketSkillsService, skillFolder, skillsCatalogFile } from '../marketplace/skills'
import { checkFolder } from '../marketplace/publish-check'
import { emptyWorkflowsFile, WorkflowLibrary } from '../workflow/library'
import { claudePluginFiles } from './claude-plugin-fixture'
import { convertFolder } from './convert'
import { addedAccess, PluginsService } from './service'
import { emptyPluginsFile, parsePluginsFile, type PluginsFile } from './store'

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const LISTING = 'abcdefghij'
const WORKFLOW = `format: 1
name: Quick fix
steps:
  - id: fix
    name: Fix
    prompt: Fix it.
    outcomes:
      - name: Done
        end: done
`
const log = () => {}

type Files = Record<string, string>

function packageFiles(extra: Files = {}, entry: Record<string, unknown> = {}): Files {
  return {
    'plugin.json': JSON.stringify({
      $schema: SCHEMA,
      name: 'review-kit',
      version: '1.0.0',
      extensions: { 'sh.kettu': { format: 1, ...entry } },
    }),
    'skills/review/SKILL.md': '---\nname: review\ndescription: Reviews a change.\n---\nReview.\n',
    'skills/review/notes.md': 'Notes.',
    'mcp.json': JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        tracker: { type: 'streamable-http', url: 'https://tracker.example.com/mcp' },
        local: { type: 'stdio', command: './bin/server', args: ['${PLUGIN_DATA}'] },
      },
    }),
    'bin/server': '#!/bin/sh\n',
    'sh.kettu/commands/ship.md': '---\ndescription: Ships it.\n---\nShip.',
    'sh.kettu/roles/reviewer.md': '---\ndescription: Reviews.\n---\nBe strict.',
    'sh.kettu/workflows/quick.yaml': WORKFLOW,
    'sh.kettu/themes/dusk.json': '{"name":"Dusk"}',
    'sh.kettu/templates/note.html': '<p></p>',
    ...extra,
  }
}

async function writeTree(dir: string, files: Files): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, text)
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-plugins-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A host's libraries around the service: the settings' lists, the skills on disk, the workflows. */
async function host(data: PluginsFile = emptyPluginsFile()) {
  const settings = { skills: [] as MarketSkill[], servers: [] as MarketServer[] }
  let saved = structuredClone(data)
  // What the Kettu Marketplace lists under the one listing, as the service would download it.
  const market = { version: '1.0.0', files: packageFiles() }
  const counted: string[] = []
  // What the host is told of a plugin's settings and removal, and the secrets its store holds.
  const told = { removed: [] as string[], settings: [] as string[], secrets: [] as string[] }
  const skills = new MarketSkillsService({
    userDataPath: root,
    file: skillsCatalogFile(root, log),
    log,
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    home: root,
    settings: () => settings.skills,
    agents: () => [],
    configFolder: () => null,
    codexSkills: async () => null,
    kettu: async () => {
      throw new Error('not used')
    },
  })
  const workflowDir = path.join(root, 'workflows')
  let workflowsSaved = emptyWorkflowsFile()
  const library: WorkflowLibrary = new WorkflowLibrary({
    dir: workflowDir,
    file: {
      load: async () => structuredClone(workflowsSaved),
      save: (value) => {
        workflowsSaved = structuredClone(value)
      },
      flush: async () => {},
    },
    knownTools: () => ({ mcp: new Set(), skills: new Set() }),
    log,
    pluginOn: (id) => plugins.on(id),
  })
  await library.load()
  const listing = (): MarketListing => ({
    id: LISTING,
    handle: 'bea',
    slug: 'review-kit',
    name: 'Review kit',
    kind: 'agent-plugin',
    description: 'Reviews.',
    visibility: 'public',
    official: false,
    version: market.version,
    versions: [market.version],
    installs: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    mine: false,
  })
  const plugins: PluginsService = new PluginsService({
    userDataPath: root,
    file: {
      load: async () => structuredClone(saved),
      save: (value) => {
        saved = structuredClone(value)
      },
      flush: async () => {},
    },
    log,
    appVersion: '0.3.0',
    settings: async () => ({ skills: [...settings.skills], servers: [...settings.servers] }),
    editSettings: async (edit) => {
      if (edit.skills) settings.skills = applyListEdit(settings.skills, edit.skills)
      if (edit.servers) settings.servers = applyListEdit(settings.servers, edit.servers)
    },
    keepSkill: (id, name, files) => skills.keepFiles(id, name, files),
    workflows: {
      install: (text, origin) => library.installPlugin(text, origin),
      remove: (id, keep) => library.removePlugin(id, keep),
      changed: () => library.pluginChanged(),
    },
    kettu: async () => ({
      listing: listing(),
      files: Object.entries(market.files).map(([name, text]) => ({
        path: name,
        data: Buffer.from(text),
      })),
    }),
    listing: async (): Promise<CommunityListing> => ({
      state: 'listed',
      listing: listing(),
      server: null,
      bundle: null,
    }),
    count: (id, version, reason) => counted.push(`${reason} ${id} ${version}`),
    secretsSet: () => told.secrets,
    removed: (id) => told.removed.push(id),
    settingChanged: (id, key) => told.settings.push(`${id}:${key}`),
    changed: () => {},
  })
  await plugins.load()
  const skillFile = (id: string, name: string): string =>
    path.join(root, 'marketplace', 'skills', skillFolder(id), name, 'SKILL.md')
  return { plugins, settings, library, market, counted, told, saved: () => saved, skillFile }
}

async function installFolder(h: Awaited<ReturnType<typeof host>>, files = packageFiles()) {
  const folder = path.join(root, 'source')
  await writeTree(folder, files)
  const plan = await h.plugins.inspect({ kind: 'local', path: folder })
  return { folder, plan, plugin: await h.plugins.install(plan.token) }
}

const fromMarket = { kind: 'kettu', id: LISTING } as const

describe('inspecting a plugin', () => {
  it('says what the package holds and would run, and writes nothing', async () => {
    const h = await host()
    const folder = path.join(root, 'source')
    await writeTree(folder, packageFiles({ 'hooks.json': '{}' }, { permissions: ['tools'] }))
    const plan = await h.plugins.inspect({ kind: 'local', path: folder })
    expect(plan.blocked).toBeNull()
    expect(plan.replaces).toBeNull()
    expect(plan.contents).toMatchObject({
      name: 'review-kit',
      skills: [{ name: 'review' }],
      servers: [
        { name: 'local', runs: './bin/server ${PLUGIN_DATA}' },
        { name: 'tracker', runs: 'https://tracker.example.com/mcp' },
      ],
      commands: [{ name: 'ship' }],
      roles: [{ name: 'reviewer' }],
      workflows: [{ name: 'quick' }],
      themes: [{ name: 'dusk' }],
      templates: [{ name: 'note' }],
      permissions: ['tools'],
      hooks: true,
    })
    expect(h.settings).toEqual({ skills: [], servers: [] })
    expect(await h.library.list()).toEqual([])
    expect(await h.plugins.list()).toEqual([])
    expect(existsSync(h.plugins.root)).toBe(false)
    expect(existsSync(path.join(root, 'marketplace', 'skills'))).toBe(false)
  })

  it('installs only what an inspection showed, once', async () => {
    const h = await host()
    await expect(h.plugins.install('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'not_found',
    })
    const { plan } = await installFolder(h)
    await expect(h.plugins.install(plan.token)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('blocks a package whose skill has the name of one Kettu already keeps', async () => {
    const h = await host()
    h.settings.skills.push({
      id: 'local:11111111-1111-4111-8111-111111111111',
      name: 'review',
      description: 'Mine.',
      source: 'local',
      origin: '/skills/review',
      version: null,
      agents: 'all',
      on: true,
    })
    const folder = path.join(root, 'source')
    await writeTree(folder, packageFiles())
    const plan = await h.plugins.inspect({ kind: 'local', path: folder })
    expect(plan.blocked).toContain('review')
    await expect(h.plugins.install(plan.token)).rejects.toMatchObject({ code: 'conflict' })
    expect(h.settings.skills).toHaveLength(1)
    expect(h.settings.servers).toEqual([])
    expect(await h.plugins.list()).toEqual([])
  })
})

describe('installing a plugin', () => {
  it('puts every kind of item in its library, marked with the plugin', async () => {
    const h = await host()
    const { plugin } = await installFolder(h)
    const { id } = plugin
    expect(plugin).toMatchObject({ development: true, enabled: true, revision: null })
    const skillId = pluginItemId(id, 'review')
    expect(h.settings.skills).toEqual([
      {
        id: skillId,
        name: 'review',
        description: 'Reviews a change.',
        source: 'plugin',
        origin: 'review-kit',
        version: '1.0.0',
        agents: 'all',
        on: true,
      },
    ])
    expect(await readFile(h.skillFile(skillId, 'review'), 'utf8')).toContain('name: review')
    const dir = path.join(h.plugins.root, id, h.saved().plugins[id]!.dir)
    const data = path.join(h.plugins.root, id, 'data')
    expect(h.settings.servers).toEqual([
      {
        id: pluginItemId(id, 'local'),
        name: 'local',
        title: 'local',
        source: 'plugin',
        version: '1.0.0',
        spec: {
          type: 'stdio',
          command: path.join(dir, 'bin', 'server'),
          args: [data],
          env: [
            { name: 'PLUGIN_ROOT', value: dir },
            { name: 'PLUGIN_DATA', value: data },
          ],
        },
        agents: 'all',
        on: true,
      },
      expect.objectContaining({
        id: pluginItemId(id, 'tracker'),
        name: 'tracker',
        spec: {
          type: 'http',
          transport: 'streamable-http',
          url: 'https://tracker.example.com/mcp',
          headers: [],
        },
      }),
    ])
    expect(existsSync(data)).toBe(true)
    const [workflow] = await h.library.list()
    expect(workflow).toMatchObject({
      source: 'plugin',
      approval: 'pending',
      origin: { kind: 'plugin', pluginId: id, name: 'quick' },
    })
    expect(usableWorkflow(workflow!)).toBe(false)
    expect(plugin.kept.workflows).toEqual([workflow!.id])
    for (const kind of ['commands', 'roles', 'themes', 'templates'] as const) {
      const [item] = await h.plugins.resources(kind)
      expect(item).toMatchObject({ pluginId: id, plugin: 'review-kit' })
      expect(item!.file.startsWith(dir + path.sep)).toBe(true)
      expect(existsSync(item!.file)).toBe(true)
    }
  })

  it('gives a server a name no other server Kettu keeps has', async () => {
    const h = await host()
    h.settings.servers.push({
      id: 'manual:11111111-1111-4111-8111-111111111111',
      name: 'tracker',
      title: 'Tracker',
      source: 'manual',
      version: null,
      spec: { type: 'http', transport: 'sse', url: 'https://a.example', headers: [] },
      agents: 'all',
      on: true,
    })
    const { plugin } = await installFolder(h)
    expect(h.settings.servers.map((server) => server.name)).toEqual([
      'tracker',
      'local',
      'tracker-2',
    ])
    await h.plugins.reload(plugin.id)
    expect(h.settings.servers.map((server) => server.name)).toEqual([
      'tracker',
      'local',
      'tracker-2',
    ])
  })

  it('keeps its copy until Reload, however the folder changes', async () => {
    const h = await host()
    const { folder, plugin } = await installFolder(h)
    const skillId = pluginItemId(plugin.id, 'review')
    h.settings.skills = h.settings.skills.map((skill) => ({ ...skill, agents: ['claude-code'] }))
    await writeTree(
      folder,
      packageFiles({
        'skills/review/SKILL.md': '---\nname: review\ndescription: Changed.\n---\n',
        'skills/tidy/SKILL.md': '---\nname: tidy\ndescription: Tidies.\n---\n',
      }),
    )
    await rm(path.join(folder, 'sh.kettu', 'commands'), { recursive: true })
    await rm(path.join(folder, 'mcp.json'))
    expect(await readFile(h.skillFile(skillId, 'review'), 'utf8')).toContain('Reviews a change.')
    expect(await h.plugins.resources('commands')).toHaveLength(1)
    const reloaded = await h.plugins.reload(plugin.id)
    expect(reloaded.id).toBe(plugin.id)
    expect(reloaded.previous).toBeNull()
    expect(h.settings.skills.map((skill) => [skill.name, skill.description, skill.agents])).toEqual(
      [
        ['review', 'Changed.', ['claude-code']],
        ['tidy', 'Tidies.', 'all'],
      ],
    )
    expect(h.settings.servers).toEqual([])
    expect(await h.plugins.resources('commands')).toEqual([])
    expect(await readdir(path.join(h.plugins.root, plugin.id))).toHaveLength(2)
  })

  it('turns its items off with the plugin, and on again those that were on', async () => {
    const h = await host()
    const { plugin } = await installFolder(h)
    const [workflow] = await h.library.list()
    await h.library.approve(workflow!.id, workflow!.hash)
    h.settings.servers = h.settings.servers.map((server) =>
      server.name === 'local' ? { ...server, on: false } : server,
    )
    expect((await h.plugins.setEnabled(plugin.id, false)).enabled).toBe(false)
    expect(h.settings.skills.every((skill) => !skill.on)).toBe(true)
    expect(h.settings.servers.every((server) => !server.on)).toBe(true)
    expect(await h.plugins.resources('roles')).toEqual([])
    expect(await h.library.list()).toEqual([])
    await expect(h.library.resolve(workflow!.id)).rejects.toThrowError('turned off')
    await h.plugins.setEnabled(plugin.id, true)
    expect(h.settings.skills.every((skill) => skill.on)).toBe(true)
    expect(h.settings.servers.map((server) => [server.name, server.on])).toEqual([
      ['local', false],
      ['tracker', true],
    ])
    expect(usableWorkflow((await h.library.list())[0]!)).toBe(true)
  })

  it('removes every item with the plugin, and no workflow of it alone', async () => {
    const h = await host()
    const other: MarketSkill = {
      id: 'local:11111111-1111-4111-8111-111111111111',
      name: 'mine',
      description: 'Mine.',
      source: 'local',
      origin: '/skills/mine',
      version: null,
      agents: 'all',
      on: true,
    }
    h.settings.skills.push(other)
    const { plugin } = await installFolder(h)
    const [workflow] = await h.library.list()
    await expect(h.library.remove(workflow!.id)).rejects.toMatchObject({ code: 'restricted' })
    await h.plugins.uninstall(plugin.id)
    expect(h.settings).toEqual({ skills: [other], servers: [] })
    expect(await h.library.list()).toEqual([])
    expect(await h.plugins.list()).toEqual([])
    expect(await h.plugins.resources('commands')).toEqual([])
    expect(existsSync(path.join(h.plugins.root, plugin.id))).toBe(false)
    await expect(h.plugins.uninstall(plugin.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('leaves nothing of a first install that fails', async () => {
    const h = await host()
    const folder = path.join(root, 'source')
    await writeTree(folder, packageFiles())
    const plan = await h.plugins.inspect({ kind: 'local', path: folder })
    h.library.installPlugin = async () => {
      throw new Error('the disk is full')
    }
    await expect(h.plugins.install(plan.token)).rejects.toThrowError('the disk is full')
    expect(h.settings).toEqual({ skills: [], servers: [] })
    expect(await h.plugins.list()).toEqual([])
    expect(await readdir(h.plugins.root)).toEqual([])
  })
})

describe('updating a plugin', () => {
  async function installed(entry: Record<string, unknown> = {}) {
    const h = await host()
    h.market.files = packageFiles({}, entry)
    const plan = await h.plugins.inspect(fromMarket)
    const plugin = await h.plugins.install(plan.token)
    return { h, id: plugin.id, plugin }
  }
  const next = (h: Awaited<ReturnType<typeof host>>, version: string, files: Files): void => {
    h.market.version = version
    h.market.files = {
      ...files,
      'plugin.json': JSON.stringify({ ...JSON.parse(files['plugin.json']!), version }),
    }
  }

  it('installs from the Kettu Marketplace at the listing version', async () => {
    const { h, plugin } = await installed()
    expect(plugin).toMatchObject({
      development: false,
      revision: '1.0.0',
      origin: '@bea/review-kit',
      source: fromMarket,
    })
    expect(h.counted).toEqual([`install ${LISTING} 1.0.0`])
    expect((await h.plugins.checkUpdates())[0]).toMatchObject({ revision: '1.0.0', held: null })
  })

  it('installs a newer version and keeps the one before to roll back to', async () => {
    const { h, id } = await installed()
    const [workflow] = await h.library.list()
    await h.library.approve(workflow!.id, workflow!.hash)
    next(
      h,
      '1.1.0',
      packageFiles({
        'skills/review/SKILL.md': '---\nname: review\ndescription: Better.\n---\n',
        'sh.kettu/commands/audit.md': 'Audit.',
      }),
    )
    const [updated] = await h.plugins.checkUpdates()
    expect(updated).toMatchObject({
      revision: '1.1.0',
      held: null,
      previous: { version: '1.0.0', revision: '1.0.0' },
    })
    expect(h.settings.skills[0]).toMatchObject({ description: 'Better.', version: '1.1.0' })
    expect((await h.plugins.resources('commands')).map((item) => item.name)).toEqual([
      'audit',
      'ship',
    ])
    expect((await h.library.list())[0]).toMatchObject({ approval: 'approved' })
    expect(h.counted).toContain(`update ${LISTING} 1.1.0`)
    const back = await h.plugins.rollBack(id)
    expect(back).toMatchObject({ revision: '1.0.0', previous: null })
    expect(h.settings.skills[0]).toMatchObject({ description: 'Reviews a change.' })
    expect((await h.plugins.resources('commands')).map((item) => item.name)).toEqual(['ship'])
    expect(await readdir(path.join(h.plugins.root, id))).toHaveLength(2)
    // The version rolled back from is not installed again.
    expect((await h.plugins.checkUpdates())[0]).toMatchObject({ revision: '1.0.0' })
    await expect(h.plugins.rollBack(id)).rejects.toMatchObject({ code: 'conflict' })
  })

  const script = { script: './sh.kettu/main.js', api: 1 }
  const main = { 'sh.kettu/main.js': 'export {}' }

  it('keeps the switch and the agents chosen for an item through an update', async () => {
    const { h } = await installed()
    h.settings.skills = h.settings.skills.map((skill) => ({
      ...skill,
      on: false,
      agents: ['codex'],
    }))
    h.settings.servers = h.settings.servers.map((server) =>
      server.name === 'local' ? { ...server, on: false, agents: ['claude-code'] } : server,
    )
    next(
      h,
      '1.1.0',
      packageFiles({ 'skills/review/SKILL.md': '---\nname: review\ndescription: Better.\n---\n' }),
    )
    await h.plugins.checkUpdates()
    expect(h.settings.skills[0]).toMatchObject({
      description: 'Better.',
      on: false,
      agents: ['codex'],
    })
    expect(h.settings.servers.map(({ name, on, agents }) => [name, on, agents])).toEqual([
      ['local', false, ['claude-code']],
      ['tracker', true, 'all'],
    ])
  })

  it('turns on with the plugin what an update added while it was off', async () => {
    const { h, id } = await installed()
    h.settings.servers = h.settings.servers.map((server) =>
      server.name === 'local' ? { ...server, on: false } : server,
    )
    await h.plugins.setEnabled(id, false)
    const files = packageFiles({
      'skills/audit/SKILL.md': '---\nname: audit\ndescription: Audits.\n---\nAudit.\n',
    })
    const mcp = JSON.parse(files['mcp.json']!) as { mcpServers: Record<string, unknown> }
    mcp.mcpServers['extra'] = { type: 'streamable-http', url: 'https://extra.example.com/mcp' }
    next(h, '1.1.0', { ...files, 'mcp.json': JSON.stringify(mcp) })
    expect((await h.plugins.checkUpdates())[0]).toMatchObject({ revision: '1.1.0', held: null })
    const on = () => [
      ...h.settings.skills.map(({ name, on }) => [name, on]),
      ...h.settings.servers.map(({ name, on }) => [name, on]),
    ]
    expect(on().every(([, on]) => on === false)).toBe(true)
    await h.plugins.setEnabled(id, true)
    expect(Object.fromEntries(on())).toEqual({
      review: true,
      audit: true,
      tracker: true,
      local: false,
      extra: true,
    })
  })

  it('holds an update that asks for more permissions, with what it adds', async () => {
    const h = await host()
    h.market.files = packageFiles(main, { ...script, permissions: ['tools'] })
    const { id } = await h.plugins.install((await h.plugins.inspect(fromMarket)).token)
    next(
      h,
      '1.1.0',
      packageFiles(
        { ...main, 'skills/review/SKILL.md': '---\nname: review\ndescription: Better.\n---\n' },
        { ...script, permissions: ['tools', 'sessions.content'] },
      ),
    )
    const [held] = await h.plugins.checkUpdates()
    expect(held).toMatchObject({
      revision: '1.0.0',
      previous: null,
      held: {
        version: '1.1.0',
        revision: '1.1.0',
        script: false,
        permissions: ['sessions.content'],
      },
    })
    expect(held!.contents.permissions).toEqual(['tools'])
    expect(h.settings.skills[0]).toMatchObject({ description: 'Reviews a change.' })
    // A later check leaves it waiting, and still does not install it.
    expect((await h.plugins.checkUpdates(id))[0]).toMatchObject({ revision: '1.0.0' })
    const applied = await h.plugins.applyUpdate(id)
    expect(applied).toMatchObject({
      revision: '1.1.0',
      held: null,
      previous: { revision: '1.0.0' },
    })
    expect(applied.contents.permissions).toEqual(['tools', 'sessions.content'])
    expect(h.settings.skills[0]).toMatchObject({ description: 'Better.' })
    await expect(h.plugins.applyUpdate(id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('keeps what a script may do at the installed version while an update waits', async () => {
    const h = await host()
    h.market.files = packageFiles(main, {
      ...script,
      permissions: ['tools', 'network:a.example.com'],
    })
    const { id } = await h.plugins.install((await h.plugins.inspect(fromMarket)).token)
    next(
      h,
      '1.1.0',
      packageFiles(main, {
        ...script,
        permissions: ['tools', 'network:a.example.com', 'sessions.start', 'network:b.example.com'],
      }),
    )
    const [held] = await h.plugins.checkUpdates()
    expect(held!.held).toMatchObject({
      permissions: ['sessions.start', 'network:b.example.com'],
      declared: ['tools', 'network:a.example.com', 'sessions.start', 'network:b.example.com'],
    })
    // The script that runs and is answered is the old version's, with the old grants.
    const before = h.plugins.scripts()
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({
      id,
      revision: expect.stringContaining(':'),
      permissions: ['tools', 'network:a.example.com'],
    })
    await h.plugins.applyUpdate(id)
    const after = h.plugins.scripts()
    expect(after[0]!.permissions).toEqual([
      'tools',
      'network:a.example.com',
      'sessions.start',
      'network:b.example.com',
    ])
    expect(after[0]!.revision).not.toBe(before[0]!.revision)
  })

  it('wakes a script for the views it declares, and lists them only while it is on', async () => {
    const h = await host()
    h.market.files = packageFiles(main, {
      ...script,
      views: [{ id: 'issues', kind: 'list', title: 'Issues' }],
    })
    const { id } = await h.plugins.install((await h.plugins.inspect(fromMarket)).token)
    expect(h.plugins.scripts()[0]!.activation).toEqual(['view:issues'])
    expect(h.plugins.views(id)).toEqual([{ id: 'issues', kind: 'list', title: { en: 'Issues' } }])
    await h.plugins.setEnabled(id, false)
    expect(h.plugins.views(id)).toEqual([])
  })

  it('wakes a script for the actions it declares, and lists panes and actions only while it is on', async () => {
    const h = await host()
    h.market.files = packageFiles(main, {
      ...script,
      views: [{ id: 'issues', kind: 'list', title: 'Issues', pane: true }],
      actions: [{ id: 'create', title: 'Create an issue' }],
    })
    const { id, contents } = await h.plugins.install((await h.plugins.inspect(fromMarket)).token)
    expect(contents.views).toEqual([
      { id: 'issues', kind: 'list', title: { en: 'Issues' }, pane: true },
    ])
    expect(h.plugins.scripts()[0]!.activation).toEqual(['view:issues', 'action:create'])
    expect(h.plugins.actions(id)).toEqual([{ id: 'create', title: { en: 'Create an issue' } }])
    // What the host keeps comes back as it was declared.
    const [kept] = await h.plugins.list()
    expect(kept!.contents.actions).toEqual([{ id: 'create', title: { en: 'Create an issue' } }])
    await h.plugins.setEnabled(id, false)
    expect(h.plugins.actions(id)).toEqual([])
  })

  it('holds an update that adds a script, and stays where it is once declined', async () => {
    const { h, id } = await installed()
    next(h, '1.1.0', packageFiles(main, script))
    expect((await h.plugins.checkUpdates())[0]).toMatchObject({
      revision: '1.0.0',
      held: { revision: '1.1.0', script: true, permissions: [] },
    })
    expect(await h.plugins.declineUpdate(id)).toMatchObject({ revision: '1.0.0', held: null })
    expect((await h.plugins.checkUpdates())[0]).toMatchObject({ revision: '1.0.0', held: null })
    await expect(h.plugins.declineUpdate(id)).rejects.toMatchObject({ code: 'conflict' })
    // A later version without the script goes in as any update does.
    next(h, '1.2.0', packageFiles())
    expect((await h.plugins.checkUpdates())[0]).toMatchObject({ revision: '1.2.0', held: null })
  })

  it('asks again when the update grew after it was shown', async () => {
    const h = await host()
    h.market.files = packageFiles(main, script)
    const { id } = await h.plugins.install((await h.plugins.inspect(fromMarket)).token)
    next(h, '1.1.0', packageFiles(main, { ...script, permissions: ['tools'] }))
    await h.plugins.checkUpdates()
    next(h, '1.2.0', packageFiles(main, { ...script, permissions: ['tools', 'sessions.start'] }))
    await expect(h.plugins.applyUpdate(id)).rejects.toMatchObject({ code: 'conflict' })
    expect((await h.plugins.list())[0]).toMatchObject({
      revision: '1.0.0',
      held: { revision: '1.2.0', permissions: ['tools', 'sessions.start'] },
    })
    expect(await h.plugins.applyUpdate(id)).toMatchObject({ revision: '1.2.0', held: null })
  })

  it('keeps the version in place when the newer one cannot be installed', async () => {
    const { h } = await installed()
    next(h, '1.1.0', packageFiles({}, { format: 2 }))
    const [plugin] = await h.plugins.checkUpdates()
    expect(plugin).toMatchObject({ revision: '1.0.0', held: null })
    expect(plugin!.updateError).toContain('version 2')
    expect(h.settings.skills).toHaveLength(1)
  })
})

describe('what a newer version asks for', () => {
  it('is a script it did not have, and each permission it did not have', () => {
    const script = { entry: 'main.js', api: 1 }
    expect(addedAccess({ script: null, permissions: [] }, { script, permissions: [] })).toEqual({
      script: true,
      permissions: [],
    })
    expect(
      addedAccess(
        { script, permissions: ['tools', 'network:a.example.com'] },
        { script, permissions: ['network:b.example.com', 'tools', 'sessions.content'] },
      ),
    ).toEqual({ script: false, permissions: ['network:b.example.com', 'sessions.content'] })
    expect(
      addedAccess({ script, permissions: ['tools'] }, { script: null, permissions: [] }),
    ).toEqual({ script: false, permissions: [] })
  })
})

describe('the plugins file', () => {
  it('drops a record whose folder or item path could leave the plugin, alone', async () => {
    const h = await host()
    const { plugin } = await installFolder(h)
    const good = h.saved().plugins[plugin.id]!
    const other = 'p000000000000'
    const parsed = parsePluginsFile({
      plugins: {
        [plugin.id]: {
          ...good,
          contents: {
            ...good.contents,
            commands: [
              ...good.contents.commands,
              { name: 'leak', description: '', path: '../../../etc/passwd' },
            ],
          },
          kept: { ...good.kept, skills: [...good.kept.skills, 'kettu:abcdefghij'] },
        },
        [other]: { ...good, id: other, dir: '../..' },
        'not-an-id': good,
      },
    })
    expect(typeof parsed).toBe('object')
    const { plugins } = parsed as PluginsFile
    expect(Object.keys(plugins)).toEqual([plugin.id])
    expect(plugins[plugin.id]!.contents.commands.map((item) => item.name)).toEqual(['ship'])
    expect(plugins[plugin.id]!.kept.skills).toEqual(good.kept.skills)
    expect(plugins[plugin.id]).toEqual({ ...good })
  })
})

describe('a Claude Code plugin converted to a Kettu plugin', () => {
  it('passes the publish check, and what would upload installs from a folder and from the Marketplace', async () => {
    const h = await host()
    const source = path.join(root, 'release-tools')
    await writeTree(source, claudePluginFiles())
    const converted = await convertFolder(source, '0.3.0')
    const check = await checkFolder(converted.path, '0.3.0')
    expect(check.problems).toEqual([])
    expect(check).toMatchObject({ kind: 'agent-plugin', slug: 'release-tools', version: '1.2.0' })

    const plan = await h.plugins.inspect({ kind: 'local', path: converted.path })
    expect(plan.blocked).toBeNull()
    expect(plan.contents).toMatchObject({
      name: 'release-tools',
      skills: [{ name: 'changelog' }],
      servers: [{ name: 'local' }, { name: 'tracker' }],
      commands: [{ name: 'ship' }],
      roles: [{ name: 'reviewer' }],
      script: null,
    })
    const plugin = await h.plugins.install(plan.token)
    expect(h.settings.skills.map((skill) => skill.id)).toEqual([
      pluginItemId(plugin.id, 'changelog'),
    ])
    expect(h.settings.servers.map((server) => server.name).sort()).toEqual(['local', 'tracker'])
    expect(await h.plugins.resources('commands')).toEqual([
      expect.objectContaining({ name: 'ship', pluginName: 'release-tools' }),
    ])
    expect(await h.plugins.resources('roles')).toEqual([
      expect.objectContaining({ name: 'reviewer' }),
    ])

    // The files the publish would upload are what an install from the Marketplace reads.
    h.market.version = '1.2.0'
    h.market.files = Object.fromEntries(
      check.files.map((file) => [file.path, file.data.toString('utf8')]),
    )
    const fromListing = await h.plugins.inspect(fromMarket)
    expect(fromListing.contents).toMatchObject({
      name: 'release-tools',
      skills: [{ name: 'changelog' }],
      commands: [{ name: 'ship' }],
      roles: [{ name: 'reviewer' }],
    })
  })
})

describe("a plugin's tools, settings and storage", () => {
  const TOOL = {
    name: 'lookup',
    description: 'Looks a word up.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }
  const SETTINGS = [
    { key: 'verbose', type: 'boolean', title: 'Verbose', default: true },
    {
      key: 'mode',
      type: 'select',
      title: 'Mode',
      options: [
        { value: 'fast', title: 'Fast' },
        { value: 'deep', title: 'Deep' },
      ],
    },
    { key: 'name', type: 'string', title: 'Name' },
    { key: 'token', type: 'secret', title: 'Token' },
  ]
  const entry = {
    script: './sh.kettu/main.js',
    api: 1,
    permissions: ['tools'],
    tools: [TOOL],
    settings: SETTINGS,
  }
  const files = packageFiles({ 'sh.kettu/main.js': 'exports.lookup = () => 1' }, entry)

  it('lists the tools of a plugin that is on, has a script and holds the permission', async () => {
    const h = await host()
    expect(h.plugins.tools()).toEqual([])
    const { plugin } = await installFolder(h, files)
    expect(h.plugins.tools()).toMatchObject([
      { name: 'lookup', pluginId: plugin.id, pluginName: 'review-kit' },
    ])
    await h.plugins.setEnabled(plugin.id, false)
    expect(h.plugins.tools()).toEqual([])
    await h.plugins.setEnabled(plugin.id, true)
    expect(h.plugins.tools()).toHaveLength(1)
    await h.plugins.uninstall(plugin.id)
    expect(h.plugins.tools()).toEqual([])
    expect(h.told.removed).toEqual([plugin.id])
  })

  it('wakes the script for a call of one of its tools, which its manifest declares', async () => {
    const h = await host()
    const { plugin } = await installFolder(h, files)
    expect(h.plugins.scripts()[0]?.activation).toEqual(['tool:lookup'])
    // Without the permission the tool is not declared, so nothing is listed or woken for it.
    await h.plugins.uninstall(plugin.id)
    const bare = packageFiles(
      { 'sh.kettu/main.js': 'exports.lookup = () => 1' },
      { script: './sh.kettu/main.js', api: 1, tools: [TOOL] },
    )
    await installFolder(h, bare)
    expect(h.plugins.tools()).toEqual([])
    expect(h.plugins.scripts()[0]?.activation).toEqual([])
  })

  it('holds a setting at its default until one is set, then keeps what was set', async () => {
    const h = await host()
    const { plugin } = await installFolder(h, files)
    expect(plugin.values).toEqual({ verbose: true, mode: 'fast', name: '' })
    const next = await h.plugins.setSetting(plugin.id, 'mode', 'deep')
    await h.plugins.setSetting(plugin.id, 'verbose', false)
    expect(next.values?.mode).toBe('deep')
    expect(h.plugins.settingValue(plugin.id, 'mode')).toBe('deep')
    expect(h.plugins.settingValue(plugin.id, 'verbose')).toBe(false)
    expect(h.told.settings).toEqual([`${plugin.id}:mode`, `${plugin.id}:verbose`])
    // Set to what it holds already, nothing changes and nobody is told.
    await h.plugins.setSetting(plugin.id, 'mode', 'deep')
    expect(h.told.settings).toHaveLength(2)
    expect(h.saved().plugins[plugin.id]?.values).toEqual({ mode: 'deep', verbose: false })
  })

  it.each([
    ['a key it does not declare', 'nothing', 'x'],
    ['a text for a switch', 'verbose', 'yes'],
    ['a choice it does not offer', 'mode', 'slow'],
    ['a text past the cap', 'name', 'x'.repeat(2049)],
    ['a secret, which the key store keeps', 'token', 'hunter2'],
  ])('refuses %s', async (_, key, value) => {
    const h = await host()
    const { plugin } = await installFolder(h, files)
    await expect(h.plugins.setSetting(plugin.id, key, value)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    expect(h.told.settings).toEqual([])
  })

  it('reads a setting at its default again when a reload no longer offers the value', async () => {
    const h = await host()
    const { plugin, folder } = await installFolder(h, files)
    await h.plugins.setSetting(plugin.id, 'mode', 'deep')
    const only = SETTINGS.map((item) =>
      item.key === 'mode' ? { ...item, options: [{ value: 'fast', title: 'Fast' }] } : item,
    )
    await writeTree(
      folder,
      packageFiles(
        { 'sh.kettu/main.js': 'exports.lookup = () => 1' },
        { ...entry, settings: only },
      ),
    )
    const reloaded = await h.plugins.reload(plugin.id)
    expect(reloaded.values?.mode).toBe('fast')
    expect(h.plugins.settingValue(plugin.id, 'mode')).toBe('fast')
  })

  it('says which secrets are set by key, for the ones declared only, never their values', async () => {
    const h = await host()
    const { plugin } = await installFolder(h, files)
    expect((await h.plugins.view(plugin.id)).secretsSet).toEqual([])
    h.told.secrets.push('token', 'gone')
    const view = await h.plugins.view(plugin.id)
    expect(view.secretsSet).toEqual(['token'])
    expect(JSON.stringify(view)).not.toContain('hunter2')
    expect(h.plugins.declaresSecret(plugin.id, 'token')).toBe(true)
    expect(h.plugins.declaresSecret(plugin.id, 'name')).toBe(false)
    expect(() => h.plugins.settingValue(plugin.id, 'token')).toThrow()
  })
})
