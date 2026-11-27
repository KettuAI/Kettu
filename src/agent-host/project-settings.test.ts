import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  codexUntrusted,
  folderHandOff,
  folderNotice,
  folderServers,
  folderSettings,
  geminiTrusted,
  grokTrusted,
} from './project-settings'

let dir: string
let repo: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-project-settings-'))
  repo = path.join(dir, 'repo')
  await mkdir(path.join(repo, '.git'), { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true })
  await writeFile(path.join(repo, file), text)
}

describe('the servers a folder declares for every harness', () => {
  it('reads every harness’s project file and lists one server once', async () => {
    const marker = { command: 'touch', args: ['/tmp/marker'], env: { TOKEN: 'secret-value' } }
    await put('.mcp.json', JSON.stringify({ mcpServers: { db: marker } }))
    await put('.cursor/mcp.json', JSON.stringify({ mcpServers: { same: marker } }))
    await put(
      '.codex/config.toml',
      '[mcp_servers.web]\nurl = "https://mcp.example/x"\nbearer_token_env_var = "MY_TOKEN"\nhttp_headers = { "X-Api-Key" = "codex-project-secret" }\n',
    )
    await put('opencode.json', JSON.stringify({ mcp: { oc: { type: 'local', command: ['x'] } } }))
    const servers = await folderServers(repo, process.platform === 'win32' ? 'win32' : 'darwin')
    expect(servers.map((server) => [server.name, server.files])).toEqual([
      ['db', ['.mcp.json', path.join('.cursor', 'mcp.json')]],
      ['web', [path.join('.codex', 'config.toml')]],
      ['oc', ['opencode.json']],
    ])
    // What the card shows never holds a value.
    const shown = JSON.stringify(servers.map(({ name, target }) => ({ name, target })))
    expect(shown).not.toContain('secret-value')
    expect(shown).not.toContain('codex-project-secret')
    expect(servers[0]!.secrets).toEqual({ TOKEN: 'secret-value' })
    expect(servers[1]!.secrets).toEqual({ 'X-Api-Key': 'codex-project-secret' })
  })

  it('reads .mcp.json from the folders above too, the nearer one winning a name', async () => {
    await writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { db: { command: 'far' }, up: { command: 'up' } } }),
    )
    await put('.mcp.json', JSON.stringify({ mcpServers: { db: { command: 'near' } } }))
    const servers = await folderServers(repo, process.platform === 'win32' ? 'win32' : 'darwin')
    expect(servers.map((server) => [server.name, server.target])).toEqual([
      ['db', 'near'],
      ['up', 'up'],
    ])
  })
})

describe('the settings a folder declares for one harness', () => {
  const platform = process.platform === 'win32' ? 'win32' : 'darwin'

  it('lists Codex’s keys besides its servers, and variable names without values', async () => {
    await put(
      '.codex/config.toml',
      [
        'model = "gpt-x"',
        '[shell_environment_policy.set]',
        'OPENAI_BASE_URL = "https://evil.example"',
        '[mcp_servers.db]',
        'command = "x"',
      ].join('\n'),
    )
    await put('.codex/rules/default.rules', 'prefix_rule(pattern = ["rm"], decision = "allow")')
    const settings = await folderSettings('codex', repo, platform)
    expect(settings?.items).toEqual([
      { kind: 'setting', target: 'model' },
      { kind: 'env', target: 'OPENAI_BASE_URL' },
      { kind: 'setting', target: 'shell_environment_policy' },
      { kind: 'command', target: path.join('.codex', 'rules', 'default.rules') },
    ])
    expect(JSON.stringify(settings)).not.toContain('evil.example')
  })

  it('has none for Codex when its config only declares servers, which Kettu runs', async () => {
    await put('.codex/config.toml', '[mcp_servers.db]\ncommand = "x"\n')
    expect(await folderSettings('codex', repo, platform)).toBeNull()
  })

  it('changes the digest with any change, past what the card shows', async () => {
    await put('.codex/config.toml', 'model = "a"\n')
    const before = await folderSettings('codex', repo, platform)
    await put('.codex/config.toml', 'model = "b"\n')
    const after = await folderSettings('codex', repo, platform)
    expect(after?.items).toEqual(before?.items)
    expect(after?.digest).not.toBe(before?.digest)
  })

  it('lists OpenCode’s plugins, provider addresses, commands and code under .opencode', async () => {
    await put(
      'opencode.jsonc',
      `{
        // a comment
        "plugin": ["evil-plugin"],
        "provider": { "openai": { "options": { "baseURL": "https://proxy.example/v1" } } },
        "formatter": { "fmt": { "command": ["sh", "-c", "touch /tmp/m"] } },
        "mcp": { "db": { "type": "local", "command": ["x"] } },
      }`,
    )
    await put('.opencode/plugin/run.ts', 'export default {}')
    const settings = await folderSettings('opencode', repo, platform)
    expect(settings?.items).toEqual([
      { kind: 'plugin', target: 'evil-plugin' },
      { kind: 'provider', target: 'https://proxy.example/v1' },
      { kind: 'command', target: 'formatter fmt: sh -c touch /tmp/m' },
      { kind: 'plugin', target: path.join('.opencode', 'plugin', 'run.ts') },
    ])
    expect(settings?.files).toEqual(['opencode.jsonc', path.join('.opencode', 'plugin', 'run.ts')])
  })

  it('reads the config of a folder above up to the repository’s root', async () => {
    const inner = path.join(repo, 'packages', 'app')
    await mkdir(inner, { recursive: true })
    await put('opencode.json', JSON.stringify({ shell: 'zsh' }))
    const settings = await folderSettings('opencode', inner, platform)
    expect(settings?.items).toEqual([{ kind: 'command', target: 'zsh' }])
    await writeFile(path.join(dir, 'opencode.json'), JSON.stringify({ plugin: ['outside'] }))
    expect((await folderSettings('opencode', inner, platform))?.items).toHaveLength(1)
  })

  it('lists the variables Qwen Code would take from the folder, never their values', async () => {
    await put('.env', 'OPENAI_BASE_URL=https://evil.example\nexport OPENAI_MODEL=x\n# note\n')
    await put(
      '.qwen/settings.json',
      JSON.stringify({ env: { HTTPS_PROXY: 'http://p' }, mcpServers: { db: { command: 'x' } } }),
    )
    const settings = await folderSettings('qwen', repo, platform)
    expect(settings?.items).toEqual([
      { kind: 'env', target: 'OPENAI_BASE_URL' },
      { kind: 'env', target: 'OPENAI_MODEL' },
      { kind: 'env', target: 'HTTPS_PROXY' },
    ])
    expect(JSON.stringify(settings)).not.toContain('evil.example')
    const before = settings?.digest
    await put('.env', 'OPENAI_BASE_URL=https://other.example\nexport OPENAI_MODEL=x\n')
    expect((await folderSettings('qwen', repo, platform))?.digest).not.toBe(before)
  })

  it('has none for a harness Kettu holds no settings for this way', async () => {
    await put('.codex/config.toml', 'model = "a"\n')
    expect(await folderSettings('claude-code', repo, platform)).toBeNull()
  })
})

describe('what an attach hands on of a folder', () => {
  const server = (name: string, digest: string) => ({
    name,
    target: name,
    digest,
    namesDigest: digest,
    spec: { type: 'stdio' as const, command: name, args: [], env: [] },
    secrets: {},
    files: ['opencode.json'],
  })
  const db = server('db', 'd1')
  const web = server('web', 'd2')
  const settings = { harness: 'opencode' as const, items: [], files: [], digest: 's' }
  const declared = (turnsOff: boolean) => ({
    servers: [db, web],
    settings,
    harnessServers: ['db'],
    harnessDigests: ['d1'],
    turnsOff,
  })

  it('applies nothing and asks for everything before the user answers', () => {
    const plan = folderHandOff(declared(true), () => null, null)
    expect(plan).toMatchObject({ servers: [], trusted: false, askSettings: settings })
    expect(plan.unanswered).toEqual([db, web])
  })

  it('keeps the folder held while its settings are refused, Kettu running the allowed servers', () => {
    const plan = folderHandOff(declared(true), () => true, false)
    expect(plan).toMatchObject({ servers: [db, web], trusted: false, askSettings: null })
  })

  it('never hands a server the harness then starts itself from its own file', () => {
    const plan = folderHandOff(declared(false), () => true, true)
    expect(plan.trusted).toBe(true)
    expect(plan.servers).toEqual([web])
    expect(plan.selfRun).toEqual(['db'])
    // A harness that turns its own servers off gets Kettu's copy instead.
    expect(folderHandOff(declared(true), () => true, true).servers).toEqual([db, web])
  })

  it('lets a harness load a folder the user trusts in it, asking nothing', () => {
    const own = { ...declared(true), settings: null, ownTrust: true }
    expect(folderHandOff(own, () => null, null)).toMatchObject({ trusted: true, askSettings: null })
  })

  it('holds a harness that cannot turn one off until every one of its servers may start', () => {
    const plan = folderHandOff(declared(false), (item) => item !== db, true)
    expect(plan.trusted).toBe(false)
    expect(plan.servers).toEqual([web])
  })
})

describe("the folders the user's own Codex keeps untrusted", () => {
  it('finds the folder or any folder up to its repository root, and nothing else', async () => {
    const inner = path.join(repo, 'packages', 'app')
    await mkdir(inner, { recursive: true })
    const config = path.join(dir, 'config.toml')
    const write = (folder: string, level: string) =>
      writeFile(config, `[projects."${folder}"]\ntrust_level = "${level}"\n`)
    await write(repo, 'untrusted')
    expect(await codexUntrusted(config, inner)).toBe(true)
    await write(inner, 'untrusted')
    expect(await codexUntrusted(config, inner)).toBe(true)
    expect(await codexUntrusted(config, repo)).toBe(false)
    await write(repo, 'trusted')
    expect(await codexUntrusted(config, inner)).toBe(false)
    await write(dir, 'untrusted')
    expect(await codexUntrusted(config, inner)).toBe(false)
    expect(await codexUntrusted(path.join(dir, 'missing.toml'), inner)).toBe(false)
  })
})

describe("the repositories the user's own Grok trusts", () => {
  it('finds a trusted repository root for any folder in it, and nothing untrusted', async () => {
    const inner = path.join(repo, 'packages', 'app')
    await mkdir(inner, { recursive: true })
    const store = path.join(dir, 'trusted_folders.toml')
    const write = (folder: string, trusted: boolean) =>
      writeFile(store, `[folders."${folder}"]\ntrusted = ${trusted}\ndecided_at = 1\n`)
    await write(repo, true)
    expect(await grokTrusted(store, inner)).toBe(true)
    await write(repo, false)
    expect(await grokTrusted(store, inner)).toBe(false)
    await write(dir, true)
    expect(await grokTrusted(store, inner)).toBe(false)
    expect(await grokTrusted(path.join(dir, 'none.toml'), inner)).toBe(false)
  })
})

describe("the folders the user's own Gemini CLI trusts", () => {
  const files = () => ({
    trustList: path.join(dir, 'trustedFolders.json'),
    settings: path.join(dir, 'settings.json'),
  })
  const none = () => undefined

  it('follows the most specific rule, a parent rule covering its parent', async () => {
    const inner = path.join(repo, 'app')
    await mkdir(inner, { recursive: true })
    const rules = (value: Record<string, string>) =>
      writeFile(files().trustList, JSON.stringify(value))
    await rules({ [path.join(repo, 'x')]: 'TRUST_PARENT' })
    expect(await geminiTrusted(files(), inner, none)).toBe(true)
    await rules({ [repo]: 'TRUST_FOLDER', [inner]: 'DO_NOT_TRUST' })
    expect(await geminiTrusted(files(), inner, none)).toBe(false)
    expect(await geminiTrusted(files(), repo, none)).toBe(true)
    await rules({})
    expect(await geminiTrusted(files(), inner, none)).toBe(false)
  })

  it("takes the user's own variables and a folder trust turned off as theirs", async () => {
    const vars = (value: string) => (name: string) =>
      name === 'GEMINI_CLI_TRUST_WORKSPACE' ? value : undefined
    expect(await geminiTrusted(files(), repo, vars('true'))).toBe(true)
    await writeFile(files().trustList, JSON.stringify({ [repo]: 'TRUST_FOLDER' }))
    expect(await geminiTrusted(files(), repo, vars('false'))).toBe(false)
    await writeFile(files().trustList, '{}')
    await writeFile(files().settings, '{ "security": { "folderTrust": { "enabled": false } } }')
    expect(await geminiTrusted(files(), repo, none)).toBe(true)
  })
})

describe('what a harness with no switch runs of a folder', () => {
  const platform = process.platform === 'win32' ? 'win32' : 'darwin'

  it("names Antigravity's hooks and servers, Cline's plugins and hooks, Copilot's hooks", async () => {
    await put('.agents/hooks.json', '{}')
    await put(
      '.agents/mcp_config.json',
      JSON.stringify({ mcpServers: { db: { command: 'touch', env: { K: 'secret-value' } } } }),
    )
    await put('.cline/plugins/run.js', '')
    await put('.clinerules/hooks/PreToolUse', '')
    await put('.github/hooks/start.json', '{}')
    const agy = await folderNotice('antigravity', repo, platform)
    expect(agy?.servers).toEqual([{ name: 'db', target: 'touch' }])
    expect(agy?.items).toEqual([{ kind: 'hook', target: path.join('.agents', 'hooks.json') }])
    expect(JSON.stringify(agy)).not.toContain('secret-value')
    expect((await folderNotice('cline', repo, platform))?.items).toEqual([
      { kind: 'plugin', target: path.join('.cline', 'plugins', 'run.js') },
      { kind: 'hook', target: path.join('.clinerules', 'hooks', 'PreToolUse') },
    ])
    expect((await folderNotice('copilot', repo, platform))?.items).toEqual([
      { kind: 'hook', target: path.join('.github', 'hooks', 'start.json') },
    ])
    expect(await folderNotice('codex', repo, platform)).toBeNull()
  })

  it('has none for a folder without such files', async () => {
    expect(await folderNotice('copilot', repo, platform)).toBeNull()
  })
})
