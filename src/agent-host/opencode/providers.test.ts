// OpenCode provider discovery through AgentManager on Windows: runs the resolved `.cmd` shim path
// from detection rather than the bare display name (`opencode`), which fails with ENOENT without a
// shell, while keeping the short command name in the terminal `loginCommand`.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { AgentManager } from '../agents'
import { OPENCODE } from '../agents/opencode'
import { Diagnostics } from '../diagnostics'
import { needsShell } from '../find-command'
import { TextRing } from '../ring'
import { EnvironmentService } from '../shell-env'
import { tempFolder } from '../testing/temp'

const WIN_SHIM = 'C:\\Users\\developer\\AppData\\Roaming\\npm\\opencode.cmd'

function runResult(stdout = '', code: number | null = 0, stderr = ''): ProgramRun {
  const output = new TextRing(4096)
  output.push(stderr)
  return { code, signal: null, timedOut: false, aborted: false, output, stdout }
}

function settings(): HostSettings {
  return {
    locale: 'en',
    initialSetupDone: true,
    agents: { opencode: { enabled: true } },
    addedAgents: [],
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
}

describe('OpenCode provider refresh on Windows', () => {
  it('invokes the detected .cmd path with spec env instead of the bare display name', async () => {
    const root = await tempFolder('kettu-opencode-providers-win-')
    const calls: ProgramOptions[] = []
    const nodeRuntime = { command: process.execPath, env: {} }
    const agents = new AgentManager({
      catalog: [OPENCODE],
      platform: 'win32',
      nodeRuntime,
      appVersion: '0.0.0-test',
      env: new EnvironmentService({
        platform: 'win32',
        nodeRuntime,
        baseEnv: { Path: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\developer' },
        resolve: async ({ baseEnv }) => ({
          env: baseEnv,
          source: 'inherited',
          shell: null,
          durationMs: 0,
          warning: null,
        }),
        probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
      }),
      diagnostics: new Diagnostics(),
      launcher: {
        launch: () => {
          throw new Error('launcher should not run during provider refresh')
        },
      },
      settings,
      reportsDir: path.join(root, 'reports'),
      adaptersDir: root,
      detect: async () => ({
        state: 'available',
        adapter: null,
        spec: {
          command: WIN_SHIM,
          args: ['acp'],
          shell: true,
          env: { OPENCODE_CONFIG_DIR: 'C:\\Users\\developer\\.config\\opencode' },
          display: { command: 'opencode', args: ['acp'], env: {} },
        },
        cli: { path: WIN_SHIM, version: '2.4.2', variable: null, problem: null },
      }),
      probeCli: async () => ({ version: '2.4.2' }),
      runProgram: async (options) => {
        calls.push(options)
        const [command, method, route] = options.args
        if (command === 'api' && method === 'get' && route === '/api/integration') {
          return runResult(
            '\uFEFF' +
              JSON.stringify({
                location: { directory: 'C:\\Users\\developer' },
                data: [
                  {
                    id: 'opencode',
                    name: 'OpenCode Console',
                    methods: [{ type: 'key' }],
                    connections: [],
                  },
                  {
                    id: 'custom-provider',
                    methods: [{ type: 'key' }],
                    connections: [
                      { type: 'credential', id: 'cred_1', label: 'Custom', method: 'key' },
                    ],
                  },
                ],
              }) +
              '\r\n',
          )
        }
        if (command === 'api' && method === 'get' && route === '/api/experimental/usage/limits') {
          return runResult('', 1, 'HTTP 404 Not Found\r\n')
        }
        throw new Error(`unexpected ${options.args.join(' ')}`)
      },
      status: () => {},
      processes: () => {},
      authCommands: () => {},
    })

    await agents.refreshLimits('opencode', { force: true })

    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const call of calls) {
      expect(call.program).toBe(WIN_SHIM)
      expect(call.platform).toBe('win32')
      expect(needsShell(call.program, 'win32')).toBe(true)
      expect(call.env.OPENCODE_CONFIG_DIR).toBe('C:\\Users\\developer\\.config\\opencode')
    }
    const status = (await agents.list()).find((item) => item.id === 'opencode')
    expect(status?.providersError).toBeNull()
    expect(status?.providers).toEqual([
      expect.objectContaining({
        id: 'opencode',
        name: 'OpenCode Console',
        loginCommand: 'opencode auth login opencode',
      }),
      expect.objectContaining({
        id: 'custom-provider',
        name: 'custom-provider',
        loginCommand: 'opencode auth login custom-provider',
      }),
    ])
    expect(status?.signIn).toBe('signed-in')
  })
})
