// The agent lifecycle with the fake agent in-process: start, timeouts, restarts, idle stop.

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { InstalledAdapter, InstallOptions } from './adapter-install'
import { AgentManager, type AgentManagerDeps, type AgentTimings } from './agents'
import { CLAUDE_CODE, detectAgent, fakeAgent, type AgentDefinition } from './catalog'
import { Diagnostics } from './diagnostics'
import type { Env } from './find-command'
import { EnvironmentService } from './shell-env'
import type { AgentsFile } from './storage'
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
    Pick<AgentManagerDeps, 'catalog' | 'detect' | 'install' | 'adaptersDir' | 'remember'>
  > = {},
) {
  const launcher = inProcessLauncher(module, env)
  const statuses: AgentStatus[] = []
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
    diagnostics: new Diagnostics(),
    launcher,
    settings: () => ({
      locale: 'en',
      agents: {},
      proxy: { mode: 'environment' },
      git: { backgroundFetch: false },
    }),
    reportsDir: path.join(os.tmpdir(), 'overbench-agent-reports'),
    adaptersDir: path.join(os.tmpdir(), 'overbench-no-adapters'),
    detect: detectAgent,
    ...extra,
    timings: { restartDelaysMs: [5], ...timings },
    status: (status) => statuses.push(status),
    processes: () => {},
    authCommands: () => {},
  })
  agents.hooks = {
    liveSessions: () => live,
    agentReady: () => {},
    agentExited: () => {},
    signedIn: () => {},
  }
  return {
    agents,
    launcher,
    statuses,
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

  it('restarts a crashed agent that live sessions need, and gives up after five failures', async () => {
    const m = manager()
    m.setLive(1)
    await m.agents.ensureReady('fake-agent')
    for (let crash = 1; crash <= 4; crash++) {
      m.launcher.crash(7)
      await until(() => m.state() === 'crashed' || m.state() === 'starting')
      await until(() => m.state() === 'ready')
      expect(m.launcher.launches).toBe(crash + 1)
    }
    m.launcher.crash(7)
    await until(() => m.state() === 'failed')
    expect(m.agents.status('fake-agent').detail).toContain('five minutes')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(m.launcher.launches).toBe(5)

    await m.agents.retry('fake-agent')
    expect(m.state()).toBe('ready')
    expect(m.launcher.launches).toBe(6)
    await m.agents.stopAll()
  })

  it('does not restart an agent nothing needs', async () => {
    const m = manager()
    await m.agents.ensureReady('fake-agent')
    m.launcher.crash(1)
    await until(() => m.state() === 'crashed')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(m.launcher.launches).toBe(1)
    expect(m.agents.status('fake-agent').detail).toBe('Fake agent exited with code 1.')
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
    dir: `/a/${version}`,
    entry: `/a/${version}/index.js`,
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
            installed: async () => [{ version: '1.0.0', dir: '/a', entry: '/a/index.js' }],
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
    expect(saved.at(-1)).toEqual({
      version: 1,
      agents: { 'fake-agent': { account, limits: [] } },
    })
    await m.agents.logout('fake-agent')
    expect(m.agents.status('fake-agent').account).toBeNull()
    expect(saved.at(-1)).toEqual({ version: 1, agents: {} })
    await m.agents.stopAll()
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
          return { version: options.version, dir: '/a', entry: '/a/index.js' }
        },
      },
    )
    await uninstalled.agents.refreshAccount('fake-agent')
    expect(installs).toEqual([])
    expect(uninstalled.launcher.launches).toBe(0)
  })
})
