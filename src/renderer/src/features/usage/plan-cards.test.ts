import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import { newestReadings, ownKey, type HostAgentList } from '@renderer/lib/plan-readings'
import { usageCards } from './plan-cards'

const NOW = 1_764_000_000_000
const HOUR = 3_600_000

function makeLimit(overrides: Partial<PlanLimit> = {}): PlanLimit {
  return {
    window: 'five_hour',
    label: '5-hour',
    usedPercent: 35,
    resetsAt: NOW + 2 * HOUR,
    observedAt: NOW - 60_000,
    state: 'ok',
    ...overrides,
  }
}

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'codex',
    harnessId: 'codex',
    harnessName: 'Codex',
    name: 'Codex',
    isDefault: true,
    registered: true,
    disabled: false,
    hidden: false,
    apiKey: null,
    state: 'ready',
    version: '1.0.0',
    package: null,
    signIn: 'signed-in',
    authMethods: [],
    canLogout: true,
    account: { kind: 'account', label: 'ChatGPT Plus', email: 'alex@example.com' },
    limits: [makeLimit()],
    balances: [],
    detail: null,
    installUrl: null,
    progress: [],
    launchCommand: 'codex',
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
      loadSession: true,
      listSessions: true,
      resumeSession: true,
      closeSession: true,
      deleteSession: true,
      forkSession: false,
      forkAtMessage: false,
      steering: false,
      reports: true,
      context: true,
      liveContext: false,
      account: true,
      mcpHttp: null,
      prompt: null,
    },
    ...overrides,
  }
}

function makeAntigravity(
  overrides: Partial<AgentStatus> = {},
  limits: PlanLimit[] = [
    makeLimit({
      window: 'five_hour_gemini',
      label: '5-hour · Gemini',
      usedPercent: 24,
      resetsAt: NOW + 3 * HOUR,
    }),
  ],
): AgentStatus {
  return makeAgent({
    id: 'antigravity',
    harnessId: 'antigravity',
    harnessName: 'Google Antigravity',
    name: 'Google Antigravity',
    account: { kind: 'account', label: 'Google AI Ultra', email: null },
    limits,
    ...overrides,
  })
}

describe('usageCards multi-host unidentified account disambiguation', () => {
  it('labels unidentified multi-host cards with showHostLabel while keeping identified accounts merged', () => {
    const sharedReset = NOW + 3 * HOUR
    const hosts: HostAgentList[] = [
      {
        hostId: null,
        agents: [
          makeAgent({ limits: [makeLimit({ usedPercent: 38, observedAt: NOW - 60_000 })] }),
          makeAntigravity({}, [
            makeLimit({
              window: 'five_hour_gemini',
              label: '5-hour · Gemini',
              usedPercent: 24,
              resetsAt: sharedReset,
            }),
          ]),
        ],
      },
      {
        hostId: 'host-studio',
        agents: [
          makeAgent({ limits: [makeLimit({ usedPercent: 31, observedAt: NOW - 180_000 })] }),
          makeAntigravity({}, [
            makeLimit({
              window: 'five_hour_gemini',
              label: '5-hour · Gemini',
              usedPercent: 68,
              resetsAt: sharedReset,
            }),
          ]),
        ],
      },
    ]

    const { cards } = usageCards(hosts, newestReadings(hosts), {}, {}, NOW)
    expect(cards).toHaveLength(3)

    const codex = cards.find((c) => c.harnessId === 'codex')!
    expect(codex.email).toBe('alex@example.com')
    expect(codex.places.map((p) => p.hostId)).toEqual([null, 'host-studio'])
    expect(codex.showHostLabel).toBe(false)

    const agyCards = cards.filter((c) => c.harnessId === 'antigravity')
    expect(agyCards).toHaveLength(2)
    expect(agyCards.map((c) => c.key)).toEqual([
      ownKey(null, 'antigravity'),
      ownKey('host-studio', 'antigravity'),
    ])
    expect(agyCards.map((c) => c.hostId)).toEqual([null, 'host-studio'])
    expect(agyCards.every((c) => c.showHostLabel)).toBe(true)
    expect(agyCards.map((c) => c.rings[0]!.percent)).toEqual([24, 68])
  })

  it('omits showHostLabel in single-host views and when only one host has an unidentified harness', () => {
    const singleHost: HostAgentList[] = [
      {
        hostId: null,
        agents: [makeAgent(), makeAntigravity()],
      },
    ]
    const singleResult = usageCards(singleHost, newestReadings(singleHost), {}, {}, NOW)
    expect(singleResult.cards).toHaveLength(2)
    expect(singleResult.cards.every((c) => !c.showHostLabel)).toBe(true)

    const onlyOneHostHasAgy: HostAgentList[] = [
      { hostId: null, agents: [makeAgent(), makeAntigravity()] },
      { hostId: 'host-studio', agents: [makeAgent()] },
    ]
    const mixedResult = usageCards(
      onlyOneHostHasAgy,
      newestReadings(onlyOneHostHasAgy),
      {},
      {},
      NOW,
    )
    expect(mixedResult.cards).toHaveLength(2)
    expect(mixedResult.cards.every((c) => !c.showHostLabel)).toBe(true)
  })

  it('omits showHostLabel when multiple unidentified agents of the same harness live on the same host', () => {
    const sameHost: HostAgentList[] = [
      {
        hostId: null,
        agents: [
          makeAntigravity({ id: 'antigravity', name: 'Google Antigravity' }),
          makeAntigravity({ id: 'antigravity~work', name: 'Antigravity Work' }),
        ],
      },
      { hostId: 'host-studio', agents: [makeAgent()] },
    ]
    const { cards } = usageCards(sameHost, newestReadings(sameHost), {}, {}, NOW)
    const agyCards = cards.filter((c) => c.harnessId === 'antigravity')
    expect(agyCards).toHaveLength(2)
    expect(agyCards.every((c) => !c.showHostLabel)).toBe(true)
  })

  it('marks matching OpenCode providers across hosts with showHostLabel but not distinct providers', () => {
    const opencodeLocal = makeAgent({
      id: 'opencode',
      harnessId: 'opencode',
      harnessName: 'OpenCode',
      name: 'OpenCode',
      account: null,
      limits: [],
      providers: [
        {
          id: 'copilot',
          name: 'GitHub Copilot',
          methods: [],
          accounts: [],
          loginCommand: 'opencode auth login',
          usage: {
            state: 'ready',
            limits: [makeLimit({ usedPercent: 20 })],
            balances: [],
            observedAt: NOW,
            error: null,
          },
        },
        {
          id: 'zai',
          name: 'Z.AI',
          methods: [],
          accounts: [],
          loginCommand: 'opencode auth login',
          usage: {
            state: 'ready',
            limits: [makeLimit({ usedPercent: 10 })],
            balances: [],
            observedAt: NOW,
            error: null,
          },
        },
      ],
    })
    const opencodeRemote = makeAgent({
      id: 'opencode',
      harnessId: 'opencode',
      harnessName: 'OpenCode',
      name: 'OpenCode',
      account: null,
      limits: [],
      providers: [
        {
          id: 'copilot',
          name: 'GitHub Copilot',
          methods: [],
          accounts: [],
          loginCommand: 'opencode auth login',
          usage: {
            state: 'ready',
            limits: [makeLimit({ usedPercent: 70 })],
            balances: [],
            observedAt: NOW,
            error: null,
          },
        },
      ],
    })
    const hosts: HostAgentList[] = [
      { hostId: null, agents: [opencodeLocal] },
      { hostId: 'host-studio', agents: [opencodeRemote] },
    ]
    const { cards } = usageCards(hosts, newestReadings(hosts), {}, {}, NOW)
    const copilotCards = cards.filter((c) => c.plan === 'GitHub Copilot')
    const zaiCards = cards.filter((c) => c.plan === 'Z.AI')
    expect(copilotCards).toHaveLength(2)
    expect(copilotCards.every((c) => c.showHostLabel)).toBe(true)
    expect(zaiCards).toHaveLength(1)
    expect(zaiCards[0]!.showHostLabel).toBe(false)
  })
})
