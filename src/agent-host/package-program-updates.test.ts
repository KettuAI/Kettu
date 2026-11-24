// The update a package harness offers for the user's own program it runs, such as a global `dsh`:
// checked by the way it was installed, and held to the versions the harness runs.

import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { LatestOptions } from './agent-updates'
import { AgentManager } from './agents'
import { DEEPSEEK } from './agents/deepseek'
import { Diagnostics } from './diagnostics'
import { inNpmRange } from './harness-manifest'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'
import { compareVersions } from './versions'

const PACKAGE = '@deepseek-ai/dsh'

/** The newest of `published` npm would name: the `latest` tag, or the newest in the range. */
function npmView(published: string[], options: LatestOptions): string {
  const range = options.range
  const matching = range ? published.filter((v) => inNpmRange(v, range)) : published
  const newest = matching.toSorted(compareVersions).at(-1)
  if (!newest) throw new Error(`No version of ${options.package} matches ${range}`)
  return newest
}

/**
 * A manager whose only agent is DeepSeek Harness, with the user's own `dsh` at `version`, which npm
 * installed globally under a prefix of its own, and `published` on npm.
 */
async function manager(version: string, published: string[]) {
  // The prefix as npm's own folders name it, links resolved.
  const root = await realpath(await tempFolder('kettu-package-updates-'))
  const prefix = path.join(root, 'prefix')
  const script = path.join(prefix, 'lib', 'node_modules', PACKAGE, 'bin', 'dsh.js')
  await mkdir(path.dirname(script), { recursive: true })
  await writeFile(script, '')
  await chmod(script, 0o755)
  await mkdir(path.join(prefix, 'bin'))
  const program = path.join(prefix, 'bin', 'dsh')
  await symlink(script, program)
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const settings: HostSettings = {
    locale: 'en',
    initialSetupDone: true,
    agents: { deepseek: { enabled: true } },
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
    catalog: [DEEPSEEK],
    platform,
    nodeRuntime,
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv: { PATH: path.join(prefix, 'bin'), HOME: root },
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
    probeCli: async () => ({ version }),
    fetchLatest: async (options) => {
      asked.push(options)
      return { adapterVersion: npmView(published, options), cliVersion: null }
    },
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  return { agents, prefix, program, asked }
}

describe('the user dsh, installed with npm', () => {
  it('is checked on npm and offered the newest version the harness runs', async () => {
    const { agents, prefix, program } = await manager('0.2.2-rc.2', [
      '0.2.2-rc.2',
      '0.2.2-rc.5',
      '0.3.0',
    ])
    await agents.list()
    expect(agents.status('deepseek').cli?.installed?.path).toBe(program)

    await agents.checkUpdates()

    expect(agents.status('deepseek').updateCheckedAt).not.toBeNull()
    await vi.waitFor(() =>
      expect(agents.status('deepseek').cli?.update).toEqual({
        version: '0.2.2-rc.5',
        command: `npm install -g --prefix ${prefix} ${PACKAGE}@0.2.2-rc.5`,
      }),
    )
  })

  it('is offered nothing when the only newer version is outside what the harness runs', async () => {
    const { agents } = await manager('0.2.2-rc.2', ['0.2.2-rc.2', '0.3.0'])
    await agents.list()
    await agents.checkUpdates()

    expect(agents.status('deepseek').updateCheckedAt).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agents.status('deepseek').cli?.update).toBeNull()
  })
})
