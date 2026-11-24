// A program picked in Settings for a harness that runs the user's own CLI: its driver is told the
// version of that program, as it is for one found on PATH.

import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from './agents'
import { PI } from './agents/pi'
import type { AgentConnection } from './connection'
import { Diagnostics } from './diagnostics'
import type { HostedContext, HostedDriver } from './driver'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

const VERSION = '1.5.2'

/**
 * A manager whose only agent is Pi, run from `program`, which answers `version`, with a driver
 * that notes what it gets; `latest` is the newest Pi on npm, offline without it.
 */
async function manager(
  program: string,
  probeMs: number,
  { version = VERSION, latest }: { version?: string; latest?: string } = {},
) {
  const root = await tempFolder('kettu-picked-')
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const settings: HostSettings = {
    locale: 'en',
    initialSetupDone: true,
    agents: { pi: { enabled: true, binaryPath: program } },
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
  const started: HostedContext[] = []
  const noting: HostedDriver = {
    kind: 'hosted',
    connect: (context) => {
      started.push(context)
      return {
        closed: new Promise<void>(() => {}),
        isClosed: false,
        close: () => {},
        initialize: () => Promise.reject(new Error('the test starts nothing')),
      } as unknown as AgentConnection
    },
  }
  const agents = new AgentManager({
    catalog: [PI],
    platform,
    nodeRuntime,
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv: { PATH: '' },
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({
        nodeVersion: '24.0.0',
        npmPath: latest ? path.join(root, 'npm') : null,
        nodePath: null,
      }),
    }),
    diagnostics: new Diagnostics(),
    launcher: {
      launch: () => {
        throw new Error('a hosted driver starts its own processes')
      },
    },
    settings: () => settings,
    reportsDir: path.join(root, 'reports'),
    adaptersDir: root,
    drivers: { 'pi-rpc': noting },
    // The program answers `--version` only after a while, as a cold start of it does.
    probeCli: async () => {
      await new Promise((resolve) => setTimeout(resolve, probeMs))
      return { version }
    },
    fetchLatest: async () => {
      if (!latest) throw new Error('offline')
      return { adapterVersion: latest, cliVersion: null }
    },
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  return { agents, started }
}

describe('a program picked in Settings', () => {
  it('reaches its driver with the version it answers, even when that answer is slow', async () => {
    const dir = await tempFolder('kettu-picked-program-')
    const program = path.join(dir, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await writeFile(program, '')
    await chmod(program, 0o755)
    const { agents, started } = await manager(program, 40)

    await expect(agents.ensureReady('pi')).rejects.toThrow()

    expect(started).toHaveLength(1)
    expect(started[0]!.spec.command).toBe(program)
    expect(started[0]!.cliVersion).toBe(VERSION)
  })

  it('shows as the program that runs, and offers no update that would land elsewhere', async () => {
    // A copy npm installed into a folder of its own, not under a global prefix.
    const dir = await tempFolder('kettu-picked-local-')
    const pkg = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent')
    await mkdir(path.join(pkg, 'dist'), { recursive: true })
    await mkdir(path.join(dir, 'node_modules', '.bin'))
    const file = path.join(pkg, 'dist', 'cli.js')
    await writeFile(file, '')
    await chmod(file, 0o755)
    const program = path.join(dir, 'node_modules', '.bin', 'pi')
    await symlink(file, program)
    const { agents } = await manager(program, 0, { version: '0.81.0', latest: '1.5.2' })

    await agents.list()
    await vi.waitFor(() => expect(agents.status('pi').cli?.installed?.version).toBe('0.81.0'))
    expect(agents.status('pi').cli?.installed?.path).toBe(program)
    await agents.checkUpdates()

    // `npm install -g` would update a global copy, never this one.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agents.status('pi').cli?.update).toBeNull()
  })
})
