import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import {
  accountAgents,
  accountCardKey,
  accountKey,
  focusUnidentifiedAccounts,
  newestReadings,
  ownKey,
  tightestAccountOf,
  type HostAgentList,
} from './plan-readings'

const NOW = 1_764_000_000_000
const HOUR = 3_600_000

function makeLimit(overrides: Partial<PlanLimit> = {}): PlanLimit {
  return {
    window: 'five_hour',
    label: '5-hour',
    usedPercent: 30,
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
      usedPercent: 25,
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

describe('plan-readings multi-host account identity and compact focus', () => {
  it('continues merging identified accounts across hosts with their newest reading', () => {
    const localCodex = makeAgent({
      limits: [makeLimit({ usedPercent: 38, observedAt: NOW - 2 * 60_000 })],
    })
    const remoteCodex = makeAgent({
      limits: [makeLimit({ usedPercent: 52, observedAt: NOW - 10_000 })],
    })
    const hosts: HostAgentList[] = [
      { hostId: null, agents: [localCodex] },
      { hostId: 'host-studio', agents: [remoteCodex] },
    ]

    const readings = newestReadings(hosts)
    const accounts = accountAgents(hosts, readings)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.key).toBe(accountCardKey(accountKey(localCodex)!))
    expect(accounts[0]!.hostIds).toEqual([null, 'host-studio'])
    expect(accounts[0]!.limits[0]!.usedPercent).toBe(52)

    const focused = focusUnidentifiedAccounts(accounts, null)
    expect(focused).toHaveLength(1)
    expect(focused[0]!.hostIds).toEqual([null, 'host-studio'])
    expect(focused[0]!.hostScoped).toBeUndefined()
  })

  it('never guesses cross-host identity by resetsAt for unidentified accounts', () => {
    const sharedReset = NOW + 3 * HOUR
    const localAgy = makeAntigravity({}, [
      makeLimit({
        window: 'five_hour_gemini',
        label: '5-hour · Gemini',
        usedPercent: 24,
        resetsAt: sharedReset,
        observedAt: NOW - 60_000,
      }),
    ])
    const remoteAgy = makeAntigravity({}, [
      makeLimit({
        window: 'five_hour_gemini',
        label: '5-hour · Gemini',
        usedPercent: 24,
        resetsAt: sharedReset,
        observedAt: NOW - 10_000,
      }),
    ])
    const hosts: HostAgentList[] = [
      { hostId: null, agents: [localAgy] },
      { hostId: 'host-studio', agents: [remoteAgy] },
    ]

    expect(accountKey(localAgy)).toBeNull()
    expect(accountKey(remoteAgy)).toBeNull()
    expect(newestReadings(hosts).size).toBe(0)

    const accounts = accountAgents(hosts, newestReadings(hosts))
    expect(accounts).toHaveLength(2)
    expect(accounts.map((a) => a.key)).toEqual([
      ownKey(null, 'antigravity'),
      ownKey('host-studio', 'antigravity'),
    ])
    expect(accounts.map((a) => a.hostIds)).toEqual([[null], ['host-studio']])
  })

  it('focuses unidentified multi-host harnesses onto the active host while keeping identified accounts merged', () => {
    const hosts: HostAgentList[] = [
      {
        hostId: null,
        agents: [
          makeAgent({ limits: [makeLimit({ usedPercent: 38, observedAt: NOW - 60_000 })] }),
          makeAntigravity({}, [
            makeLimit({
              window: 'five_hour_claude',
              label: '5-hour · Claude',
              usedPercent: 42,
              observedAt: NOW - 60_000,
            }),
          ]),
        ],
      },
      {
        hostId: 'host-studio',
        agents: [
          makeAgent({ limits: [makeLimit({ usedPercent: 30, observedAt: NOW - 120_000 })] }),
          makeAntigravity({}, [
            makeLimit({
              window: 'five_hour_claude',
              label: '5-hour · Claude',
              usedPercent: 82,
              observedAt: NOW - 30_000,
              state: 'warning',
            }),
          ]),
        ],
      },
    ]

    const accounts = accountAgents(hosts, newestReadings(hosts))
    expect(accounts).toHaveLength(3)

    // Active host = local (This Mac)
    const onLocal = focusUnidentifiedAccounts(accounts, null)
    expect(onLocal).toHaveLength(2)
    expect(onLocal[0]!.agent.harnessId).toBe('codex')
    expect(onLocal[0]!.hostScoped).toBeUndefined()
    expect(onLocal[1]!.key).toBe(ownKey(null, 'antigravity'))
    expect(onLocal[1]!.hostId).toBeNull()
    expect(onLocal[1]!.limits[0]!.usedPercent).toBe(42)
    expect(onLocal[1]!.hostScoped).toBe(true)

    // Active host = remote (Mac Studio)
    const onRemote = focusUnidentifiedAccounts(accounts, 'host-studio')
    expect(onRemote).toHaveLength(2)
    expect(onRemote[1]!.key).toBe(ownKey('host-studio', 'antigravity'))
    expect(onRemote[1]!.hostId).toBe('host-studio')
    expect(onRemote[1]!.limits[0]!.usedPercent).toBe(82)
    expect(onRemote[1]!.hostScoped).toBe(true)
  })

  it('falls back to local host, then most recently read host when active host has no matching unidentified harness', () => {
    const hostsWithLocal: HostAgentList[] = [
      {
        hostId: null,
        agents: [
          makeAntigravity({}, [makeLimit({ usedPercent: 20, observedAt: NOW - 5 * 60_000 })]),
        ],
      },
      {
        hostId: 'host-studio',
        agents: [makeAntigravity({}, [makeLimit({ usedPercent: 75, observedAt: NOW - 10_000 })])],
      },
    ]
    const accountsWithLocal = accountAgents(hostsWithLocal, newestReadings(hostsWithLocal))

    // Undefined active host falls back to local
    const fallbackLocalUndefined = focusUnidentifiedAccounts(accountsWithLocal, undefined)
    expect(fallbackLocalUndefined).toHaveLength(1)
    expect(fallbackLocalUndefined[0]!.hostId).toBeNull()
    expect(fallbackLocalUndefined[0]!.hostScoped).toBe(true)

    // Active host without this harness falls back to local
    const fallbackLocalOther = focusUnidentifiedAccounts(accountsWithLocal, 'host-linux')
    expect(fallbackLocalOther).toHaveLength(1)
    expect(fallbackLocalOther[0]!.hostId).toBeNull()
    expect(fallbackLocalOther[0]!.hostScoped).toBe(true)

    // Two remote hosts only (no local): falls back to the most recently read host
    const remoteOnlyHosts: HostAgentList[] = [
      {
        hostId: 'host-a',
        agents: [
          makeAntigravity({}, [makeLimit({ usedPercent: 30, observedAt: NOW - 10 * 60_000 })]),
        ],
      },
      {
        hostId: 'host-b',
        agents: [makeAntigravity({}, [makeLimit({ usedPercent: 60, observedAt: NOW - 30_000 })])],
      },
    ]
    const remoteAccounts = accountAgents(remoteOnlyHosts, newestReadings(remoteOnlyHosts))
    const fallbackNewest = focusUnidentifiedAccounts(remoteAccounts, null)
    expect(fallbackNewest).toHaveLength(1)
    expect(fallbackNewest[0]!.hostId).toBe('host-b')
    expect(fallbackNewest[0]!.hostScoped).toBe(true)
  })

  it('preserves multiple unidentified profiles on the chosen host and leaves single-host harnesses unflagged', () => {
    const singleHost: HostAgentList[] = [
      {
        hostId: null,
        agents: [
          makeAntigravity({ id: 'antigravity', name: 'Google Antigravity' }),
          makeAntigravity({ id: 'antigravity~work', name: 'Antigravity Work' }),
        ],
      },
    ]
    const singleAccounts = accountAgents(singleHost, newestReadings(singleHost))
    const singleFocused = focusUnidentifiedAccounts(singleAccounts, null)
    expect(singleFocused).toHaveLength(2)
    expect(singleFocused.every((a) => !a.hostScoped)).toBe(true)

    const multiHost: HostAgentList[] = [
      ...singleHost,
      {
        hostId: 'host-studio',
        agents: [makeAntigravity({ id: 'antigravity', name: 'Google Antigravity' })],
      },
    ]
    const multiAccounts = accountAgents(multiHost, newestReadings(multiHost))
    const multiFocused = focusUnidentifiedAccounts(multiAccounts, null)
    expect(multiFocused).toHaveLength(2)
    expect(multiFocused.every((a) => a.hostId === null && a.hostScoped === true)).toBe(true)
  })

  it('scopes TightestLimit to the active host for unidentified multi-host harnesses', () => {
    const hosts: HostAgentList[] = [
      {
        hostId: null,
        agents: [
          makeAgent({
            limits: [makeLimit({ window: 'seven_day', label: 'Weekly', usedPercent: 52 })],
          }),
          makeAntigravity({}, [
            makeLimit({ window: 'five_hour_claude', label: '5-hour · Claude', usedPercent: 42 }),
          ]),
        ],
      },
      {
        hostId: 'host-studio',
        agents: [
          makeAgent({
            limits: [
              makeLimit({
                window: 'seven_day',
                label: 'Weekly',
                usedPercent: 48,
                observedAt: NOW - 10 * 60_000,
              }),
            ],
          }),
          makeAntigravity({}, [
            makeLimit({
              window: 'five_hour_claude',
              label: '5-hour · Claude',
              usedPercent: 82,
              state: 'warning',
            }),
          ]),
        ],
      },
    ]
    const accounts = accountAgents(hosts, newestReadings(hosts))

    // Focused on local: Mac Studio's 82% unidentified card does not hijack the sidebar hint
    const localTightest = tightestAccountOf(accounts, NOW, null)
    expect(localTightest?.account.agent.harnessId).toBe('codex')
    expect(localTightest?.limit.usedPercent).toBe(52)

    // Focused on Mac Studio: Mac Studio's 82% card wins
    const remoteTightest = tightestAccountOf(accounts, NOW, 'host-studio')
    expect(remoteTightest?.account.hostId).toBe('host-studio')
    expect(remoteTightest?.account.hostScoped).toBe(true)
    expect(remoteTightest?.limit.usedPercent).toBe(82)
  })
})
