// Conditional Codex User-Agent originator override: keeps honest Kettu clientInfo against
// official OpenAI/ChatGPT endpoints and injects CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_cli_rs
// only when a custom model_provider or non-official base_url is active.

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from '../agents'
import { CODEX } from '../agents/codex'
import { configFolders, type LaunchSpec } from '../catalog'
import type { AgentConnection } from '../connection'
import { Diagnostics } from '../diagnostics'
import type { ProcessDriver } from '../driver'
import type { Env } from '../find-command'
import { EnvironmentService } from '../shell-env'
import { tempFolder } from '../testing/temp'
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_ORIGINATOR_ENV,
  isOfficialOpenAIEndpoint,
  resolveCodexHome,
  usesCustomCodexEndpoint,
  withCodexOriginator,
} from './originator'

describe('isOfficialOpenAIEndpoint', () => {
  it('recognizes official OpenAI and ChatGPT HTTPS endpoints', () => {
    expect(isOfficialOpenAIEndpoint('https://api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://api.openai.com:443/v1')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://API.OPENAI.COM/v1/')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://api.openai.com./v1')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://us.api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://gov.api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://chatgpt.com/backend-api/')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://gov.chatgpt.com/backend-api/')).toBe(true)
    expect(isOfficialOpenAIEndpoint('https://chat.openai.com/backend-api')).toBe(true)
  })

  it('rejects third-party hosts, non-HTTPS URLs, non-standard ports, and malformed URLs', () => {
    expect(isOfficialOpenAIEndpoint('https://proxy.example.com/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('https://api.openai.com.evil.com/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('https://evil-chatgpt.com/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('https://api.openai.com@proxy.example.com/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('https://user:pass@api.openai.com/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('http://api.openai.com/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('https://api.openai.com:8443/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('http://localhost:11434/v1')).toBe(false)
    expect(isOfficialOpenAIEndpoint('not-a-url')).toBe(false)
    expect(isOfficialOpenAIEndpoint('')).toBe(false)
  })
})

describe('usesCustomCodexEndpoint', () => {
  it('treats empty config and official OpenAI/ChatGPT endpoints as official', () => {
    expect(usesCustomCodexEndpoint({}, {}, 'darwin')).toBe(false)
    expect(
      usesCustomCodexEndpoint({}, { OPENAI_BASE_URL: 'https://api.openai.com/v1' }, 'darwin'),
    ).toBe(false)
    expect(
      usesCustomCodexEndpoint(
        {
          model_provider: 'openai',
          model_providers: { openai: { base_url: 'https://api.openai.com/v1' } },
        },
        {},
        'darwin',
      ),
    ).toBe(false)
    expect(
      usesCustomCodexEndpoint(
        {
          openai_base_url: 'https://api.openai.com/v1',
          chatgpt_base_url: 'https://chatgpt.com/backend-api/',
        },
        {},
        'darwin',
      ),
    ).toBe(false)
  })

  it('detects custom model_provider with custom or absent base_url', () => {
    expect(
      usesCustomCodexEndpoint(
        {
          model_provider: 'my_proxy',
          model_providers: { my_proxy: { base_url: 'https://proxy.example.com/v1' } },
        },
        {},
        'darwin',
      ),
    ).toBe(true)
    expect(usesCustomCodexEndpoint({ model_provider: 'ollama' }, {}, 'darwin')).toBe(true)
    expect(
      usesCustomCodexEndpoint(
        { model_provider: 'my_proxy', model_providers: { my_proxy: { name: 'Proxy' } } },
        {},
        'darwin',
      ),
    ).toBe(true)
  })

  it('keeps official behavior when a custom model_provider explicitly points to official OpenAI', () => {
    expect(
      usesCustomCodexEndpoint(
        {
          model_provider: 'my_openai',
          model_providers: { my_openai: { base_url: 'https://api.openai.com/v1' } },
        },
        {},
        'darwin',
      ),
    ).toBe(false)
  })

  it('ignores inactive custom providers when openai is active', () => {
    expect(
      usesCustomCodexEndpoint(
        {
          model_providers: { my_proxy: { base_url: 'https://proxy.example.com/v1' } },
        },
        {},
        'darwin',
      ),
    ).toBe(false)
  })

  it('detects non-official OPENAI_BASE_URL, openai_base_url, chatgpt_base_url, and [model_providers.openai]', () => {
    expect(
      usesCustomCodexEndpoint({}, { OPENAI_BASE_URL: 'https://proxy.example.com/v1' }, 'darwin'),
    ).toBe(true)
    expect(
      usesCustomCodexEndpoint({ openai_base_url: 'https://proxy.example.com/v1' }, {}, 'darwin'),
    ).toBe(true)
    expect(
      usesCustomCodexEndpoint(
        { chatgpt_base_url: 'https://proxy.example.com/backend-api' },
        {},
        'darwin',
      ),
    ).toBe(true)
    expect(
      usesCustomCodexEndpoint(
        { model_providers: { openai: { base_url: 'https://proxy.example.com/v1' } } },
        {},
        'darwin',
      ),
    ).toBe(true)
  })

  it('prefers explicit config base_url over OPENAI_BASE_URL when both are present', () => {
    expect(
      usesCustomCodexEndpoint(
        { openai_base_url: 'https://api.openai.com/v1' },
        { OPENAI_BASE_URL: 'https://proxy.example.com/v1' },
        'darwin',
      ),
    ).toBe(false)
    expect(
      usesCustomCodexEndpoint(
        { openai_base_url: 'https://proxy.example.com/v1' },
        { OPENAI_BASE_URL: 'https://api.openai.com/v1' },
        'darwin',
      ),
    ).toBe(true)
  })

  it('supports legacy profile overrides in config.toml', () => {
    expect(
      usesCustomCodexEndpoint(
        {
          profile: 'work',
          profiles: { work: { model_provider: 'my_proxy' } },
          model_providers: { my_proxy: { base_url: 'https://proxy.example.com/v1' } },
        },
        {},
        'darwin',
      ),
    ).toBe(true)
    expect(
      usesCustomCodexEndpoint(
        {
          profiles: { unused: { model_provider: 'my_proxy' } },
          model_providers: { my_proxy: { base_url: 'https://proxy.example.com/v1' } },
        },
        {},
        'darwin',
      ),
    ).toBe(false)
  })

  it('matches OPENAI_BASE_URL case-insensitively on Windows', () => {
    expect(
      usesCustomCodexEndpoint({}, { openai_base_url: 'https://proxy.example.com/v1' }, 'win32'),
    ).toBe(true)
  })
})

describe('resolveCodexHome', () => {
  it('resolves CODEX_HOME relative to HOME/USERPROFILE or falls back to .codex', () => {
    expect(resolveCodexHome({ HOME: '/Users/me' }, 'darwin', '/fallback')).toBe('/Users/me/.codex')
    expect(
      resolveCodexHome({ HOME: '/Users/me', CODEX_HOME: 'alt-codex' }, 'darwin', '/fallback'),
    ).toBe('/Users/me/alt-codex')
    expect(
      resolveCodexHome({ HOME: '/Users/me', CODEX_HOME: '/custom/codex' }, 'darwin', '/fallback'),
    ).toBe('/custom/codex')
    expect(resolveCodexHome({ USERPROFILE: 'C:\\Users\\me' }, 'win32', 'C:\\fallback')).toBe(
      'C:\\Users\\me\\.codex',
    )
    expect(
      resolveCodexHome(
        { USERPROFILE: 'C:\\Users\\me', codex_home: 'D:\\codex' },
        'win32',
        'C:\\fallback',
      ),
    ).toBe('D:\\codex')
  })
})

describe('withCodexOriginator', () => {
  async function writeConfig(dir: string, content: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'config.toml'), content, 'utf8')
  }

  it('does not inject an override for official default Codex config', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    const env = await withCodexOriginator({ HOME: home }, { platform: 'darwin' })
    expect(env[CODEX_ORIGINATOR_ENV]).toBeUndefined()
  })

  it('does not inject an override for official OPENAI_BASE_URL or official model_provider', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    await writeConfig(
      path.join(home, '.codex'),
      [
        'model_provider = "openai"',
        '[model_providers.openai]',
        'base_url = "https://api.openai.com/v1"',
      ].join('\n'),
    )
    const env = await withCodexOriginator(
      { HOME: home, OPENAI_BASE_URL: 'https://api.openai.com/v1' },
      { platform: 'darwin' },
    )
    expect(env[CODEX_ORIGINATOR_ENV]).toBeUndefined()
  })

  it('injects codex_cli_rs for a custom model_provider in config.toml', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    await writeConfig(
      path.join(home, '.codex'),
      [
        'model_provider = "my_proxy"',
        '[model_providers.my_proxy]',
        'name = "Proxy"',
        'base_url = "https://proxy.example.com/v1"',
      ].join('\n'),
    )
    const env = await withCodexOriginator({ HOME: home }, { platform: 'darwin' })
    expect(env[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })

  it('injects codex_cli_rs for a third-party OPENAI_BASE_URL', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    const env = await withCodexOriginator(
      { HOME: home, OPENAI_BASE_URL: 'https://proxy.example.com/v1' },
      { platform: 'darwin' },
    )
    expect(env[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })

  it('injects codex_cli_rs for [model_providers.openai] with a third-party base_url', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    await writeConfig(
      path.join(home, '.codex'),
      ['[model_providers.openai]', 'base_url = "https://proxy.example.com/v1"'].join('\n'),
    )
    const env = await withCodexOriginator({ HOME: home }, { platform: 'darwin' })
    expect(env[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })

  it('preserves a user-supplied CODEX_INTERNAL_ORIGINATOR_OVERRIDE in both official and custom cases', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    const official = await withCodexOriginator(
      { HOME: home, [CODEX_ORIGINATOR_ENV]: 'custom_user_agent' },
      { platform: 'darwin' },
    )
    expect(official[CODEX_ORIGINATOR_ENV]).toBe('custom_user_agent')

    await writeConfig(
      path.join(home, '.codex'),
      [
        'model_provider = "my_proxy"',
        '[model_providers.my_proxy]',
        'base_url = "https://proxy.example.com/v1"',
      ].join('\n'),
    )
    const custom = await withCodexOriginator(
      { HOME: home, [CODEX_ORIGINATOR_ENV]: 'custom_user_agent' },
      { platform: 'darwin' },
    )
    expect(custom[CODEX_ORIGINATOR_ENV]).toBe('custom_user_agent')
  })

  it('treats an empty or whitespace CODEX_INTERNAL_ORIGINATOR_OVERRIDE as unset for custom endpoints', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    const custom = await withCodexOriginator(
      {
        HOME: home,
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        [CODEX_ORIGINATOR_ENV]: '   ',
      },
      { platform: 'darwin' },
    )
    expect(custom[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })

  it('fails safe on missing or malformed config.toml without throwing', async () => {
    const home = await tempFolder('kettu-codex-ua-')
    const missing = await withCodexOriginator({ HOME: home }, { platform: 'darwin' })
    expect(missing[CODEX_ORIGINATOR_ENV]).toBeUndefined()

    await writeConfig(path.join(home, '.codex'), 'model_provider = [unterminated\n')
    const malformed = await withCodexOriginator({ HOME: home }, { platform: 'darwin' })
    expect(malformed[CODEX_ORIGINATOR_ENV]).toBeUndefined()

    const malformedWithProxyEnv = await withCodexOriginator(
      { HOME: home, OPENAI_BASE_URL: 'https://proxy.example.com/v1' },
      { platform: 'darwin' },
    )
    expect(malformedWithProxyEnv[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })

  it('reads config.toml from each account’s CODEX_HOME', async () => {
    const root = await tempFolder('kettu-codex-multi-')
    const officialHome = path.join(root, 'official')
    const proxyHome = path.join(root, 'proxy')
    await writeConfig(officialHome, 'model = "gpt-5.4"\n')
    await writeConfig(
      proxyHome,
      [
        'model_provider = "gateway"',
        '[model_providers.gateway]',
        'base_url = "https://gateway.internal/v1"',
      ].join('\n'),
    )

    const officialEnv = await withCodexOriginator(
      { HOME: root, CODEX_HOME: officialHome },
      { platform: 'darwin' },
    )
    const proxyEnv = await withCodexOriginator(
      { HOME: root, CODEX_HOME: proxyHome },
      { platform: 'darwin' },
    )
    expect(officialEnv[CODEX_ORIGINATOR_ENV]).toBeUndefined()
    expect(proxyEnv[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })

  it('handles case-insensitive override variables on Windows', async () => {
    const home = await tempFolder('kettu-codex-win-')
    const preserved = await withCodexOriginator(
      {
        USERPROFILE: home,
        openai_base_url: 'https://proxy.example.com/v1',
        codex_internal_originator_override: 'my_win_ua',
      },
      { platform: 'win32' },
    )
    expect(preserved.codex_internal_originator_override).toBe('my_win_ua')
    expect(preserved[CODEX_ORIGINATOR_ENV]).toBeUndefined()

    const injected = await withCodexOriginator(
      {
        USERPROFILE: home,
        openai_base_url: 'https://proxy.example.com/v1',
        codex_internal_originator_override: '',
      },
      { platform: 'win32' },
    )
    expect(injected.codex_internal_originator_override).toBeUndefined()
    expect(injected[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })
})

describe('AgentManager Codex launch environment', () => {
  interface Launch {
    spec: LaunchSpec
    env: Env
  }

  async function codexManager(options: {
    program: string
    home: string
    addedCodexDir: string
    baseEnv?: Env
    launchEnv?: (agentId: string, env: Env) => Env
  }) {
    const root = await tempFolder('kettu-codex-mgr-')
    const platform = process.platform === 'win32' ? 'win32' : process.platform
    const nodeRuntime = { command: process.execPath, env: {} }
    const settings: HostSettings = {
      locale: 'en',
      initialSetupDone: true,
      agents: { codex: { enabled: true, binaryPath: options.program } },
      addedAgents: [
        { id: 'codex~proxy', name: 'Proxy', configDir: options.addedCodexDir, created: true },
      ],
      disabledAgents: [],
      proxy: DEFAULT_SETTINGS.proxy,
      git: DEFAULT_SETTINGS.git,
      mcp: DEFAULT_SETTINGS.mcp,
      marketplace: DEFAULT_SETTINGS.marketplace,
      startModes: DEFAULT_SETTINGS.startModes,
      idleSessions: DEFAULT_SETTINGS.idleSessions,
      workflow: DEFAULT_SETTINGS.workflow,
      startedSessions: DEFAULT_SETTINGS.startedSessions,
      usage: { fromComputer: false },
      sessionTitles: true,
      promptSuggestions: true,
      continueAfterLimit: true,
      agentPasswords: false,
      lightModel: { mode: 'small' },
      defaultAgent: null,
      computerUse: DEFAULT_SETTINGS.computerUse,
      downloadService: false,
    }
    const envService = new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv: {
        PATH: '',
        ...(platform === 'win32' ? { USERPROFILE: options.home } : { HOME: options.home }),
        ...options.baseEnv,
      },
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    })
    envService.setConfigFolders(configFolders([CODEX], settings))
    const launches: Launch[] = []
    const noting: ProcessDriver = {
      kind: 'process',
      connect: () => ({}) as unknown as AgentConnection,
    }
    const agents = new AgentManager({
      catalog: [CODEX],
      platform,
      nodeRuntime,
      appVersion: '0.0.0-test',
      env: envService,
      diagnostics: new Diagnostics(),
      launcher: {
        launch: (_def, spec, env) => {
          launches.push({ spec, env })
          throw new Error('the test starts nothing')
        },
      },
      settings: () => settings,
      reportsDir: path.join(root, 'reports'),
      adaptersDir: root,
      drivers: { 'codex-app-server': noting },
      probeCli: async () => ({ version: '0.172.0' }),
      status: () => {},
      processes: () => {},
      authCommands: () => {},
      ...(options.launchEnv ? { launchEnv: options.launchEnv } : {}),
    })
    return { agents, launches }
  }

  it('injects codex_cli_rs only for the Codex account whose CODEX_HOME uses a custom provider', async () => {
    const dir = await tempFolder('kettu-codex-agent-')
    const program = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    await writeFile(program, '')
    await chmod(program, 0o755)
    const home = path.join(dir, 'home')
    const addedDir = path.join(dir, 'agents', 'codex~proxy')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await mkdir(addedDir, { recursive: true })
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.4"\n', 'utf8')
    await writeFile(
      path.join(addedDir, 'config.toml'),
      [
        'model_provider = "my_proxy"',
        '[model_providers.my_proxy]',
        'base_url = "https://proxy.example.com/v1"',
      ].join('\n'),
      'utf8',
    )

    const { agents, launches } = await codexManager({ program, home, addedCodexDir: addedDir })
    await expect(agents.ensureReady('codex')).rejects.toThrow()
    await expect(agents.ensureReady('codex~proxy')).rejects.toThrow()

    expect(launches).toHaveLength(2)
    const [official, proxy] = launches
    expect(official?.env[CODEX_ORIGINATOR_ENV]).toBeUndefined()
    expect(proxy?.env.CODEX_HOME).toBe(addedDir)
    expect(proxy?.env[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
  })

  it('respects per-agent launchEnv OPENAI_BASE_URL and preserves user CODEX_INTERNAL_ORIGINATOR_OVERRIDE', async () => {
    const dir = await tempFolder('kettu-codex-env-')
    const program = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    await writeFile(program, '')
    await chmod(program, 0o755)
    const home = path.join(dir, 'home')
    const addedDir = path.join(dir, 'agents', 'codex~proxy')
    await mkdir(home, { recursive: true })
    await mkdir(addedDir, { recursive: true })

    const { agents, launches } = await codexManager({
      program,
      home,
      addedCodexDir: addedDir,
      launchEnv: (agentId, env) =>
        agentId === 'codex'
          ? { ...env, OPENAI_BASE_URL: 'https://proxy.example.com/v1' }
          : {
              ...env,
              OPENAI_BASE_URL: 'https://proxy.example.com/v1',
              [CODEX_ORIGINATOR_ENV]: 'my_custom_cli',
            },
    })
    await expect(agents.ensureReady('codex')).rejects.toThrow()
    await expect(agents.ensureReady('codex~proxy')).rejects.toThrow()

    expect(launches).toHaveLength(2)
    expect(launches[0]?.env[CODEX_ORIGINATOR_ENV]).toBe(CODEX_CLI_ORIGINATOR)
    expect(launches[1]?.env[CODEX_ORIGINATOR_ENV]).toBe('my_custom_cli')
  })
})
