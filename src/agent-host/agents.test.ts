// The agent lifecycle with the fake agent in-process: start, timeouts, restarts, idle stop.

import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AgentStatus, AgentUpdate } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import {
  compareInstalls,
  type InstalledAdapter,
  type InstallOptions,
  type ProgramOptions,
  type ProgramRun,
} from './adapter-install'
import {
  AgentManager,
  type AgentLauncher,
  type AgentManagerDeps,
  type AgentTimings,
} from './agents'
import {
  CLAUDE_CODE,
  detectAgent,
  fakeAgent,
  OPENCODE,
  type AgentDefinition,
  type DetectContext,
  type LaunchSpec,
} from './catalog'
import { Diagnostics } from './diagnostics'
import type { Env } from './find-command'
import { CliVersions, type AdapterCli } from './installed-cli'
import { EnvironmentService } from './shell-env'
import { TextRing } from './ring'
import type { AgentsFile, AgentUpdatesFile } from './storage'
import {
  FAKE_AGENT_MAIN,
  inProcessLauncher,
  loadFakeAgent,
  type FakeAgentModule,
} from './testing/harness'

let module: FakeAgentModule

beforeAll(async () => {
  module = await loadFakeAgent()
})

function manager(
  env: Env = {},
  timings: Partial<AgentTimings> = {},
  extra: Partial<
    Pick<
      AgentManagerDeps,
      | 'catalog'
      | 'detect'
      | 'install'
      | 'adaptersDir'
      | 'remember'
      | 'env'
      | 'fetchLatest'
      | 'runProgram'
      | 'rememberUpdates'
      | 'launcher'
      | 'probeCli'
      | 'cliVersions'
    >
  > = {},
) {
  const launcher = inProcessLauncher(module, env)
  const statuses: AgentStatus[] = []
  const diagnostics = new Diagnostics()
  let live = 0
  const environment = new EnvironmentService({
    platform: process.platform,
    electronPath: process.execPath,
    baseEnv: process.env,
    resolve: async ({ baseEnv }) => ({
      env: baseEnv,
      source: 'inherited',
      shell: null,
      durationMs: 0,
      warning: null,
    }),
    probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
  })
  const agents = new AgentManager({
    catalog: [fakeAgent(FAKE_AGENT_MAIN)],
    platform: process.platform,
    electronPath: process.execPath,
    appVersion: '0.0.0-test',
    env: environment,
    diagnostics,
    launcher,
    settings: () => ({
      locale: 'en',
      agents: {},
      proxy: { mode: 'environment' },
      git: { backgroundFetch: false },
      usage: { fromComputer: false },
    }),
    reportsDir: path.join(os.tmpdir(), 'overbench-agent-reports'),
    adaptersDir: path.join(os.tmpdir(), 'overbench-no-adapters'),
    detect: detectAgent,
    // The tests never ask the machine's own claude or codex.
    ...(extra.cliVersions ? {} : { probeCli: async () => ({ error: 'not asked in tests' }) }),
    ...extra,
    timings,
    status: (status) => statuses.push(status),
    processes: () => {},
    authCommands: () => {},
  })
  agents.hooks = {
    liveSessions: () => live,
    agentExited: () => {},
    signedIn: () => {},
    optionsKnown: () => true,
    optionsSeen: () => {},
  }
  return {
    agents,
    launcher,
    statuses,
    diagnostics,
    setLive: (n: number) => {
      live = n
      agents.sessionsChanged('fake-agent')
    },
    state: () => agents.status('fake-agent').state,
  }
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${check.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('AgentManager', () => {
  it('starts lazily, once, however many callers wait', async () => {
    const m = manager()
    expect(await m.agents.list()).toMatchObject([{ id: 'fake-agent', state: 'available' }])
    expect(m.launcher.launches).toBe(0)
    const [a, b] = await Promise.all([
      m.agents.ensureReady('fake-agent'),
      m.agents.ensureReady('fake-agent'),
    ])
    expect(a).toBe(b)
    expect(m.launcher.launches).toBe(1)
    expect(m.state()).toBe('ready')
    expect(m.statuses.map((s) => s.state)).toEqual(
      expect.arrayContaining(['available', 'starting', 'ready']),
    )
    await m.agents.stopAll()
    expect(m.state()).toBe('available')
  })

  it('shows stderr as progress while starting, and times out initialize', async () => {
    const m = manager(
      { FAKE_AGENT_SLOW_START_MS: '400', FAKE_AGENT_DELAY_SCALE: '1' },
      { initializeMs: 150, progressMs: 10 },
    )
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      code: 'agent_unavailable',
      message: expect.stringContaining('did not answer initialize within 0.15 s'),
    })
    expect(m.state()).toBe('failed')
    const progress = m.statuses.flatMap((s) => s.progress)
    expect(progress.some((line) => line.includes('downloading the adapter'))).toBe(true)
    // A failed agent stays failed until the user retries.
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
    expect(m.launcher.launches).toBe(1)
  })

  it('does not restart a crashed agent, and gives up after five crashes', async () => {
    const m = manager()
    m.setLive(1)
    await m.agents.ensureReady('fake-agent')
    m.launcher.crash(7)
    await until(() => m.state() === 'available')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(m.launcher.launches).toBe(1)
    expect(m.agents.status('fake-agent').detail).toBeNull()
    // The next session that needs it starts it again.
    for (let crash = 2; crash <= 5; crash++) {
      await m.agents.ensureReady('fake-agent')
      expect(m.launcher.launches).toBe(crash)
      m.launcher.crash(7)
      await until(() => m.state() !== 'ready')
    }
    expect(m.state()).toBe('failed')
    expect(m.agents.status('fake-agent').detail).toContain('five minutes')
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      code: 'agent_unavailable',
    })

    await m.agents.retry('fake-agent')
    expect(m.state()).toBe('ready')
    expect(m.launcher.launches).toBe(6)
    await m.agents.stopAll()
  })

  it('stops an agent after it has been idle', async () => {
    const m = manager({}, { idleMs: 40 })
    m.setLive(1)
    await m.agents.ensureReady('fake-agent')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(m.state()).toBe('ready')
    m.setLive(0)
    await until(() => m.state() === 'available')
    expect(m.launcher.launches).toBe(1)
  })

  it('stops an agent started ahead of a session that never came', async () => {
    const m = manager({}, { idleMs: 40 })
    await m.agents.ensureReady('fake-agent')
    expect(m.state()).toBe('ready')
    await until(() => m.state() === 'available')
    expect(m.launcher.launches).toBe(1)
  })

  it('reports terminal sign-in methods as a quoted command', async () => {
    const m = manager()
    await m.agents.ensureReady('fake-agent')
    const terminal = m.agents
      .status('fake-agent')
      .authMethods.find((method) => method.type === 'terminal')
    expect(terminal?.command).toContain('ELECTRON_RUN_AS_NODE=1')
    // Quoted with single quotes on POSIX and double quotes for cmd.exe, when a path needs it.
    expect(terminal?.command).toMatch(/main\.ts["']? --login$/)
    await m.agents.stopAll()
  })

  it('keeps the known use of a window when an event for its period has none', () => {
    const m = manager()
    const window = (usedPercent: number | null, resetsAt: number) => ({
      window: 'five_hour',
      label: '5-hour',
      usedPercent,
      resetsAt,
      state: 'ok' as const,
      observedAt: 1,
    })
    const used = () => m.agents.status('fake-agent').limits[0]?.usedPercent
    m.agents.setLimit('fake-agent', window(54, 1_800_000_000_000))
    // `/usage` prints the reset to the minute, the events to the second.
    m.agents.setLimit('fake-agent', window(null, 1_800_000_030_000))
    expect(used()).toBe(54)
    m.agents.setLimit('fake-agent', window(null, 1_800_018_000_000))
    expect(used()).toBeNull()
  })

  it("reads Codex's plan limits from /status", async () => {
    const m = manager(
      {},
      {},
      { catalog: [{ ...fakeAgent(FAKE_AGENT_MAIN), id: 'codex', name: 'Codex' }] },
    )
    expect(m.agents.status('codex').capabilities.reports).toBe(true)
    await m.agents.refreshLimits('codex')
    expect(m.agents.status('codex').limits).toEqual([
      expect.objectContaining({ window: 'five_hour', label: '5-hour', usedPercent: 19 }),
      expect.objectContaining({ window: 'seven_day', label: 'Weekly', usedPercent: 32 }),
    ])
    await m.agents.stopAll()
  })

  it('opens no hidden session in an agent that lacks the request that removes it', async () => {
    const m = manager(
      { FAKE_AGENT_WITHOUT: 'close' },
      {},
      { catalog: [{ ...fakeAgent(FAKE_AGENT_MAIN), id: 'codex', name: 'Codex' }] },
    )
    const seen: AgentId[] = []
    m.agents.hooks = {
      ...m.agents.hooks,
      optionsKnown: () => false,
      optionsSeen: (agentId) => seen.push(agentId),
    }
    const runtime = await m.agents.ensureReady('codex')
    await m.agents.readOptions('codex')
    await m.agents.refreshLimits('codex')
    const sent = m.diagnostics
      .agentRecords('codex')
      .traffic.filter((r) => r.direction === 'out')
      .map((r) => r.method)
    expect(seen).toEqual([])
    expect(sent).not.toContain('session/new')
    const listed = await runtime.connection.listSessions(
      path.join(os.tmpdir(), 'overbench-agent-reports'),
      null,
    )
    expect(listed.sessions.filter((s) => s.acpSessionId.startsWith('fake-'))).toEqual([])
    await m.agents.stopAll()
  })

  it('gives up on options that do not come in time, and removes the session when it answers', async () => {
    const m = manager({ FAKE_AGENT_NEW_SESSION_MS: '300' }, { optionsMs: 20 })
    const seen: AgentId[] = []
    m.agents.hooks = {
      ...m.agents.hooks,
      optionsKnown: () => false,
      optionsSeen: (agentId) => seen.push(agentId),
    }
    await m.agents.ensureReady('fake-agent')
    const sent = () =>
      m.diagnostics
        .agentRecords('fake-agent')
        .traffic.filter((r) => r.direction === 'out')
        .map((r) => r.method)
    await m.agents.readOptions('fake-agent')
    // Resolved before the answer came, so its session is not removed yet.
    expect(sent()).toContain('session/new')
    expect(sent()).not.toContain('session/delete')
    await until(() => sent().includes('session/delete'))
    expect(seen).toEqual([])
    // A failed read is not tried again until the agent restarts.
    await m.agents.readOptions('fake-agent')
    expect(sent().filter((method) => method === 'session/new')).toHaveLength(1)
    await m.agents.stopAll()
  })

  it('stops the agent without waiting for a hidden session/new that has not answered', async () => {
    const m = manager({ FAKE_AGENT_NEW_SESSION_MS: '5000' }, { optionsMs: 10_000 })
    m.agents.hooks = { ...m.agents.hooks, optionsKnown: () => false }
    await m.agents.ensureReady('fake-agent')
    const read = m.agents.readOptions('fake-agent')
    const sent = () =>
      m.diagnostics
        .agentRecords('fake-agent')
        .traffic.filter((r) => r.direction === 'out')
        .map((r) => r.method)
    await until(() => sent().includes('session/new'))
    const stopping = m.agents.stop('fake-agent')
    // Waiting for the answer would keep it ready for 5 s.
    await until(() => m.state() !== 'ready', 2_000)
    await stopping
    await read
    expect(m.state()).toBe('available')
  })

  it('closes a hidden Codex session rather than delete it, which would archive it', async () => {
    const m = manager(
      {},
      {},
      { catalog: [{ ...fakeAgent(FAKE_AGENT_MAIN), id: 'codex', name: 'Codex' }] },
    )
    const seen: AgentId[] = []
    m.agents.hooks = {
      ...m.agents.hooks,
      optionsKnown: () => seen.length > 0,
      optionsSeen: (agentId) => seen.push(agentId),
    }
    await m.agents.ensureReady('codex')
    await m.agents.readOptions('codex')
    await m.agents.readOptions('codex')
    await m.agents.refreshLimits('codex')
    const sent = m.diagnostics
      .agentRecords('codex')
      .traffic.filter((r) => r.direction === 'out')
      .map((r) => r.method)
    // Read once when the agent starts; the limits report records them only while none are known.
    expect(seen).toEqual(['codex'])
    expect(sent.filter((method) => method === 'session/new')).toHaveLength(2)
    expect(sent.filter((method) => method === 'session/close')).toHaveLength(2)
    expect(sent).not.toContain('session/delete')
    await m.agents.stopAll()
  })
})

/** The fake agent as a package agent, with installs that only record what they were asked. */
function packageManager(installedVersions: string[], adaptersDir?: string) {
  const def: AgentDefinition = {
    ...fakeAgent(FAKE_AGENT_MAIN),
    launch: { kind: 'package', package: 'fake-adapter', version: '2.0.0' },
  }
  const versions = [...installedVersions]
  const adapterAt = (version: string): InstalledAdapter => ({
    version,
    dir: adaptersDir ? path.join(adaptersDir, 'fake-agent', version) : `/a/${version}`,
    entry: `/a/${version}/index.js`,
    installedAt: 1,
  })
  const installs: InstallOptions[] = []
  let installImpl: (options: InstallOptions) => Promise<void> = async () => {}
  const m = manager(
    {},
    { progressMs: 1 },
    {
      catalog: [def],
      ...(adaptersDir ? { adaptersDir } : {}),
      detect: (d, ctx) =>
        detectAgent(d, {
          ...ctx,
          node: { nodeVersion: 'v24.1.0', npmPath: '/x/npm', nodePath: '/x/node' },
          installed: async () =>
            versions.toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true })).map(adapterAt),
        }),
      install: async (options) => {
        installs.push(options)
        await installImpl(options)
        versions.push(options.version)
        return adapterAt(options.version)
      },
    },
  )
  return {
    ...m,
    installs,
    versions,
    onInstall: (impl: (options: InstallOptions) => Promise<void>) => (installImpl = impl),
    status: () => m.agents.status('fake-agent'),
  }
}

describe('AgentManager with an installed adapter', () => {
  it('installs the pinned version before its first start, once for every caller', async () => {
    const m = packageManager([])
    let release!: () => void
    m.onInstall(async (options) => {
      options.onOutput?.('npm http fetch GET 200 https://registry.npmjs.org/fake-adapter\n')
      await new Promise<void>((resolve) => (release = resolve))
    })
    expect((await m.agents.list())[0]?.package).toEqual({
      name: 'fake-adapter',
      version: '2.0.0',
      installed: false,
    })
    const starts = Promise.all([
      m.agents.ensureReady('fake-agent'),
      m.agents.ensureReady('fake-agent'),
    ])
    await until(() => m.status().progress.some((line) => line.includes('fetch')))
    expect(m.state()).toBe('installing')
    release()
    const [a, b] = await starts
    expect(a).toBe(b)
    expect(m.installs.map((i) => [i.version, i.npm])).toEqual([['2.0.0', '/x/npm']])
    expect(m.launcher.launches).toBe(1)
    expect(m.status()).toMatchObject({
      state: 'ready',
      package: { installed: true },
      launchCommand: expect.stringContaining('/a/2.0.0/index.js'),
    })
    await m.agents.stopAll()
  })

  it('runs an older installed version when the install fails, and says so', async () => {
    const m = packageManager(['1.0.0'])
    m.onInstall(async () => {
      throw new Error('npm exited with code 1. npm error code ENOTFOUND')
    })
    await m.agents.ensureReady('fake-agent')
    expect(m.status()).toMatchObject({
      state: 'ready',
      detail:
        'Running 1.0.0: 2.0.0 could not be installed. npm exited with code 1. npm error code ENOTFOUND',
      launchCommand: expect.stringContaining('/a/1.0.0/index.js'),
    })
    await m.agents.stopAll()
  })

  it('fails without an older version, and installs again after Retry', async () => {
    const m = packageManager([])
    m.onInstall(async () => {
      throw new Error('npm exited with code 1. npm error code E404')
    })
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      code: 'agent_unavailable',
      message: 'Fake agent could not be installed. npm exited with code 1. npm error code E404',
    })
    expect(m.state()).toBe('failed')
    m.onInstall(async () => {})
    await m.agents.retry('fake-agent')
    await m.agents.ensureReady('fake-agent')
    expect(m.installs).toHaveLength(2)
    expect(m.state()).toBe('ready')
    await m.agents.stopAll()
  })

  it('deletes the versions the pinned one replaced once it runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-adapters-'))
    await mkdir(path.join(dir, 'fake-agent', '1.0.0'), { recursive: true })
    await mkdir(path.join(dir, 'fake-agent', '2.0.0'))
    const m = packageManager(['1.0.0', '2.0.0'], dir)
    await m.agents.ensureReady('fake-agent')
    await until(() => m.agents.status('fake-agent').state === 'ready')
    let left: string[] = []
    await until(() => {
      void readdir(path.join(dir, 'fake-agent')).then((names) => (left = names))
      return left.length === 1
    })
    expect(left).toEqual(['2.0.0'])
    expect(m.installs).toHaveLength(0)
    await m.agents.stopAll()
  })

  it('reinstalls only while no session uses the agent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-adapters-'))
    await mkdir(path.join(dir, 'fake-agent', '2.0.0'), { recursive: true })
    const m = packageManager(['2.0.0'], dir)
    m.setLive(1)
    await expect(m.agents.reinstall('fake-agent')).rejects.toMatchObject({ code: 'busy' })
    m.setLive(0)
    await m.agents.ensureReady('fake-agent')
    m.versions.length = 0
    await m.agents.reinstall('fake-agent')
    expect(await readdir(path.join(dir, 'fake-agent'))).toEqual([])
    expect(m.installs.map((i) => i.version)).toEqual(['2.0.0'])
    expect(m.status()).toMatchObject({ state: 'available', package: { installed: true } })
  })

  it('holds a start that comes during a reinstall until the new install runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-adapters-'))
    await mkdir(path.join(dir, 'fake-agent', '2.0.0'), { recursive: true })
    const m = packageManager(['2.0.0'], dir)
    const before = await m.agents.ensureReady('fake-agent')
    m.versions.length = 0
    const reinstall = m.agents.reinstall('fake-agent')
    const after = await m.agents.ensureReady('fake-agent')
    await reinstall
    expect(after).not.toBe(before)
    expect(m.installs).toHaveLength(1)
    expect(m.launcher.launches).toBe(2)
    expect(m.state()).toBe('ready')
    await m.agents.stopAll()
  })

  it('stops a running install when the agent stops', async () => {
    const m = packageManager([])
    m.onInstall(
      (options) =>
        new Promise((_, reject) =>
          options.signal?.addEventListener('abort', () =>
            reject(new Error('The install was stopped.')),
          ),
        ),
    )
    const start = m.agents.ensureReady('fake-agent')
    await until(() => m.state() === 'installing')
    await m.agents.stopAll()
    await expect(start).rejects.toMatchObject({
      message: 'Fake agent could not be installed. The install was stopped.',
    })
    expect(m.launcher.launches).toBe(0)
  })
})

/** A CLI the user installed on PATH, which an adapter runs from version 1.0.0 on. */
const FAKE_CLI: AdapterCli = {
  command: 'fake-cli',
  variable: 'FAKE_CLI_PATH',
  startsAtInitialize: true,
  resolve: async (found) => ({ path: found, env: {} }),
  minimum: async () => '1.0.0',
}

function cliFound(version: string): Partial<DetectContext> {
  return {
    env: { PATH: path.resolve('/bin') },
    isExecutable: async (file) => /fake-cli(\.exe)?$/.test(file),
    probeCli: async () => ({ version }),
  }
}

/** The fake agent as a package agent whose adapter can run FAKE_CLI; installs stay in memory. */
function cliManager(
  options: {
    installed?: InstalledAdapter[]
    cli?: string
    minimum?: string
    /** The adapter exits with code 1 before it initializes when it runs the installed CLI. */
    failWithCli?: boolean
    /** It exits with code 2 when it runs its own copy. */
    failCopy?: boolean
    /** The host is stopped while the start with the installed CLI fails. */
    stopOnCliFailure?: boolean
    startsAtInitialize?: boolean
    /** Asks versions through the manager's own cache, with this one's stubbed runs. */
    cliVersions?: CliVersions
  } = {},
) {
  const def: AgentDefinition = {
    ...fakeAgent(FAKE_AGENT_MAIN),
    launch: { kind: 'package', package: 'fake-adapter', version: '2.0.0' },
    cli: {
      ...FAKE_CLI,
      startsAtInitialize: options.startsAtInitialize ?? true,
      minimum: async () => options.minimum ?? '1.0.0',
    },
  }
  const adapters = [...(options.installed ?? [])]
  const installs: InstallOptions[] = []
  const launches: LaunchSpec[] = []
  const base = inProcessLauncher(module)
  const launcher: AgentLauncher = {
    launch: (d, spec, env, output) => {
      launches.push(spec)
      const launched = base.launch(d, spec, env, output)
      const withCli = spec.env.FAKE_CLI_PATH !== undefined
      if (withCli ? !options.failWithCli : !options.failCopy) return launched
      if (withCli && options.stopOnCliFailure) void m.agents.stopAll()
      return {
        pid: null,
        startedAt: launched.startedAt,
        transport: launched.transport,
        exited: Promise.resolve({ code: withCli ? 1 : 2, signal: null }),
        hasExited: true,
        stop: () => launched.stop(),
      }
    },
  }
  const m = manager(
    {},
    { progressMs: 1 },
    {
      catalog: [def],
      launcher,
      ...(options.cliVersions ? { cliVersions: options.cliVersions } : {}),
      detect: (d, ctx) =>
        detectAgent(d, {
          ...ctx,
          node: { nodeVersion: 'v24.1.0', npmPath: '/x/npm', nodePath: '/x/node' },
          installed: async () => adapters.toSorted((a, b) => compareInstalls(b, a)),
          ...cliFound(options.cli ?? '2.0.0'),
          ...(options.cliVersions && ctx.probeCli ? { probeCli: ctx.probeCli } : {}),
        }),
      install: async (request) => {
        installs.push(request)
        const install: InstalledAdapter = {
          version: request.version,
          dir: `/a/${request.version}~${installs.length}`,
          entry: `/a/${request.version}/index.js`,
          installedAt: installs.length + 1,
        }
        adapters.push(install)
        return install
      },
    },
  )
  return { ...m, installs, launches, status: () => m.agents.status('fake-agent') }
}

describe('the CLI the user installed', () => {
  const installedAt = (version: string) => ({
    version,
    dir: `/a/${version}`,
    entry: `/a/${version}/index.js`,
    installedAt: 1,
  })

  it('runs the installed CLI when it is new enough', async () => {
    const m = cliManager({ installed: [installedAt('2.0.0')] })
    await m.agents.ensureReady('fake-agent')
    expect(m.installs).toEqual([])
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH)).toEqual([
      expect.stringContaining('fake-cli'),
    ])
    expect(m.status()).toMatchObject({
      state: 'ready',
      cli: {
        command: 'fake-cli',
        runs: 'installed',
        installed: { version: '2.0.0', problem: null },
      },
    })
    await m.agents.stopAll()
  })

  it('runs the copy when the CLI is older than the adapter needs', async () => {
    const m = cliManager({ installed: [installedAt('2.0.0')], minimum: '3.0.0' })
    await m.agents.ensureReady('fake-agent')
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH)).toEqual([undefined])
    expect(m.status()).toMatchObject({
      state: 'ready',
      cli: { runs: 'bundled', installed: { problem: { kind: 'too-old', minimum: '3.0.0' } } },
    })
    await m.agents.stopAll()
  })

  it('runs the copy when a start with the installed CLI fails, and keeps to it', async () => {
    const m = cliManager({ installed: [installedAt('2.0.0')], failWithCli: true })
    await m.agents.ensureReady('fake-agent')
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH !== undefined)).toEqual([true, false])
    expect(m.installs).toEqual([])
    expect(m.status()).toMatchObject({
      state: 'ready',
      detail: null,
      cli: {
        runs: 'bundled',
        installed: { problem: { kind: 'failed', reason: expect.any(String) } },
      },
    })
    await m.agents.stopAll()
    await m.agents.ensureReady('fake-agent')
    expect(m.launches.at(-1)?.env.FAKE_CLI_PATH).toBeUndefined()
    await m.agents.stopAll()
  })

  it('asks a program that hangs once per environment, not at every detection', async () => {
    let runs = 0
    const cliVersions = new CliVersions({
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      run: async () => {
        runs++
        return {
          code: null,
          signal: null,
          timedOut: true,
          aborted: false,
          output: new TextRing(64),
          stdout: '',
        }
      },
      stat: async () => ({ size: 1, mtimeMs: 1 }),
    })
    const m = cliManager({ installed: [installedAt('2.0.0')], cliVersions })
    await m.agents.check()
    expect(runs).toBe(2)
    expect(m.status().cli).toMatchObject({
      runs: 'bundled',
      installed: { problem: { kind: 'failed' } },
    })
    await m.agents.check()
    expect(runs).toBe(2)
    await m.agents.reloadEnvironment()
    expect(runs).toBe(4)
  })

  it('tries the copy once, and surfaces its own error when it fails too', async () => {
    const m = cliManager({ installed: [installedAt('2.0.0')], failWithCli: true, failCopy: true })
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      message: expect.stringContaining('exited with code 2'),
    })
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH !== undefined)).toEqual([true, false])
    expect(m.status()).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('exited with code 2'),
    })
    await m.agents.stopAll()
  })

  it('leaves the CLI alone when the adapter failed before it ran it', async () => {
    const m = cliManager({
      installed: [installedAt('2.0.0')],
      failWithCli: true,
      startsAtInitialize: false,
    })
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      message: expect.stringContaining('exited with code 1'),
    })
    expect(m.launches).toHaveLength(1)
    expect(m.status()).toMatchObject({
      state: 'failed',
      cli: { runs: 'installed', installed: { problem: null } },
    })
    await m.agents.stopAll()
  })

  it('does not start the copy while the host stops', async () => {
    const m = cliManager({
      installed: [installedAt('2.0.0')],
      failWithCli: true,
      stopOnCliFailure: true,
    })
    await expect(m.agents.ensureReady('fake-agent')).rejects.toBeDefined()
    expect(m.launches).toHaveLength(1)
    await m.agents.stopAll()
  })

  it('installs the adapter, then runs the installed CLI', async () => {
    const m = cliManager()
    await m.agents.ensureReady('fake-agent')
    expect(m.installs.map((i) => i.version)).toEqual(['2.0.0'])
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH)).toEqual([
      expect.stringContaining('fake-cli'),
    ])
    expect(m.status()).toMatchObject({ state: 'ready', cli: { runs: 'installed' } })
    await m.agents.stopAll()
  })
})

describe('details', () => {
  it('reads the pinned adapter and the environment the agents see', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-adapters-'))
    const sdk = path.join(
      dir,
      'claude-code',
      '1.2.3',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
    )
    await mkdir(sdk, { recursive: true })
    await writeFile(
      path.join(sdk, 'package.json'),
      JSON.stringify({ claudeCodeVersion: '2.1.303' }),
    )
    const def: AgentDefinition = {
      ...CLAUDE_CODE,
      launch: { kind: 'package', package: 'adapter', version: '1.2.3' },
    }
    const m = manager({}, {}, { catalog: [def], adaptersDir: dir })
    const configDir = path.join(dir, 'claude-config')
    const before = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      expect(await m.agents.details('claude-code')).toEqual({
        cliVersion: '2.1.303',
        config: [
          { id: 'folder', path: configDir, exists: false, env: 'CLAUDE_CONFIG_DIR' },
          { id: 'settings', path: path.join(configDir, 'settings.json'), exists: false, env: null },
          { id: 'instructions', path: path.join(configDir, 'CLAUDE.md'), exists: false, env: null },
        ],
      })
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = before
    }
  })

  it('reads the CLI of the fallback adapter while the pinned one is not installed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-adapters-'))
    const sdk = path.join(
      dir,
      'claude-code',
      '1.0.0',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
    )
    await mkdir(sdk, { recursive: true })
    await writeFile(
      path.join(sdk, 'package.json'),
      JSON.stringify({ claudeCodeVersion: '2.1.200' }),
    )
    const def: AgentDefinition = {
      ...CLAUDE_CODE,
      launch: { kind: 'package', package: 'adapter', version: '1.2.3' },
    }
    const m = manager(
      {},
      {},
      {
        catalog: [def],
        adaptersDir: dir,
        detect: (d, ctx) =>
          detectAgent(d, {
            ...ctx,
            node: { nodeVersion: 'v24.1.0', npmPath: '/x/npm', nodePath: '/x/node' },
            installed: async () => [
              {
                version: '1.0.0',
                dir: path.join(dir, 'claude-code', '1.0.0'),
                entry: '/a/index.js',
                installedAt: 1,
              },
            ],
          }),
      },
    )
    expect((await m.agents.details('claude-code')).cliVersion).toBe('2.1.200')
  })

  it('has no CLI version or configuration to show for the fake agent, and refuses unknown agents', async () => {
    const m = manager()
    expect(await m.agents.details('fake-agent')).toEqual({ cliVersion: null, config: [] })
    await expect(m.agents.details('gemini' as AgentId)).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})

describe('remembered accounts', () => {
  const account = { kind: 'account' as const, label: 'Fake Pro', email: 'developer@example.com' }
  const limit = {
    window: 'five_hour',
    label: '5-hour',
    usedPercent: 42,
    resetsAt: 1_000,
    state: 'ok' as const,
    observedAt: 500,
  }

  it('shows what an earlier run reported without starting the agent or claiming a sign-in', async () => {
    const saved: AgentsFile[] = []
    const m = manager({}, {}, { remember: (file) => saved.push(file) })
    m.agents.restore({ version: 1, agents: { 'fake-agent': { account, limits: [limit] } } })
    expect(m.agents.status('fake-agent')).toMatchObject({
      account,
      limits: [limit],
      signIn: 'unknown',
      state: 'available',
    })
    expect(m.launcher.launches).toBe(0)
    expect(saved).toEqual([])
  })

  it('remembers the account an agent reports, and forgets it on sign-out', async () => {
    const saved: AgentsFile[] = []
    const m = manager({}, {}, { remember: (file) => saved.push(file) })
    await m.agents.ensureReady('fake-agent')
    await until(() => m.agents.status('fake-agent').account !== null)
    const init = {
      version: '0.1.0',
      capabilities: expect.objectContaining({ forkSession: true, forkAtMessage: true }),
    }
    expect(saved.at(-1)).toEqual({
      version: 1,
      agents: { 'fake-agent': { account, limits: [], init } },
    })
    await m.agents.logout('fake-agent')
    expect(m.agents.status('fake-agent').account).toBeNull()
    expect(saved.at(-1)).toEqual({
      version: 1,
      agents: { 'fake-agent': { account: null, limits: [], init } },
    })
    await m.agents.stopAll()
  })

  it('shows the capabilities an earlier run reported while the same adapter is installed', async () => {
    const remembered = (version: string): AgentsFile => ({
      version: 1,
      agents: {
        'fake-agent': {
          account: null,
          limits: [],
          init: { version, capabilities: { forkSession: true, forkAtMessage: true } },
        },
      },
    })
    const m = packageManager(['2.0.0'])
    m.agents.restore(remembered('2.0.0'))
    await m.agents.list()
    expect(m.status().capabilities).toMatchObject({ forkSession: true, forkAtMessage: true })
    m.agents.restore(remembered('1.9.0'))
    expect(m.status().capabilities).toMatchObject({ forkSession: false, forkAtMessage: false })
    expect(m.launcher.launches).toBe(0)
  })
})

describe('refreshAccount', () => {
  it('starts an agent that reports its account', async () => {
    const m = manager()
    await m.agents.refreshAccount('fake-agent')
    await until(() => m.agents.status('fake-agent').account !== null)
    expect(m.launcher.launches).toBe(1)
    await m.agents.stopAll()
  })

  it('leaves alone an agent that reports no account, and one that would need an install', async () => {
    const quiet = manager(
      {},
      {},
      { catalog: [{ ...fakeAgent(FAKE_AGENT_MAIN), reportsAccount: false }] },
    )
    await quiet.agents.refreshAccount('fake-agent')
    expect(quiet.launcher.launches).toBe(0)

    const def: AgentDefinition = {
      ...fakeAgent(FAKE_AGENT_MAIN),
      launch: { kind: 'package', package: 'fake-adapter', version: '2.0.0' },
    }
    const installs: InstallOptions[] = []
    const uninstalled = manager(
      {},
      {},
      {
        catalog: [def],
        detect: (d, ctx) =>
          detectAgent(d, {
            ...ctx,
            node: { nodeVersion: 'v24.1.0', npmPath: '/x/npm', nodePath: '/x/node' },
            installed: async () => [],
          }),
        install: async (options) => {
          installs.push(options)
          return { version: options.version, dir: '/a', entry: '/a/index.js', installedAt: 1 }
        },
      },
    )
    await uninstalled.agents.refreshAccount('fake-agent')
    expect(installs).toEqual([])
    expect(uninstalled.launcher.launches).toBe(0)
  })
})

/** Codex as a package agent with real install directories, each carrying a Codex CLI version. */
async function updateManager(
  options: {
    timings?: Partial<AgentTimings>
    npm?: string | null
    latest?: () => Promise<AgentUpdate>
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'overbench-updates-'))
  const def: AgentDefinition = {
    ...fakeAgent(FAKE_AGENT_MAIN),
    id: 'codex',
    name: 'Codex',
    launch: { kind: 'package', package: 'fake-adapter', version: '2.0.0' },
  }
  const write = async (name: string, version: string, cli: string, installedAt: number) => {
    const dir = path.join(root, 'codex', name)
    const pkg = path.join(dir, 'node_modules', 'fake-adapter')
    const codex = path.join(dir, 'node_modules', '@openai', 'codex')
    await mkdir(pkg, { recursive: true })
    await mkdir(codex, { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ bin: 'index.js' }))
    await writeFile(path.join(pkg, 'index.js'), '')
    await writeFile(path.join(codex, 'package.json'), JSON.stringify({ version: cli }))
    const record = { package: 'fake-adapter', version, node: null, npm: null, installedAt }
    await writeFile(path.join(dir, 'installed.json'), JSON.stringify(record))
    return { version, dir, entry: path.join(pkg, 'index.js'), installedAt }
  }
  const installs: InstallOptions[] = []
  const checks: unknown[] = []
  const saved: AgentUpdatesFile[] = []
  let cli = '0.160.1'
  let installImpl: (options: InstallOptions) => Promise<void> = async () => {}
  const m = manager(
    {},
    { progressMs: 1, ...options.timings },
    {
      catalog: [def],
      adaptersDir: root,
      detect: (d, ctx) =>
        detectAgent(d, {
          ...ctx,
          node: {
            nodeVersion: 'v24.1.0',
            npmPath: options.npm === undefined ? '/x/npm' : options.npm,
            nodePath: '/x/node',
          },
        }),
      install: async (request) => {
        installs.push(request)
        await installImpl(request)
        const at = Date.now()
        const taken = await stat(path.join(root, 'codex', request.version)).catch(() => null)
        const name = request.alongside && taken ? `${request.version}~${at}` : request.version
        return write(name, request.version, cli, at)
      },
      fetchLatest: async (request) => {
        checks.push(request)
        return (options.latest ?? (async () => ({ adapterVersion: '2.0.0', cliVersion: cli })))()
      },
      rememberUpdates: (file) => saved.push(structuredClone(file)),
    },
  )
  return {
    ...m,
    root,
    installs,
    checks,
    saved,
    write,
    setCli: (version: string) => (cli = version),
    onInstall: (impl: (options: InstallOptions) => Promise<void>) => (installImpl = impl),
    status: () => m.agents.status('codex'),
    dirs: async () => (await readdir(path.join(root, 'codex'))).sort(),
  }
}

describe('update checks', () => {
  it('finds a newer CLI for the installed adapter and keeps it across a restart', async () => {
    const m = await updateManager()
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    m.setCli('0.160.3')
    expect(await m.agents.list()).toMatchObject([{ update: null, updateCheckedAt: null }])
    const [status] = await m.agents.checkUpdates()
    expect(status).toMatchObject({
      update: { adapterVersion: '2.0.0', cliVersion: '0.160.3' },
      updateCheckedAt: expect.any(Number),
      task: null,
      installMethods: [],
    })
    expect(m.checks).toEqual([
      expect.objectContaining({
        npm: '/x/npm',
        package: 'fake-adapter',
        cli: { package: '@openai/codex', field: 'version' },
        cwd: os.homedir(),
        timeoutMs: 20_000,
      }),
    ])
    const file = m.saved.at(-1)!
    expect(file).toEqual({
      version: 1,
      agents: {
        codex: {
          checkedAt: status!.updateCheckedAt,
          attemptedAt: status!.updateCheckedAt,
          latest: { adapterVersion: '2.0.0', cliVersion: '0.160.3' },
        },
      },
    })

    // The next run shows it before any check, without the network.
    const next = await updateManager()
    await next.write('2.0.0', '2.0.0', '0.160.1', 1)
    next.agents.restoreUpdates(file)
    expect((await next.agents.list())[0]?.update).toEqual({
      adapterVersion: '2.0.0',
      cliVersion: '0.160.3',
    })
    expect(next.checks).toEqual([])
  })

  it('offers nothing when up to date, or before the first install', async () => {
    const m = await updateManager()
    expect((await m.agents.checkUpdates())[0]?.update).toBeNull()
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    expect((await m.agents.check())[0]?.update).toBeNull()
    await m.write('2.1.0', '2.1.0', '0.160.1', 2)
    expect((await m.agents.check())[0]).toMatchObject({
      package: { version: '2.1.0', installed: true },
      update: null,
    })
  })

  it('keeps the last result when the check fails, and says why when all of it failed', async () => {
    let online = true
    const m = await updateManager({
      latest: async () => {
        if (!online) throw new Error('The npm registry could not be reached.')
        return { adapterVersion: '2.1.0', cliVersion: null }
      },
    })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    const [first] = await m.agents.checkUpdates()
    online = false
    await expect(m.agents.checkUpdates()).rejects.toMatchObject({
      code: 'agent_error',
      message: 'Could not check for updates. The npm registry could not be reached.',
    })
    expect(m.status()).toMatchObject({
      update: { adapterVersion: '2.1.0' },
      updateCheckedAt: first!.updateCheckedAt,
    })
  })

  it('refuses a check without npm', async () => {
    const m = await updateManager({ npm: null })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    await expect(m.agents.checkUpdates()).rejects.toMatchObject({
      code: 'agent_unavailable',
      message: 'Updates are checked with npm, and npm was not found on PATH.',
    })
    expect(m.checks).toEqual([])
  })

  it('checks a minute after start once the last check is a day old, then daily', async () => {
    const timings = { updateDelayMs: 20, updateIntervalMs: 120 }
    const due = await updateManager({ timings })
    due.agents.restoreUpdates({
      version: 1,
      agents: {
        codex: {
          checkedAt: Date.now() - 1_000,
          attemptedAt: Date.now() - 1_000,
          latest: { adapterVersion: '1.0.0', cliVersion: null },
        },
      },
    })
    await due.agents.detectAll()
    due.agents.scheduleUpdateChecks()
    await until(() => due.checks.length === 1, 1_000)
    await until(() => due.checks.length === 2, 1_000)
    await due.agents.stopAll()

    const fresh = await updateManager({ timings: { ...timings, updateIntervalMs: 60_000 } })
    fresh.agents.restoreUpdates({
      version: 1,
      agents: {
        codex: {
          checkedAt: Date.now(),
          attemptedAt: Date.now(),
          latest: { adapterVersion: '1.0.0', cliVersion: null },
        },
      },
    })
    await fresh.agents.detectAll()
    fresh.agents.scheduleUpdateChecks()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fresh.checks).toEqual([])
    await fresh.agents.stopAll()
  })

  it('waits a day after a failed check too, across a restart', async () => {
    const timings = { updateDelayMs: 20, updateIntervalMs: 60_000 }
    const failing = await updateManager({
      timings,
      latest: async () => {
        throw new Error('404 Not Found - GET https://npm.example.com/fake-adapter')
      },
    })
    await failing.write('2.0.0', '2.0.0', '0.160.1', 1)
    await failing.agents.detectAll()
    failing.agents.scheduleUpdateChecks()
    await until(() => failing.checks.length === 1, 1_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(failing.checks).toHaveLength(1)
    await failing.agents.stopAll()
    const file = failing.saved.at(-1)!
    expect(file.agents.codex).toEqual({
      checkedAt: null,
      attemptedAt: expect.any(Number),
      latest: null,
    })

    // The next run does not check again within the day.
    const next = await updateManager({ timings })
    next.agents.restoreUpdates(file)
    await next.agents.detectAll()
    next.agents.scheduleUpdateChecks()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(next.checks).toEqual([])
    // The user's own check still asks.
    await next.agents.checkUpdates()
    expect(next.checks).toHaveLength(1)
    await next.agents.stopAll()
  })
})

describe('updates', () => {
  it('installs the update beside the running version, which the next start runs', async () => {
    const m = await updateManager()
    const old = await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    m.setCli('0.160.3')
    await m.agents.checkUpdates()
    const before = await m.agents.ensureReady('codex')
    let release!: () => void
    m.onInstall(async (request) => {
      request.onOutput?.('npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex\n')
      await new Promise<void>((resolve) => (release = resolve))
    })
    const update = m.agents.update('codex')
    await until(() => m.status().task?.progress.some((line) => line.includes('fetch')) ?? false)
    expect(m.status()).toMatchObject({
      state: 'ready',
      task: { kind: 'update', state: 'running', error: null },
    })
    // On Windows the command is quoted for cmd.exe, which splits words at `=`.
    expect(m.status().task?.command).toMatch(/install fake-adapter@2\.0\.0 "?--omit=dev"?/)
    release()
    await update
    expect(m.installs.map((i) => [i.version, i.alongside])).toEqual([['2.0.0', true]])
    const [, fresh] = await m.dirs()
    expect(fresh).toMatch(/^2\.0\.0~\d+$/)
    expect(m.status()).toMatchObject({ state: 'ready', task: null, update: null })
    // The running agent is left alone, and its install with it.
    expect(m.agents.runtime('codex')).toBe(before)
    expect(m.launcher.launches).toBe(1)
    expect(await m.dirs()).toEqual(['2.0.0', fresh])
    expect(m.status().launchCommand).toContain(old.entry)

    await m.agents.stopAll()
    await m.agents.ensureReady('codex')
    expect(m.status().launchCommand).toContain(path.join(m.root, 'codex', fresh!))
    let left: string[] = []
    await until(() => {
      void m.dirs().then((names) => (left = names))
      return left.length === 1
    })
    expect(left).toEqual([fresh])
    await m.agents.stopAll()
  })

  it('reports a failed update as a failed task and leaves the old install', async () => {
    const m = await updateManager({
      latest: async () => ({ adapterVersion: '2.1.0', cliVersion: null }),
    })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    await m.agents.checkUpdates()
    m.onInstall(async () => {
      throw new Error('npm exited with code 1. npm error code E404')
    })
    await expect(m.agents.update('codex')).rejects.toMatchObject({
      code: 'agent_error',
      message: 'Codex could not be updated. npm exited with code 1. npm error code E404',
    })
    expect(m.status()).toMatchObject({
      state: 'available',
      update: { adapterVersion: '2.1.0' },
      task: {
        kind: 'update',
        state: 'failed',
        error: 'Codex could not be updated. npm exited with code 1. npm error code E404',
      },
    })
    expect(await m.dirs()).toEqual(['2.0.0'])
    await m.agents.cancelTask('codex')
    expect(m.status().task).toBeNull()
  })

  it('stops an update when cancelled, and resolves', async () => {
    const m = await updateManager({
      latest: async () => ({ adapterVersion: '2.1.0', cliVersion: null }),
    })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    await m.agents.checkUpdates()
    m.onInstall(
      (request) =>
        new Promise((_, reject) =>
          request.signal?.addEventListener('abort', () =>
            reject(new Error('The install was stopped.')),
          ),
        ),
    )
    const update = m.agents.update('codex')
    await until(() => m.status().task?.state === 'running')
    await expect(m.agents.update('codex')).rejects.toMatchObject({ code: 'busy' })
    await expect(m.agents.reinstall('codex')).rejects.toMatchObject({ code: 'busy' })
    await m.agents.cancelTask('codex')
    await expect(update).resolves.toBeUndefined()
    expect(m.status()).toMatchObject({ task: null, update: { adapterVersion: '2.1.0' } })
    expect(await m.dirs()).toEqual(['2.0.0'])
  })

  it('refuses an update when there is none', async () => {
    const m = await updateManager()
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    await expect(m.agents.update('codex')).rejects.toMatchObject({ code: 'invalid_params' })
    await m.agents.checkUpdates()
    await expect(m.agents.update('codex')).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'Codex has no update to install',
    })
  })
})

describe('failed tasks and older installs', () => {
  it('clears a failed update once that update is no longer offered', async () => {
    const m = await updateManager()
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    m.setCli('0.160.3')
    await m.agents.checkUpdates()
    m.onInstall(async () => {
      throw new Error('ENOSPC: no space left on device')
    })
    await expect(m.agents.update('codex')).rejects.toMatchObject({ code: 'agent_error' })
    expect(m.status().task).toMatchObject({ kind: 'update', state: 'failed', method: null })
    // The newer CLI arrived another way, so there is nothing left to retry.
    await m.write('2.0.0~2', '2.0.0', '0.160.3', 2)
    await m.agents.check('codex')
    expect(m.status()).toMatchObject({ update: null, task: null })
  })

  it('counts an install below the pin as installed, and offers the pin', async () => {
    const m = await updateManager()
    await m.write('1.9.0', '1.9.0', '0.159.0', 1)
    expect((await m.agents.list())[0]).toMatchObject({
      package: { version: '1.9.0', installed: true },
      update: { adapterVersion: '2.0.0', cliVersion: null },
    })
    await m.agents.update('codex')
    expect(m.installs.map((i) => [i.version, i.alongside])).toEqual([['2.0.0', true]])
    expect(m.status()).toMatchObject({
      package: { version: '2.0.0', installed: true },
      update: null,
      task: null,
    })
  })

  it('keeps an agent with an older install usable when installing the pin fails', async () => {
    const m = await updateManager()
    await m.write('1.9.0', '1.9.0', '0.159.0', 1)
    m.onInstall(async () => {
      throw new Error('npm error code ENOTFOUND')
    })
    await m.agents.list()
    await expect(m.agents.install('codex')).rejects.toMatchObject({ code: 'agent_error' })
    expect(m.status().state).toBe('available')
    // A start still runs the older install.
    await expect(m.agents.ensureReady('codex')).resolves.toBeDefined()
    expect(m.status()).toMatchObject({ state: 'ready', package: { version: '1.9.0' } })
    await m.agents.stopAll()
  })
})

describe('installing a missing agent', () => {
  it("installs a package agent's adapter without starting it, shared with a start", async () => {
    const m = await updateManager()
    let release!: () => void
    m.onInstall(async (request) => {
      request.onOutput?.('npm http fetch GET 200 https://registry.npmjs.org/fake-adapter\n')
      await new Promise<void>((resolve) => (release = resolve))
    })
    const install = m.agents.install('codex', 'brew')
    await until(() => m.status().state === 'installing')
    const start = m.agents.ensureReady('codex')
    await until(() => m.status().progress.some((line) => line.includes('fetch')))
    release()
    await install
    await start
    expect(m.installs.map((i) => [i.version, i.alongside])).toEqual([['2.0.0', undefined]])
    expect(m.status()).toMatchObject({ state: 'ready', package: { installed: true }, task: null })
    expect(m.launcher.launches).toBe(1)
    // Installed already: nothing to do.
    await m.agents.install('codex')
    expect(m.installs).toHaveLength(1)
    await m.agents.stopAll()
  })

  it('goes back to not installed when the install is cancelled', async () => {
    const m = await updateManager()
    m.onInstall(
      (request) =>
        new Promise((_, reject) =>
          request.signal?.addEventListener('abort', () =>
            reject(new Error('The install was stopped.')),
          ),
        ),
    )
    const install = m.agents.install('codex')
    await until(() => m.status().state === 'installing')
    await m.agents.cancelTask('codex')
    await expect(install).resolves.toBeUndefined()
    expect(m.status()).toMatchObject({ state: 'available', package: { installed: false } })
    expect(m.launcher.launches).toBe(0)
  })
})

describe('installing a binary agent', () => {
  const windows = process.platform === 'win32'

  /** OpenCode as `fake-opencode`, on a PATH that holds only a fake npm, and what installs it does. */
  async function binaryManager(
    run: (options: ProgramOptions, bin: string) => Promise<Partial<ProgramRun>>,
  ) {
    const bin = await mkdtemp(path.join(os.tmpdir(), 'overbench-bin-'))
    const executable = async (name: string): Promise<string> => {
      const file = path.join(bin, windows ? `${name}.cmd` : name)
      await writeFile(file, windows ? '@exit /b 0\r\n' : '#!/bin/sh\n')
      if (!windows) await chmod(file, 0o755)
      return file
    }
    const npm = await executable('npm')
    const def: AgentDefinition = {
      ...OPENCODE,
      launch: { kind: 'binary', command: 'fake-opencode', args: ['acp'] },
    }
    const runs: ProgramOptions[] = []
    const env = new EnvironmentService({
      platform: process.platform,
      electronPath: process.execPath,
      baseEnv: {},
      resolve: async () => ({
        env: { PATH: bin, PATHEXT: '.EXE;.CMD' },
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({ nodeVersion: null, npmPath: npm, nodePath: null }),
    })
    const m = manager(
      {},
      { progressMs: 1 },
      {
        catalog: [def],
        env,
        runProgram: async (options) => {
          runs.push(options)
          return {
            code: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            output: new TextRing(1024),
            stdout: '',
            ...(await run(options, bin)),
          }
        },
      },
    )
    return { ...m, bin, npm, runs, executable, status: () => m.agents.status('opencode') }
  }

  it('lists its routes and installs by the first available one', async () => {
    const m = await binaryManager(async (options, bin) => {
      options.onOutput?.('added 2 packages in 3s\n')
      const file = path.join(bin, windows ? 'fake-opencode.cmd' : 'fake-opencode')
      await writeFile(file, '')
      if (!windows) await chmod(file, 0o755)
      return {}
    })
    const [status] = await m.agents.list()
    expect(status).toMatchObject({ state: 'not-installed', updateCheckedAt: null, update: null })
    expect(status?.installMethods.map((method) => [method.id, method.available])).toEqual(
      windows
        ? [['npm', true]]
        : [
            ['brew', false],
            ['script', false],
            ['npm', true],
          ],
    )
    await expect(m.agents.install('opencode', 'brew')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await m.agents.install('opencode')
    expect(m.runs).toEqual([
      expect.objectContaining({
        program: m.npm,
        args: expect.arrayContaining(['install', '-g', 'opencode-ai']),
        cwd: os.homedir(),
        timeoutMs: 15 * 60_000,
      }),
    ])
    expect(m.status()).toMatchObject({ state: 'available', task: null })
    await expect(m.agents.install('opencode')).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('fails naming the folder when the program is still not on PATH', async () => {
    const prefix = windows ? 'C:\\npm-prefix' : '/npm-prefix'
    const m = await binaryManager(async (options) =>
      options.args[0] === 'prefix' ? { stdout: `${prefix}\n` } : {},
    )
    await m.agents.list()
    const folder = windows ? prefix : `${prefix}/bin`
    const message = `OpenCode could not be installed. OpenCode was installed in ${folder}, but fake-opencode is still not found on PATH. Add that folder to PATH and reload the environment, or choose the program in Settings › Agents.`
    await expect(m.agents.install('opencode')).rejects.toMatchObject({
      code: 'agent_error',
      message,
    })
    expect(m.status()).toMatchObject({
      state: 'not-installed',
      task: {
        kind: 'install',
        state: 'failed',
        command: 'npm install -g opencode-ai',
        method: 'npm',
        error: message,
      },
    })
    // Once the user puts it on PATH, the failed install has nothing left to do.
    await m.executable('fake-opencode')
    await m.agents.check('opencode')
    expect(m.status()).toMatchObject({ state: 'available', task: null })
  })

  it("reports the tool's failure, and stops it when cancelled", async () => {
    const failing = await binaryManager(async () => {
      const output = new TextRing(1024)
      output.push('npm error code EACCES\nnpm error syscall mkdir\n')
      return { code: 243, output }
    })
    await failing.agents.list()
    await expect(failing.agents.install('opencode')).rejects.toMatchObject({
      message:
        'OpenCode could not be installed. npm exited with code 243. npm error code EACCES npm error syscall mkdir',
    })

    const hanging = await binaryManager(
      (options) =>
        new Promise((resolve) =>
          options.signal?.addEventListener('abort', () => resolve({ code: null, aborted: true })),
        ),
    )
    await hanging.agents.list()
    const install = hanging.agents.install('opencode')
    await until(() => hanging.status().task?.state === 'running')
    await hanging.agents.cancelTask('opencode')
    await expect(install).resolves.toBeUndefined()
    expect(hanging.status()).toMatchObject({ state: 'not-installed', task: null })
  })
})
