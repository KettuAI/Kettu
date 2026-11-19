// A program picked in Settings for a harness that runs the user's own CLI: its driver is told the
// version of that program, as it is for one found on PATH.

import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from './agents'
import { PI } from './agents/pi'
import type { AgentConnection } from './connection'
import { Diagnostics } from './diagnostics'
import type { HostedContext, HostedDriver } from './driver'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

const VERSION = '1.5.2'

/** A manager whose only agent is Pi, run from `program`, with a driver that notes what it gets. */
async function manager(program: string, probeMs: number) {
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
    usage: { fromComputer: false },
    sessionTitles: true,
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
      probe: async () => ({ nodeVersion: '24.0.0', npmPath: null, nodePath: null }),
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
      return { version: VERSION }
    },
    fetchLatest: async () => {
      throw new Error('offline')
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
})
