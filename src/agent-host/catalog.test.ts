import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCatalog,
  CLAUDE_CODE,
  CODEX,
  detectAgent,
  displayCommand,
  fakeAgent,
  OPENCODE,
  type DetectContext,
} from './catalog'

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
    expect(buildCatalog(null).map((d) => d.id)).toEqual(['claude-code', 'codex', 'opencode'])
    expect(buildCatalog('/repo/tools/fake-agent/main.ts').map((d) => d.id)).toContain('fake-agent')
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
})
