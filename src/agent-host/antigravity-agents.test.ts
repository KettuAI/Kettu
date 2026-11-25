// An added Google Antigravity agent keeps its own sign-in: its process takes the agent's folder
// with `--gemini-dir` and keeps agy's token in a file there, never in the keychain entry the
// default agent and the user's terminal `agy` share.

import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from './agents'
import { ANTIGRAVITY } from './agents/antigravity'
import type { LaunchSpec } from './catalog'
import type { AgentConnection } from './connection'
import { Diagnostics } from './diagnostics'
import type { ProcessDriver } from './driver'
import type { Env } from './find-command'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

const FILE_TOKEN = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE'

interface Launch {
  spec: LaunchSpec
  env: Env
}

/** A manager whose only harness is Antigravity, run from `program`, with one added agent. */
async function manager(program: string, folder: string) {
  const root = await tempFolder('kettu-agy-agents-')
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const settings: HostSettings = {
    locale: 'en',
    initialSetupDone: true,
    agents: { antigravity: { enabled: true, binaryPath: program } },
    addedAgents: [{ id: 'antigravity~work', name: 'Work', configDir: folder, created: true }],
    disabledAgents: [],
    proxy: DEFAULT_SETTINGS.proxy,
    git: DEFAULT_SETTINGS.git,
    mcp: DEFAULT_SETTINGS.mcp,
    marketplace: DEFAULT_SETTINGS.marketplace,
    startModes: DEFAULT_SETTINGS.startModes,
    idleSessions: DEFAULT_SETTINGS.idleSessions,
    workflow: DEFAULT_SETTINGS.workflow,
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
  const launches: Launch[] = []
  const noting: ProcessDriver = {
    kind: 'process',
    connect: () => ({}) as unknown as AgentConnection,
  }
  const agents = new AgentManager({
    catalog: [ANTIGRAVITY],
    platform,
    nodeRuntime,
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv: { PATH: '', HOME: '/Users/me' },
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
      launch: (_def, spec, env) => {
        launches.push({ spec, env })
        throw new Error('the test starts nothing')
      },
    },
    settings: () => settings,
    reportsDir: path.join(root, 'reports'),
    adaptersDir: root,
    drivers: { acp: noting },
    probeCli: async () => ({ version: '1.5.17' }),
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  return { agents, launches }
}

describe('an added Google Antigravity agent', () => {
  it('runs agy with its own folder and file token, the default agent with neither', async () => {
    const dir = await tempFolder('kettu-agy-program-')
    const program = path.join(dir, process.platform === 'win32' ? 'agy.cmd' : 'agy')
    await writeFile(program, '')
    await chmod(program, 0o755)
    const folder = path.join(dir, 'agents', 'antigravity~work')
    const { agents, launches } = await manager(program, folder)

    await expect(agents.ensureReady('antigravity~work')).rejects.toThrow()
    await expect(agents.ensureReady('antigravity')).rejects.toThrow()

    expect(launches).toHaveLength(2)
    const [added, own] = launches
    expect(added?.spec.args.slice(-2)).toEqual(['--gemini-dir', path.join(folder, '.gemini')])
    expect(added?.env[FILE_TOKEN]).toBe('1')
    // Its sessions run the user's commands, which keep the user's own home folder.
    expect(added?.env.HOME).toBe('/Users/me')

    expect(own?.spec.args).not.toContain('--gemini-dir')
    expect(own?.env[FILE_TOKEN]).toBeUndefined()
  })
})
