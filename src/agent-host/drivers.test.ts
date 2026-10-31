// Starting an agent through its protocol's driver: the dispatch, the direct reads a connection
// may answer in place of the reports, and the processes a driver that runs in the host spawns.

import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ContextBreakdown, PlanLimit } from '@shared/agent-host'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { ACP_DRIVER } from './acp/driver'
import type { AgentTrees } from './agent-trees'
import { AgentManager, type AgentManagerDeps } from './agents'
import {
  buildCatalog,
  CLAUDE_CODE,
  detectAgent,
  fakeAgent,
  OPENCODE,
  type AgentDefinition,
} from './catalog'
import { CLAUDE_SDK_DRIVER } from './claude/driver'
import { CODEX_DRIVER } from './codex/driver'
import type { AgentConnection, AgentInit, OpenedSession } from './connection'
import { Diagnostics } from './diagnostics'
import type { AgentDriver, HostedContext, HostedDriver, ProcessDriver } from './driver'
import { driverOf } from './drivers'
import { EnvironmentService } from './shell-env'
import {
  FAKE_AGENT_MAIN,
  inProcessLauncher,
  loadFakeAgent,
  startTestHost,
  type FakeAgentModule,
  type TestHost,
} from './testing/harness'

let module: FakeAgentModule

beforeAll(async () => {
  module = await loadFakeAgent()
})

const stopping: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const stop of stopping.splice(0)) await stop()
})

function manager(
  drivers: AgentManagerDeps['drivers'],
  {
    def = fakeAgent(FAKE_AGENT_MAIN),
    trees,
    timings = {},
  }: { def?: AgentDefinition; trees?: AgentTrees; timings?: AgentManagerDeps['timings'] } = {},
) {
  const diagnostics = new Diagnostics()
  const agents = new AgentManager({
    catalog: [def],
    platform: process.platform,
    nodeRuntime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform: process.platform,
      nodeRuntime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
      baseEnv: process.env,
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    }),
    diagnostics,
    launcher: inProcessLauncher(module),
    settings: () => ({
      locale: 'en',
      agents: {},
      addedAgents: [],
      proxy: { mode: 'environment' },
      git: { backgroundFetch: false },
      mcp: DEFAULT_SETTINGS.mcp,
      usage: { fromComputer: false },
      sessionTitles: true,
    }),
    reportsDir: path.join(os.tmpdir(), 'kettu-agent-reports'),
    adaptersDir: path.join(os.tmpdir(), 'kettu-no-adapters'),
    detect: detectAgent,
    probeCli: async () => ({ error: 'not asked in tests' }),
    ...(drivers ? { drivers } : {}),
    ...(trees ? { trees } : {}),
    timings,
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  const exited: AgentId[] = []
  agents.hooks = {
    liveSessions: () => 0,
    agentExited: (agentId) => exited.push(agentId),
    signedIn: () => {},
    optionsKnown: () => true,
    optionsSeen: () => {},
    configChanged: () => {},
  }
  stopping.push(() => agents.stopAll())
  const sent = (agentId: AgentId) =>
    diagnostics
      .agentRecords(agentId)
      .traffic.filter((r) => r.direction === 'out')
      .map((r) => r.method)
  return { agents, diagnostics, exited, sent }
}

/** ACP over the fake agent, with `extra` added to each connection it makes. */
function acpWith(
  extra: Partial<Pick<AgentConnection, 'readLimits' | 'readContext'>>,
  reads: ProcessDriver['reads'] = {},
): ProcessDriver & { connects: number } {
  const driver = {
    kind: 'process' as const,
    reads,
    connects: 0,
    connect: (...args: Parameters<ProcessDriver['connect']>) => {
      driver.connects++
      return Object.assign(ACP_DRIVER.connect(...args), extra)
    },
  }
  return driver
}

const LIMIT: PlanLimit = {
  window: 'five_hour',
  label: '5-hour',
  usedPercent: 42,
  resetsAt: null,
  state: 'ok',
  observedAt: 1,
}

describe('driverOf', () => {
  it('starts Claude Code through its SDK, Codex through its app-server, the rest over ACP', () => {
    const own: Partial<Record<string, AgentDriver>> = {
      'claude-code': CLAUDE_SDK_DRIVER,
      codex: CODEX_DRIVER,
    }
    for (const def of buildCatalog(FAKE_AGENT_MAIN)) {
      expect(driverOf(def)).toBe(own[def.id] ?? ACP_DRIVER)
    }
    expect(CLAUDE_SDK_DRIVER.reads).toEqual({ limits: true, context: true })
    expect(CODEX_DRIVER.reads).toEqual({ limits: true })
  })

  it("takes a test's protocol over the catalog's, and its driver over the built-in one", () => {
    expect(driverOf(CLAUDE_CODE, { protocols: { 'claude-code': 'acp' } })).toBe(ACP_DRIVER)
    const own = acpWith({})
    expect(driverOf(OPENCODE, { drivers: { acp: own } })).toBe(own)
    const sdk = hostedDriver([])
    expect(driverOf(CLAUDE_CODE, { drivers: { 'claude-sdk': sdk } })).toBe(sdk)
  })
})

describe('agent drivers', () => {
  it("starts an agent through its protocol's driver", async () => {
    const driver = acpWith({})
    const { agents } = manager({ acp: driver })
    const runtime = await agents.ensureReady('fake-agent')
    expect(driver.connects).toBe(1)
    expect(runtime.init.name).toBe('Fake agent')
  })

  it('reads the plan limits from the connection, without a hidden session', async () => {
    const readLimits = vi.fn(async () => [LIMIT])
    const { agents, sent } = manager({ acp: acpWith({ readLimits }) })
    await agents.refreshLimits('fake-agent')
    expect(readLimits).toHaveBeenCalledTimes(1)
    expect(agents.limitsOf('fake-agent')).toEqual([LIMIT])
    expect(sent('fake-agent')).not.toContain('session/new')
  })

  it("runs the agent's report for a connection that does not read the limits", async () => {
    const { agents, sent } = manager({ acp: acpWith({}) })
    await agents.refreshLimits('fake-agent')
    expect(sent('fake-agent')).toContain('session/new')
    expect(sent('fake-agent')).toContain('session/prompt')
  })

  it('offers limits and context with no report when the driver reads them', async () => {
    const def = { ...fakeAgent(FAKE_AGENT_MAIN), id: 'opencode' as const }
    const plain = manager(undefined, { def })
    expect(plain.agents.status('opencode').capabilities).toMatchObject({
      reports: false,
      context: false,
    })
    const readLimits = vi.fn(async () => [LIMIT])
    const reading = manager(
      { acp: acpWith({ readLimits }, { limits: true, context: true }) },
      { def },
    )
    expect(reading.agents.status('opencode').capabilities).toMatchObject({
      reports: true,
      context: true,
    })
    await reading.agents.refreshLimits('opencode')
    expect(reading.agents.limitsOf('opencode')).toEqual([LIMIT])
  })
})

describe('direct context', () => {
  let current: TestHost | null = null

  afterEach(async () => {
    await current?.stop()
    current = null
  })

  it("reads a session's context from the connection, without a fork", async () => {
    const breakdown: ContextBreakdown = {
      model: 'fake',
      used: 10,
      size: 100,
      categories: [],
      lists: [],
      observedAt: 1,
    }
    const readContext = vi.fn(async () => breakdown)
    current = await startTestHost({ drivers: { acp: acpWith({ readContext }) } })
    const t = current
    const port = t.connect()
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
      options: { __ultracode: true },
    })
    await port.open(summary.id)
    await port.request('sessions.prompt', {
      sessionId: summary.id,
      content: [{ type: 'text', text: 'Fix the flaky login test' }],
    })
    await port.untilStatus(summary.id, 'ready')
    expect(await port.request('sessions.context', { sessionId: summary.id })).toEqual(breakdown)
    const acpSessionId = port.thread(summary.id).session.acpSessionId
    expect(readContext).toHaveBeenCalledWith(acpSessionId, t.project, {
      mcpServers: [],
      ultracode: true,
    })
    const forks = t.host.diagnostics
      .agentRecords('fake-agent')
      .traffic.filter((r) => r.direction === 'out' && r.method === 'session/fork')
    expect(forks).toEqual([])
  })
})

const INIT: AgentInit = {
  name: 'Hosted agent',
  version: '1.0.0',
  capabilities: {
    loadSession: false,
    listSessions: false,
    resumeSession: false,
    closeSession: false,
    deleteSession: false,
    forkSession: false,
    forkAtMessage: false,
    ownTitles: null,
    logout: false,
    steering: false,
    mcpHttp: false,
    prompt: { image: false, audio: false, embeddedContext: false },
  },
  authMethods: [],
  raw: null,
}

// A process that runs until its stdin closes, as Claude Code's CLI does in stream-json mode.
const UNTIL_EOF = ['-e', 'process.stdin.resume()']
// One that runs on after its stdin closes.
const PAST_EOF = ['-e', 'setInterval(() => {}, 1000)']

/** A connection that runs in the host and spawns one process for each session it opens. */
class HostedConnection implements Partial<AgentConnection> {
  readonly hiddenSessions = false
  private closedNow = false
  private settle: () => void = () => {}
  readonly closed = new Promise<void>((resolve) => (this.settle = resolve))
  readonly children: ReturnType<HostedContext['spawn']>[] = []

  constructor(
    readonly context: HostedContext,
    private readonly args: string[],
  ) {}

  get isClosed(): boolean {
    return this.closedNow
  }

  close(): void {
    this.closedNow = true
    this.settle()
  }

  async initialize(): Promise<AgentInit> {
    return INIT
  }

  async newSession(cwd: string): Promise<OpenedSession> {
    this.children.push(
      this.context.spawn({
        command: process.execPath,
        args: this.args,
        cwd,
        env: this.context.env,
      }),
    )
    return { sessionId: `s-${this.children.length}`, config: [] }
  }
}

function hostedDriver(args: string[]): HostedDriver & { connections: HostedConnection[] } {
  const driver = {
    kind: 'hosted' as const,
    connections: [] as HostedConnection[],
    connect: (context: HostedContext) => {
      const connection = new HostedConnection(context, args)
      driver.connections.push(connection)
      return connection as unknown as AgentConnection
    },
  }
  return driver
}

function treesStub() {
  const calls: string[] = []
  const trees = {
    launched: (id: { pid: number }) => calls.push(`launched ${id.pid}`),
    active: () => {},
    note: async (id: { pid: number }) => void calls.push(`note ${id.pid}`),
    reap: async (id: { pid: number }) => void calls.push(`reap ${id.pid}`),
  }
  return { calls, trees: trees as unknown as AgentTrees }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${check.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('a driver that runs in the host', () => {
  async function started(args = UNTIL_EOF, timings: AgentManagerDeps['timings'] = {}) {
    const driver = hostedDriver(args)
    const { calls, trees } = treesStub()
    const m = manager({ acp: driver as AgentDriver }, { trees, timings })
    const runtime = await m.agents.ensureReady('fake-agent')
    await runtime.connection.newSession(os.tmpdir())
    const connection = driver.connections[0]!
    const pid = connection.children[0]!.pid!
    return { ...m, calls, connection, pid }
  }

  it('records the processes it spawns as the agent', async () => {
    const { agents, calls, pid } = await started()
    expect(agents.status('fake-agent').state).toBe('ready')
    expect(agents.processes()).toEqual([
      { agentId: 'fake-agent', pid, startedAt: expect.any(Number) },
    ])
    expect(calls).toEqual([`launched ${pid}`])
  })

  it('stops them, and closes its connection, when the agent stops', async () => {
    const { agents, calls, connection, pid } = await started()
    await agents.stop('fake-agent')
    expect(connection.isClosed).toBe(true)
    expect(connection.children[0]!.exitCode).toBe(0)
    expect(agents.processes()).toEqual([])
    expect(calls).toContain(`note ${pid}`)
    expect(calls).toContain(`reap ${pid}`)
    expect(agents.status('fake-agent').state).toBe('available')
  })

  it('kills them when a quit cannot wait', async () => {
    const { agents, connection } = await started(PAST_EOF, { quitStopMs: 50 })
    const child = connection.children[0]!
    await agents.stopAll()
    expect(connection.isClosed).toBe(true)
    await until(() => child.exitCode !== null || child.signalCode !== null)
    expect(child.signalCode).toBe(process.platform === 'win32' ? null : 'SIGKILL')
  })

  it('reaps one that exits by itself', async () => {
    const { agents, calls, connection, pid } = await started()
    connection.children[0]!.stdin!.end()
    await until(() => agents.processes().length === 0)
    expect(calls).toContain(`reap ${pid}`)
    expect(agents.status('fake-agent').state).toBe('ready')
  })

  it('counts a connection that closes by itself as an exit, and stops what it ran', async () => {
    const { agents, connection, exited } = await started()
    connection.close()
    await until(() => exited.length > 0)
    expect(exited).toEqual(['fake-agent'])
    await until(() => agents.processes().length === 0)
    expect(agents.status('fake-agent').state).toBe('available')
    expect(() =>
      connection.context.spawn({ command: process.execPath, args: UNTIL_EOF, env: {} }),
    ).toThrow('The agent is stopping')
  })
})
