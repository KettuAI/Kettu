import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AgentStatus } from '@shared/agent-host'
import { DEFAULT_SETTINGS } from '@shared/settings'
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
      systemLocale: 'en',
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
      marketplace: {
        setKeys: vi.fn(() => neverSettle),
        setAgentEnv: vi.fn(() => neverSettle),
      },
    },
  })
}

function makeGlmStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'glm',
    name: 'GLM Agent',
    harnessId: 'glm',
    harnessName: 'GLM Agent',
    isDefault: true,
    registered: true,
    uninstalled: false,
    uninstallCommand: null,
    hidden: false,
    disabled: false,
    apiKey: { set: false, providers: false },
    state: 'available',
    version: '1.18.0',
    package: { name: 'glm-acp-agent', version: '1.18.0', installed: true },
    release: null,
    signIn: 'required',
    authMethods: [
      {
        id: 'glm-setup',
        name: 'Setup in terminal',
        description: 'Run `glm-acp-agent --setup` to store your Z.AI Coding Plan API key on disk.',
        type: 'terminal',
        command: 'node /adapters/glm/1.18.0/node_modules/glm-acp-agent/dist/index.js --setup',
      },
      {
        id: 'glm-api-key',
        name: 'Z.AI API key',
        description:
          'Set your Z.AI Coding Plan API key below, or export Z_AI_API_KEY in your environment.',
        type: 'env',
        envVars: [],
      },
    ],
    canLogout: false,
    account: null,
    limits: [],
    limitsReason: 'not-yet-supported',
    detail: null,
    reason: null,
    installNotice: null,
    installUrl: null,
    progress: [],
    launchCommand: 'node /adapters/glm/1.18.0/node_modules/glm-acp-agent/dist/index.js',
    binaryOverride: null,
    binaryCommand: null,
    program: { command: 'glm-acp-agent', onPath: false },
    unusedProgram: null,
    binaryPath: null,
    update: null,
    updateCheckedAt: 1_000,
    automatic: null,
    versionWarning: null,
    failedVersion: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: null,
    configDir: null,
    kettuServer: { runs: true, active: null },
    skills: false,
    capabilities: {
      loadSession: true,
      listSessions: true,
      resumeSession: true,
      closeSession: true,
      deleteSession: false,
      forkSession: true,
      forkAtMessage: false,
      steering: false,
      reports: false,
      context: false,
      liveContext: false,
      account: true,
      mcpHttp: true,
      prompt: { image: true, audio: false, embeddedContext: true },
    },
    ...overrides,
  }
}

let modules: {
  createAgentsStore: typeof import('@renderer/stores/agents').createAgentsStore
  LOCAL_SCOPE: typeof import('@renderer/stores/host-scope').LOCAL_SCOPE
  HostScopeContext: typeof import('@renderer/stores/host-scope').HostScopeContext
  section: typeof import('./agents-section')
}

beforeAll(async () => {
  stubGlobals()
  const { i18n } = await import('@renderer/lib/i18n')
  await i18n.changeLanguage('en')
  const { createAgentsStore } = await import('@renderer/stores/agents')
  const { LOCAL_SCOPE, HostScopeContext } = await import('@renderer/stores/host-scope')
  const section = await import('./agents-section')
  modules = { createAgentsStore, LOCAL_SCOPE, HostScopeContext, section }
}, 20_000)

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderWithStatus(status: AgentStatus, hostId: string | null = null) {
  const { createAgentsStore, LOCAL_SCOPE, HostScopeContext, section } = modules
  const request = vi.fn(async () => [status]) as unknown as HostRequest
  const rawAgentsStore = createAgentsStore(request)
  rawAgentsStore.getState().setAll([status])
  const useAgentsStore = Object.assign(
    <T>(selector: (state: ReturnType<typeof rawAgentsStore.getState>) => T) =>
      selector(rawAgentsStore.getState()),
    rawAgentsStore,
  ) as unknown as typeof rawAgentsStore
  const rawSettingsStore = create(() => ({
    settings: DEFAULT_SETTINGS,
    loaded: true,
    update: vi.fn(async () => {}),
  }))
  const useSettingsStore = Object.assign(
    <T>(selector: (state: ReturnType<typeof rawSettingsStore.getState>) => T) =>
      selector(rawSettingsStore.getState()),
    rawSettingsStore,
  ) as unknown as typeof LOCAL_SCOPE.useSettingsStore
  const scope = {
    ...LOCAL_SCOPE,
    hostId,
    request,
    useAgentsStore,
    useSettingsStore,
  }
  const render = (node: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(HostScopeContext.Provider, { value: scope }, node))
  return { section, render }
}

describe('Settings › Agents › GLM Agent sign-in UI', () => {
  it('renders Sign in pill in list and both API key and terminal sign-in entries when signed out', () => {
    const status = makeGlmStatus()
    const { section, render } = renderWithStatus(status)

    const listHtml = render(createElement(section.AgentListItem, { status }))
    expect(listHtml).toContain('GLM Agent')
    expect(listHtml).toContain('Needs you to sign in')
    expect(listHtml).toContain('Sign in')

    const pageHtml = render(createElement(section.AgentPage, { agentId: 'glm' }))
    expect(pageHtml).toContain('Sign in to GLM Agent to use it')
    expect(pageHtml).toContain('Sign in in terminal')
    expect(pageHtml).toContain('--setup')
    expect(pageHtml).toContain('Account')
    expect(pageHtml).toContain('API key')
    expect(pageHtml).toContain('A Z.AI Coding Plan API key for GLM Agent.')
    expect(pageHtml).toContain('Set…')
  })

  it('renders API key sign-in guidance even on remote/web hosts or before package install', () => {
    const status = makeGlmStatus({
      package: { name: 'glm-acp-agent', version: '1.18.0', installed: false },
      authMethods: [
        {
          id: 'glm-api-key',
          name: 'Z.AI API key',
          description:
            'Set your Z.AI Coding Plan API key below, or export Z_AI_API_KEY in your environment.',
          type: 'env',
          envVars: [],
        },
      ],
    })
    const { section, render } = renderWithStatus(status, 'remote-host')

    const pageHtml = render(createElement(section.AgentPage, { agentId: 'glm' }))
    expect(pageHtml).toContain('Sign in to GLM Agent to use it')
    expect(pageHtml).toContain('Set your Z.AI Coding Plan API key below')
    expect(pageHtml).toContain('API key')
    expect(pageHtml).toContain('Set…')
  })

  it('renders signed-in account state with Replace and Clear controls once authenticated', () => {
    const status = makeGlmStatus({
      signIn: 'signed-in',
      apiKey: { set: true, providers: false },
      account: { kind: 'api_key', label: 'Z.AI API key', email: null },
    })
    const { section, render } = renderWithStatus(status)

    const listHtml = render(createElement(section.AgentListItem, { status }))
    expect(listHtml).toContain('Z.AI API key')
    expect(listHtml).not.toContain('Needs you to sign in')

    const pageHtml = render(createElement(section.AgentPage, { agentId: 'glm' }))
    expect(pageHtml).not.toContain('Sign in to GLM Agent to use it')
    expect(pageHtml).toContain('Login method')
    expect(pageHtml).toContain('Z.AI API key')
    expect(pageHtml).toContain('Replace…')
    expect(pageHtml).toContain('Clear')
  })
})
