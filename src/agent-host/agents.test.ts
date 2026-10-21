// The agent lifecycle with the fake agent in-process: start, timeouts, restarts, idle stop.

import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { AgentManager, type AgentTimings } from './agents'
import { detectAgent, fakeAgent } from './catalog'
import { Diagnostics } from './diagnostics'
import type { Env } from './find-command'
import { EnvironmentService } from './shell-env'
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

function manager(env: Env = {}, timings: Partial<AgentTimings> = {}) {
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
    probe: async () => ({ nodeVersion: null, npxPath: null, nodePath: null }),
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
      agents: {},
      proxy: { mode: 'environment' },
      git: { backgroundFetch: false },
    }),
    reportsDir: path.join(os.tmpdir(), 'overbench-agent-reports'),
    detect: detectAgent,
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
      { initializeFirstMs: 150, progressMs: 10 },
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

  it('gives the first launch longer to initialize than later ones', async () => {
    const m = manager(
      { FAKE_AGENT_SLOW_START_MS: '100', FAKE_AGENT_DELAY_SCALE: '1' },
      { initializeFirstMs: 2_000, initializeMs: 30 },
    )
    await m.agents.ensureReady('fake-agent')
    await m.agents.stop('fake-agent')
    await expect(m.agents.ensureReady('fake-agent')).rejects.toMatchObject({
      message: expect.stringContaining('within 0.03 s'),
    })
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
