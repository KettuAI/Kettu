// Grok's sign-in and plan come from its own `x.ai/auth/info` and `x.ai/billing`, which are read
// only on a Grok that has them. Its handshake names no version, so the version that runs is the
// one of the program Kettu runs: here the user's own `grok`, as xAI's install script leaves it.

import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from './agents'
import { GROK } from './agents/grok'
import type { AgentConnection, AgentInit } from './connection'
import { Diagnostics } from './diagnostics'
import type { ProcessDriver } from './driver'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

// Grok 1.0.92's `initialize`: no `agentInfo`, its version only in `_meta`.
const INIT: AgentInit = {
  protocolVersion: 1,
  name: null,
  version: null,
  capabilities: {
    loadSession: true,
    listSessions: true,
    resumeSession: true,
    closeSession: true,
    deleteSession: false,
    forkSession: false,
    forkAtMessage: false,
    ownTitles: null,
    logout: false,
    steering: false,
    mcpHttp: true,
    mcpSse: true,
    mcpStdio: true,
    prompt: { image: true, audio: false, embeddedContext: true },
  },
  authMethods: [
    {
      id: 'cached_token',
      name: 'cached_token',
      description: 'Cached token from ~/.grok/auth.json',
      type: 'agent',
      args: [],
      env: {},
    },
    {
      id: 'grok.com',
      name: 'Grok',
      description: 'Sign in with Grok',
      type: 'agent',
      args: [],
      env: {},
    },
  ],
  raw: { _meta: { agentVersion: '1.0.92' } },
}

// Grok 1.0.92's replies, with the account's details replaced.
const REPLIES: Record<string, unknown> = {
  '_x.ai/auth/info': {
    methodId: 'cached_token',
    email: 'someone@example.com',
    firstName: 'Someone',
    lastName: null,
    principalType: 'User',
    userBlockedReason: null,
    teamBlockedReasons: [],
  },
  '_x.ai/billing': {
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-11-24T12:26:43.231+00:00',
        end: '2026-12-01T12:26:43.231+00:00',
      },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
      billingPeriodStart: '2026-11-24T12:26:43.231+00:00',
      billingPeriodEnd: '2026-12-01T12:26:43.231+00:00',
    },
    subscription_tier: 'X Premium',
  },
}

function settings(program: string): HostSettings {
  return {
    locale: 'en',
    initialSetupDone: true,
    agents: { grok: { enabled: true, binaryPath: program } },
    addedAgents: [],
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
}

/** A manager whose only harness is Grok, run from the user's own `grok` at `version`. */
async function manager(version: string) {
  const root = await tempFolder('kettu-grok-limits-')
  const program = path.join(root, process.platform === 'win32' ? 'grok.cmd' : 'grok')
  await writeFile(program, '')
  await chmod(program, 0o755)
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const asked: string[] = []
  const connection = {
    closed: new Promise<void>(() => {}),
    initialize: async () => INIT,
    request: async (method: string) => {
      asked.push(method)
      if (!(method in REPLIES)) throw new Error(`unexpected ${method}`)
      return REPLIES[method]
    },
    authenticate: async () => {},
    close: () => {},
  } as unknown as AgentConnection
  const driver: ProcessDriver = { kind: 'process', connect: () => connection }
  const settled = new Promise<never>(() => {})
  const agents = new AgentManager({
    catalog: [GROK],
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
    launcher: {
      launch: () => ({
        pid: null,
        startedAt: 0,
        exited: settled,
        hasExited: false,
        stop: async () => ({ code: 0, signal: null }),
        kill: async () => {},
        transport: {} as never,
        child: {} as never,
      }),
    },
    settings: () => settings(program),
    reportsDir: path.join(root, 'reports'),
    adaptersDir: root,
    drivers: { acp: driver },
    probeCli: async () => ({ version }),
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })
  return { agents, asked }
}

describe("Grok's plan limits", () => {
  it('are read from the user’s own grok, whose handshake names no version', async () => {
    const { agents, asked } = await manager('1.0.92')

    await agents.refreshAccount('grok', { force: true })

    expect(asked).toContain('_x.ai/auth/info')
    expect(asked).toContain('_x.ai/billing')
    const grok = (await agents.list()).find((status) => status.id === 'grok')
    expect(grok?.signIn).toBe('signed-in')
    expect(grok?.account).toMatchObject({ kind: 'account', label: 'X Premium' })
    expect(grok?.limits).toEqual([
      expect.objectContaining({ window: 'seven_day', label: 'Weekly', usedPercent: 0 }),
    ])
  })

  it('are not asked of a grok older than the version they were checked on', async () => {
    const { agents, asked } = await manager('1.0.80')

    await agents.refreshAccount('grok', { force: true })

    expect(asked).toEqual([])
  })
})
