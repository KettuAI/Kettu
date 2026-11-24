// The update a binary harness offers for the user's own program: one WinGet installed is not
// compared with npm, which gets new versions before WinGet does, so `winget upgrade` would do
// nothing.

import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { LatestOptions } from './agent-updates'
import { AgentManager } from './agents'
import { CODEWHALE } from './agents/codewhale'
import { Diagnostics } from './diagnostics'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

/**
 * A manager whose only agent is CodeWhale, whose program `codewhale` WinGet or npm installed and
 * answers `1.0.0`; npm names `2.0.0` as the newest.
 */
async function manager(installedBy: 'winget' | 'npm') {
  // Links resolved, as the program's real path is told apart by its folders.
  const root = await realpath(await tempFolder('kettu-winget-updates-'))
  const dir = path.join(root, installedBy === 'winget' ? 'winget' : 'prefix/bin')
  await mkdir(dir, { recursive: true })
  const program = path.join(dir, 'codewhale')
  if (installedBy === 'winget') {
    await writeFile(program, '')
  } else {
    const script = path.join(root, 'prefix/lib/node_modules/codewhale/bin/codewhale.js')
    await mkdir(path.dirname(script), { recursive: true })
    await writeFile(script, '')
    await chmod(script, 0o755)
    await symlink(script, program)
  }
  await chmod(program, 0o755)
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const settings: HostSettings = {
    locale: 'en',
    initialSetupDone: true,
    agents: { codewhale: { enabled: true } },
    addedAgents: [],
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
  const asked: LatestOptions[] = []
  const agents = new AgentManager({
    catalog: [CODEWHALE],
    platform,
    nodeRuntime,
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv: { PATH: dir, HOME: root },
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({
        nodeVersion: '24.11.0',
        npmPath: path.join(root, 'npm'),
        nodePath: path.join(root, 'node'),
      }),
    }),
    diagnostics: new Diagnostics(),
    launcher: {
      launch: () => {
        throw new Error('the test starts nothing')
      },
    },
    settings: () => settings,
    reportsDir: path.join(root, 'reports'),
    adaptersDir: path.join(root, 'harnesses'),
    probeCli: async () => ({ version: '1.0.0' }),
    fetchLatest: async (options) => {
      asked.push(options)
      return { adapterVersion: '2.0.0', cliVersion: null }
    },
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  return { agents, program, asked }
}

describe("a user's program WinGet installed", () => {
  it('is not checked on npm, so no update is offered before WinGet has it', async () => {
    const { agents, program, asked } = await manager('winget')
    await agents.list()
    await vi.waitFor(() => expect(agents.status('codewhale').cli?.method).toBe('winget'))
    expect(agents.status('codewhale').cli?.installed?.path).toBe(program)

    await agents.checkUpdates().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(asked).toEqual([])
    expect(agents.status('codewhale').cli?.update).toBeNull()
    expect(agents.status('codewhale').cli?.checkable).toBe(false)
  })

  it('is offered nothing from an npm version an earlier check kept', async () => {
    const { agents } = await manager('winget')
    await agents.list()
    await vi.waitFor(() => expect(agents.status('codewhale').cli?.method).toBe('winget'))

    agents.restoreUpdates({
      version: 1,
      agents: { codewhale: { checkedAt: 1, attemptedAt: 1, latest: null, cli: '2.0.0' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(agents.status('codewhale').cli?.update).toBeNull()
  })

  it('leaves one installed with npm checked on npm, as before', async () => {
    const { agents, asked } = await manager('npm')
    await agents.list()
    await agents.checkUpdates()

    expect(asked.map((options) => options.package)).toEqual(['codewhale'])
    await vi.waitFor(() =>
      expect(agents.status('codewhale').cli?.update).toMatchObject({ version: '2.0.0' }),
    )
  })
})
