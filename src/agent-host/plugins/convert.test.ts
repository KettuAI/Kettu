import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudePluginFiles, writeFiles } from './claude-plugin-fixture'
import { convertFolder, convertHarnessPlugin, harnessOf } from './convert'
import { readPackage, readPackageFolder, type PackageFile } from './package'

const APP = '0.3.0'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-convert-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function files(source: Record<string, string>): PackageFile[] {
  return Object.entries(source).map(([name, text]) => ({
    path: name,
    data: Buffer.from(text),
    mode: 0o644,
  }))
}

function convert(source: Record<string, string>, folder = 'release-tools') {
  const made = convertHarnessPlugin(files(source), 'claude-code', folder, APP)
  const byPath = new Map(made.files.map((file) => [file.path, file.data.toString('utf8')]))
  return { made, byPath, json: (name: string) => JSON.parse(byPath.get(name)!) as unknown }
}

describe('converting a Claude Code plugin', () => {
  it('copies skills as they are, with the files beside them', () => {
    const { byPath, made } = convert(claudePluginFiles())
    expect(byPath.get('skills/changelog/SKILL.md')).toBe(
      claudePluginFiles()['skills/changelog/SKILL.md'],
    )
    expect(byPath.get('skills/changelog/examples/one.md')).toBe('An example.\n')
    expect(made.conversion.carried).toContainEqual({ label: 'skills', items: ['changelog'] })
  })

  it('names a skill that has no name after its folder, which a listing needs', () => {
    const { byPath, made } = convert({
      ...claudePluginFiles(),
      'skills/lint/SKILL.md': '---\ndescription: Lints.\n---\nLint.\n',
    })
    expect(byPath.get('skills/lint/SKILL.md')).toContain('name: lint')
    expect(made.conversion.notes.map((note) => note.name)).toContain('lint')
  })

  it('writes servers in the standard form, with an explicit type and the plugin variables', () => {
    const { json, made } = convert(claudePluginFiles())
    expect(json('mcp.json')).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        local: { type: 'stdio', command: './bin/server', args: ['--data', '${PLUGIN_ROOT}/data'] },
        tracker: {
          type: 'streamable-http',
          url: 'https://tracker.example.com/mcp',
          headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' },
        },
      },
    })
    // A variable of the user's environment is passed on as written, and the card is told.
    expect(made.conversion.notes.find((note) => note.name === 'tracker')?.message).toContain(
      'TRACKER_TOKEN',
    )
  })

  it('leaves out a server that is no program and no address', () => {
    const { byPath, made } = convert({
      ...claudePluginFiles(),
      '.mcp.json': JSON.stringify({ mcpServers: { broken: { type: 'carrier-pigeon' } } }),
    })
    expect(byPath.has('mcp.json')).toBe(false)
    expect(made.conversion.leftOut).toContainEqual(
      expect.objectContaining({ kind: 'server', name: 'broken' }),
    )
  })

  it('turns a command into a Kettu command with its argument', () => {
    const { byPath, made } = convert(claudePluginFiles())
    const command = byPath.get('sh.kettu/commands/ship.md')!
    expect(command).toContain('description: Ship the release')
    expect(command).toContain('name: version')
    expect(command).toContain('Ship version {{arguments}}.')
    // What a Kettu command has no place for is said, not carried.
    expect(made.conversion.notes.find((note) => note.name === '/ship')?.message).toContain(
      'allowed-tools',
    )
  })

  it('turns an agent into a role that suggests Claude Code only for its own model', () => {
    const { byPath } = convert(claudePluginFiles())
    const role = byPath.get('sh.kettu/roles/reviewer.md')!
    expect(role).toContain('name: reviewer')
    expect(role).toContain('agent: claude-code')
    expect(role).toContain('model: opus')
    expect(role).toContain('You review releases. Be strict.')
    const plain = convert({
      ...claudePluginFiles(),
      'agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\nHelp.\n',
    })
    expect(plain.byPath.get('sh.kettu/roles/helper.md')).not.toContain('agent:')
  })

  it('names every hook it leaves out, with the reason, and the scripts only they used', () => {
    const { byPath, made } = convert(claudePluginFiles())
    const hooks = made.conversion.leftOut.filter((item) => item.kind === 'hook')
    expect(hooks.map((item) => item.name)).toEqual([
      expect.stringContaining('PostToolUse (Write|Edit)'),
      expect.stringContaining('SessionStart'),
    ])
    expect(hooks.every((item) => item.message.length > 0)).toBe(true)
    expect([...byPath.keys()].some((name) => name.startsWith('hooks/'))).toBe(false)
    expect(byPath.has('scripts/format.sh')).toBe(false)
    expect(made.conversion.leftOut).toContainEqual(
      expect.objectContaining({ kind: 'file', name: 'scripts/format.sh' }),
    )
  })

  it('keeps a script a server runs, and the files it has no kind for', () => {
    const { byPath } = convert(claudePluginFiles())
    expect(byPath.get('bin/server')).toBe('#!/bin/sh\necho ok\n')
    expect(byPath.get('README.md')).toBe('# Release tools\n')
  })

  it('makes a package the plugin reader reads, with its own name and version', () => {
    const { made, json } = convert(claudePluginFiles())
    const manifest = json('plugin.json') as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: 'release-tools',
      version: '1.2.0',
      description: 'Helpers for cutting a release.',
      extensions: { 'sh.kettu': { format: 1 } },
    })
    const read = readPackage(made.files, APP).contents
    expect(read).toMatchObject({
      name: 'release-tools',
      skills: [{ name: 'changelog' }],
      servers: [{ name: 'local' }, { name: 'tracker' }],
      commands: [{ name: 'ship' }],
      roles: [{ name: 'reviewer' }],
      script: null,
    })
    // A converted plugin runs no script, so it can publish under any publisher.
    expect(read.permissions).toEqual([])
  })

  it('starts at 1.0.0 when the plugin names no version, and says so', () => {
    const source = claudePluginFiles()
    source['.claude-plugin/plugin.json'] = JSON.stringify({ name: 'bare', description: 'Bare.' })
    const { json, made } = convert(source)
    expect((json('plugin.json') as { version: string }).version).toBe('1.0.0')
    expect(made.conversion.notes.some((note) => note.message.includes('1.0.0'))).toBe(true)
  })

  it('refuses what is no plugin of that harness', () => {
    expect(() =>
      convertHarnessPlugin(files({ 'README.md': 'x' }), 'claude-code', 'x', APP),
    ).toThrow()
    expect(harnessOf(files({ '.codex-plugin/plugin.json': '{}' }))).toBe('codex')
    expect(harnessOf(files({ 'plugin.json': '{}' }))).toBeNull()
  })
})

describe('converting a Codex plugin', () => {
  it('reads its manifest, its display name and its servers', () => {
    const made = convertHarnessPlugin(
      files({
        '.codex-plugin/plugin.json': JSON.stringify({
          name: 'deploy-kit',
          version: '0.4.0',
          description: 'Deploys.',
          interface: { displayName: 'Deploy kit' },
        }),
        'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys.\n---\nDeploy.\n',
        '.mcp.json': JSON.stringify({
          mcpServers: {
            cloud: { url: 'https://cloud.example.com/mcp', http_headers: { 'X-Key': 'a' } },
          },
        }),
        '.app.json': '{}',
      }),
      'codex',
      'deploy-kit',
      APP,
    )
    // The 1.0.0 format has no display name of its own, so it goes in Kettu's entry.
    const contents = readPackage(made.files, APP).contents
    expect(contents.titles).toEqual({ en: 'Deploy kit' })
    expect(made.files.find((file) => file.path === 'mcp.json')!.data.toString()).toContain(
      '"headers"',
    )
    expect(made.conversion.leftOut).toContainEqual(expect.objectContaining({ name: '.app.json' }))
  })
})

describe('converting a folder', () => {
  it('writes a new folder beside it and never changes the one it read', async () => {
    const source = path.join(root, 'release-tools')
    await writeFiles(source, claudePluginFiles())
    const before = await readPackageFolder(source)
    const converted = await convertFolder(source, APP)
    expect(converted.path).toBe(`${source}-kettu`)
    expect(converted.name).toBe('release-tools')
    expect(await readPackageFolder(source)).toEqual(before)
    expect(await readFile(path.join(converted.path, 'plugin.json'), 'utf8')).toContain(
      'agent-plugins.org',
    )
    // The server's script keeps its run bit.
    expect((await stat(path.join(converted.path, 'bin', 'server'))).mode & 0o111).not.toBe(0)
  })

  it('takes the next name when the folder is taken, leaving what is there', async () => {
    const source = path.join(root, 'release-tools')
    await writeFiles(source, claudePluginFiles())
    const first = await convertFolder(source, APP)
    const second = await convertFolder(source, APP)
    expect(second.path).toBe(`${source}-kettu-2`)
    expect(first.path).not.toBe(second.path)
  })

  it('refuses a folder with no harness manifest', async () => {
    const source = path.join(root, 'plain')
    await writeFiles(source, { 'README.md': 'x' })
    await expect(convertFolder(source, APP)).rejects.toMatchObject({ code: 'invalid_params' })
  })
})
