import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import type { HostRequest } from '@renderer/lib/host'

function stubGlobals() {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  const neverSettle = new Promise(() => {})
  vi.stubGlobal('window', {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    kettu: {
      platform: 'darwin',
      client: 'desktop',
      hostPlatform: () => 'darwin',
      agents: {
        request: vi.fn(() => neverSettle),
        onEvent: () => () => {},
        onConnection: () => () => {},
      },
      hosts: {
        request: vi.fn(() => neverSettle),
        onChanged: () => () => {},
        onSession: () => () => {},
        status: vi.fn(() => neverSettle),
      },
      settings: {
        get: vi.fn(() => neverSettle),
        update: vi.fn(() => neverSettle),
        onChanged: () => () => {},
      },
    },
  })
}

async function loadModules() {
  vi.resetModules()
  stubGlobals()
  const agents = await import('@renderer/stores/agents')
  const helpers = await import('./agent-helpers')
  return { agents, helpers }
}

function codexStatus(version: string, updateVersion: string | null): AgentStatus {
  return {
    id: 'codex',
    name: 'Codex',
    harnessId: 'codex',
    harnessName: 'Codex',
    isDefault: true,
    registered: true,
    uninstalled: false,
    uninstallCommand: null,
    hidden: false,
    disabled: false,
    apiKey: { set: false, providers: false },
    state: 'available',
    version,
    package: null,
    release: null,
    signIn: 'unknown',
    authMethods: [],
    canLogout: false,
    account: null,
    limits: [],
    detail: null,
    reason: null,
    installNotice: null,
    installUrl: null,
    progress: [],
    launchCommand: 'codex app-server',
    binaryOverride: null,
    binaryCommand: 'codex',
    program: { command: 'codex', onPath: true },
    unusedProgram: null,
    binaryPath: '/usr/local/bin/codex',
    update: null,
    updateCheckedAt: 1_000,
    automatic: null,
    versionWarning: null,
    failedVersion: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: {
      command: 'codex',
      installed: { path: '/usr/local/bin/codex', version, variable: null, problem: null },
      method: 'npm',
      update: updateVersion
        ? { version: updateVersion, command: 'npm install -g @openai/codex' }
        : null,
      checkable: true,
    },
    configDir: null,
    kettuServer: { runs: false, active: null },
    skills: false,
    capabilities: {
      loadSession: false,
      listSessions: false,
      resumeSession: false,
      closeSession: false,
      deleteSession: false,
      forkSession: false,
      forkAtMessage: false,
      steering: false,
      reports: false,
      context: false,
      liveContext: false,
      account: true,
      mcpHttp: null,
      prompt: null,
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('quiet harness refresh on settings open', () => {
  it('re-checks all harnesses or a single harness and updates stored CLI version and banner state', async () => {
    const { agents, helpers } = await loadModules()
    const calls: Array<{ method: string; params: unknown }> = []
    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'agents.check') return [codexStatus('0.172.0', null)]
      throw new Error(`unexpected method ${method}`)
    }) as unknown as HostRequest

    const store = agents.createAgentsStore(request)
    store.getState().setAll([codexStatus('0.171.0', '0.172.0')])
    expect(helpers.harnessVersion(store.getState().byId.codex!)).toBe('0.171.0')
    expect(store.getState().byId.codex?.cli?.update?.version).toBe('0.172.0')

    await helpers.checkHarnessQuietly(store, 'codex')
    expect(calls).toEqual([{ method: 'agents.check', params: { agentId: 'codex' } }])
    expect(helpers.harnessVersion(store.getState().byId.codex!)).toBe('0.172.0')
    expect(store.getState().byId.codex?.cli?.update).toBeNull()

    await helpers.checkHarnessQuietly(store)
    expect(calls[1]).toEqual({ method: 'agents.check', params: {} })
  })

  it('swallows check failures quietly with a warning so opening settings never throws', async () => {
    const { agents, helpers } = await loadModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const request = vi.fn(async () => {
      throw new Error('host disconnected')
    }) as unknown as HostRequest
    const store = agents.createAgentsStore(request)

    await expect(helpers.checkHarnessQuietly(store, 'codex')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not check codex'))
  })
})
