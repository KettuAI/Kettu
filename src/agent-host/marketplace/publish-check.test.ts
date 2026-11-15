import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PUBLISH_LIMITS } from '@shared/market-publish'
import { checkFolder, describe as describeText, findSecrets } from './publish-check'

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
    const check = await checkFolder(root)
    expect(check.problems).toEqual([])
    expect(check).toMatchObject({
      kind: 'skill',
      harness: null,
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
    const check = await checkFolder(root)
    expect(check.problems.map((p) => p.message)).toEqual([
      'It has no name in its front matter.',
      'It has no description in its front matter.',
    ])
  })

  it('reads a Claude Code plugin: its version, what it adds and the commands its hooks run', async () => {
    await put({
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'release-tools',
        version: '1.2.0',
        description: 'Release helpers.',
      }),
      'commands/ship.md': '# Ship\n',
      'agents/reviewer.md': '# Reviewer\n',
      'skills/notes/SKILL.md': SKILL,
      'hooks/hooks.json': JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node lint.js' }] }] },
      }),
      '.mcp.json': JSON.stringify({
        mcpServers: { docs: { command: 'npx', args: ['-y', 'docs'] } },
      }),
    })
    const check = await checkFolder(root)
    expect(check.problems).toEqual([])
    expect(check).toMatchObject({
      kind: 'plugin',
      harness: 'claude-code',
      slug: 'release-tools',
      name: 'Release tools',
      version: '1.2.0',
      runs: ['node lint.js', 'npx -y docs'],
    })
    expect(check.adds).toEqual([
      { label: 'commands', items: ['ship'] },
      { label: 'agents', items: ['reviewer'] },
      { label: 'skills', items: ['notes'] },
      { label: 'hooks', items: ['PostToolUse'] },
      { label: 'servers', items: ['docs'] },
    ])
  })

  it('tells a Codex plugin, and needs a plugin’s version', async () => {
    await put({
      '.codex-plugin/plugin.json': JSON.stringify({
        name: 'linear',
        description: 'Linear for Codex.',
        interface: { displayName: 'Linear' },
      }),
    })
    const check = await checkFolder(root)
    expect(check).toMatchObject({ kind: 'plugin', harness: 'codex', name: 'Linear' })
    expect(check.problems).toEqual([
      { path: '.codex-plugin/plugin.json', message: 'It has no version.' },
    ])
  })

  it('refuses a folder that is both kinds of plugin, and one that is nothing it knows', async () => {
    await put({ '.claude-plugin/plugin.json': '{}', '.codex-plugin/plugin.json': '{}' })
    expect((await checkFolder(root)).problems).toHaveLength(1)
    const other = await put({ 'README.md': 'hi' }, path.join(root, 'other'))
    const check = await checkFolder(other)
    expect(check.kind).toBeNull()
    expect(check.problems[0]!.message).toMatch(/cannot tell what this folder is/)
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
    const check = await checkFolder(root)
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
    const bundled = await checkFolder(root)
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
    const check = await checkFolder(file)
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

  it('refuses links, and stops at the version’s limits', async () => {
    await put({ 'SKILL.md': SKILL, 'real.md': 'x' })
    await symlink(path.join(root, 'real.md'), path.join(root, 'link.md'))
    const linked = await checkFolder(root)
    expect(linked.problems).toEqual([{ path: 'link.md', message: expect.stringMatching(/link/) }])

    const many = path.join(root, 'many')
    await put({ 'SKILL.md': SKILL }, many)
    for (let i = 0; i < PUBLISH_LIMITS.files; i++) await put({ [`f/${i}.txt`]: 'x' }, many)
    const tooMany = await checkFolder(many)
    expect(tooMany.problems.map((p) => p.message)).toContainEqual(
      expect.stringMatching(/more than 400 files/),
    )

    const big = path.join(root, 'big')
    await put({ 'SKILL.md': SKILL, 'data.bin': Buffer.alloc(PUBLISH_LIMITS.bytes) }, big)
    const tooBig = await checkFolder(big)
    expect(tooBig.problems.map((p) => p.message)).toContainEqual(
      expect.stringMatching(/larger than 10 MB/),
    )
  })

  it('refuses a folder holding a secret, without saying the secret', async () => {
    const token = `ghp_${'aB3'.repeat(12)}`
    await put({ 'SKILL.md': SKILL, 'scripts/run.sh': `echo hi\nexport GH=${token}\n` })
    const check = await checkFolder(root)
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
