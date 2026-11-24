import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expand, serverSpec } from './mcp'
import { readPackage, readPackageFolder, safePackagePath, type PackageFile } from './package'

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
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

const file = (name: string, text: string | object): PackageFile => ({
  path: name,
  data: Buffer.from(typeof text === 'string' ? text : JSON.stringify(text)),
  mode: 0o644,
})
const skill = (name: string, description = 'Does it.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`
const manifest = (extra: Record<string, unknown> = {}): PackageFile =>
  file('plugin.json', { $schema: SCHEMA, name: 'review-kit', version: '1.0.0', ...extra })
const read = (files: PackageFile[]) => readPackage(files, '0.3.0')

describe('a plugin package', () => {
  it('finds the skills in the immediate subfolders of skills/ alone', () => {
    const { contents } = read([
      manifest(),
      file('skills/review/SKILL.md', skill('review')),
      file('skills/review/scripts/run.sh', '#!/bin/sh\n'),
      file('skills/deep/er/SKILL.md', skill('deeper')),
      file('skills/SKILL.md', skill('top')),
      file('other/SKILL.md', skill('other')),
    ])
    expect(contents.skills).toEqual([
      { name: 'review', description: 'Does it.', path: 'skills/review' },
    ])
  })

  it('leaves out a skill that does not read, with a warning, and keeps the rest', () => {
    const { contents } = read([
      manifest(),
      file('skills/bad/SKILL.md', '---\nname: Bad Name\ndescription: x\n---\n'),
      file('skills/none/SKILL.md', '---\nname: none\n---\n'),
      file('skills/twin/SKILL.md', skill('review')),
      file('skills/review/SKILL.md', skill('review')),
    ])
    expect(contents.skills.map((item) => item.name)).toEqual(['review'])
    expect(contents.warnings).toHaveLength(3)
  })

  it('reads the servers of mcp.json, each with its type and what it runs', () => {
    const { contents, servers } = read([
      manifest(),
      file('bin/server', '#!/bin/sh\n'),
      file('mcp.json', {
        $schema: MCP_SCHEMA,
        mcpServers: {
          local: {
            type: 'stdio',
            command: './bin/server',
            args: ['--data', '${PLUGIN_DATA}/db'],
            env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
          },
          api: { type: 'streamable-http', url: 'https://deploy.example.com/mcp' },
          old: { type: 'sse', url: 'http://localhost:9000/sse', headers: { 'X-Tenant': 'a' } },
        },
      }),
    ])
    expect(contents.servers).toEqual([
      { name: 'api', type: 'streamable-http', runs: 'https://deploy.example.com/mcp' },
      { name: 'local', type: 'stdio', runs: './bin/server --data ${PLUGIN_DATA}/db' },
      { name: 'old', type: 'sse', runs: 'http://localhost:9000/sse' },
    ])
    expect(servers).toHaveLength(3)
    expect(contents.warnings).toEqual([])
  })

  it.each([
    ['no type', { command: 'npx' }],
    ['an unknown type', { type: 'websocket', url: 'wss://a.example' }],
    ['a field of another variant', { type: 'stdio', command: 'npx', url: 'https://a.example' }],
    ['a shell command line', { type: 'stdio', command: 'npx -y server' }],
    ['a program outside the package', { type: 'stdio', command: './../../bin/sh' }],
    ['a program by an absolute path', { type: 'stdio', command: '/bin/sh' }],
    ['a bundled program that is not in it', { type: 'stdio', command: './bin/missing' }],
    ['a reserved variable', { type: 'stdio', command: 'npx', env: { PLUGIN_ROOT: '/' } }],
    ['a folder outside the package', { type: 'stdio', command: 'npx', cwd: './../..' }],
    ['a folder that is not relative', { type: 'stdio', command: 'npx', cwd: '/etc' }],
    ['plain http to another computer', { type: 'sse', url: 'http://example.com/sse' }],
    ['a URL with a password', { type: 'sse', url: 'https://a:b@example.com/sse' }],
    ['one header twice', { type: 'sse', url: 'https://a.example', headers: { A: '1', a: '2' } }],
  ])('leaves out a server with %s, and keeps the others', (_, bad) => {
    const { contents } = read([
      manifest(),
      file('mcp.json', {
        $schema: MCP_SCHEMA,
        mcpServers: { bad, good: { type: 'stdio', command: 'npx', args: ['-y', 'server'] } },
      }),
    ])
    expect(contents.servers.map((item) => item.name)).toEqual(['good'])
    expect(contents.warnings).toHaveLength(1)
  })

  it('turns MCP off for a file of another format version, or with a field it does not have', () => {
    const servers = { a: { type: 'stdio', command: 'npx' } }
    for (const mcp of [
      { $schema: MCP_SCHEMA.replace('1.0.0', '1.1.0'), mcpServers: servers },
      { $schema: MCP_SCHEMA, mcpServers: servers, extra: true },
      { mcpServers: servers },
    ]) {
      const { contents } = read([manifest(), file('mcp.json', mcp)])
      expect(contents.servers).toEqual([])
      expect(contents.warnings).toHaveLength(1)
    }
  })

  it('reads the items of the sh.kettu folder, one per file or folder', () => {
    const { contents } = read([
      manifest(),
      file('sh.kettu/commands/ship.md', '---\ndescription: Ships it.\n---\nShip $1.'),
      file('sh.kettu/commands/audit/command.md', '---\nname: Audit\n---\nAudit.'),
      file('sh.kettu/commands/audit/notes.txt', 'x'),
      file(
        'sh.kettu/roles/reviewer.md',
        '---\nname: Reviewer\ndescription: Reviews.\n---\nBe strict.',
      ),
      file('sh.kettu/workflows/quick.yaml', WORKFLOW),
      file('sh.kettu/themes/dusk.json', { name: 'Dusk', description: 'Dark.' }),
      file('sh.kettu/templates/report/template.json', { name: 'Report' }),
      file('sh.kettu/templates/report/index.html', '<p></p>'),
      file('sh.kettu/templates/note.html', '<p></p>'),
    ])
    expect(contents.commands).toEqual([
      {
        name: 'audit',
        title: 'Audit',
        description: '',
        path: 'sh.kettu/commands/audit/command.md',
      },
      { name: 'ship', description: 'Ships it.', path: 'sh.kettu/commands/ship.md' },
    ])
    expect(contents.roles).toEqual([
      {
        name: 'reviewer',
        title: 'Reviewer',
        description: 'Reviews.',
        path: 'sh.kettu/roles/reviewer.md',
      },
    ])
    expect(contents.workflows).toEqual([
      { name: 'quick', title: 'Quick fix', description: '', path: 'sh.kettu/workflows/quick.yaml' },
    ])
    expect(contents.themes.map((item) => item.name)).toEqual(['dusk'])
    expect(contents.templates.map((item) => item.name)).toEqual(['note', 'report'])
    expect(contents.warnings).toEqual([])
  })

  it('leaves out what it cannot list in the sh.kettu folder, with a warning each', () => {
    const { contents } = read([
      manifest(),
      file('sh.kettu/commands/ship.txt', 'x'),
      file('sh.kettu/commands/bad name.md', 'x'),
      file('sh.kettu/commands/empty/readme.md', 'x'),
      file('sh.kettu/workflows/broken.yaml', 'name: [\n'),
      file('sh.kettu/themes/dusk.json', '{'),
      file('sh.kettu/bots/helper.md', 'x'),
    ])
    expect(contents.commands).toEqual([])
    expect(contents.workflows).toEqual([])
    expect(contents.themes).toEqual([])
    expect(contents.warnings).toHaveLength(6)
  })

  it('says that portable hooks do not run, and holds no script for a package without one', () => {
    const { contents } = read([manifest(), file('hooks.json', { hooks: {} })])
    expect(contents.hooks).toBe(true)
    expect(contents.script).toBeNull()
    expect(contents.warnings).toHaveLength(1)
  })

  it('keeps the script and its permissions as declared', () => {
    const entry = { format: 1, script: './sh.kettu/main.js', api: 1, permissions: ['tools'] }
    const files = [manifest({ extensions: { 'sh.kettu': entry } })]
    expect(() => read(files)).toThrowError(/main\.js/)
    const { contents } = read([...files, file('sh.kettu/main.js', 'export {}')])
    expect(contents.script).toEqual({ entry: 'sh.kettu/main.js', api: 1 })
    expect(contents.permissions).toEqual(['tools'])
  })

  it('takes the icon from assets/icon.png alone', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const { contents } = read([
      manifest(),
      { path: 'assets/icon.png', data: png, mode: 0o644 },
      file('assets/icon.svg', '<svg onload="x()"/>'),
    ])
    expect(contents.icon).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(read([manifest(), file('assets/icon.svg', '<svg/>')]).contents.icon).toBeNull()
  })

  it('refuses a package without a manifest, or with a path that could leave it', () => {
    expect(() => read([file('skills/a/SKILL.md', skill('a'))])).toThrowError(/plugin\.json/)
    for (const bad of ['../plugin.json', 'skills/../../x', '/etc/passwd', 'a\\b', 'C:/x', 'a//b']) {
      expect(safePackagePath(bad)).toBe(false)
      expect(() => read([manifest(), file(bad, 'x')])).toThrowError(
        expect.objectContaining({ code: 'invalid_params' }),
      )
    }
  })
})

describe('a server of a package, as Kettu keeps it', () => {
  it('runs a bundled program by its path in the package, with both folders in its environment', () => {
    const { servers } = read([
      manifest(),
      file('bin/server', '#!/bin/sh\n'),
      file('mcp.json', {
        $schema: MCP_SCHEMA,
        mcpServers: {
          local: {
            type: 'stdio',
            command: './bin/server',
            args: ['${PLUGIN_DATA}/db', '${HOME}', '${PLUGIN_ROOT}'],
            env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
          },
        },
      }),
    ])
    const root = path.join(path.sep, 'plugins', 'p1', 'v-1')
    const data = path.join(path.sep, 'plugins', 'p1', 'data')
    expect(serverSpec(servers[0]!, root, data)).toEqual({
      type: 'stdio',
      command: path.join(root, 'bin', 'server'),
      args: [`${data}/db`, '${HOME}', root],
      env: [
        { name: 'CONFIG', value: `${root}/config.json` },
        { name: 'PLUGIN_ROOT', value: root },
        { name: 'PLUGIN_DATA', value: data },
      ],
    })
  })

  it('never reads a replacement again for another placeholder', () => {
    expect(expand('${PLUGIN_ROOT}', '${PLUGIN_DATA}', '/data')).toBe('${PLUGIN_DATA}')
  })
})

describe('a package folder', () => {
  let root: string
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a link, so nothing outside the folder is read', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kettu-plugin-folder-'))
    const outside = path.join(root, 'secret')
    const folder = path.join(root, 'plugin')
    await mkdir(path.join(folder, 'skills'), { recursive: true })
    await writeFile(outside, 'token')
    await writeFile(path.join(folder, 'plugin.json'), manifest().data)
    await symlink(outside, path.join(folder, 'skills', 'leak'))
    await expect(readPackageFolder(folder)).rejects.toMatchObject({ code: 'invalid_params' })
    await rm(path.join(folder, 'skills', 'leak'))
    await symlink(root, path.join(folder, 'up'), 'dir')
    await expect(readPackageFolder(folder)).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('stops at the limits', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kettu-plugin-folder-'))
    await writeFile(path.join(root, 'plugin.json'), manifest().data)
    await writeFile(path.join(root, 'big'), Buffer.alloc(2048))
    await expect(readPackageFolder(root, { files: 10, bytes: 1024 })).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(readPackageFolder(root, { files: 1, bytes: 1 << 20 })).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})
