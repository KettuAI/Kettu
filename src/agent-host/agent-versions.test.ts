import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { InstallOptions, InstalledAdapter } from './adapter-install'
import type { ExitInfo } from './agent-process'
import { AgentManager, type LaunchedAgent } from './agents'
import type { AgentDefinition } from './catalog'
import { Diagnostics } from './diagnostics'
import { parseBundled } from './harness-versions'
import { parseRegistry, type RegistryAgents } from './registry'
import { EnvironmentService } from './shell-env'
import type { AgentUpdatesFile } from './storage'
import { inProcessLauncher, loadFakeAgent } from './testing/harness'
import { tempFolder } from './testing/temp'

const PACKAGE = '@google/gemini-cli'

const DEF: AgentDefinition = {
  id: 'gemini',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: PACKAGE, args: ['--acp'] },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}

function listing(version: string): RegistryAgents {
  const agents = [
    { id: 'gemini', version, distribution: { npx: { package: `${PACKAGE}@${version}` } } },
  ]
  return parseRegistry({ agents })!
}

/** A complete npm install of the package, as Kettu records one, written straight to disk. */
async function writeInstall(root: string, version: string): Promise<InstalledAdapter> {
  const dir = path.join(root, 'gemini', version)
  const packageDir = path.join(dir, 'node_modules', PACKAGE)
  await mkdir(packageDir, { recursive: true })
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ bin: 'cli.js' }))
  await writeFile(path.join(packageDir, 'cli.js'), '')
  const installedAt = Date.now()
  const record = { package: PACKAGE, version, node: null, npm: null, installedAt }
  await writeFile(path.join(dir, 'installed.json'), JSON.stringify(record))
  return { version, dir, entry: path.join(packageDir, 'cli.js'), installedAt }
}

/** A process that exits before it answers `initialize`, as a broken release does. */
function brokenRun(): LaunchedAgent {
  const exit: ExitInfo = { code: 1, signal: null }
  return {
    pid: null,
    startedAt: Date.now(),
    transport: {
      kind: 'messages',
      stream: { readable: new ReadableStream(), writable: new WritableStream() },
      close: () => {},
    },
    exited: Promise.resolve(exit),
    hasExited: true,
    stop: async () => exit,
    kill: async () => {},
  }
}

interface Setup {
  installed?: string[]
  ran?: string
  live?: string
  bundled?: string
  autoUpdate?: false
  broken?: string
}

async function manager(setup: Setup) {
  const root = await tempFolder('kettu-versions-')
  for (const version of setup.installed ?? []) await writeInstall(root, version)
  const installs: string[] = []
  const launches: (string | undefined)[] = []
  const statuses: AgentStatus[] = []
  let remembered: AgentUpdatesFile | null = null
  const base = inProcessLauncher(await loadFakeAgent())
  const settings: HostSettings = {
    locale: 'en',
    initialSetupDone: true,
    agents: {
      gemini: { enabled: true, ...(setup.autoUpdate === false ? { autoUpdate: false } : {}) },
    },
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
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
  }
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const agents = new AgentManager({
    catalog: [DEF],
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
        npmPath: '/kettu/npm',
        nodePath: '/kettu/node',
      }),
    }),
    diagnostics: new Diagnostics(),
    launcher: {
      launch: (def, spec, env, output) => {
        launches.push(spec.version)
        return spec.version === setup.broken ? brokenRun() : base.launch(def, spec, env, output)
      },
    },
    settings: () => settings,
    reportsDir: path.join(root, 'reports'),
    adaptersDir: root,
    bundled: parseBundled({
      registry: { agents: [...listing(setup.bundled ?? '1.0.0').values()] },
    }),
    fetchRegistry: async () => {
      if (!setup.live) throw new Error('offline')
      return listing(setup.live)
    },
    install: async (options: InstallOptions) => {
      installs.push(options.version)
      return writeInstall(root, options.version)
    },
    status: (status) => statuses.push(status),
    processes: () => {},
    authCommands: () => {},
    rememberUpdates: (file) => (remembered = file),
  })
  if (setup.ran) {
    agents.restoreUpdates({
      version: 1,
      agents: { gemini: { checkedAt: null, attemptedAt: null, latest: null, ran: setup.ran } },
    })
  }
  const status = (): AgentStatus => agents.status('gemini')
  /** Waits for what the background does, such as an automatic update, to show in the status. */
  const until = async (check: () => boolean): Promise<void> => {
    for (let tries = 0; !check(); tries++) {
      if (tries > 200) throw new Error('timed out')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  return {
    agents,
    installs,
    launches,
    status,
    until,
    remembered: () => remembered,
    /** Starts the agent and stops it again; resolves to the version it ran. */
    async start(): Promise<string | undefined> {
      await agents.ensureReady('gemini')
      const version = launches.at(-1)
      await agents.stop('gemini')
      return version
    },
  }
}

describe('the version of a harness that follows the registry', () => {
  it('installs the version the registry lists on first use', async () => {
    const m = await manager({ live: '1.1.0' })
    await m.agents.checkUpdates()
    expect(await m.start()).toBe('1.1.0')
    expect(m.installs).toEqual(['1.1.0'])
  })

  it('installs a newer version in the background, which the next start runs', async () => {
    const m = await manager({ installed: ['1.0.0'], ran: '1.0.0', live: '1.1.0' })
    await m.agents.checkUpdates()
    await m.until(() => m.status().package?.version === '1.1.0')
    expect(m.installs).toEqual(['1.1.0'])
    expect(m.status().automatic).toMatchObject({
      on: true,
      moved: { from: '1.0.0', to: '1.1.0', withdrawn: false },
    })
    expect(await m.start()).toBe('1.1.0')
  })

  it('goes back to the version the registry lists after a withdrawal, below the current one', async () => {
    const m = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      bundled: '1.1.0',
      live: '1.0.0',
    })
    await m.agents.checkUpdates()
    expect(m.status().automatic?.moved).toMatchObject({
      from: '1.1.0',
      to: '1.0.0',
      withdrawn: true,
    })
    expect(await m.start()).toBe('1.0.0')
    expect(m.installs).toEqual([])
  })

  it('with automatic updates off stays where it is and offers the target, a withdrawal too', async () => {
    const newer = await manager({
      installed: ['1.0.0'],
      ran: '1.0.0',
      live: '1.1.0',
      autoUpdate: false,
    })
    await newer.agents.checkUpdates()
    expect(newer.status().update).toEqual({ adapterVersion: '1.1.0', cliVersion: null })
    expect(newer.status().automatic).toMatchObject({ on: false, back: false })
    expect(newer.installs).toEqual([])
    expect(await newer.start()).toBe('1.0.0')

    const back = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      live: '1.0.0',
      autoUpdate: false,
    })
    await back.agents.checkUpdates()
    expect(back.status().automatic).toMatchObject({ on: false, back: true })
    await back.agents.update('gemini')
    expect(back.installs).toEqual([])
    expect(await back.start()).toBe('1.0.0')
  })

  it('falls back to the install before a new version that fails to start', async () => {
    const m = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.0.0',
      bundled: '1.1.0',
      live: '1.1.0',
      broken: '1.1.0',
    })
    expect(await m.start()).toBe('1.0.0')
    expect(m.launches).toEqual(['1.1.0', '1.0.0'])
    expect(m.status().failedVersion).toMatchObject({ version: '1.1.0', runs: '1.0.0' })
    expect(m.remembered()?.agents.gemini?.failed?.version).toBe('1.1.0')
    // The registry still listing it installs nothing, and the next start runs the one before.
    await m.agents.checkUpdates()
    expect(await m.start()).toBe('1.0.0')
    expect(m.installs).toEqual([])
  })
})
