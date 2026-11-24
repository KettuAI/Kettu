import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PUBLISH_LIMITS } from '@shared/market-publish'
import { checkFolder, describe as describeText, findSecrets } from './publish-check'

const APP = '0.3.0'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-publish-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(files: Record<string, string | Buffer>, under = root): Promise<string> {
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(under, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, data)
  }
  return under
}

const SKILL = '---\nname: changelog-writer\ndescription: One line per change.\n---\n\n# Body\n'

describe('checkFolder', () => {
  it('reads a skill, leaving out the repository and the Finder files', async () => {
    await put({
      'SKILL.md': SKILL,
      'examples/one.md': 'Example\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.DS_Store': Buffer.from([0, 1, 2]),
    })
    const check = await checkFolder(root, APP)
    expect(check.problems).toEqual([])
    expect(check).toMatchObject({
      kind: 'skill',
      manifest: 'SKILL.md',
      slug: 'changelog-writer',
      name: 'Changelog writer',
      description: 'One line per change.',
      version: null,
      adds: [{ label: 'skills', items: ['changelog-writer'] }],
      runs: [],
    })
    expect(check.files.map((file) => file.path)).toEqual(['SKILL.md', 'examples/one.md'])
    expect(check.bytes).toBe(Buffer.byteLength(SKILL) + 'Example\n'.length)
  })

  it('needs a skill’s name and description in its front matter', async () => {
    await put({ 'SKILL.md': '---\ntitle: x\n---\n' })
    const check = await checkFolder(root, APP)
    expect(check.problems.map((p) => p.message)).toEqual([
      'It has no name in its front matter.',
      'It has no description in its front matter.',
    ])
  })

  it('offers a Claude Code or Codex plugin for conversion, and refuses a folder it knows nothing of', async () => {
    for (const [manifest, harness] of [
      ['.claude-plugin/plugin.json', 'claude-code'],
      ['.codex-plugin/plugin.json', 'codex'],
    ] as const) {
      const folder = await put(
        { [manifest]: JSON.stringify({ name: 'tools', version: '1.0.0' }), 'SKILL.md': SKILL },
        path.join(root, manifest.split('/')[0]!),
      )
      const plugin = await checkFolder(folder, APP)
      expect(plugin.kind).toBeNull()
      expect(plugin.convertible).toBe(harness)
      expect(plugin.files).toEqual([])
      expect(plugin.problems.map((p) => p.message)).toEqual([
        expect.stringContaining('plugin. The Kettu Marketplace takes Kettu plugins'),
      ])
    }
    const other = await put({ 'README.md': 'hi' }, path.join(root, 'other'))
    const check = await checkFolder(other, APP)
    expect(check.kind).toBeNull()
    expect(check.convertible).toBeNull()
    expect(check.problems[0]!.message).toMatch(/cannot tell what this folder is/)
  })

  describe('a Kettu plugin', () => {
    const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
    const plugin = (extra: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) =>
      JSON.stringify({
        $schema: SCHEMA,
        name: 'review-kit',
        version: '1.0.0',
        description: 'Reviews a change.',
        extensions: { 'sh.kettu': { format: 1, ...entry } },
        ...extra,
      })
    const files = (): Record<string, string> => ({
      'plugin.json': plugin(),
      'skills/review/SKILL.md': '---\nname: review\ndescription: Reviews.\n---\nReview.\n',
      'mcp.json': JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          tracker: { type: 'streamable-http', url: 'https://tracker.example.com/mcp' },
        },
      }),
      'sh.kettu/commands/ship.md': '---\ndescription: Ships it.\n---\nShip.',
      'sh.kettu/roles/reviewer.md': '---\ndescription: Reviews.\n---\nBe strict.',
    })

    it('is read by the plugin reader, as the install reads it', async () => {
      await put(files())
      const check = await checkFolder(root, APP)
      expect(check.problems).toEqual([])
      expect(check).toMatchObject({
        kind: 'agent-plugin',
        manifest: 'plugin.json',
        slug: 'review-kit',
        name: 'review-kit',
        description: 'Reviews a change.',
        version: '1.0.0',
        convertible: null,
        adds: [
          { label: 'skills', items: ['review'] },
          { label: 'servers', items: ['tracker'] },
          { label: 'commands', items: ['ship'] },
          { label: 'roles', items: ['reviewer'] },
        ],
        runs: ['https://tracker.example.com/mcp'],
      })
      expect(check.plugin).toMatchObject({ script: null, permissions: [] })
      expect(check.files.map((file) => file.path)).toContain('plugin.json')
    })

    it('lists a script with its permissions apart from what it adds', async () => {
      await put({
        ...files(),
        'plugin.json': plugin({}, { script: './sh.kettu/main.js', api: 1, permissions: ['tools'] }),
        'sh.kettu/main.js': 'export default {}',
      })
      const check = await checkFolder(root, APP)
      expect(check.problems).toEqual([])
      expect(check.plugin?.script).toEqual({ entry: 'sh.kettu/main.js', api: 1 })
      expect(check.adds.at(-1)).toEqual({ label: 'script', items: ['tools'] })
    })

    it('gives the reader’s reason when the package cannot be installed', async () => {
      await put({ ...files(), 'plugin.json': plugin({ name: 'Not A Name' }) })
      const check = await checkFolder(root, APP)
      expect(check.problems).toEqual([
        expect.objectContaining({ path: 'plugin.json', message: expect.stringContaining('name') }),
      ])
      expect(check.slug).toBeNull()
    })

    it('needs the manifest’s description and a version', async () => {
      await put({
        ...files(),
        'plugin.json': plugin({ description: undefined, version: undefined }),
      })
      const check = await checkFolder(root, APP)
      expect(check.problems.map((p) => p.message)).toEqual([
        'It has no description.',
        'It has no version.',
      ])
    })

    it('blocks a skill or server an install would leave out', async () => {
      await put({
        ...files(),
        'skills/bare/SKILL.md': '---\nname: bare\n---\nNo description.\n',
        'mcp.json': JSON.stringify({
          $schema: MCP_SCHEMA,
          mcpServers: {
            loose: { command: 'node' },
            tracker: { type: 'sse', url: 'https://t.example.com/sse' },
          },
        }),
      })
      const check = await checkFolder(root, APP)
      expect(check.problems.map((p) => [p.path, p.message])).toEqual([
        ['skills/bare/SKILL.md', expect.stringContaining('skills/bare')],
        ['mcp.json', expect.stringContaining('loose')],
      ])
    })

    it('publishes a Codex plugin that is in this format as it is', async () => {
      await put({ ...files(), '.codex-plugin/plugin.json': JSON.stringify({ name: 'old' }) })
      const check = await checkFolder(root, APP)
      expect(check.kind).toBe('agent-plugin')
      expect(check.convertible).toBeNull()
      expect(check.problems).toEqual([])
    })

    it('finds a secret in any file of it', async () => {
      await put({ ...files(), 'notes.md': `token ghp_${'a1b2c3d4e5'.repeat(4)}\n` })
      const check = await checkFolder(root, APP)
      expect(check.problems.map((p) => p.path)).toEqual(['notes.md'])
    })
  })

  describe('a workflow', () => {
    const WORKFLOW = `format: 1
name: Release notes
description: Draft the release notes from what merged, then let you review them.
steps:
  - id: gather
    name: Gather
    prompt: List what merged.
    tools:
      mcp: [github]
    outcomes:
      - name: Done
        to: draft
  - id: draft
    name: Draft
    prompt: Draft the notes.
    you_review: true
    tools:
      skills: [changelog-writer]
    outcomes:
      - name: Done
        end: done
`

    it('reads it with the library’s parser, its README as the listing’s text', async () => {
      await put({ 'workflow.yaml': WORKFLOW, 'README.md': '# Release notes\n\nUse it weekly.\n' })
      const check = await checkFolder(root, APP)
      expect(check.problems).toEqual([])
      expect(check).toMatchObject({
        kind: 'workflow',
        manifest: 'workflow.yaml',
        slug: 'release-notes',
        name: 'Release notes',
        description: 'Draft the release notes from what merged, then let you review them.',
        about: '# Release notes\n\nUse it weekly.',
        version: null,
        adds: [
          { label: 'steps', items: ['Gather', 'Draft'] },
          { label: 'waits', items: ['Draft'] },
          { label: 'servers', items: ['github'] },
          { label: 'skills', items: ['changelog-writer'] },
        ],
        runs: [],
      })
      expect(check.files.map((file) => file.path)).toEqual(['README.md', 'workflow.yaml'])
    })

    it('refuses one with every problem the parser finds, before anything uploads', async () => {
      await put({
        'workflow.yaml': WORKFLOW.replace('to: draft', 'to: review').replace(
          'format: 1',
          'format: 2',
        ),
      })
      const check = await checkFolder(root, APP)
      expect(check.kind).toBe('workflow')
      expect(check.problems.length).toBeGreaterThan(1)
      expect(check.problems.every((p) => p.path === 'workflow.yaml')).toBe(true)
      expect(check.problems.map((p) => p.message).join('\n')).toMatch(/format/)
      expect(check.problems.map((p) => p.message).join('\n')).toMatch(/review/)
      expect(check.slug).toBeNull()
    })

    it('takes the name of a workflow Kettu once shipped, and refuses one without a description or not in UTF-8', async () => {
      await put({ 'workflow.yaml': WORKFLOW.replace('Release notes', 'Feature development') })
      const check = await checkFolder(root, APP)
      expect(check.problems).toEqual([])
      expect(check.slug).toBe('feature-development')
      const bare = await put(
        { 'workflow.yaml': WORKFLOW.replace(/^description: .*\n/m, '') },
        path.join(root, 'bare'),
      )
      expect((await checkFolder(bare, APP)).problems).toEqual([
        { path: 'workflow.yaml', message: 'It has no description.' },
      ])
      const latin1 = await put(
        { 'workflow.yaml': Buffer.from(WORKFLOW.replace('notes', 'notés'), 'latin1') },
        path.join(root, 'latin1'),
      )
      expect((await checkFolder(latin1, APP)).problems).toEqual([
        { path: 'workflow.yaml', message: 'It is not UTF-8 text.' },
      ])
    })

    it('needs a name a listing can be called by', async () => {
      await put({ 'workflow.yaml': WORKFLOW.replace('name: Release notes', 'name: 发布说明') })
      const check = await checkFolder(root, APP)
      expect(check.slug).toBeNull()
      expect(check.problems).toHaveLength(1)
      expect(check.problems[0]!.message).toMatch(/no Latin letters or digits/)
    })
  })

  it('reads an MCP server from its server.json, uploading no file but a bundle', async () => {
    const server = {
      name: 'io.github.someone/weather',
      description: 'Weather for agents.',
      version: '0.3.0',
      packages: [
        {
          registryType: 'npm',
          identifier: '@someone/weather',
          version: '0.3.0',
          transport: { type: 'stdio' },
        },
      ],
    }
    await put({ 'server.json': JSON.stringify(server), 'src/index.ts': 'x', 'package.json': '{}' })
    const check = await checkFolder(root, APP)
    expect(check.problems).toEqual([])
    expect(check).toMatchObject({
      kind: 'mcp-server',
      slug: 'weather',
      version: '0.3.0',
      files: [],
      server,
    })
    expect(check.runs[0]).toContain('@someone/weather@0.3.0')

    await put({ 'weather.mcpb': Buffer.from('bundle') })
    const bundled = await checkFolder(root, APP)
    expect(bundled.files.map((file) => file.path)).toEqual(['weather.mcpb'])
  })

  it('reads an MCP bundle on its own from its manifest', async () => {
    const zip = new JSZip()
    zip.file(
      'manifest.json',
      JSON.stringify({
        name: 'files-server',
        display_name: 'Files',
        version: '2.0.0',
        description: 'Files for agents.',
        server: { mcp_config: { command: 'node', args: ['server/index.js'] } },
      }),
    )
    const file = path.join(root, 'files.mcpb')
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))
    const check = await checkFolder(file, APP)
    expect(check.problems).toEqual([])
    expect(check).toMatchObject({
      kind: 'mcp-server',
      slug: 'files-server',
      name: 'Files',
      version: '2.0.0',
      runs: ['node server/index.js'],
    })
    expect(check.files.map((f) => f.path)).toEqual(['files.mcpb'])
    // The bundle is the version's file; an mcpb package would need an https URL.
    expect(check.server).toEqual({
      name: 'files-server',
      title: 'Files',
      description: 'Files for agents.',
      version: '2.0.0',
    })
  })

  it('refuses links, and stops at the version’s limits', { timeout: 60_000 }, async () => {
    await put({ 'SKILL.md': SKILL, 'real.md': 'x' })
    await symlink(path.join(root, 'real.md'), path.join(root, 'link.md'))
    const linked = await checkFolder(root, APP)
    expect(linked.problems).toEqual([{ path: 'link.md', message: expect.stringMatching(/link/) }])

    const many = path.join(root, 'many')
    await put({ 'SKILL.md': SKILL }, many)
    await Promise.all(
      Array.from({ length: PUBLISH_LIMITS.files }, (_, i) => put({ [`f/${i}.txt`]: 'x' }, many)),
    )
    const tooMany = await checkFolder(many, APP)
    expect(tooMany.problems.map((p) => p.message)).toContainEqual(
      expect.stringMatching(/more than 400 files/),
    )

    const big = path.join(root, 'big')
    await put({ 'SKILL.md': SKILL, 'data.bin': Buffer.alloc(PUBLISH_LIMITS.bytes) }, big)
    const tooBig = await checkFolder(big, APP)
    expect(tooBig.problems.map((p) => p.message)).toContainEqual(
      expect.stringMatching(/larger than 10 MB/),
    )
  })

  it('refuses a folder holding a secret, without saying the secret', async () => {
    const token = `ghp_${'aB3'.repeat(12)}`
    await put({ 'SKILL.md': SKILL, 'scripts/run.sh': `echo hi\nexport GH=${token}\n` })
    const check = await checkFolder(root, APP)
    expect(check.problems).toEqual([
      {
        path: 'scripts/run.sh',
        message: 'Line 2 looks like a GitHub token. Remove it, and revoke it if it is real.',
      },
    ])
    expect(JSON.stringify(check.problems)).not.toContain(token)
  })
})

describe('findSecrets', () => {
  it('finds the kinds of keys and tokens people paste', () => {
    const samples: [string, string][] = [
      [`token = "github_pat_${'A1b2C3d4E5'.repeat(3)}"`, 'a GitHub token'],
      [`gho_${'Zx9'.repeat(12)}`, 'a GitHub token'],
      [`ANTHROPIC_API_KEY=sk-ant-api03-${'Qw3Er4Ty5'.repeat(4)}`, 'an Anthropic API key'],
      [`OPENAI_API_KEY=sk-proj-${'Ab1Cd2Ef3'.repeat(5)}`, 'an OpenAI API key'],
      [`key: sk-${'Ab1Cd2Ef3'.repeat(5)}`, 'an OpenAI API key'],
      ['AKIA2E0A8F3B244C9986', 'an AWS access key'],
      ['ASIAY34FZKBOKMUTVV7A', 'an AWS access key'],
      [`xoxb-${'1234567890'}-abcdefABCDEF`, 'a Slack token'],
      [`sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`, 'a Stripe key'],
      [`rk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`, 'a Stripe key'],
      [`AIza${'SyD-9tSrke72PouQMnMX7KK8RkjL3pC1Abc'}`, 'a Google API key'],
    ]
    for (const [line, what] of samples) {
      expect(findSecrets(`first\n${line}\n`), line).toEqual([{ line: 2, what }])
    }
  })

  it('finds what the Marketplace refuses: a key in a JSON string and more kinds of tokens', () => {
    const body = 'QUJDRA'.repeat(10)
    expect(
      findSecrets(`a\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`),
    ).toEqual([{ line: 2, what: 'a private key' }])
    const json = `{\n  "private_key": "-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----\\n"\n}`
    expect(findSecrets(json)).toEqual([{ line: 2, what: 'a private key' }])
    const samples: [string, string][] = [
      [`OPENROUTER_API_KEY=sk-or-v1-${'0a1b2c3d'.repeat(8)}`, 'an OpenRouter API key'],
      [`DEEPSEEK_API_KEY=sk-${'0a1b2c3d'.repeat(4)}`, 'a DeepSeek-style API key'],
      [`//registry.npmjs.org/:_authToken=npm_${'Ab1Cd2Ef3G'.repeat(3)}Hi4Jk5`, 'an npm token'],
      [`GITLAB_TOKEN=glpat-${'Ab1Cd2Ef3G'.repeat(2)}`, 'a GitLab token'],
      [`HF_TOKEN=hf_${'Ab1Cd2Ef3G'.repeat(3)}Hi4Jk`, 'a Hugging Face token'],
    ]
    for (const [line, what] of samples) {
      expect(findSecrets(`first\n${line}\n`), line).toEqual([{ line: 2, what }])
    }
  })

  it('passes over a private key header alone, as documentation shows one', () => {
    expect(findSecrets('Starts with -----BEGIN OPENSSH PRIVATE KEY----- and a body.')).toEqual([])
  })

  it('passes over placeholders and ordinary words', () => {
    expect(findSecrets(`ghp_${'x'.repeat(36)}`)).toEqual([])
    expect(findSecrets('AKIAIOSFODNN7EXAMPLE')).toEqual([])
    expect(findSecrets('Use the task-runner and the sk-learn docs.')).toEqual([])
    expect(findSecrets('-----BEGIN PUBLIC KEY-----')).toEqual([])
  })
})

describe('describe', () => {
  it('keeps a short description and cuts a long one at a sentence, keeping the whole', () => {
    expect(describeText('One  line\nper change.')).toEqual({
      description: 'One line per change.',
      about: null,
    })
    const long = `Writes the changelog from merged pull requests, one line each. ${'More detail. '.repeat(12)}`
    const { description, about } = describeText(long)
    expect(description).toBe('Writes the changelog from merged pull requests, one line each.')
    expect(about).toBe(long.trim())
  })
})
