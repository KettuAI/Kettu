import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { InstallOptions, InstalledAdapter } from './adapter-install'
import type { ArchiveInstallOptions, InstalledArchive } from './archive-install'
import type { ExitInfo } from './agent-process'
import { AgentManager, type LaunchedAgent } from './agents'
import { archiveKey } from './binary-install'
import type { AgentDefinition } from './catalog'
import { Diagnostics } from './diagnostics'
import type { SignedManifest } from './harness-manifest'
import { parseBundled } from './harness-versions'
import { parseRegistry, type RegistryAgents } from './registry'
import { EnvironmentService } from './shell-env'
import type { AgentUpdatesFile, HarnessManifestFile } from './storage'
import { inProcessLauncher, loadFakeAgent } from './testing/harness'
import { manifestDocument, manifestSigner } from './testing/manifest'
import { tempFolder } from './testing/temp'

const PACKAGE = '@google/gemini-cli'

const DEF: AgentDefinition = {
  id: 'gemini',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: PACKAGE, args: ['--acp'] },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}

/** The same package as a vendor's own, which the Registry does not list as Kettu installs it. */
const VENDOR: AgentDefinition = {
  ...DEF,
  launch: { kind: 'package', package: PACKAGE, args: ['--acp'], fromVendor: true },
}

const signer = manifestSigner()
const KETTU_VERSION = '0.1.9'

/** A signed manifest for the harness, at `sequence`, with one rule for every Kettu version. */
function manifest(sequence: number, rule: Record<string, unknown>): SignedManifest {
  return signer.sign(manifestDocument(sequence, { gemini: [{ kettu: '*', ...rule }] }))
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
  def?: AgentDefinition
  installed?: string[]
  ran?: string
  live?: string
  bundled?: string
  autoUpdate?: false
  broken?: string
  /** The manifest the download service sends, signed or not. */
  manifest?: unknown
  /** The manifest kept from an earlier run. */
  kept?: SignedManifest
  /** The manifest the build bundles. */
  bundledManifest?: SignedManifest
  /** Local mode or GitHub only: the download service is not asked. */
  noDownloads?: true
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
    workflow: DEFAULT_SETTINGS.workflow,
    usage: { fromComputer: false },
    sessionTitles: true,
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
    lightModel: { mode: 'small' },
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
    downloadService: !setup.noDownloads,
  }
  const def = setup.def ?? DEF
  const vendor = def.launch.kind === 'package' && !!def.launch.fromVendor
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  let manifestReads = 0
  let kept: HarnessManifestFile | null = null
  const agents = new AgentManager({
    catalog: [def],
    platform,
    nodeRuntime,
    appVersion: KETTU_VERSION,
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
      registry: vendor
        ? { agents: [] }
        : { agents: [...listing(setup.bundled ?? '1.0.0').values()] },
      ...(vendor ? { kettu: { gemini: { version: setup.bundled ?? '1.0.0' } } } : {}),
      ...(setup.bundledManifest ? { manifest: setup.bundledManifest } : {}),
    }),
    fetchRegistry: async () => {
      if (!setup.live) throw new Error('offline')
      return listing(setup.live)
    },
    manifestKeys: [signer.key],
    fetchManifest: async () => {
      manifestReads++
      if (setup.manifest === undefined) throw new Error('offline')
      return JSON.stringify(setup.manifest)
    },
    rememberManifest: (file) => (kept = file),
    // A vendor's package asks npm for its updates, which these tests leave unanswered.
    fetchLatest: async () => {
      throw new Error('offline')
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
  if (setup.kept) agents.restoreManifest({ version: 1, readAt: 1, ...setup.kept })
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
    manifestReads: () => manifestReads,
    kept: () => kept,
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
  it('installs the version the registry lists when the user installs it, which a start runs', async () => {
    const m = await manager({ live: '1.1.0' })
    await m.agents.checkUpdates()
    await m.agents.install('gemini')
    expect(m.installs).toEqual(['1.1.0'])
    expect(await m.start()).toBe('1.1.0')
    expect(m.installs).toEqual(['1.1.0'])
  })

  it('installs nothing when a session starts while no copy is installed, and says so', async () => {
    const m = await manager({ live: '1.1.0' })
    await m.agents.checkUpdates()
    await expect(m.agents.ensureReady('gemini')).rejects.toMatchObject({
      code: 'agent_unavailable',
      message: 'Gemini CLI is not installed.',
      data: { agentId: 'gemini', state: 'not-installed', reason: { kind: 'not-installed' } },
    })
    expect(m.installs).toEqual([])
    expect(m.launches).toEqual([])
    expect(m.status()).toMatchObject({ state: 'available', package: { installed: false } })
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

describe("the version Kettu's compatibility manifest gives", () => {
  it("moves a vendor's own package to the version it recommends, without a release", async () => {
    const m = await manager({
      def: VENDOR,
      installed: ['1.0.0'],
      ran: '1.0.0',
      live: '1.0.0',
      manifest: manifest(10, { recommended: '1.0.1' }),
    })
    expect(m.status().automatic).toBeNull()
    await m.agents.checkUpdates()
    await m.until(() => m.status().package?.version === '1.0.1')
    expect(m.installs).toEqual(['1.0.1'])
    expect(m.status().automatic).toMatchObject({
      on: true,
      follows: 'kettu',
      moved: { from: '1.0.0', to: '1.0.1', withdrawn: false, reason: 'manifest' },
    })
    expect(m.kept()?.payload).toBe(manifest(10, { recommended: '1.0.1' }).payload)
    expect(await m.start()).toBe('1.0.1')
  })

  it('switches a version it marks broken back on the next start, and says why', async () => {
    const m = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      bundled: '1.1.0',
      live: '1.1.0',
      manifest: manifest(10, { recommended: '1.0.0', broken: ['1.1.0'] }),
    })
    await m.agents.checkUpdates()
    expect(m.status().automatic?.moved).toMatchObject({
      from: '1.1.0',
      to: '1.0.0',
      withdrawn: true,
      reason: 'broken',
    })
    expect(await m.start()).toBe('1.0.0')
    expect(m.installs).toEqual([])
  })

  it('tells a withdrawal from the version withdrawn once its target is installed', async () => {
    const m = await manager({
      installed: ['1.0.0', '1.2.0'],
      ran: '1.2.0',
      bundled: '1.2.0',
      live: '1.2.0',
      manifest: manifest(10, { recommended: '1.1.0', broken: ['1.2.0'] }),
    })
    await m.agents.checkUpdates()
    await m.until(() => m.status().package?.version === '1.1.0')
    expect(m.installs).toEqual(['1.1.0'])
    expect(m.status().automatic?.moved).toMatchObject({
      from: '1.2.0',
      to: '1.1.0',
      withdrawn: true,
      reason: 'broken',
    })
    expect(await m.start()).toBe('1.1.0')
  })

  it('with automatic updates off offers the switch back, and says why', async () => {
    const m = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      bundled: '1.1.0',
      live: '1.1.0',
      autoUpdate: false,
      manifest: manifest(10, { recommended: '1.0.0', broken: ['>=1.1.0'] }),
    })
    await m.agents.checkUpdates()
    expect(m.status().automatic).toMatchObject({ on: false, back: true, backReason: 'broken' })
    expect(m.status().update).toEqual({ adapterVersion: '1.0.0', cliVersion: null })
  })

  it('ignores a manifest that is unsigned, signed by another key or older than the one kept', async () => {
    const stranger = manifestSigner()
    for (const sent of [
      manifestDocument(10, { gemini: [{ kettu: '*', broken: ['1.1.0'] }] }),
      stranger.sign(manifestDocument(10, { gemini: [{ kettu: '*', broken: ['1.1.0'] }] })),
    ]) {
      const m = await manager({
        installed: ['1.0.0', '1.1.0'],
        ran: '1.1.0',
        live: '1.1.0',
        manifest: sent,
      })
      await m.agents.checkUpdates()
      expect(m.manifestReads()).toBe(1)
      expect(m.kept()).toBeNull()
      expect(await m.start()).toBe('1.1.0')
    }
    const older = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      live: '1.1.0',
      kept: manifest(20, {}),
      manifest: manifest(19, { broken: ['1.1.0'] }),
    })
    await older.agents.checkUpdates()
    expect(older.kept()).toBeNull()
    expect(await older.start()).toBe('1.1.0')
  })

  it('asks the download service nothing in Local mode or with GitHub only', async () => {
    const m = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      live: '1.1.0',
      noDownloads: true,
      kept: manifest(20, { broken: ['1.1.0'] }),
      manifest: manifest(21, { broken: ['1.1.0'] }),
      bundledManifest: manifest(5, {}),
    })
    await m.agents.checkUpdates()
    expect(m.manifestReads()).toBe(0)
    // Only the bundled manifest is in force, so the kept one withdraws nothing.
    expect(await m.start()).toBe('1.1.0')
  })

  it('records why a start went back for the bundled versions or the kept manifest', async () => {
    const bundled = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      bundled: '1.0.0',
    })
    await bundled.agents.detectAll()
    expect(bundled.status().automatic?.moved).toMatchObject({
      from: '1.1.0',
      to: '1.0.0',
      withdrawn: true,
      reason: 'bundled',
    })
    expect(bundled.remembered()?.agents.gemini?.moved?.reason).toBe('bundled')

    const kept = await manager({
      installed: ['1.0.0', '1.1.0'],
      ran: '1.1.0',
      bundled: '1.1.0',
      bundledManifest: manifest(5, { broken: ['1.1.0'], recommended: '1.0.0' }),
    })
    await kept.agents.detectAll()
    expect(kept.status().automatic?.moved).toMatchObject({
      from: '1.1.0',
      to: '1.0.0',
      reason: 'broken',
    })
    expect(await kept.start()).toBe('1.0.0')
  })
})

const ARCHIVE_DEF: AgentDefinition = {
  id: 'cursor',
  name: 'Cursor',
  registryId: 'cursor',
  launch: { kind: 'binary', command: 'cursor-agent', args: ['acp'] },
  install: { hint: 'detect.hint.cursor', url: 'https://cursor.com/docs/cli/acp' },
  installs: { archive: {} },
}

const ARCHIVE_PROGRAM = '#!/bin/sh\nexit 0\n'

/** The registry's listing of the archive at `version`, which gives no SHA-256 for it. */
function unhashedListing(version: string): RegistryAgents {
  const binary = {
    [archiveKey(process.platform === 'win32' ? 'win32' : process.platform, process.arch)]: {
      archive: `https://downloads.example.com/cursor-${version}.tar.gz`,
      cmd: './cursor-agent',
      args: ['acp'],
    },
  }
  return parseRegistry({ agents: [{ id: 'cursor', version, distribution: { binary } }] })!
}

/** An archive install as Kettu records it, written straight to disk. */
async function writeArchive(root: string, version: string): Promise<InstalledArchive> {
  const dir = path.join(root, 'cursor', version)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'cursor-agent'), ARCHIVE_PROGRAM, { mode: 0o755 })
  const record = {
    version,
    url: `https://downloads.example.com/cursor-${version}.tar.gz`,
    sha256: 'ab'.repeat(32),
    cmd: './cursor-agent',
    args: ['acp'],
    installedAt: Date.now(),
  }
  await writeFile(path.join(dir, 'installed.json'), JSON.stringify(record))
  return { ...record, dir }
}

/** A harness installed from a registry archive at 1.0.0, whose registry lists `live` unhashed. */
async function archiveManager(live: string) {
  const root = await tempFolder('kettu-archive-versions-')
  await writeArchive(root, '1.0.0')
  const downloads: ArchiveInstallOptions[] = []
  const diagnostics = new Diagnostics()
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const settings: HostSettings = {
    ...DEFAULT_SETTINGS,
    locale: 'en',
    initialSetupDone: true,
    agents: { cursor: { enabled: true } },
    addedAgents: [],
    disabledAgents: [],
    usage: { fromComputer: false },
    sessionTitles: true,
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
    lightModel: { mode: 'small' },
    defaultAgent: null,
    downloadService: false,
  }
  const agents = new AgentManager({
    catalog: [ARCHIVE_DEF],
    platform,
    nodeRuntime,
    appVersion: KETTU_VERSION,
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
    diagnostics,
    launcher: inProcessLauncher(await loadFakeAgent()),
    settings: () => settings,
    reportsDir: path.join(root, 'reports'),
    adaptersDir: root,
    bundled: parseBundled({ registry: { agents: [...unhashedListing('1.0.0').values()] } }),
    fetchRegistry: async () => unhashedListing(live),
    manifestKeys: [signer.key],
    fetchManifest: async () => {
      throw new Error('offline')
    },
    installArchive: async (options) => {
      downloads.push(options)
      const installed = await writeArchive(root, options.version)
      return { ...installed, sha256: 'cd'.repeat(32) }
    },
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  agents.restoreUpdates({
    version: 1,
    agents: { cursor: { checkedAt: null, attemptedAt: null, latest: null, ran: '1.0.0' } },
  })
  return { agents, downloads, diagnostics, status: () => agents.status('cursor') }
}

describe('an archive the registry gives no SHA-256 for', () => {
  it('is not installed by automatic updates, which say so and offer it by hand', async () => {
    const m = await archiveManager('1.1.0')
    await m.agents.checkUpdates()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(m.downloads).toEqual([])
    expect(m.status().release?.version).toBe('1.0.0')
    expect(m.status().automatic).toMatchObject({ on: true, noChecksum: true })
    expect(m.status().update).toEqual({ adapterVersion: '1.1.0', cliVersion: null })
  })

  it('installs by hand as a first install does, logging the hash it measured', async () => {
    const m = await archiveManager('1.1.0')
    await m.agents.checkUpdates()
    await m.agents.update('cursor')
    expect(m.downloads.map((d) => [d.version, d.sha256])).toEqual([['1.1.0', undefined]])
    expect(m.status().release?.version).toBe('1.1.0')
    expect(m.status().update).toBeNull()
    const warning = m.diagnostics
      .logEntries()
      .find((entry) => entry.level === 'warn' && entry.message.includes('cd'.repeat(32)))
    expect(warning?.message).toContain('cursor-1.1.0.tar.gz')
  })
})
