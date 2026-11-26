import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import { onHost } from '@renderer/lib/host-paths'
import {
  accountAgents,
  focusUnidentifiedAccounts,
  newestReadings,
  ownKey,
  type HostAgentList,
} from '@renderer/lib/plan-readings'
import { resolveActiveHostId } from '@renderer/lib/active-host'
import { currentCard, planCards } from './model'

const NOW = 1_764_000_000_000
const HOUR = 3_600_000
const REMOTE_HOST = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'

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

describe('account planCards and currentCard host-scoped behavior', () => {
  it('propagates hostScoped on focused unidentified cards and resolves fallback ownKey across hosts', () => {
    const hosts: HostAgentList[] = [
      {
        hostId: null,
        agents: [
          makeAgent(),
          makeAgent({
            id: 'antigravity',
            harnessId: 'antigravity',
            harnessName: 'Google Antigravity',
            name: 'Google Antigravity',
            account: { kind: 'account', label: 'Google AI Ultra', email: null },
            limits: [
              makeLimit({ window: 'five_hour_gemini', label: '5-hour · Gemini', usedPercent: 24 }),
            ],
          }),
        ],
      },
      {
        hostId: 'host-studio',
        agents: [
          makeAgent(),
          makeAgent({
            id: 'antigravity',
            harnessId: 'antigravity',
            harnessName: 'Google Antigravity',
            name: 'Google Antigravity',
            account: { kind: 'account', label: 'Google AI Ultra', email: null },
            limits: [
              makeLimit({ window: 'five_hour_gemini', label: '5-hour · Gemini', usedPercent: 76 }),
            ],
          }),
        ],
      },
    ]

    const focused = focusUnidentifiedAccounts(accountAgents(hosts, newestReadings(hosts)), null)
    const cards = planCards(focused, NOW)
    expect(cards).toHaveLength(2)

    const codex = cards.find((c) => c.agentId === 'codex')!
    const agy = cards.find((c) => c.agentId === 'antigravity')!
    expect(codex.hostScoped).toBe(false)
    expect(agy.hostScoped).toBe(true)
    expect(agy.hostId).toBeNull()

    // Exact match still wins
    expect(currentCard(cards, ownKey(null, 'antigravity'))?.key).toBe(ownKey(null, 'antigravity'))

    // A previously kept unidentified key from another host resolves to the newly focused card
    expect(currentCard(cards, ownKey('host-studio', 'antigravity'))?.key).toBe(
      ownKey(null, 'antigravity'),
    )

    // Identified account keys never fall back to another card
    expect(currentCard(cards, 'account:codex\nother@example.com\nChatGPT Plus\n')).toBeNull()
  })

  it('resolves the active host from the focused session, New session, or global page pane', () => {
    const remotePath = onHost(REMOTE_HOST, '/Users/alex/studio-api')
    const localPath = '/Users/alex/kettu-workbench'

    // Active session on remote host
    expect(
      resolveActiveHostId({
        main: { kind: 'session', sessionId: 's-remote' },
        focusedPaneView: { kind: 'session', sessionId: 's-remote', projectPath: remotePath },
        projectPath: localPath,
        sessionHost: (id) => (id === 's-remote' ? REMOTE_HOST : undefined),
      }),
    ).toBe(REMOTE_HOST)

    // Usage page stays anchored to the focused pane's host
    expect(
      resolveActiveHostId({
        main: { kind: 'usage' },
        focusedPaneView: { kind: 'session', sessionId: 's-remote', projectPath: remotePath },
        projectPath: localPath,
        sessionHost: (id) => (id === 's-remote' ? REMOTE_HOST : undefined),
      }),
    ).toBe(REMOTE_HOST)

    // New session with a local project resolves to local (null)
    expect(
      resolveActiveHostId({
        main: { kind: 'new', agentId: 'antigravity', noProject: false },
        focusedPaneView: {
          kind: 'new',
          agentId: 'antigravity',
          noProject: false,
          projectPath: localPath,
        },
        projectPath: localPath,
        sessionHost: () => undefined,
      }),
    ).toBeNull()

    // Launch with no project or host returns undefined for fallback selection
    expect(
      resolveActiveHostId({
        main: { kind: 'launch' },
        focusedPaneView: { kind: 'new', agentId: null, noProject: false, projectPath: null },
        projectPath: null,
        sessionHost: () => undefined,
      }),
    ).toBeUndefined()
  })
})
