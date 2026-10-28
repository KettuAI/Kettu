import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InstalledAdapter } from './adapter-install'
import {
  AGORAGENTIC,
  AUGGIE,
  AUTOHAND,
  AMP,
  buildCatalog,
  CLAUDE_CODE,
  CLINE,
  CODEBUDDY,
  CODEX,
  COPILOT,
  DEEPAGENTS,
  CURSOR,
  detectAgent,
  DIMCODE,
  DIRAC,
  DROID,
  displayCommand,
  fakeAgent,
  GEMINI,
  GLM,
  NOVA,
  GOOSE,
  GROK,
  KILO,
  KIMI,
  OPENCODE,
  PI,
  QODER,
  QWEN,
  SIGIT,
  type AgentDefinition,
  type DetectContext,
} from './catalog'
import { archiveEntry, type BinaryInstalls } from './binary-install'
import { programPath, type InstalledArchive } from './archive-install'

function context(overrides: Partial<DetectContext> = {}): DetectContext {
  return {
    platform: 'darwin',
    env: { PATH: '/usr/local/bin:/usr/bin' },
    electronPath: '/Apps/OverBench.app/Contents/MacOS/OverBench',
    binaryOverride: null,
    node: {
      nodeVersion: 'v24.1.0',
      npmPath: '/usr/local/bin/npm',
      nodePath: '/usr/local/bin/node',
    },
    adaptersDir: '/data/agents',
    isExecutable: async () => false,
    isFile: async () => true,
    installed: async () => [],
    ...overrides,
  }
}

describe('buildCatalog', () => {
  it('lists the fake agent only when main passes its path', () => {
    expect(buildCatalog(null).map((d) => d.id)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'pi',
      'auggie',
      'codebuddy',
      'deepagents',
      'dimcode',
      'dirac',
      'glm',
      'nova',
      'qoder',
      'sigit',
      'agoragentic',
      'autohand',
      'gemini',
      'copilot',
      'qwen',
      'grok',
      'cline',
      'droid',
      'cursor',
      'kimi',
      'amp',
      'goose',
      'kilo',
    ])
    expect(buildCatalog('/repo/tools/fake-agent/main.ts').map((d) => d.id)).toContain('fake-agent')
  })

  it('keeps the agents in order', () => {
    expect(buildCatalog('/repo/tools/fake-agent/main.ts').map((d) => d.id)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'pi',
      'auggie',
      'codebuddy',
      'deepagents',
      'dimcode',
      'dirac',
      'glm',
      'nova',
      'qoder',
      'sigit',
      'agoragentic',
      'autohand',
      'gemini',
      'copilot',
      'qwen',
      'grok',
      'cline',
      'droid',
      'cursor',
      'kimi',
      'amp',
      'goose',
      'kilo',
      'fake-agent',
    ])
  })
})

describe('detectAgent', () => {
  const entry = (agentId: string, name: string, version: string): string =>
    `/data/agents/${agentId}/${version}/node_modules/${name}/dist/index.js`
  // A version may carry `~<installedAt>`, as an install beside one of the same version does.
  const installed =
    (...versions: string[]): DetectContext['installed'] =>
    async (agentId, name) =>
      versions.map((dirName) => {
        const [version = dirName, at = '1'] = dirName.split('~')
        return {
          version,
          dir: `/data/agents/${agentId}/${dirName}`,
          entry: entry(agentId, name, dirName),
          installedAt: Number(at),
        }
      })
  const CLAUDE = '@agentclientprotocol/claude-agent-acp'

  it('runs an installed adapter with node and its entry', async () => {
    const claudeEntry = entry('claude-code', CLAUDE, '0.94.0')
    expect(await detectAgent(CLAUDE_CODE, context({ installed: installed('0.94.0') }))).toEqual({
      state: 'available',
      spec: {
        command: '/usr/local/bin/node',
        args: [claudeEntry],
        env: {},
        shell: false,
        display: { command: '/usr/local/bin/node', args: [claudeEntry], env: {} },
      },
      adapter: {
        package: CLAUDE,
        version: '0.94.0',
        installed: true,
        current: {
          version: '0.94.0',
          dir: '/data/agents/claude-code/0.94.0',
          entry: claudeEntry,
          installedAt: 1,
        },
        node: '/usr/local/bin/node',
        nodeVersion: 'v24.1.0',
        npm: '/usr/local/bin/npm',
        fallback: null,
        cli: { runs: 'bundled', installed: null, needsCopy: false },
      },
    })
  })

  it('installs the pinned version on first use, with an older one to fall back on', async () => {
    expect(
      await detectAgent(CLAUDE_CODE, context({ installed: installed('0.93.0') })),
    ).toMatchObject({
      state: 'available',
      spec: null,
      adapter: {
        installed: false,
        fallback: { version: '0.93.0', spec: { args: [entry('claude-code', CLAUDE, '0.93.0')] } },
      },
    })
  })

  it('runs the newest install from the pin up, and the latest install of one version', async () => {
    const detection = await detectAgent(
      CLAUDE_CODE,
      context({ installed: installed('0.93.0', '0.95.0', '0.95.0~5', '0.94.0') }),
    )
    expect(detection).toMatchObject({
      state: 'available',
      spec: { args: [entry('claude-code', CLAUDE, '0.95.0~5')] },
      adapter: {
        version: '0.94.0',
        installed: true,
        current: { version: '0.95.0', dir: '/data/agents/claude-code/0.95.0~5', installedAt: 5 },
        fallback: { version: '0.93.0', dir: '/data/agents/claude-code/0.93.0' },
      },
    })
  })

  it('needs npm only until the adapter is installed', async () => {
    const node = { nodeVersion: 'v24.1.0', npmPath: null, nodePath: '/usr/local/bin/node' }
    expect(await detectAgent(CODEX, context({ node }))).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining('npm was not found'),
    })
    expect(
      await detectAgent(CODEX, context({ node, installed: installed('2.2.2') })),
    ).toMatchObject({ state: 'available', adapter: { installed: true, npm: null } })
  })

  it("starts Codex's binary directly, without npm's codex.js", async () => {
    const nm = '/data/agents/codex/2.2.2/node_modules'
    const binary = `${nm}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
    const files = new Set([
      `${nm}/@openai/codex/package.json`,
      `${nm}/@openai/codex-darwin-arm64/package.json`,
      binary,
    ])
    const detection = await detectAgent(
      CODEX,
      context({
        installed: installed('2.2.2'),
        isFile: async (file) => files.has(file),
        realpath: async (file) => file,
      }),
    )
    const env = {
      CODEX_PATH: binary,
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_MANAGED_PACKAGE_ROOT: `${nm}/@openai/codex`,
    }
    expect(detection).toMatchObject({
      state: 'available',
      spec: { args: [entry('codex', '@agentclientprotocol/codex-acp', '2.2.2')], env },
    })
    if (detection.state === 'available') expect(detection.spec?.display.env).toEqual(env)
  })

  it('needs a recent enough Node.js', async () => {
    expect(
      await detectAgent(
        CODEX,
        context({ node: { nodeVersion: null, npmPath: null, nodePath: null } }),
      ),
    ).toMatchObject({ state: 'node-missing' })
    expect(
      await detectAgent(
        CODEX,
        context({ node: { nodeVersion: 'v20.18.0', npmPath: '/x/npm', nodePath: '/x/node' } }),
      ),
    ).toMatchObject({ state: 'node-outdated', detail: expect.stringContaining('v20.18.0') })
  })

  it('runs node.exe without a shell on Windows', async () => {
    const detection = await detectAgent(
      CLAUDE_CODE,
      context({
        platform: 'win32',
        node: {
          nodeVersion: 'v22.12.0',
          npmPath: 'C:\\Program Files\\nodejs\\npm.cmd',
          nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        },
        installed: installed('0.94.0'),
      }),
    )
    expect(detection).toMatchObject({
      state: 'available',
      spec: { command: 'C:\\Program Files\\nodejs\\node.exe', shell: false },
    })
  })

  it('finds binaries on PATH or uses the chosen program', async () => {
    expect(await detectAgent(OPENCODE, context())).toMatchObject({ state: 'not-installed' })
    expect(
      await detectAgent(
        OPENCODE,
        context({ isExecutable: async (file) => file === '/usr/bin/opencode' }),
      ),
    ).toMatchObject({ state: 'available', spec: { command: '/usr/bin/opencode', args: ['acp'] } })
    expect(
      await detectAgent(
        OPENCODE,
        context({ binaryOverride: '/opt/oc', isExecutable: async (file) => file === '/opt/oc' }),
      ),
    ).toMatchObject({
      state: 'available',
      spec: { command: '/opt/oc', display: { command: '/opt/oc' } },
    })
    expect(await detectAgent(OPENCODE, context({ binaryOverride: '/opt/gone' }))).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining('/opt/gone'),
    })
  })

  it('runs the fake agent with Electron as Node.js', async () => {
    const def = fakeAgent('/repo/tools/fake-agent/main.ts')
    expect(await detectAgent(def, context())).toMatchObject({
      state: 'available',
      spec: {
        command: '/Apps/OverBench.app/Contents/MacOS/OverBench',
        args: ['/repo/tools/fake-agent/main.ts'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    })
    expect(await detectAgent(def, context({ isFile: async () => false }))).toMatchObject({
      state: 'not-installed',
    })
  })

  it('runs a package agent with the arguments and variables its ACP mode needs', async () => {
    const def: AgentDefinition = {
      ...CLAUDE_CODE,
      launch: {
        kind: 'package',
        package: CLAUDE,
        version: '0.94.0',
        args: ['--acp'],
        env: { COPILOT_ACP: '1' },
      },
    }
    const claudeEntry = entry('claude-code', CLAUDE, '0.94.0')
    expect(await detectAgent(def, context({ installed: installed('0.94.0') }))).toMatchObject({
      state: 'available',
      spec: {
        args: [claudeEntry, '--acp'],
        env: { COPILOT_ACP: '1' },
        display: {
          command: '/usr/local/bin/node',
          args: [claudeEntry, '--acp'],
          env: { COPILOT_ACP: '1' },
        },
      },
    })
  })

  it('runs a uvx agent through uvx, and says so when uvx is missing', async () => {
    const def: AgentDefinition = {
      id: 'opencode',
      name: 'Minion Code',
      registryId: 'minion-code',
      launch: { kind: 'uvx', package: 'minion-code', version: '0.1.44', args: ['acp'] },
      install: { hint: 'detect.hint.node', url: 'https://docs.astral.sh/uv/' },
    }
    expect(await detectAgent(def, context())).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining('uvx was not found on PATH'),
    })
    expect(
      await detectAgent(
        def,
        context({ isExecutable: async (file) => file === '/usr/local/bin/uvx' }),
      ),
    ).toMatchObject({
      state: 'available',
      spec: {
        command: '/usr/local/bin/uvx',
        args: ['minion-code==0.1.44', 'acp'],
        display: { command: 'uvx', args: ['minion-code==0.1.44', 'acp'] },
      },
    })
  })

  it('runs the archive OverBench installed only when no copy is on PATH', async () => {
    const command = '/data/agents/opencode/2026.10.22/dist-package/cursor-agent'
    const def: AgentDefinition = {
      ...OPENCODE,
      launch: { kind: 'binary', command: 'cursor-agent', args: ['acp'] },
      installs: {
        archive: {
          version: '2026.10.22',
          entries: {
            'darwin-aarch64': {
              url: 'https://example.com/cursor-agent.tar.gz',
              sha256: 'a'.repeat(64),
              cmd: './dist-package/cursor-agent',
              args: ['acp'],
            },
          },
        },
      },
    }
    const installedArchive = {
      installedArchives: async () => [
        {
          version: '2026.10.22',
          dir: '/data/agents/opencode/2026.10.22',
          url: 'https://example.com/cursor-agent.tar.gz',
          sha256: 'a'.repeat(64),
          cmd: './dist-package/cursor-agent',
          args: ['acp'],
          installedAt: 1,
        },
      ],
    }
    expect(
      await detectAgent(
        def,
        context({ ...installedArchive, isExecutable: async (file) => file === command }),
      ),
    ).toMatchObject({
      state: 'available',
      spec: { command, args: ['acp'], display: { command, args: ['acp'] } },
    })
    expect(
      await detectAgent(
        def,
        context({
          ...installedArchive,
          isExecutable: async (file) => file === command || file === '/usr/bin/cursor-agent',
        }),
      ),
    ).toMatchObject({ state: 'available', spec: { command: '/usr/bin/cursor-agent' } })
    expect(
      await detectAgent(
        def,
        context({
          ...installedArchive,
          binaryOverride: '/opt/cursor',
          isExecutable: async (file) =>
            file === command || file === '/usr/bin/cursor-agent' || file === '/opt/cursor',
        }),
      ),
    ).toMatchObject({ state: 'available', spec: { command: '/opt/cursor' } })
  })
})

describe('the ACP Registry npm agents', () => {
  const registry = [
    {
      def: AUGGIE,
      package: '@augmentcode/auggie',
      version: '0.36.0',
      args: ['--acp'],
      env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
    },
    {
      def: CODEBUDDY,
      package: '@tencent-ai/codebuddy-code',
      version: '2.177.1',
      args: ['--acp'],
      env: {},
    },
    { def: DEEPAGENTS, package: 'deepagents-acp', version: '0.1.7', args: [], env: {} },
    { def: DIMCODE, package: 'dimcode', version: '0.5.22', args: ['acp'], env: {} },
    { def: DIRAC, package: 'dirac-cli', version: '0.5.24', args: ['--acp'], env: {} },
    { def: GLM, package: 'glm-acp-agent', version: '1.16.0', args: [], env: {} },
    { def: NOVA, package: '@compass-ai/nova', version: '1.1.60', args: ['acp'], env: {} },
    { def: QODER, package: '@qoder-ai/qodercli', version: '0.2.14', args: ['--acp'], env: {} },
    { def: SIGIT, package: '@smbcloud/sigit', version: '1.7.5', args: [], env: {} },
    {
      def: AGORAGENTIC,
      package: 'agoragentic-mcp',
      version: '1.3.0',
      args: ['--acp'],
      env: {},
    },
    {
      def: AUTOHAND,
      package: '@autohandai/autohand-acp',
      version: '0.2.1',
      args: [],
      env: {},
    },
    { def: GEMINI, package: '@google/gemini-cli', version: '0.66.0', args: ['--acp'], env: {} },
    { def: COPILOT, package: '@github/copilot', version: '1.0.105', args: ['--acp'], env: {} },
    { def: QWEN, package: '@qwen-code/qwen-code', version: '0.26.2', args: ['--acp'], env: {} },
    {
      def: GROK,
      package: '@xai-official/grok',
      version: '1.0.72',
      args: ['agent', 'stdio'],
      env: {},
    },
    { def: CLINE, package: 'cline', version: '3.0.74', args: ['--acp'], env: {} },
    {
      def: DROID,
      package: 'droid',
      version: '0.251.0',
      args: ['exec', '--output-format', 'acp-daemon'],
      env: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    },
  ]

  for (const { def, package: name, version, args, env } of registry) {
    it(`detects ${def.id} before and after its install`, async () => {
      // None of them names a CLI of its own, so an install keeps the optional platform package.
      expect(def.cli).toBeUndefined()
      expect(await detectAgent(def, context())).toMatchObject({
        state: 'available',
        spec: null,
        adapter: { package: name, version, installed: false },
      })
      const install = `/data/agents/${def.id}/${version}`
      const entry = `${install}/node_modules/${name}/dist/index.js`
      const detection = await detectAgent(
        def,
        context({
          installed: async () => [{ version, dir: install, entry, installedAt: 1 }],
        }),
      )
      expect(detection).toMatchObject({
        state: 'available',
        spec: { command: '/usr/local/bin/node', args: [entry, ...args], env },
        adapter: { package: name, version, installed: true },
      })
    })
  }

  for (const { def } of registry) {
    it(`does not offer ${def.id} without Node.js`, async () => {
      expect(
        await detectAgent(
          def,
          context({ node: { nodeVersion: null, npmPath: null, nodePath: null } }),
        ),
      ).toMatchObject({ state: 'node-missing' })
    })
  }

  it('holds Grok to the Node.js its package asks for, not 22', async () => {
    expect(GROK.requiresNode).toBe('>=20')
    await expect(
      detectAgent(
        GROK,
        context({ node: { nodeVersion: 'v20.18.0', npmPath: '/x/npm', nodePath: '/x/node' } }),
      ),
    ).resolves.toMatchObject({ state: 'available' })
  })

  it('pins the seventeen packages the registry lists', () => {
    expect(buildCatalog(null).slice(4, 4 + registry.length)).toEqual(registry.map(({ def }) => def))
  })
})

describe('detectAgent with the CLI the user installed', () => {
  const install = (version: string, extra: Partial<InstalledAdapter> = {}): InstalledAdapter => ({
    version,
    dir: `/data/agents/claude-code/${version}`,
    entry: `/data/agents/claude-code/${version}/index.js`,
    installedAt: 1,
    ...extra,
  })
  // `claude` on PATH answering 2.1.304, and installs whose SDK names 2.1.303.
  function withClaude(overrides: Partial<DetectContext> = {}, answer = '2.1.304'): DetectContext {
    return context({
      isExecutable: async (file) => file === '/usr/local/bin/claude',
      probeCli: async () => ({ version: answer }),
      cliFiles: {
        isFile: async () => true,
        realpath: async (file) => file,
        readText: async (file) => {
          if (file.endsWith(path.join('claude-agent-sdk', 'package.json')))
            return JSON.stringify({ claudeCodeVersion: '2.1.303' })
          throw new Error(`ENOENT: ${file}`)
        },
      },
      installed: async () => [install('0.94.0')],
      ...overrides,
    })
  }

  it('passes the installed program to the adapter when it is new enough', async () => {
    const detection = await detectAgent(CLAUDE_CODE, withClaude())
    const env = { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' }
    expect(detection).toMatchObject({
      state: 'available',
      spec: { env, display: { env }, cli: '/usr/local/bin/claude' },
      adapter: {
        cli: {
          runs: 'installed',
          installed: { path: '/usr/local/bin/claude', version: '2.1.304', problem: null },
          needsCopy: false,
        },
      },
    })
  })

  it('runs the copy when the program is older than the adapter needs, or missing', async () => {
    const old = await detectAgent(CLAUDE_CODE, withClaude({}, '2.1.200'))
    expect(old).toMatchObject({
      spec: { env: {} },
      adapter: {
        cli: { runs: 'bundled', installed: { problem: { kind: 'too-old', minimum: '2.1.303' } } },
      },
    })
    if (old.state === 'available') expect(old.spec?.cli).toBeUndefined()
    const none = await detectAgent(CLAUDE_CODE, withClaude({ isExecutable: async () => false }))
    expect(none).toMatchObject({
      spec: { env: {} },
      adapter: { cli: { runs: 'bundled', installed: null } },
    })
  })

  it('runs the copy when the program does not start, or after a start with it failed', async () => {
    expect(
      await detectAgent(
        CLAUDE_CODE,
        withClaude({ probeCli: async () => ({ error: 'claude exited with code 1.' }) }),
      ),
    ).toMatchObject({
      adapter: { cli: { runs: 'bundled', installed: { problem: { kind: 'failed' } } } },
    })
    expect(
      await detectAgent(
        CLAUDE_CODE,
        withClaude({ cliFailure: { path: '/usr/local/bin/claude', reason: 'It exited.' } }),
      ),
    ).toMatchObject({
      spec: { env: {} },
      adapter: {
        cli: { runs: 'bundled', installed: { problem: { kind: 'failed', reason: 'It exited.' } } },
      },
    })
  })

  it('counts the program as usable before the adapter is installed, which says the minimum', async () => {
    expect(await detectAgent(CLAUDE_CODE, withClaude({ installed: async () => [] }))).toMatchObject(
      {
        spec: null,
        adapter: { installed: false, cli: { runs: 'installed', needsCopy: false } },
      },
    )
  })

  it('holds the program to the older install while the pinned one is not installed', async () => {
    const older = withClaude({ installed: async () => [install('0.93.0')] }, '2.1.200')
    expect(await detectAgent(CLAUDE_CODE, older)).toMatchObject({
      spec: null,
      adapter: {
        fallback: { version: '0.93.0', spec: { env: {} } },
        cli: { runs: 'bundled', installed: { problem: { kind: 'too-old', minimum: '2.1.303' } } },
      },
    })
  })

  it('installs the copy first when it is needed and the install has none', async () => {
    const bare = async () => [install('0.94.0', { withoutCli: true })]
    expect(
      await detectAgent(CLAUDE_CODE, withClaude({ installed: bare }, '2.1.200')),
    ).toMatchObject({
      spec: null,
      adapter: { installed: true, cli: { runs: 'bundled', needsCopy: true } },
    })
    // The installed program does not need the copy.
    expect(await detectAgent(CLAUDE_CODE, withClaude({ installed: bare }))).toMatchObject({
      spec: { cli: '/usr/local/bin/claude' },
      adapter: { cli: { runs: 'installed', needsCopy: false } },
    })
  })

  it('runs the copy when the user chose it', async () => {
    expect(await detectAgent(CLAUDE_CODE, withClaude({ cliPreference: 'bundled' }))).toMatchObject({
      spec: { env: {} },
      adapter: { cli: { runs: 'bundled', installed: { version: '2.1.304', problem: null } } },
    })
  })

  it('leaves a program the environment names to the adapter', async () => {
    const detection = await detectAgent(
      CLAUDE_CODE,
      withClaude({ env: { PATH: '/usr/local/bin', CLAUDE_CODE_EXECUTABLE: '/opt/claude' } }),
    )
    expect(detection).toMatchObject({
      spec: { env: {} },
      adapter: {
        cli: {
          runs: 'installed',
          installed: { path: '/opt/claude', variable: 'CLAUDE_CODE_EXECUTABLE' },
        },
      },
    })
  })
})

describe('a program the adapter runs (Pi)', () => {
  const PI_ACP = 'pi-acp'
  const ROUTER = '/data/session-router.js'
  const entry = (agentId: string, name: string, version: string): string =>
    `/data/agents/${agentId}/${version}/node_modules/${name}/dist/index.js`
  // `pi` on PATH answering 0.83.0, and pi-acp 0.0.34 installed.
  function withPi(overrides: Partial<DetectContext> = {}, answer = '0.83.0'): DetectContext {
    return context({
      isExecutable: async (file) => file === '/usr/local/bin/pi',
      probeCli: async () => ({ version: answer }),
      installed: async (agentId, name) => [
        {
          version: '0.0.34',
          dir: `/data/agents/${agentId}/0.0.34`,
          entry: entry(agentId, name, '0.0.34'),
          installedAt: 1,
        },
      ],
      sessionRouterPath: ROUTER,
      ...overrides,
    })
  }

  it('launches through the router, with the variable the adapter reads', async () => {
    const detection = await detectAgent(PI, withPi())
    expect(detection).toMatchObject({
      state: 'available',
      spec: {
        command: '/usr/local/bin/node',
        args: [ROUTER, '/usr/local/bin/node', entry('pi', PI_ACP, '0.0.34')],
        env: {
          PI_ACP_PI_COMMAND: '/usr/local/bin/pi',
          PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true',
        },
      },
      requires: { program: '/usr/local/bin/pi', version: '0.83.0' },
    })
    if (detection.state === 'available') expect(detection.adapter?.installed).toBe(true)
  })

  it('says how to install or update pi when it is missing, too old or does not answer', async () => {
    const hint = 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
    expect(await detectAgent(PI, withPi({ isExecutable: async () => false }))).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining(hint),
    })
    expect(await detectAgent(PI, withPi({}, '0.80.9'))).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining('0.81.0'),
    })
    expect(
      await detectAgent(
        PI,
        withPi({ probeCli: async () => ({ error: 'pi exited with code 1.' }) }),
      ),
    ).toMatchObject({ state: 'not-installed', detail: expect.stringContaining('code 1') })
  })

  it('finds a pi.cmd on Windows and asks it its version', async () => {
    const probed: string[] = []
    const detection = await detectAgent(
      PI,
      withPi({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\a\\AppData\\Roaming\\npm' },
        isExecutable: async (file) => file === 'C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd',
        probeCli: async (program) => {
          probed.push(program)
          return { version: '0.83.0' }
        },
      }),
    )
    expect(probed).toEqual(['C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd'])
    expect(detection).toMatchObject({ state: 'available' })
  })

  it('runs only through a session router, so a build without one does not offer it', async () => {
    expect(await detectAgent(PI, withPi({ sessionRouterPath: null }))).toMatchObject({
      state: 'not-installed',
    })
  })

  it('shows the router command line as the launch', () => {
    expect(displayCommand(PI, '/e', null, '/data/agents', ROUTER)).toEqual({
      command: 'node',
      args: [ROUTER, 'node', path.join('/data/agents', 'pi', '0.0.34', 'node_modules', PI_ACP)],
      env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' },
    })
  })
})

describe('displayCommand', () => {
  it('shows the bare command the user would type', () => {
    expect(displayCommand(OPENCODE, '/e', null, '/data/agents')).toEqual({
      command: 'opencode',
      args: ['acp'],
      env: {},
    })
    expect(displayCommand(CODEX, '/e', null, '/data/agents')).toEqual({
      command: 'node',
      args: [
        path.join(
          '/data/agents',
          'codex',
          '2.2.2',
          'node_modules',
          '@agentclientprotocol/codex-acp',
        ),
      ],
      env: {},
    })
  })

  it('shows a package agent with its arguments and variables', () => {
    const def: AgentDefinition = {
      ...CODEX,
      launch: {
        kind: 'package',
        package: '@agentclientprotocol/codex-acp',
        version: '2.2.2',
        args: ['--acp'],
        env: { COPILOT_ACP: '1' },
      },
    }
    expect(displayCommand(def, '/e', null, '/data/agents')).toEqual({
      command: 'node',
      args: [
        path.join(
          '/data/agents',
          'codex',
          '2.2.2',
          'node_modules',
          '@agentclientprotocol/codex-acp',
        ),
        '--acp',
      ],
      env: { COPILOT_ACP: '1' },
    })
  })

  it('shows a uvx agent as uvx with its pinned package', () => {
    const def: AgentDefinition = {
      ...OPENCODE,
      launch: { kind: 'uvx', package: 'fast-agent-acp', version: '0.10.1', args: ['-x'] },
    }
    expect(displayCommand(def, '/e', null, '/data/agents')).toEqual({
      command: 'uvx',
      args: ['fast-agent-acp==0.10.1', '-x'],
      env: {},
    })
  })
})

describe('the registry archive agents', () => {
  function archived(
    def: AgentDefinition,
    platform: 'darwin' | 'linux' | 'win32' = 'darwin',
    arch = 'arm64',
  ): {
    entry: NonNullable<ReturnType<typeof archiveEntry>>
    install: InstalledArchive
    command: string
  } {
    const release = (def.installs as BinaryInstalls).archive!
    const entry = archiveEntry(release, platform, arch)!
    const dir = `/data/agents/${def.id}/${release.version}`
    return {
      entry,
      command: programPath(dir, entry.cmd, platform),
      install: {
        version: release.version,
        dir,
        url: entry.url,
        sha256: entry.sha256 ?? 'a'.repeat(64),
        cmd: entry.cmd,
        args: entry.args ?? [],
        installedAt: 1,
      },
    }
  }

  async function runsFromArchive(def: AgentDefinition): Promise<void> {
    const { entry, install, command } = archived(def)
    expect(await detectAgent(def, context())).toMatchObject({ state: 'not-installed' })
    expect(
      await detectAgent(
        def,
        context({
          installedArchives: async () => [install],
          isExecutable: async (file) => file === command,
        }),
      ),
    ).toMatchObject({
      state: 'available',
      spec: { command, args: entry.args ?? [], shell: false },
    })
  }

  it('adds Cursor with its platform archives and its own CLI', async () => {
    expect(CURSOR.launch).toEqual({ kind: 'binary', command: 'cursor-agent', args: ['acp'] })
    const entries = CURSOR.installs!.archive!.entries
    expect(Object.keys(entries).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-aarch64',
      'linux-x86_64',
      'windows-aarch64',
      'windows-x86_64',
    ])
    for (const [key, entry] of Object.entries(entries)) {
      expect(entry.url).toMatch(/^https:\/\/downloads\.cursor\.com\/lab\/2026\.10\.22-27dcf5f\//)
      expect(entry.cmd).toBe(
        key.startsWith('windows')
          ? './dist-package\\cursor-agent.cmd'
          : './dist-package/cursor-agent',
      )
      expect(entry.args).toEqual(['acp'])
      // The registry publishes no hash for Cursor, so the install records the one it measured.
      expect(entry.sha256).toBeUndefined()
    }
    await runsFromArchive(CURSOR)
    expect(
      await detectAgent(
        CURSOR,
        context({ isExecutable: async (file) => file === '/usr/local/bin/cursor-agent' }),
      ),
    ).toMatchObject({
      state: 'available',
      spec: { command: '/usr/local/bin/cursor-agent', args: ['acp'] },
    })
  })

  it('adds Kimi Code CLI where the registry ships an archive, hashes included', async () => {
    expect(KIMI.launch).toEqual({ kind: 'binary', command: 'kimi', args: ['acp'] })
    const entries = KIMI.installs!.archive!.entries
    expect(Object.keys(entries).sort()).toEqual([
      'darwin-aarch64',
      'linux-aarch64',
      'linux-x86_64',
      'windows-aarch64',
      'windows-x86_64',
    ])
    expect(archiveEntry(KIMI.installs!.archive, 'darwin', 'x64')).toBeNull()
    for (const [key, entry] of Object.entries(entries)) {
      expect(entry.cmd).toBe(key.startsWith('windows') ? './kimi.exe' : './kimi')
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.args).toEqual(['acp'])
    }
    await runsFromArchive(KIMI)
    expect(
      await detectAgent(KIMI, context({ isExecutable: async (file) => file === '/usr/bin/kimi' })),
    ).toMatchObject({ state: 'available', spec: { command: '/usr/bin/kimi' } })
  })

  it('adds Amp as the adapter archive alone', async () => {
    expect(AMP.launch).toEqual({ kind: 'binary', command: 'amp-acp', args: [] })
    const entries = AMP.installs!.archive!.entries
    expect(Object.keys(entries).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-aarch64',
      'linux-x86_64',
      'windows-x86_64',
    ])
    for (const [key, entry] of Object.entries(entries)) {
      expect(entry.cmd).toBe(key.startsWith('windows') ? 'amp-acp.exe' : './amp-acp')
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      // The archive is the adapter itself, so it needs no arguments of its own.
      expect(entry.args).toBeUndefined()
    }
    await runsFromArchive(AMP)
    expect(
      await detectAgent(
        AMP,
        context({ isExecutable: async (file) => file === '/usr/local/bin/amp-acp' }),
      ),
    ).toMatchObject({ state: 'available', spec: { command: '/usr/local/bin/amp-acp' } })
  })

  it('adds goose with its archives, commands and hashes', async () => {
    expect(GOOSE.launch).toEqual({ kind: 'binary', command: 'goose', args: ['acp'] })
    const entries = GOOSE.installs!.archive!.entries
    expect(Object.keys(entries).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-aarch64',
      'linux-x86_64',
      'windows-x86_64',
    ])
    for (const [key, entry] of Object.entries(entries)) {
      expect(entry.cmd).toBe(key.startsWith('windows') ? './goose-package\\goose.exe' : './goose')
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.args).toEqual(['acp'])
    }
    await runsFromArchive(GOOSE)
    expect(
      await detectAgent(
        GOOSE,
        context({ isExecutable: async (file) => file === '/usr/bin/goose' }),
      ),
    ).toMatchObject({ state: 'available', spec: { command: '/usr/bin/goose' } })
  })

  it('adds Kilo Code with its archive and its npm package', async () => {
    expect(KILO.launch).toEqual({ kind: 'binary', command: 'kilo', args: ['acp'] })
    expect(KILO.installs!.npm).toBe('@kilocode/cli')
    const entries = KILO.installs!.archive!.entries
    expect(Object.keys(entries).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-aarch64',
      'linux-x86_64',
      'windows-x86_64',
    ])
    for (const [key, entry] of Object.entries(entries)) {
      expect(entry.cmd).toBe(key.startsWith('windows') ? './kilo.exe' : './kilo')
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.args).toEqual(['acp'])
    }
    await runsFromArchive(KILO)
    expect(
      await detectAgent(KILO, context({ isExecutable: async (file) => file === '/usr/bin/kilo' })),
    ).toMatchObject({ state: 'available', spec: { command: '/usr/bin/kilo' } })
  })
})
