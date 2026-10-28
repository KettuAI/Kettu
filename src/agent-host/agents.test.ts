// The agent lifecycle with the fake agent in-process: start, timeouts, restarts, idle stop.

import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCliSource, AgentStatus, AgentUpdate } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
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
import { archiveKey } from './binary-install'
import {
  CLAUDE_CODE,
  configFolders,
  detectAgent,
  fakeAgent,
  OPENCODE,
  type AgentDefinition,
  type DetectContext,
  type Detection,
  type LaunchSpec,
} from './catalog'
import { Diagnostics } from './diagnostics'
import type { Env } from './find-command'
import { CliVersions, type AdapterCli, type CliProbe } from './installed-cli'
import { QUIT_REASON, type ToolOptions } from './process-tree'
import { EnvironmentService } from './shell-env'
import { TextRing } from './ring'
import { parseAgentUpdatesFile, type AgentsFile, type AgentUpdatesFile } from './storage'
import { archiveTar, serveArchives, sha256 } from './testing/archives'
import {
  FAKE_AGENT_MAIN,
  inProcessLauncher,
  loadFakeAgent,
  type FakeAgentModule,
} from './testing/harness'
import { tempFolder } from './testing/temp'

/** A delete that fails as Windows fails it while a process runs from the folder. */
const removal = vi.hoisted(() => ({ fail: null as Error | null, calls: 0 }))
vi.mock('./adapter-install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapter-install')>()
  return {
    ...actual,
    removeInstall: async (dir: string) => {
      removal.calls++
      if (removal.fail) throw removal.fail
      return actual.removeInstall(dir)
    },
  }
})

/** The removal of Codex's archived report threads, as each detection asks for it. */
const reportThreads = vi.hoisted(() => ({
  calls: [] as unknown[],
  answer: (): Promise<number> => Promise.resolve(0),
}))
vi.mock('./codex-report-threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex-report-threads')>()
  return {
    ...actual,
    removeReportThreads: (options: unknown) => {
      reportThreads.calls.push(options)
      return reportThreads.answer()
    },
  }
})

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
      | 'settings'
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
      mcp: DEFAULT_SETTINGS.mcp,
      usage: { fromComputer: false },
      sessionTitles: true,
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
    configChanged: () => {},
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

/** A launcher whose first process ignores its stop, as after a Windows taskkill that failed. */
function stopFails(firstEnv: Env = {}) {
  const first = inProcessLauncher(module, firstEnv)
  const base = inProcessLauncher(module)
  let end: (() => Promise<unknown>) | null = null
  const launcher: AgentLauncher = {
    launch: (def, spec, launchEnv, output) => {
      if (first.launches > 0) return base.launch(def, spec, launchEnv, output)
      const launched = first.launch(def, spec, launchEnv, output)
      end = launched.stop
      return Object.assign(launched, {
        pid: 4242,
        stop: async () => ({
          code: null,
          signal: null,
          error: 'taskkill failed: taskkill did not finish within 10000 ms',
        }),
      })
    },
  }
  const pids = (m: ReturnType<typeof manager>) => m.agents.processes().map((p) => p.pid)
  // The first process exits after all, as the reap's taskkill would end it.
  const launches = () => first.launches + base.launches
  return { launcher, launches, pids, exitFirst: () => end?.() }
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

  it('reports MCP over HTTP as null before a start, then as the agent advertised it', async () => {
    const m = manager(
      {},
      {},
      {
        catalog: [
          fakeAgent(FAKE_AGENT_MAIN),
          { ...fakeAgent(FAKE_AGENT_MAIN), id: 'codex', name: 'Codex' },
        ],
      },
    )
    expect(m.agents.status('fake-agent').capabilities.mcpHttp).toBeNull()
    await m.agents.ensureReady('fake-agent')
    expect(m.agents.status('fake-agent').capabilities.mcpHttp).toBe(true)
    expect(m.agents.status('codex').capabilities.mcpHttp).toBeNull()
    await m.agents.stopAll()
  })

  it('reports OverBench’s server as on by default, and off from the settings', async () => {
    const m = manager({}, {}, { settings: () => withMcpOff(['fake-agent']) })
    expect(m.agents.status('fake-agent').overbenchServer).toEqual({
      runs: false,
      active: null,
    })
    await m.agents.ensureReady('fake-agent')
    expect(m.agents.status('fake-agent').overbenchServer).toEqual({
      runs: false,
      active: false,
    })
    await m.agents.stopAll()
  })

  it('tells which agents break their context down', async () => {
    const m = manager(
      {},
      {},
      {
        catalog: [
          { ...fakeAgent(FAKE_AGENT_MAIN) },
          { ...fakeAgent(FAKE_AGENT_MAIN), id: 'codex', name: 'Codex' },
          { ...fakeAgent(FAKE_AGENT_MAIN), id: 'opencode', name: 'opencode' },
        ],
      },
    )
    expect(m.agents.status('fake-agent').capabilities.context).toBe(true)
    expect(m.agents.status('codex').capabilities.context).toBe(false)
    expect(m.agents.status('opencode').capabilities.context).toBe(false)
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
    // The menu's next opening tries again.
    await m.agents.readOptions('fake-agent')
    expect(sent().filter((method) => method === 'session/new')).toHaveLength(2)
    await m.agents.stopAll()
  })

  it('does not hand out the runtime of an agent its stop did not end', async () => {
    const { launcher, launches, pids, exitFirst } = stopFails()
    const m = manager({}, {}, { launcher })
    const first = await m.agents.ensureReady('fake-agent')
    await m.agents.stop('fake-agent')
    expect(m.state()).toBe('available')
    expect(m.agents.runtime('fake-agent')).toBeNull()
    expect(m.diagnostics.logEntries()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('taskkill failed: taskkill did not finish'),
      }),
    )
    // Main still knows of it, for a host that dies before it exits.
    expect(pids(m)).toEqual([4242])
    const second = await m.agents.ensureReady('fake-agent')
    expect(second).not.toBe(first)
    expect(launches()).toBe(2)

    await exitFirst()
    await until(() => !pids(m).includes(4242))
    expect(m.agents.runtime('fake-agent')).toBe(second)
    expect(m.state()).toBe('ready')
    await m.agents.stopAll()
  })

  /** A package agent whose install is on disk, with a first process that ignores its stop. */
  async function reinstallable() {
    const given = stopFails()
    const root = await tempFolder('overbench-adapters-')
    const def: AgentDefinition = {
      ...fakeAgent(FAKE_AGENT_MAIN),
      launch: { kind: 'package', package: 'fake-adapter', version: '2.0.0' },
    }
    const installs: InstallOptions[] = []
    const installed: InstalledAdapter = {
      version: '2.0.0',
      dir: path.join(root, 'fake-agent', '2.0.0'),
      entry: '/a/2.0.0/index.js',
      installedAt: 1,
    }
    const m = manager(
      {},
      {},
      {
        catalog: [def],
        launcher: given.launcher,
        detect: (d, ctx) =>
          detectAgent(d, {
            ...ctx,
            node: { nodeVersion: 'v24.1.0', npmPath: '/x/npm', nodePath: '/x/node' },
            installed: async () => [installed],
          }),
        install: async (options) => {
          installs.push(options)
          return installed
        },
      },
    )
    await mkdir(installed.dir, { recursive: true })
    // Windows refuses to delete a folder a process runs from.
    removal.calls = 0
    removal.fail = Object.assign(
      new Error(`EBUSY: resource busy or locked, rmdir '${installed.dir}'`),
      { code: 'EBUSY' },
    )
    const end = async () => {
      removal.fail = null
      await given.exitFirst()
      await m.agents.stopAll()
    }
    return { ...given, m, installs, end }
  }

  const stillRunning = {
    name: 'HostError',
    code: 'busy',
    message: 'Fake agent did not stop and is still running; try again once it has exited',
  }

  it('refuses a reinstall before deleting anything when its stop leaves the agent running', async () => {
    const { m, pids, installs, end } = await reinstallable()
    try {
      await m.agents.ensureReady('fake-agent')
      await expect(m.agents.reinstall('fake-agent')).rejects.toMatchObject(stillRunning)
      // The stop gave the process up, so it still runs from the folder the reinstall would delete.
      expect(pids(m)).toEqual([4242])
      expect(removal.calls).toBe(0)
      expect(installs).toEqual([])
      expect(m.state()).toBe('available')
    } finally {
      await end()
    }
  })

  it('refuses a reinstall while a process an earlier stop gave up still runs', async () => {
    const { m, installs, launches, exitFirst, end } = await reinstallable()
    try {
      await m.agents.ensureReady('fake-agent')
      await m.agents.stop('fake-agent')
      // A new process runs beside the one the stop gave up, and the refusal leaves it running.
      const running = await m.agents.ensureReady('fake-agent')
      await expect(m.agents.reinstall('fake-agent')).rejects.toMatchObject(stillRunning)
      expect(m.state()).toBe('ready')
      expect(m.agents.runtime('fake-agent')).toBe(running)
      expect(launches()).toBe(2)
      expect(removal.calls).toBe(0)
      // Once it has ended, the reinstall goes ahead.
      removal.fail = null
      await exitFirst()
      await m.agents.reinstall('fake-agent')
      expect(removal.calls).toBe(1)
      expect(installs).toHaveLength(1)
    } finally {
      await end()
    }
  })

  it('kills a given-up process that still runs when the quit cuts the stops short', async () => {
    const given = stopFails()
    const launcher: AgentLauncher = {
      launch: (def, spec, env, output) => {
        const launched = given.launcher.launch(def, spec, env, output)
        if (given.launches() === 1) return launched
        // The process after it hangs in its stop, so the quit's cut comes.
        return Object.assign(launched, { stop: () => new Promise<never>(() => {}) })
      },
    }
    const m = manager({}, { quitStopMs: 100 }, { launcher })
    await m.agents.ensureReady('fake-agent')
    await m.agents.stop('fake-agent')
    await m.agents.ensureReady('fake-agent')
    expect(given.pids(m)).toEqual([4242])
    await m.agents.stopAll()
    expect(given.pids(m)).toEqual([])
  })

  it('gives up the process of a failed start that its stop did not end', async () => {
    const { launcher, pids, exitFirst } = stopFails({
      FAKE_AGENT_SLOW_START_MS: '10000',
      FAKE_AGENT_DELAY_SCALE: '1',
    })
    const m = manager({}, { initializeMs: 100 }, { launcher })
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
    expect(m.state()).toBe('failed')
    expect(m.diagnostics.logEntries()).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('did not stop') }),
    )
    // It stays listed after the slot has moved on to a new process.
    await m.agents.retry('fake-agent')
    await m.agents.ensureReady('fake-agent')
    expect(pids(m)).toEqual([4242])
    await exitFirst()
    await until(() => pids(m).length === 0)
    expect(m.state()).toBe('ready')
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
    await m.agents.refreshLimits('codex')
    const sent = m.diagnostics
      .agentRecords('codex')
      .traffic.filter((r) => r.direction === 'out')
      .map((r) => r.method)
    // The limits report records them only while none are known.
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

describe('quitting', () => {
  /** What `stopAll` came to before `ms` passed: 'stopped', or 'waiting' while it still runs. */
  const stopAllWithin = (m: ReturnType<typeof manager>, ms: number) =>
    Promise.race([
      m.agents.stopAll().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), ms)),
    ])

  it('stops waiting for an agent that outlasts the quit, and kills what is left of it', async () => {
    const base = inProcessLauncher(module)
    let kills = 0
    const launcher: AgentLauncher = {
      launch: (def, spec, env, output) => {
        const launched = base.launch(def, spec, env, output)
        const stop = launched.stop
        return Object.assign(launched, {
          // An agent that ignores EOF and every signal the stop sends.
          stop: () => new Promise<never>(() => {}),
          kill: async () => {
            kills++
            await stop()
          },
        })
      },
    }
    const m = manager({}, { quitStopMs: 100 }, { launcher })
    await m.agents.ensureReady('fake-agent')
    expect(await stopAllWithin(m, 2_000)).toBe('stopped')
    expect(kills).toBe(1)
    expect(m.diagnostics.logEntries()).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('Fake agent') }),
    )
  })

  it('stops an agent that is still starting without waiting for its initialize', async () => {
    const base = inProcessLauncher(module, {
      FAKE_AGENT_SLOW_START_MS: '10000',
      FAKE_AGENT_DELAY_SCALE: '1',
    })
    const stops: boolean[] = []
    const launcher: AgentLauncher = {
      launch: (def, spec, env, output) => {
        const launched = base.launch(def, spec, env, output)
        const stop = launched.stop
        return Object.assign(launched, {
          stop: (tools?: ToolOptions) => {
            stops.push(tools?.quitting ?? false)
            return stop(tools)
          },
        })
      },
    }
    const m = manager({}, {}, { launcher })
    const start = m.agents.ensureReady('fake-agent')
    await until(() => m.state() === 'starting')
    expect(await stopAllWithin(m, 2_000)).toBe('stopped')
    await expect(start).rejects.toMatchObject({ code: 'agent_unavailable' })
    // Stopped by the quit, not failed.
    expect(m.state()).toBe('available')
    expect(stops.length).toBeGreaterThan(0)
    expect(stops.every((quitting) => quitting)).toBe(true)
  })

  it('starts nothing once the quit has begun', async () => {
    const m = manager()
    await m.agents.stopAll()
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
    expect(m.launcher.launches).toBe(0)
    expect(m.state()).toBe('available')
  })
})

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
    const dir = await tempFolder('overbench-adapters-')
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
    const dir = await tempFolder('overbench-adapters-')
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
    const dir = await tempFolder('overbench-adapters-')
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

  it('stops a running install when the agent stops, and names a quit as its reason', async () => {
    const m = packageManager([])
    let reason: unknown
    m.onInstall(
      (options) =>
        new Promise((_, reject) =>
          options.signal?.addEventListener('abort', () => {
            reason = options.signal?.reason
            reject(new Error('The install was stopped.'))
          }),
        ),
    )
    const start = m.agents.ensureReady('fake-agent')
    await until(() => m.state() === 'installing')
    await m.agents.stopAll()
    await expect(start).rejects.toMatchObject({
      message: 'Fake agent could not be installed. The install was stopped.',
    })
    expect(m.launcher.launches).toBe(0)
    // So npm's tree is stopped with the quit's short limits.
    expect(reason).toBe(QUIT_REASON)
  })
})

/** A CLI the user installed on PATH, which an adapter runs from version 1.0.0 on. */
const FAKE_CLI: AdapterCli = {
  command: 'fake-cli',
  variable: 'FAKE_CLI_PATH',
  startsAtInitialize: true,
  pinsVersion: false,
  copyMegabytes: 100,
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

/** Where the PATH lookup finds `fake-pi`, which on Windows takes an extension from PATHEXT. */
const FAKE_PI = path.join(
  path.resolve('/bin'),
  process.platform === 'win32' ? 'fake-pi.exe' : 'fake-pi',
)

/**
 * Pi as the fake agent: a package agent whose `requires` program is `fake-pi` on PATH, answering
 * `0.83.0`, and whose terminal sign-in runs that program alone.
 */
function requiresManager(
  options: {
    version?: string
    installed?: InstalledAdapter[]
    /** Whether the program is on PATH; true unless set false. */
    found?: boolean
    /** What `--version` answers instead of a version. */
    error?: string
  } = {},
) {
  const def: AgentDefinition = {
    ...fakeAgent(FAKE_AGENT_MAIN),
    id: 'pi',
    name: 'Pi',
    launch: { kind: 'package', package: 'fake-adapter', version: '0.0.34' },
    requires: { command: 'fake-pi', minimum: '0.81.0', variable: 'PI_ACP_PI_COMMAND' },
    signInWithCli: true,
    install: {
      hint: 'detect.hint.pi',
      url: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md',
    },
  }
  const adapters = [
    ...(options.installed ?? [
      { version: '0.0.34', dir: '/a/0.0.34', entry: '/a/0.0.34/index.js', installedAt: 1 },
    ]),
  ]
  const launches: LaunchSpec[] = []
  const base = inProcessLauncher(module)
  const launcher: AgentLauncher = {
    launch: (d, spec, env, output) => {
      launches.push(spec)
      return base.launch(d, spec, env, output)
    },
  }
  const m = manager(
    {},
    { progressMs: 1 },
    {
      catalog: [def],
      launcher,
      detect: async (d, ctx) =>
        detectAgent(d, {
          ...ctx,
          node: { nodeVersion: 'v24.1.0', npmPath: '/x/npm', nodePath: '/x/node' },
          installed: async () => adapters,
          env: { PATH: path.resolve('/bin') },
          isExecutable: async (file) => options.found !== false && file === FAKE_PI,
          probeCli: async () =>
            options.error ? { error: options.error } : { version: options.version ?? '0.83.0' },
        }),
    },
  )
  return { ...m, launches, status: () => m.agents.status('pi') }
}

describe('a program the adapter runs', () => {
  it("sets the launch's variable to the program detection found", async () => {
    const m = requiresManager()
    await m.agents.ensureReady('pi')
    expect(m.launches.map((spec) => spec.env.PI_ACP_PI_COMMAND)).toEqual([FAKE_PI])
    await m.agents.stopAll()
  })

  it("reports the program's version, never the adapter's", async () => {
    const m = requiresManager()
    await m.agents.list()
    expect(m.status()).toMatchObject({ version: '0.83.0', state: 'available' })
    await m.agents.ensureReady('pi')
    // The fake agent's own initialize reports 0.1.0, which is not what Pi's row shows.
    expect(m.status()).toMatchObject({ state: 'ready', version: '0.83.0' })
    await m.agents.stopAll()
  })

  it('runs the program alone for the terminal sign-in', async () => {
    const m = requiresManager()
    await m.agents.ensureReady('pi')
    const terminal = m.status().authMethods.find((method) => method.type === 'terminal')
    expect(terminal?.command).toBe(FAKE_PI)
    await m.agents.stopAll()
  })

  it('is not installed while the program is missing, too old or does not answer', async () => {
    const missing = requiresManager({ found: false })
    await missing.agents.list()
    expect(missing.status()).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining('earendil-works/pi-coding-agent'),
    })
    const old = requiresManager({ version: '0.80.9' })
    await old.agents.list()
    expect(old.status()).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining('0.81.0'),
    })
    const failing = requiresManager({ error: 'fake-pi exited with code 1.' })
    await failing.agents.list()
    expect(failing.status()).toMatchObject({
      state: 'not-installed',
      detail: expect.stringContaining('code 1'),
    })
  })
})

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
    settings?: AgentManagerDeps['settings']
    /** Runs before each install records its directory. */
    beforeInstall?: (request: InstallOptions) => Promise<void>
    /** Runs before each detection. */
    beforeDetect?: () => Promise<void>
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
        kill: () => launched.kill(),
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
      ...(options.settings ? { settings: options.settings } : {}),
      detect: async (d, ctx) => {
        await options.beforeDetect?.()
        return detectAgent(d, {
          ...ctx,
          node: { nodeVersion: 'v24.1.0', npmPath: '/x/npm', nodePath: '/x/node' },
          installed: async () => adapters.toSorted((a, b) => compareInstalls(b, a)),
          ...cliFound(options.cli ?? '2.0.0'),
          ...(options.cliVersions && ctx.probeCli ? { probeCli: ctx.probeCli } : {}),
        })
      },
      install: async (request) => {
        installs.push(request)
        await options.beforeInstall?.(request)
        const install: InstalledAdapter = {
          version: request.version,
          dir: `/a/${request.version}~${installs.length}`,
          entry: `/a/${request.version}/index.js`,
          installedAt: installs.length + 1,
          ...(request.withoutCli ? { withoutCli: true as const } : {}),
        }
        adapters.push(install)
        return install
      },
    },
  )
  return { ...m, installs, launches, status: () => m.agents.status('fake-agent') }
}

/** The host settings with OverBench's MCP server off for these agents. */
function withMcpOff(off: AgentId[]): HostSettings {
  return {
    locale: 'en',
    agents: {},
    proxy: { mode: 'environment' },
    git: { backgroundFetch: false },
    mcp: { overbench: { off } },
    usage: { fromComputer: false },
    sessionTitles: true,
  }
}

/** The host settings with the fake agent's choice of CLI. */
const cliSettings = (cli: AgentCliSource): HostSettings => ({
  locale: 'en',
  agents: { 'fake-agent': { cli } },
  proxy: { mode: 'environment' },
  git: { backgroundFetch: false },
  mcp: DEFAULT_SETTINGS.mcp,
  usage: { fromComputer: false },
  sessionTitles: true,
})

describe('the CLI the user installed', () => {
  const installedAt = (version: string, extra: Partial<InstalledAdapter> = {}) => ({
    version,
    dir: `/a/${version}`,
    entry: `/a/${version}/index.js`,
    installedAt: 1,
    ...extra,
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
    await m.agents.stop('fake-agent')
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

  it('installs the adapter without its own CLI and runs the installed one', async () => {
    const m = cliManager()
    await m.agents.ensureReady('fake-agent')
    expect(m.installs.map((i) => [i.version, i.withoutCli])).toEqual([['2.0.0', true]])
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH)).toEqual([
      expect.stringContaining('fake-cli'),
    ])
    expect(m.status()).toMatchObject({
      state: 'ready',
      cli: {
        prefer: 'installed',
        runs: 'installed',
        installed: { version: '2.0.0', problem: null },
      },
    })
    await m.agents.stopAll()
  })

  it('installs the copy after all when the CLI is older than the adapter needs', async () => {
    const m = cliManager({ minimum: '3.0.0' })
    await m.agents.ensureReady('fake-agent')
    expect(m.installs.map((i) => [i.withoutCli ?? false, i.alongside ?? false])).toEqual([
      [true, false],
      [false, true],
    ])
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH)).toEqual([undefined])
    expect(m.status()).toMatchObject({
      state: 'ready',
      cli: { runs: 'bundled', installed: { problem: { kind: 'too-old', minimum: '3.0.0' } } },
    })
    await m.agents.stopAll()
  })

  /** Holds the install of the copy that follows an install without it until it is aborted. */
  function holdSecondInstall() {
    const held: { request?: InstallOptions; end?: (error: Error) => void } = {}
    const beforeInstall = (request: InstallOptions) => {
      if (!request.alongside) return Promise.resolve()
      held.request = request
      return new Promise<void>((_, reject) => {
        held.end = reject
        request.signal?.addEventListener('abort', () =>
          reject(new Error('The install was stopped.')),
        )
      })
    }
    return { held, beforeInstall }
  }

  it('cancels the install of the copy that follows an install without it', async () => {
    const { held, beforeInstall } = holdSecondInstall()
    const m = cliManager({ minimum: '3.0.0', beforeInstall })
    const start = m.agents.ensureReady('fake-agent')
    await until(() => held.request !== undefined)
    await m.agents.cancelTask('fake-agent')
    const aborted = held.request?.signal?.aborted
    // Ends an install the cancel did not stop, as npm's 15-minute limit would.
    held.end?.(new Error('npm did not finish within 900 s.'))
    await start.catch(() => {})
    expect(aborted).toBe(true)
    expect(m.state()).toBe('available')
    await m.agents.stopAll()
  })

  it('cancels the install of the copy that Install asked for', async () => {
    const { held, beforeInstall } = holdSecondInstall()
    const m = cliManager({ minimum: '3.0.0', beforeInstall })
    const install = m.agents.install('fake-agent')
    await until(() => held.request !== undefined)
    await m.agents.cancelTask('fake-agent')
    await expect(install).resolves.toBeUndefined()
    expect(m.state()).toBe('available')
    await m.agents.stopAll()
  })

  it('does not start the copy when the cancel comes before its install', async () => {
    const detection: { held?: boolean; release?: () => void } = {}
    let installedWithoutCli = false
    const m = cliManager({
      minimum: '3.0.0',
      beforeInstall: async (request) => {
        if (request.withoutCli) installedWithoutCli = true
      },
      // Holds the detection that follows the install without the copy.
      beforeDetect: () => {
        if (!installedWithoutCli || detection.held) return Promise.resolve()
        detection.held = true
        return new Promise<void>((resolve) => (detection.release = resolve))
      },
    })
    const start = m.agents.ensureReady('fake-agent')
    await until(() => detection.held === true)
    const cancel = m.agents.cancelTask('fake-agent')
    detection.release?.()
    await cancel
    await start.catch(() => {})
    expect(m.installs.map((i) => i.withoutCli ?? false)).toEqual([true])
    expect(m.launches).toEqual([])
    expect(m.state()).toBe('available')
    await m.agents.stopAll()
  })

  it('stops the install of the copy that follows an install without it at a quit', async () => {
    const { held, beforeInstall } = holdSecondInstall()
    const m = cliManager({ minimum: '3.0.0', beforeInstall })
    const start = m.agents.ensureReady('fake-agent').catch(() => {})
    await until(() => held.request !== undefined)
    const quit = m.agents.stopAll()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reason = held.request?.signal?.reason
    held.end?.(new Error('npm did not finish within 900 s.'))
    await Promise.all([start, quit])
    expect(reason).toBe(QUIT_REASON)
  })

  it('says which CLI the running adapter uses until it stops', async () => {
    let choice: AgentCliSource = 'installed'
    const m = cliManager({ installed: [installedAt('2.0.0')], settings: () => cliSettings(choice) })
    const change = async (next: AgentCliSource) => {
      const previous = choice
      choice = next
      await m.agents.settingsChanged(cliSettings(previous), cliSettings(next))
    }
    await m.agents.check()
    expect(m.status().cli).toMatchObject({ runs: 'installed', active: null })
    await m.agents.ensureReady('fake-agent')
    expect(m.status().cli).toMatchObject({ runs: 'installed', active: 'installed' })
    await change('bundled')
    expect(m.status().cli).toMatchObject({ runs: 'bundled', active: 'installed' })
    // Back to what the process runs: nothing waits for the next start.
    await change('installed')
    expect(m.status().cli).toMatchObject({ runs: 'installed', active: 'installed' })
    await change('bundled')
    await m.agents.stop('fake-agent')
    expect(m.status().cli).toMatchObject({ runs: 'bundled', active: null })
    await m.agents.ensureReady('fake-agent')
    expect(m.status().cli).toMatchObject({ runs: 'bundled', active: 'bundled' })
    await m.agents.stopAll()
  })

  it('says when the copy is to run but the next start downloads it', async () => {
    const bare = [installedAt('2.0.0', { withoutCli: true })]
    const old = cliManager({ installed: bare, minimum: '3.0.0' })
    await old.agents.check()
    expect(old.status().cli).toMatchObject({ runs: 'bundled', needsCopy: true, copyMegabytes: 100 })
    const fine = cliManager({ installed: bare })
    await fine.agents.check()
    expect(fine.status().cli).toMatchObject({ runs: 'installed', needsCopy: false })
  })

  it('tries the installed CLI again once the choice changes after a start with it failed', async () => {
    let choice: AgentCliSource = 'installed'
    const options = {
      installed: [installedAt('2.0.0')],
      failWithCli: true,
      settings: () => cliSettings(choice),
    }
    const m = cliManager(options)
    await m.agents.ensureReady('fake-agent')
    await m.agents.stop('fake-agent')
    const failed = { runs: 'bundled', installed: { problem: { kind: 'failed' } } }
    expect(m.status().cli).toMatchObject(failed)
    // A change elsewhere keeps the failure.
    await m.agents.settingsChanged(cliSettings('installed'), cliSettings('installed'))
    expect(m.status().cli).toMatchObject(failed)
    options.failWithCli = false
    choice = 'bundled'
    await m.agents.settingsChanged(cliSettings('installed'), cliSettings('bundled'))
    expect(m.status().cli).toMatchObject({
      prefer: 'bundled',
      runs: 'bundled',
      installed: { problem: null },
    })
    choice = 'installed'
    await m.agents.settingsChanged(cliSettings('bundled'), cliSettings('installed'))
    expect(m.status().cli).toMatchObject({ prefer: 'installed', runs: 'installed' })
    await m.agents.ensureReady('fake-agent')
    expect(m.launches.at(-1)?.env.FAKE_CLI_PATH).toContain('fake-cli')
    await m.agents.stopAll()
  })

  it('does not download the copy over one --version that timed out', async () => {
    const answers = [true, false]
    const versions = new CliVersions({
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      run: async () => ({
        code: 0,
        signal: null,
        timedOut: answers.shift() ?? false,
        aborted: false,
        output: new TextRing(64),
        stdout: 'fake-cli 2.0.0\n',
      }),
      stat: async () => ({ size: 1, mtimeMs: 1 }),
    })
    const m = cliManager({
      installed: [installedAt('2.0.0', { withoutCli: true })],
      cliVersions: versions,
    })
    await m.agents.ensureReady('fake-agent')
    expect(m.installs).toEqual([])
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH)).toEqual([
      expect.stringContaining('fake-cli'),
    ])
    await m.agents.stopAll()
  })

  it('installs the copy beside an install without it when a start with the CLI fails', async () => {
    const m = cliManager({
      installed: [installedAt('2.0.0', { withoutCli: true })],
      failWithCli: true,
    })
    await m.agents.ensureReady('fake-agent')
    expect(m.launches.map((spec) => spec.env.FAKE_CLI_PATH !== undefined)).toEqual([true, false])
    expect(m.installs.map((i) => [i.version, i.alongside, i.withoutCli])).toEqual([
      ['2.0.0', true, undefined],
    ])
    expect(m.status()).toMatchObject({ state: 'ready', cli: { runs: 'bundled' } })
    await m.agents.stopAll()
  })
})

describe("a binary agent's version", () => {
  const windows = process.platform === 'win32'

  /** OpenCode as `fake-opencode`, on a PATH of its own, its version answered by `probe`. */
  async function opencodeManager(probe: CliProbe) {
    const bin = await tempFolder('overbench-bin-')
    const program = path.join(bin, windows ? 'fake-opencode.cmd' : 'fake-opencode')
    await writeFile(program, windows ? '@exit /b 0\r\n' : '#!/bin/sh\n')
    if (!windows) await chmod(program, 0o755)
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
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    })
    const def: AgentDefinition = {
      ...OPENCODE,
      launch: { kind: 'binary', command: 'fake-opencode', args: ['acp'] },
    }
    const m = manager({}, { progressMs: 1 }, { catalog: [def], env, probeCli: probe })
    return { ...m, program, status: () => m.agents.status('opencode') }
  }

  it('shows the version --version prints before it has ever started', async () => {
    const asked: string[] = []
    const m = await opencodeManager(async (program) => {
      asked.push(program)
      return { version: '2.0.32' }
    })
    expect(await m.agents.list()).toMatchObject([{ id: 'opencode', state: 'available' }])
    await until(() => m.status().version === '2.0.32')
    expect(asked).toEqual([m.program])
    expect(m.launcher.launches).toBe(0)
  })

  it('shows what initialize reports once it starts', async () => {
    const m = await opencodeManager(async () => ({ version: '2.0.32' }))
    await m.agents.list()
    await until(() => m.status().version === '2.0.32')
    await m.agents.ensureReady('opencode')
    expect(m.status()).toMatchObject({ state: 'ready', version: '0.1.0' })
    await m.agents.stopAll()
  })

  it('shows no version when --version fails, and logs the failure once', async () => {
    let asked = 0
    const m = await opencodeManager(async () => {
      asked++
      return { error: 'opencode --version printed no version.' }
    })
    await m.agents.list()
    const logged = () =>
      m.diagnostics
        .logEntries()
        .filter((entry) => entry.message.includes('could not read its version'))
    await until(() => logged().length === 1)
    expect(m.status().version).toBeNull()
    await m.agents.check('opencode')
    await until(() => asked === 2)
    // The answer's continuation runs after the poll saw the ask; a second log would follow it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(logged()).toHaveLength(1)
  })
})

describe('a configuration folder of its own', () => {
  const shellFolder = path.join(os.tmpdir(), 'overbench-shell-claude')
  const picked = path.join(os.tmpdir(), 'overbench-picked-claude')
  // The fake agent under Claude Code's id, whose folder can be picked.
  const def: AgentDefinition = {
    ...fakeAgent(FAKE_AGENT_MAIN),
    id: 'claude-code',
    configVariable: 'CLAUDE_CONFIG_DIR',
  }
  const settingsWith = (configDir?: string): HostSettings => ({
    locale: 'en',
    agents: configDir ? { 'claude-code': { configDir } } : {},
    proxy: { mode: 'environment' },
    git: { backgroundFetch: false },
    mcp: DEFAULT_SETTINGS.mcp,
    usage: { fromComputer: false },
    sessionTitles: true,
  })

  function folderManager() {
    let current = settingsWith()
    const env = new EnvironmentService({
      platform: process.platform,
      electronPath: process.execPath,
      baseEnv: { ...process.env, CLAUDE_CONFIG_DIR: shellFolder },
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    })
    const launches: Env[] = []
    const inner = inProcessLauncher(module)
    const launcher: AgentLauncher = {
      launch: (agent, spec, launchEnv, output) => {
        launches.push(launchEnv)
        return inner.launch(agent, spec, launchEnv, output)
      },
    }
    const m = manager({}, {}, { catalog: [def], env, launcher, settings: () => current })
    const changed: AgentId[] = []
    m.agents.hooks.configChanged = (agentId) => changed.push(agentId)
    const pick = async (folder?: string) => {
      const previous = current
      current = settingsWith(folder)
      env.setConfigFolders(configFolders([def], current.agents))
      await m.agents.settingsChanged(previous, current)
    }
    const status = () => m.agents.status('claude-code')
    const restart = async () => {
      await m.agents.stop('claude-code')
      await m.agents.ensureReady('claude-code')
    }
    return { ...m, launches, changed, pick, status, restart }
  }

  it('applies a picked folder from the next start, and forgets what the old one reported', async () => {
    const m = folderManager()
    await m.agents.ensureReady('claude-code')
    expect(m.launches[0]?.CLAUDE_CONFIG_DIR).toBe(shellFolder)
    expect(m.status().configDir).toEqual({ runs: shellFolder, active: shellFolder })
    await until(() => m.status().account !== null)

    await m.pick(picked)
    expect(m.changed).toEqual(['claude-code'])
    expect(m.status()).toMatchObject({
      configDir: { runs: picked, active: shellFolder },
      account: null,
      limits: [],
      state: 'ready',
    })
    expect(m.launches).toHaveLength(1)

    await m.restart()
    expect(m.launches[1]?.CLAUDE_CONFIG_DIR).toBe(picked)
    expect(m.status().configDir).toEqual({ runs: picked, active: picked })

    await m.pick()
    expect(m.changed).toEqual(['claude-code', 'claude-code'])
    expect(m.status().configDir).toEqual({ runs: shellFolder, active: picked })
    await m.restart()
    expect(m.launches[2]?.CLAUDE_CONFIG_DIR).toBe(shellFolder)
    await m.agents.stopAll()
  })

  it('signs in to the picked folder from a terminal', async () => {
    const m = folderManager()
    const command = () =>
      m.status().authMethods.find((method) => method.type === 'terminal')?.command ?? ''
    await m.agents.ensureReady('claude-code')
    expect(command()).toContain('--login')
    expect(command()).not.toContain('CLAUDE_CONFIG_DIR')
    await m.pick(picked)
    // The running agent still uses the environment's folder, which the terminal has too.
    expect(command()).not.toContain('CLAUDE_CONFIG_DIR')
    await m.restart()
    expect(command()).toContain(`CLAUDE_CONFIG_DIR=${picked}`)
    await m.agents.stopAll()
  })

  it('shows the picked folder on the page, in place of the variable', async () => {
    const m = folderManager()
    expect((await m.agents.details('claude-code')).config[0]).toEqual({
      id: 'folder',
      path: shellFolder,
      exists: false,
      env: 'CLAUDE_CONFIG_DIR',
      chosen: false,
    })
    await m.pick(picked)
    const { config } = await m.agents.details('claude-code')
    expect(config[0]).toEqual({
      id: 'folder',
      path: picked,
      exists: false,
      env: null,
      chosen: true,
    })
    expect(config[1]).toMatchObject({ path: path.join(picked, 'settings.json') })
  })

  it('has no folder to pick for an agent without a variable', async () => {
    const m = manager()
    await m.agents.ensureReady('fake-agent')
    expect(m.agents.status('fake-agent').configDir).toBeNull()
    await m.agents.stopAll()
  })
})

describe('details', () => {
  it('reads the pinned adapter and the environment the agents see', async () => {
    const dir = await tempFolder('overbench-adapters-')
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
          {
            id: 'folder',
            path: configDir,
            exists: false,
            env: 'CLAUDE_CONFIG_DIR',
            chosen: false,
          },
          {
            id: 'settings',
            path: path.join(configDir, 'settings.json'),
            exists: false,
            env: null,
            chosen: false,
          },
          {
            id: 'instructions',
            path: path.join(configDir, 'CLAUDE.md'),
            exists: false,
            env: null,
            chosen: false,
          },
        ],
      })
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = before
    }
  })

  it('reads the CLI of the fallback adapter while the pinned one is not installed', async () => {
    const dir = await tempFolder('overbench-adapters-')
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

describe('the archived report threads', () => {
  const def: AgentDefinition = { ...fakeAgent(FAKE_AGENT_MAIN), id: 'codex', name: 'Codex' }
  const spec = {
    command: '/x/codex',
    args: [],
    env: { CODEX_PATH: '/x/codex' },
    shell: false,
    display: { command: '/x/codex', args: [], env: {} },
  }
  function codexManager(detection: Detection, environment: Env = process.env) {
    const saved: AgentsFile[] = []
    const env = new EnvironmentService({
      platform: process.platform,
      electronPath: process.execPath,
      baseEnv: environment,
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    })
    const m = manager(
      {},
      {},
      {
        catalog: [def],
        env,
        remember: (file) => saved.push(file),
        detect: async () => detection,
      },
    )
    return { ...m, saved }
  }
  const logged = (m: ReturnType<typeof manager>, text: string): boolean =>
    m.diagnostics.logEntries().some((entry) => entry.message.includes(text))

  beforeEach(() => {
    reportThreads.calls.length = 0
    reportThreads.answer = () => Promise.resolve(0)
  })

  it('removes them once, through the binary its launch runs, and records that it did', async () => {
    reportThreads.answer = () => Promise.resolve(3)
    const m = codexManager({ state: 'available', spec, adapter: null })
    await m.agents.list()
    expect(reportThreads.calls).toEqual([
      expect.objectContaining({ binary: '/x/codex', reportsDir: expect.any(String) }),
    ])
    await until(() => m.saved.some((file) => file.codexReportThreadsRemovedAt !== undefined))
    expect(m.saved.at(-1)).toMatchObject({
      version: 1,
      codexReportThreadsRemovedAt: expect.any(Number),
    })
    expect(logged(m, 'Removed 3 archived Codex threads')).toBe(true)
    // A later detection in the same launch leaves it alone.
    await m.agents.check('codex')
    expect(reportThreads.calls).toHaveLength(1)
  })

  it('records nothing after a failure, and logs it', async () => {
    reportThreads.answer = () => Promise.reject(new Error('no rollout found'))
    const m = codexManager({ state: 'available', spec, adapter: null })
    await m.agents.list()
    await until(() => logged(m, 'no rollout found'))
    expect(m.saved.some((file) => file.codexReportThreadsRemovedAt !== undefined)).toBe(false)
  })

  it('runs nothing once an earlier run recorded that it did', async () => {
    const m = codexManager({ state: 'available', spec, adapter: null })
    m.agents.restore({ version: 1, agents: {}, codexReportThreadsRemovedAt: 7 })
    await m.agents.list()
    expect(reportThreads.calls).toEqual([])
  })

  it('takes the binary from the agent environment when the launch has none', async () => {
    const m = codexManager(
      { state: 'available', spec: { ...spec, env: {} }, adapter: null },
      {
        ...process.env,
        CODEX_PATH: '/env/codex',
      },
    )
    await m.agents.list()
    expect(reportThreads.calls).toEqual([expect.objectContaining({ binary: '/env/codex' })])
  })

  it('runs nothing for an agent other than Codex, or while Codex is not available', async () => {
    const other = { ...def, id: 'fake-agent' as const, name: 'Fake agent' }
    const m = manager(
      {},
      {},
      {
        catalog: [other],
        detect: async () => ({ state: 'available', spec, adapter: null }),
      },
    )
    await m.agents.list()
    expect(reportThreads.calls).toEqual([])
    const missing = codexManager({ state: 'not-installed', detail: 'Codex is not installed.' })
    await missing.agents.list()
    expect(reportThreads.calls).toEqual([])
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
    /** The version of an installed CLI the adapter runs. */
    installedCli?: string
    /** The adapter pins its CLI, so the check's CLI version is the oldest it runs. */
    pinsVersion?: boolean
    launcher?: AgentLauncher
  } = {},
) {
  const root = await tempFolder('overbench-updates-')
  const def: AgentDefinition = {
    ...fakeAgent(FAKE_AGENT_MAIN),
    id: 'codex',
    name: 'Codex',
    launch: { kind: 'package', package: 'fake-adapter', version: '2.0.0' },
    ...(options.installedCli
      ? { cli: { ...FAKE_CLI, pinsVersion: options.pinsVersion ?? false } }
      : {}),
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
          ...(options.installedCli ? cliFound(options.installedCli) : {}),
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
      ...(options.launcher ? { launcher: options.launcher } : {}),
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

  it('offers only a newer adapter while the installed CLI runs, and installs it without a CLI', async () => {
    const same = await updateManager({ installedCli: '2.0.0' })
    await same.write('2.0.0', '2.0.0', '0.160.1', 1)
    same.setCli('0.160.3')
    expect((await same.agents.checkUpdates())[0]).toMatchObject({
      cli: { runs: 'installed' },
      update: null,
    })
    const newer = await updateManager({
      installedCli: '2.0.0',
      latest: async () => ({ adapterVersion: '2.1.0', cliVersion: '0.161.0' }),
    })
    await newer.write('2.0.0', '2.0.0', '0.160.1', 1)
    expect((await newer.agents.checkUpdates())[0]?.update).toEqual({
      adapterVersion: '2.1.0',
      cliVersion: null,
    })
    await newer.agents.update('codex')
    expect(newer.installs.map((i) => [i.version, i.withoutCli])).toEqual([['2.1.0', true]])
  })

  it('brings the CLI with an update that needs a newer one than the user has', async () => {
    const m = await updateManager({
      installedCli: '2.0.0',
      pinsVersion: true,
      latest: async () => ({ adapterVersion: '2.1.0', cliVersion: '2.5.0' }),
    })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    expect((await m.agents.checkUpdates())[0]?.update).toEqual({
      adapterVersion: '2.1.0',
      cliVersion: '2.5.0',
    })
    await m.agents.update('codex')
    expect(m.installs.map((i) => [i.version, i.withoutCli])).toEqual([['2.1.0', undefined]])
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

    await m.agents.stop('codex')
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

  it('keeps the older install while a process its stop gave up still runs', async () => {
    const given = stopFails()
    const m = await updateManager({ launcher: given.launcher })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    m.setCli('0.160.3')
    await m.agents.checkUpdates()
    await m.agents.ensureReady('codex')
    await m.agents.update('codex')
    const [, fresh] = await m.dirs()
    // The stop gives up the process that runs from 2.0.0, and the next start runs the update.
    await m.agents.stop('codex')
    await m.agents.ensureReady('codex')
    expect(m.status().launchCommand).toContain(path.join(m.root, 'codex', fresh!))
    expect(given.pids(m)).toEqual([4242])
    // A cleanup would have deleted 2.0.0 by now.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await m.dirs()).toEqual(['2.0.0', fresh])

    await given.exitFirst()
    let left: string[] = []
    await until(() => {
      void m.dirs().then((names) => (left = names))
      return left.length === 1
    })
    expect(left).toEqual([fresh])
    await m.agents.stopAll()
  })

  it('keeps the older install when its given-up process exits after a failed start', async () => {
    const given = stopFails()
    const slow = inProcessLauncher(module, {
      FAKE_AGENT_SLOW_START_MS: '10000',
      FAKE_AGENT_DELAY_SCALE: '1',
    })
    // Every process after the given-up one is too slow to answer initialize.
    const launcher: AgentLauncher = {
      launch: (def, spec, env, output) =>
        (given.launches() === 0 ? given.launcher : slow).launch(def, spec, env, output),
    }
    const m = await updateManager({ launcher, timings: { initializeMs: 1_000 } })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    m.setCli('0.160.3')
    await m.agents.checkUpdates()
    await m.agents.ensureReady('codex')
    await m.agents.update('codex')
    const [, fresh] = await m.dirs()
    await m.agents.stop('codex')
    await expect(m.agents.ensureReady('codex')).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
    expect(m.status().state).toBe('failed')

    // No start of the update answered, so its exit leaves 2.0.0 for a start that does.
    await given.exitFirst()
    await until(() => given.pids(m).length === 0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await m.dirs()).toEqual(['2.0.0', fresh])
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

describe('skipped updates', () => {
  it('skips the update the notice shows, and keeps it across a restart', async () => {
    const m = await updateManager()
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    m.setCli('0.160.3')
    expect((await m.agents.checkUpdates())[0]).toMatchObject({ updateSkipped: false })

    await m.agents.skipUpdate('codex')
    expect(m.status()).toMatchObject({
      update: { adapterVersion: '2.0.0', cliVersion: '0.160.3' },
      updateSkipped: true,
    })
    const file = m.saved.at(-1)!
    expect(file.agents.codex).toMatchObject({
      skipped: { adapterVersion: '2.0.0', cliVersion: '0.160.3' },
    })

    // The next run reads the skip from the stored file, without the network.
    const next = await updateManager()
    await next.write('2.0.0', '2.0.0', '0.160.1', 1)
    const stored = parseAgentUpdatesFile(
      JSON.parse(JSON.stringify(file)) as Record<string, unknown>,
    )
    expect(typeof stored).toBe('object')
    next.agents.restoreUpdates(stored as AgentUpdatesFile)
    expect((await next.agents.list())[0]).toMatchObject({
      update: { adapterVersion: '2.0.0', cliVersion: '0.160.3' },
      updateSkipped: true,
    })
    expect(next.checks).toEqual([])
  })

  it('shows the update again once a newer CLI is found', async () => {
    const m = await updateManager()
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    m.setCli('0.160.3')
    await m.agents.checkUpdates()
    await m.agents.skipUpdate('codex')
    expect(m.status().updateSkipped).toBe(true)

    m.setCli('0.160.4')
    expect((await m.agents.checkUpdates())[0]).toMatchObject({
      update: { adapterVersion: '2.0.0', cliVersion: '0.160.4' },
      updateSkipped: false,
    })
  })

  it('clears the skip when the update installs', async () => {
    const m = await updateManager({
      latest: async () => ({ adapterVersion: '2.1.0', cliVersion: null }),
    })
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    await m.agents.checkUpdates()
    await m.agents.skipUpdate('codex')
    expect(m.status().updateSkipped).toBe(true)

    await m.agents.update('codex')
    expect(m.status()).toMatchObject({ update: null, updateSkipped: false })
    expect(m.saved.at(-1)?.agents.codex).not.toHaveProperty('skipped')
  })

  it('leaves the skip alone when the update is gone by the click', async () => {
    const m = await updateManager()
    await m.write('2.0.0', '2.0.0', '0.160.1', 1)
    await m.agents.skipUpdate('codex')
    expect(m.status().updateSkipped).toBe(false)
    expect(m.saved).toEqual([])
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
    const bin = await tempFolder('overbench-bin-')
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

  it('runs no install once the quit has begun', async () => {
    const m = await binaryManager(async () => ({}))
    await m.agents.list()
    await m.agents.stopAll()
    await m.agents.install('opencode')
    expect(m.runs).toEqual([])
    expect(m.status().task).toBeNull()
  })

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

describe('installing a binary agent from its archive', () => {
  const posix = process.platform !== 'win32'
  const CONTENT = Buffer.from('#!/bin/sh\necho fake\n')

  /** OpenCode as `fake-archive-agent`, which only OverBench's own archive install provides. */
  async function archiveManager(options: { withoutHash?: boolean } = {}) {
    const bin = await tempFolder('overbench-bin-')
    const adaptersDir = await tempFolder('overbench-archives-')
    const archive = gzipSync(archiveTar([{ name: 'agent', data: CONTENT, mode: 0o100755 }]))
    const link = await serveArchives({ '/agent.tar.gz': archive })
    const def: AgentDefinition = {
      ...OPENCODE,
      launch: { kind: 'binary', command: 'fake-archive-agent', args: ['acp'] },
      installs: {
        archive: {
          version: '1.0.0',
          entries: {
            [archiveKey(process.platform as Platform, process.arch)]: {
              url: link('/agent.tar.gz'),
              ...(options.withoutHash ? {} : { sha256: sha256(archive) }),
              cmd: './agent',
            },
          },
        },
      },
    }
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
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    })
    let agentSettings: HostSettings['agents'] = {}
    const m = manager(
      {},
      { progressMs: 1 },
      {
        catalog: [def],
        adaptersDir,
        env,
        settings: () => ({
          locale: 'en',
          agents: agentSettings,
          proxy: { mode: 'environment' },
          git: { backgroundFetch: false },
          mcp: DEFAULT_SETTINGS.mcp,
          usage: { fromComputer: false },
          sessionTitles: true,
        }),
      },
    )
    return {
      ...m,
      bin,
      adaptersDir,
      setAgentSettings: (next: HostSettings['agents']): void => {
        agentSettings = next
      },
      status: () => m.agents.status('opencode'),
      program: path.join(adaptersDir, 'opencode', '1.0.0', 'agent'),
    }
  }

  it('installs from the archive, turns available and starts', async () => {
    const m = await archiveManager()
    const [status] = await m.agents.list()
    expect(status).toMatchObject({ state: 'not-installed', task: null })
    expect(status?.installMethods).toEqual([
      {
        id: 'archive',
        label: 'agent.tar.gz',
        command: expect.stringContaining('http://127.0.0.1:'),
        available: true,
      },
    ])
    await m.agents.install('opencode')
    expect(m.status()).toMatchObject({ state: 'available', task: null })
    expect(await readFile(m.program)).toEqual(CONTENT)
    expect(m.status().launchCommand).toContain(m.program)
    const runtime = await m.agents.ensureReady('opencode')
    expect(runtime.agentId).toBe('opencode')
    await m.agents.stopAll()
  })

  it("runs the user's own copy on PATH instead of the archive", async () => {
    const m = await archiveManager()
    const file = path.join(m.bin, 'fake-archive-agent')
    await writeFile(file, posix ? '#!/bin/sh\n' : '')
    if (posix) await chmod(file, 0o755)
    await m.agents.list()
    expect(m.status()).toMatchObject({ state: 'available' })
    expect(m.status().launchCommand).toBe('fake-archive-agent acp')
    await expect(m.agents.install('opencode')).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('runs the chosen binary instead of the archive', async () => {
    const m = await archiveManager()
    const chosen = path.join(m.bin, 'chosen-agent')
    await writeFile(chosen, posix ? '#!/bin/sh\n' : '')
    if (posix) await chmod(chosen, 0o755)
    m.setAgentSettings({ opencode: { binaryPath: chosen } })
    await m.agents.check('opencode')
    expect(m.status()).toMatchObject({ state: 'available', binaryOverride: chosen })
    expect(m.status().launchCommand).toContain(chosen)
  })

  it('installs without a registry hash, and warns in the host log', async () => {
    const m = await archiveManager({ withoutHash: true })
    await m.agents.list()
    await m.agents.install('opencode')
    expect(m.status()).toMatchObject({ state: 'available' })
    expect(m.diagnostics.logEntries()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('has no SHA-256 in the registry'),
      }),
    )
  })
})
