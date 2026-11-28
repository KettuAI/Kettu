import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from './agents'
import { ANTIGRAVITY } from './agents/antigravity'
import { Diagnostics } from './diagnostics'
import { EnvironmentService } from './shell-env'
import type { AgentsFile } from './storage'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

function fakeStatus(window: TestPort): AgentStatus | undefined {
  return window.events.findLast(
    (event): event is Extract<typeof event, { type: 'agent.status' }> =>
      event.type === 'agent.status' && event.status.id === 'fake-agent',
  )?.status
}

it('keeps a failed limits read of a running agent in its status until a read succeeds', async () => {
  // The hidden session of the fake agent's `/usage` opens only once this file exists.
  const gate = path.join(await tempFolder('kettu-limits-gate-'), 'open')
  const host = await startTestHost({
    agentEnv: { FAKE_AGENT_NEW_SESSION_GATE: gate },
    agentTimings: { limitsReadMs: 1_000 },
  })
  hosts.push(host)
  const window = host.connect()

  await expect(window.request('agents.refreshAccount', { agentId: 'fake-agent' })).rejects.toThrow()
  await window.until(() => fakeStatus(window)?.state === 'ready')
  expect(fakeStatus(window)).toMatchObject({ limits: [], limitsError: expect.any(String) })

  await writeFile(gate, '')
  await window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true })
  const read = fakeStatus(window)
  expect(read?.limits.length).toBeGreaterThan(0)
  expect(read?.limitsError).toBeUndefined()
})

it('takes a limits report it cannot read for a failed read, without quoting the reply', async () => {
  const host = await startTestHost({ agentEnv: { FAKE_AGENT_USAGE: 'unreadable' } })
  hosts.push(host)
  const window = host.connect()

  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true }),
  ).rejects.toThrow()
  const failed = fakeStatus(window)
  expect(failed).toMatchObject({ state: 'ready', limits: [], limitsError: expect.any(String) })
  expect(failed?.limitsError).not.toContain('subscription plans')
})

it('drops the plan windows kept from before once an agent goes through a gateway', async () => {
  const dir = await tempFolder('kettu-gateway-limits-')
  await mkdir(path.join(dir, 'state'), { recursive: true })
  const window5h = {
    window: 'five_hour',
    label: '5-hour',
    usedPercent: 50,
    resetsAt: null,
    state: 'ok',
    observedAt: 1,
  }
  await writeFile(
    path.join(dir, 'state', 'agents.json'),
    JSON.stringify({
      version: 1,
      agents: {
        'fake-agent': {
          account: { kind: 'account', label: 'Fake Pro', email: 'developer@example.com' },
          limits: [window5h],
        },
      },
    }),
  )
  const host = await startTestHost({ userDataPath: dir, agentEnv: { FAKE_AGENT_GATEWAY: '1' } })
  hosts.push(host)
  const window = host.connect()

  // A session starts the agent, which reports its account, without reading its limits.
  await window.request('sessions.create', { agentId: 'fake-agent', projectPath: host.project })
  await window.until(() => fakeStatus(window)?.account?.kind === 'gateway')
  expect(fakeStatus(window)?.limits).toEqual([])
})

it('keeps no plan windows for an agent that goes through a gateway, from a read or an event', async () => {
  const host = await startTestHost({ agentEnv: { FAKE_AGENT_GATEWAY: '1' } })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.until(() => fakeStatus(window)?.account?.kind === 'gateway')

  // The plan of a sign-in the gateway does not use still answers a limits read.
  await window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true })
  expect(fakeStatus(window)?.limits).toEqual([])

  // A turn's own rate-limit events say nothing of the gateway's limits either.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'hi' }],
  })
  await window.untilStatus(id, 'ready')
  expect(fakeStatus(window)?.account?.kind).toBe('gateway')
  expect(fakeStatus(window)?.limits).toEqual([])
})

it('covers a used-up window with extra usage until an event says it is over', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const say = async (text: string) => {
    await window.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
    await window.untilStatus(id, 'ready')
  }
  const fiveHour = () => fakeStatus(window)?.limits.find((limit) => limit.window === 'five_hour')

  await say('/extra-usage')
  await window.until(() => fiveHour()?.extraUsage === true)
  expect(fiveHour()).toMatchObject({ state: 'reached', usedPercent: 100, extraUsage: true })

  // Extra usage stops covering the window while it is still used up: the block stays.
  await say('/extra-usage refused')
  await window.until(() => fiveHour()?.extraUsage === undefined)
  expect(fiveHour()).toMatchObject({ state: 'reached', usedPercent: 100 })

  await say('/extra-usage off')
  await window.until(() => fiveHour()?.extraUsage === undefined && fiveHour()?.state === 'ok')
  expect(fiveHour()).toMatchObject({ usedPercent: 12, state: 'ok' })
})

it('backs off background limit reads after failures while still honoring forced refreshes', async () => {
  const host = await startTestHost({
    agentEnv: { FAKE_AGENT_USAGE: 'unreadable' },
    agentTimings: { limitsMs: 10, limitsBackgroundMs: 100 },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  // First failure puts the agent into backoff; a non-forced refresh immediately after returns
  // without issuing another failing read, while force:true bypasses the backoff.
  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true }),
  ).rejects.toThrow()
  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent' }),
  ).resolves.toBeUndefined()
  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true }),
  ).rejects.toThrow()
})

it('skips background limit polling when an agent only has un-adopted prepared sessions', async () => {
  const host = await startTestHost({
    agentEnv: { FAKE_AGENT_USAGE: 'unreadable' },
    agentTimings: { limitsMs: 10, limitsBackgroundMs: 40 },
  })
  hosts.push(host)
  const window = host.connect()
  const prepared = await window.request('sessions.prepare', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  expect(prepared.prepared).toBeDefined()

  await new Promise((resolve) => setTimeout(resolve, 160))
  expect(fakeStatus(window)?.limitsError).toBeUndefined()
})

it('excludes stale and archived sessions from activitySummaries while keeping live and recent ones', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id: liveId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(liveId)
  await window.untilStatus(liveId, 'ready')

  const { id: archivedId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.request('sessions.archive', { sessionId: archivedId })

  const now = Date.now()
  const active = host.host.sessions.activitySummaries(now)
  expect(active.map((s) => s.id)).toContain(liveId)
  expect(active.map((s) => s.id)).not.toContain(archivedId)

  // Advancing `now` past the 30-minute window drops closed old records while keeping live sessions.
  const future = host.host.sessions.activitySummaries(now + 60 * 60_000)
  expect(future.map((s) => s.id)).toContain(liveId)
})

describe('Google Antigravity plan limits disabled', () => {
  async function makeAntigravityManager(options?: { envKeySet?: boolean }) {
    const root = await tempFolder('kettu-agy-no-limits-')
    const program = path.join(root, process.platform === 'win32' ? 'agy.cmd' : 'agy')
    await writeFile(program, '')
    await chmod(program, 0o755)
    const workFolder = path.join(root, 'agents', 'antigravity~work')
    const platform = process.platform === 'win32' ? 'win32' : process.platform
    const nodeRuntime = { command: process.execPath, env: {} }
    const settings: HostSettings = {
      locale: 'en',
      initialSetupDone: true,
      agents: { antigravity: { enabled: true, binaryPath: program } },
      addedAgents: [{ id: 'antigravity~work', name: 'Work', configDir: workFolder, created: true }],
      disabledAgents: [],
      proxy: DEFAULT_SETTINGS.proxy,
      git: DEFAULT_SETTINGS.git,
      mcp: DEFAULT_SETTINGS.mcp,
      marketplace: DEFAULT_SETTINGS.marketplace,
      startModes: DEFAULT_SETTINGS.startModes,
      idleSessions: DEFAULT_SETTINGS.idleSessions,
      workflow: DEFAULT_SETTINGS.workflow,
      startedSessions: DEFAULT_SETTINGS.startedSessions,
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
    const runProgram = vi.fn(async () => {
      throw new Error('agy must not be polled for plan limits')
    })
    const launch = vi.fn(() => {
      throw new Error('agy must not be launched for plan limits')
    })
    const remembered: AgentsFile[] = []
    const agents = new AgentManager({
      catalog: [ANTIGRAVITY],
      platform,
      nodeRuntime,
      appVersion: '0.0.0-test',
      env: new EnvironmentService({
        platform,
        nodeRuntime,
        baseEnv: { PATH: '', HOME: root },
        resolve: async ({ baseEnv }) => ({
          env: baseEnv,
          source: 'inherited',
          shell: null,
          durationMs: 0,
          warning: null,
        }),
        probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
      }),
      diagnostics: new Diagnostics(),
      launcher: { launch },
      settings: () => settings,
      reportsDir: path.join(root, 'reports'),
      adaptersDir: root,
      runProgram,
      probeCli: async () => ({ version: '1.5.17' }),
      remember: (file) => remembered.push(file),
      envKeyIsSet: () => options?.envKeySet === true,
      status: () => {},
      processes: () => {},
      authCommands: () => {},
    })
    return { agents, runProgram, launch, remembered }
  }

  it('reports no plan limits capability and never spawns agy on refreshLimits or refreshAccount', async () => {
    const { agents, runProgram, launch } = await makeAntigravityManager()

    expect(agents.hasLimits('antigravity')).toBe(false)
    expect(agents.hasLimits('antigravity~work')).toBe(false)
    expect(agents.status('antigravity')).toMatchObject({
      limits: [],
      limitsReason: 'vendor-disallows',
      capabilities: { reports: false },
    })

    await agents.refreshLimits('antigravity', { force: true })
    await agents.refreshLimits('antigravity~work', { force: true })
    await agents.refreshAccount('antigravity', { force: true, afterSignIn: true })

    expect(runProgram).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(agents.status('antigravity').limits).toEqual([])
  })

  it('clears stale persisted Antigravity plan limits on restore while keeping account tier metadata', async () => {
    const { agents, remembered } = await makeAntigravityManager()
    const staleLimit = {
      window: 'five_hour_gemini_models',
      label: '5-hour · Gemini Models',
      usedPercent: 42,
      resetsAt: Date.UTC(2026, 10, 28, 12, 0),
      state: 'ok' as const,
      observedAt: Date.UTC(2026, 10, 28, 8, 0),
    }

    agents.restore({
      version: 1,
      agents: {
        antigravity: {
          account: { kind: 'account', label: 'Google AI Ultra', email: null, tier: '20x' },
          limits: [staleLimit],
          signIn: 'oauth-personal',
        },
        'antigravity~work': {
          account: { kind: 'account', label: 'Google AI Pro', email: null },
          limits: [staleLimit],
          signIn: 'oauth-personal',
        },
      },
    })

    expect(agents.status('antigravity')).toMatchObject({
      account: { kind: 'account', label: 'Google AI Ultra', email: null, tier: '20x' },
      limits: [],
      limitsReason: 'vendor-disallows',
      capabilities: { reports: false },
    })
    expect(agents.status('antigravity~work')).toMatchObject({
      account: { kind: 'account', label: 'Google AI Pro', email: null },
      limits: [],
      limitsReason: 'vendor-disallows',
      capabilities: { reports: false },
    })
    // Pruned limits are written back immediately so stale rings never reappear on restart.
    const persisted = remembered.at(-1)
    expect(persisted?.agents.antigravity?.limits).toEqual([])
    expect(persisted?.agents.antigravity?.account).toEqual({
      kind: 'account',
      label: 'Google AI Ultra',
      email: null,
      tier: '20x',
    })
    expect(persisted?.agents['antigravity~work']?.limits).toEqual([])
  })

  it('reports console-managed limitsReason when signed in with an API key', async () => {
    const { agents } = await makeAntigravityManager({ envKeySet: true })
    agents.restore({
      version: 1,
      agents: {
        antigravity: {
          account: null,
          limits: [],
        },
      },
    })
    expect(agents.status('antigravity')).toMatchObject({
      limitsReason: 'console-managed',
      capabilities: { reports: false },
    })
  })
})
