import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccount, AgentStatus, HostEvent, PlanLimit } from '@shared/agent-host'
import type { PortConnectionState } from '@shared/port-rpc'
import type { RemoteStatus } from '@shared/remote/status'
import { limitRows } from '@shared/session-groups'
import type { TrayHostAgent, TrayHostAgents, TrayPanelApi } from '@shared/tray'
import { agentsWithNewestLimits, initTrayPanel, useTrayPanelStore } from './tray-panel'

const NOW = 1_000_000

function planLimit(usedPercent: number, observedAt: number): PlanLimit {
  return {
    window: 'five_hour',
    label: '5-hour',
    usedPercent,
    resetsAt: NOW + 3_600_000,
    state: usedPercent >= 100 ? 'reached' : usedPercent >= 80 ? 'warning' : 'ok',
    observedAt,
  }
}

function localAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    harnessId: 'claude-code',
    harnessName: 'Claude Code',
    isDefault: true,
    hidden: false,
    apiKey: null,
    state: 'ready',
    version: '1.0.0',
    package: null,
    signIn: 'signed-in',
    authMethods: [],
    canLogout: true,
    account: { kind: 'account', label: 'Claude Max', email: 'alice@example.com', tier: '5x' },
    limits: [planLimit(30, 100)],
    detail: null,
    installUrl: null,
    progress: [],
    launchCommand: 'claude',
    binaryOverride: null,
    binaryCommand: null,
    update: null,
    updateCheckedAt: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: null,
    configDir: null,
    kettuServer: { runs: false, active: null },
    capabilities: {
      loadSession: false,
      listSessions: false,
      resumeSession: false,
      closeSession: false,
      deleteSession: false,
      forkSession: false,
      forkAtMessage: false,
      steering: false,
      reports: true,
      context: false,
      liveContext: false,
      account: true,
      mcpHttp: null,
      prompt: null,
    },
    ...overrides,
  }
}

function remoteAgent(overrides: Partial<TrayHostAgent> = {}): TrayHostAgent {
  return {
    id: 'claude-code',
    harnessId: 'claude-code',
    account: { kind: 'account', label: 'Claude Max', email: 'alice@example.com', tier: '5x' },
    limits: [planLimit(75, 200)],
    ...overrides,
  }
}

function fakeRemoteStatus(): RemoteStatus {
  return {
    state: 'off',
    hostName: 'This Mac',
    systemName: 'This Mac',
    plainTextKey: false,
    devices: [],
    online: [],
    direct: { state: 'off' },
    relay: { state: 'off' },
    ownRelayKeyEnd: null,
    account: null,
  }
}

interface FakeTrayEnv {
  emitAgentEvent(event: HostEvent): void
  emitConnection(state: PortConnectionState): void
  emitHostAgents(hosts: TrayHostAgents[]): void
  resolveInitialHostAgents(hosts: TrayHostAgents[]): void
}

function installFakeTrayEnv(
  options: {
    localAgents?: AgentStatus[]
    initialHostAgents?: TrayHostAgents[]
    deferHostAgents?: boolean
  } = {},
): FakeTrayEnv {
  let agentEventListener: ((event: HostEvent) => void) | null = null
  let connectionListener: ((state: PortConnectionState) => void) | null = null
  let hostAgentsListener: ((hosts: TrayHostAgents[]) => void) | null = null
  let resolveHostAgents!: (hosts: TrayHostAgents[]) => void
  const hostAgentsPromise = options.deferHostAgents
    ? new Promise<TrayHostAgents[]>((resolve) => {
        resolveHostAgents = resolve
      })
    : Promise.resolve(options.initialHostAgents ?? [])

  const api: TrayPanelApi = {
    platform: 'darwin',
    client: 'desktop',
    systemLocale: 'en',
    settings: { get: vi.fn(), onChanged: () => () => {} },
    themes: { get: vi.fn(), onChanged: () => () => {} },
    remote: {
      status: vi.fn(async () => fakeRemoteStatus()),
      onChanged: () => () => {},
    },
    agents: {
      request: vi.fn(async (method: string) => {
        if (method === 'sessions.list') return []
        if (method === 'agents.list') return options.localAgents ?? []
        return undefined
      }) as TrayPanelApi['agents']['request'],
      onEvent: (listener) => {
        agentEventListener = listener
        return () => {
          if (agentEventListener === listener) agentEventListener = null
        }
      },
      onConnection: (listener) => {
        connectionListener = listener
        return () => {
          if (connectionListener === listener) connectionListener = null
        }
      },
    },
    tray: {
      open: vi.fn(),
      quit: vi.fn(),
      hide: vi.fn(),
      resize: vi.fn(),
      onShown: () => () => {},
      hostAgents: vi.fn(() => hostAgentsPromise),
      onHostAgentsChanged: (listener) => {
        hostAgentsListener = listener
        return () => {
          if (hostAgentsListener === listener) hostAgentsListener = null
        }
      },
    },
  }

  vi.stubGlobal('window', { kettu: api })
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })

  return {
    emitAgentEvent: (event) => agentEventListener?.(event),
    emitConnection: (state) => connectionListener?.(state),
    emitHostAgents: (hosts) => hostAgentsListener?.(hosts),
    resolveInitialHostAgents: (hosts) => resolveHostAgents(hosts),
  }
}

describe('agentsWithNewestLimits', () => {
  it('picks a newer remote host reading for the same identified account', () => {
    const merged = agentsWithNewestLimits(
      [localAgent({ limits: [planLimit(25, 100)] })],
      [
        {
          hostId: 'host-a',
          agents: [
            remoteAgent({
              account: {
                kind: 'account',
                label: 'Claude Max',
                email: 'ALICE@EXAMPLE.COM ',
                tier: '5x',
              },
              limits: [planLimit(78, 250)],
            }),
          ],
        },
      ],
    )
    const rows = limitRows(merged, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.limit.usedPercent).toBe(78)
    expect(rows[0]!.limit.observedAt).toBe(250)
  })

  it('populates limits from a connected remote host when the local agent has no reading yet', () => {
    const merged = agentsWithNewestLimits(
      [localAgent({ limits: [] })],
      [{ hostId: 'host-a', agents: [remoteAgent({ limits: [planLimit(62, 200)] })] }],
    )
    const rows = limitRows(merged, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.limit.usedPercent).toBe(62)
  })

  it('keeps the local reading when local is newer or when no remote host is connected', () => {
    const local = localAgent({ limits: [planLimit(85, 400)] })
    const withOlderRemote = agentsWithNewestLimits(
      [local],
      [{ hostId: 'host-a', agents: [remoteAgent({ limits: [planLimit(40, 200)] })] }],
    )
    expect(limitRows(withOlderRemote, NOW)[0]!.limit.usedPercent).toBe(85)

    const withoutRemote = agentsWithNewestLimits([local], [])
    expect(limitRows(withoutRemote, NOW)[0]!.limit.usedPercent).toBe(85)
  })

  it('does not merge unidentified accounts across distinct hosts', () => {
    const unidentifiedCases: (AgentAccount | null)[] = [
      null,
      { kind: 'api_key', label: 'Anthropic API key', email: 'alice@example.com' },
      { kind: 'account', label: 'Claude Max', email: null },
      { kind: 'account', label: 'Claude Max', email: '   ' },
    ]
    for (const account of unidentifiedCases) {
      const merged = agentsWithNewestLimits(
        [localAgent({ account, limits: [planLimit(20, 100)] })],
        [{ hostId: 'host-a', agents: [remoteAgent({ account, limits: [planLimit(95, 500)] })] }],
      )
      expect(limitRows(merged, NOW)[0]!.limit.usedPercent).toBe(20)
    }
  })

  it('does not merge different accounts, plans, tiers, or harnesses', () => {
    const merged = agentsWithNewestLimits(
      [localAgent({ limits: [planLimit(20, 100)] })],
      [
        {
          hostId: 'host-a',
          agents: [
            remoteAgent({
              account: {
                kind: 'account',
                label: 'Claude Max',
                email: 'bob@example.com',
                tier: '5x',
              },
              limits: [planLimit(90, 500)],
            }),
            remoteAgent({
              id: 'claude-code~work',
              account: {
                kind: 'account',
                label: 'Claude Max',
                email: 'alice@example.com',
                tier: '20x',
              },
              limits: [planLimit(88, 500)],
            }),
            remoteAgent({
              id: 'codex',
              harnessId: 'codex',
              account: {
                kind: 'account',
                label: 'Claude Max',
                email: 'alice@example.com',
                tier: '5x',
              },
              limits: [planLimit(87, 500)],
            }),
          ],
        },
      ],
    )
    expect(limitRows(merged, NOW)[0]!.limit.usedPercent).toBe(20)
  })
})

describe('initTrayPanel cross-host plan limits', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    useTrayPanelStore.setState({
      connection: null,
      loaded: false,
      sessions: {},
      details: {},
      agents: [],
      hostAgents: [],
      remote: null,
      reviewing: null,
      shown: 0,
      answeredElsewhere: null,
    })
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    vi.unstubAllGlobals()
  })

  it('applies live remote updates and falls back cleanly when a remote host disconnects', async () => {
    const env = installFakeTrayEnv({
      localAgents: [localAgent({ limits: [planLimit(30, 100)] })],
      initialHostAgents: [
        { hostId: 'host-a', agents: [remoteAgent({ limits: [planLimit(64, 200)] })] },
      ],
    })
    dispose = await initTrayPanel()
    env.emitConnection('connected')
    await Promise.resolve()
    await Promise.resolve()

    const currentPercent = () => {
      const { agents, hostAgents } = useTrayPanelStore.getState()
      return limitRows(agentsWithNewestLimits(agents, hostAgents), NOW)[0]!.limit.usedPercent
    }

    expect(currentPercent()).toBe(64)

    // Live remote push updates the shown figure.
    env.emitHostAgents([
      { hostId: 'host-a', agents: [remoteAgent({ limits: [planLimit(88, 300)] })] },
      { hostId: 'host-b', agents: [remoteAgent({ limits: [planLimit(50, 150)] })] },
    ])
    expect(currentPercent()).toBe(88)

    // host-a disconnects: falls back to host-b (newer than local).
    env.emitHostAgents([
      { hostId: 'host-b', agents: [remoteAgent({ limits: [planLimit(50, 150)] })] },
    ])
    expect(currentPercent()).toBe(50)

    // host-b disconnects: falls back cleanly to local reading.
    env.emitHostAgents([])
    expect(currentPercent()).toBe(30)

    // Newer local reading beats an older remote host that reconnects later.
    env.emitAgentEvent({
      type: 'agent.status',
      status: localAgent({ limits: [planLimit(92, 500)] }),
    })
    env.emitHostAgents([
      { hostId: 'host-a', agents: [remoteAgent({ limits: [planLimit(40, 250)] })] },
    ])
    expect(currentPercent()).toBe(92)
  })

  it('keeps live updates that arrive before the initial hostAgents() snapshot resolves', async () => {
    const env = installFakeTrayEnv({
      localAgents: [localAgent({ limits: [planLimit(20, 100)] })],
      deferHostAgents: true,
    })
    const init = initTrayPanel()
    // Push arrives before initial invoke resolves.
    env.emitHostAgents([
      { hostId: 'host-a', agents: [remoteAgent({ limits: [planLimit(84, 400)] })] },
    ])
    env.resolveInitialHostAgents([])
    dispose = await init

    expect(useTrayPanelStore.getState().hostAgents[0]!.agents[0]!.limits[0]!.usedPercent).toBe(84)
  })
})
