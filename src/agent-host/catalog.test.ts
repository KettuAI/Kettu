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
      npxPath: '/usr/local/bin/npx',
      nodePath: '/usr/local/bin/node',
    },
    isExecutable: async () => false,
    isFile: async () => true,
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
  it('runs npx agents with npx -y and the pinned package', async () => {
    expect(await detectAgent(CLAUDE_CODE, context())).toEqual({
      state: 'available',
      spec: {
        command: '/usr/local/bin/npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'],
        env: {},
        shell: false,
        display: {
          command: 'npx',
          args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'],
          env: {},
        },
      },
    })
  })

  it('needs npx and a recent enough Node.js', async () => {
    expect(
      await detectAgent(
        CODEX,
        context({ node: { nodeVersion: null, npxPath: null, nodePath: null } }),
      ),
    ).toMatchObject({ state: 'node-missing' })
    expect(
      await detectAgent(
        CODEX,
        context({ node: { nodeVersion: 'v20.18.0', npxPath: '/x/npx', nodePath: '/x/node' } }),
      ),
    ).toMatchObject({ state: 'node-outdated', detail: expect.stringContaining('v20.18.0') })
  })

  it('spawns npx.cmd through a shell on Windows', async () => {
    const detection = await detectAgent(
      CLAUDE_CODE,
      context({
        platform: 'win32',
        node: {
          nodeVersion: 'v22.12.0',
          npxPath: 'C:\\Program Files\\nodejs\\npx.cmd',
          nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        },
      }),
    )
    expect(detection).toMatchObject({ state: 'available', spec: { shell: true } })
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
    expect(displayCommand(OPENCODE, '/e', null)).toEqual({
      command: 'opencode',
      args: ['acp'],
      env: {},
    })
    expect(displayCommand(CODEX, '/e', null)).toEqual({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp@2.2.2'],
      env: {},
    })
  })
})
