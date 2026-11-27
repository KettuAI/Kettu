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
    },
  })
}

function makeStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  const id = overrides.id ?? 'antigravity'
  const harnessId = overrides.harnessId ?? 'antigravity'
  const harnessName = overrides.harnessName ?? 'Google Antigravity'
  return {
    id,
    name: harnessName,
    harnessId,
    harnessName,
    isDefault: true,
    registered: true,
    uninstalled: false,
    uninstallCommand: null,
    hidden: false,
    disabled: false,
    apiKey: null,
    state: 'available',
    version: '1.5.18',
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
    launchCommand: 'agy acp',
    binaryOverride: null,
    binaryCommand: 'agy',
    program: { command: 'agy', onPath: true },
    unusedProgram: null,
    binaryPath: '/Users/test/.local/bin/agy',
    update: null,
    updateCheckedAt: 1_000,
    automatic: null,
    versionWarning: null,
    failedVersion: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: {
      command: 'agy',
      installed: {
        path: '/Users/test/.local/bin/agy',
        version: '1.5.18',
        variable: null,
        problem: null,
      },
      method: 'script',
      update: null,
      checkable: true,
      newerVersion: null,
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
      account: false,
      mcpHttp: null,
      prompt: null,
    },
    ...overrides,
  }
}

let modules: {
  createAgentsStore: typeof import('@renderer/stores/agents').createAgentsStore
  LOCAL_SCOPE: typeof import('@renderer/stores/host-scope').LOCAL_SCOPE
  HostScopeContext: typeof import('@renderer/stores/host-scope').HostScopeContext
  readiness: typeof import('@renderer/features/agents/readiness')
  section: typeof import('./harness-section')
}

beforeAll(async () => {
  stubGlobals()
  const { i18n } = await import('@renderer/lib/i18n')
  await i18n.changeLanguage('en')
  const { createAgentsStore } = await import('@renderer/stores/agents')
  const { LOCAL_SCOPE, HostScopeContext } = await import('@renderer/stores/host-scope')
  const readiness = await import('@renderer/features/agents/readiness')
  const section = await import('./harness-section')
  modules = { createAgentsStore, LOCAL_SCOPE, HostScopeContext, readiness, section }
}, 20_000)

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function loadTestHarness(statuses: AgentStatus[]) {
  const { createAgentsStore, LOCAL_SCOPE, HostScopeContext, readiness, section } = modules
  const request = vi.fn(async () => statuses) as unknown as HostRequest
  const rawAgentsStore = createAgentsStore(request)
  rawAgentsStore.getState().setAll(statuses)
  // Static server rendering does not subscribe; read live store state directly instead of Zustand's
  // initial-state server snapshot.
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
    request,
    useAgentsStore,
    useSettingsStore,
  }
  const render = (node: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(HostScopeContext.Provider, { value: scope }, node))
  return { readiness, section, render, useAgentsStore: rawAgentsStore }
}

describe('showsCurrent and programUnchecked across harness states', () => {
  it('returns true only when installed, checked, version known, and no update or warning exists', () => {
    const { readiness } = loadTestHarness([])

    // Antigravity checked and up to date
    expect(readiness.showsCurrent(makeStatus())).toBe(true)

    // Antigravity not checked yet must NOT show Up to date
    expect(readiness.showsCurrent(makeStatus({ updateCheckedAt: null }))).toBe(false)

    // Antigravity with update available or newerVersion without auto-update command
    expect(
      readiness.showsCurrent(
        makeStatus({
          cli: {
            command: 'agy',
            installed: { path: '/bin/agy', version: '1.5.17', variable: null, problem: null },
            method: 'script',
            update: { version: '1.5.18', command: 'agy update' },
            checkable: true,
            newerVersion: '1.5.18',
          },
        }),
      ),
    ).toBe(false)
    expect(
      readiness.showsCurrent(
        makeStatus({
          cli: {
            command: 'agy',
            installed: { path: '/custom/agy', version: '1.5.17', variable: null, problem: null },
            method: null,
            update: null,
            checkable: true,
            newerVersion: '1.5.18',
          },
        }),
      ),
    ).toBe(false)

    // User CLI whose version could not be read must NOT claim to be up to date
    expect(
      readiness.showsCurrent(
        makeStatus({
          version: null,
          cli: {
            command: 'agy',
            installed: { path: '/bin/agy', version: null, variable: null, problem: null },
            method: 'script',
            update: null,
            checkable: true,
            newerVersion: null,
          },
        }),
      ),
    ).toBe(false)

    // Uncheckable user CLI (e.g. WinGet CodeWhale or WinGet Claude Code)
    expect(
      readiness.showsCurrent(
        makeStatus({
          id: 'codewhale',
          harnessId: 'codewhale',
          harnessName: 'CodeWhale',
          updateCheckedAt: null,
          cli: {
            command: 'codewhale',
            installed: {
              path: '/winget/codewhale',
              version: '1.0.0',
              variable: null,
              problem: null,
            },
            method: 'winget',
            update: null,
            checkable: false,
            newerVersion: null,
          },
        }),
      ),
    ).toBe(false)
    expect(
      readiness.showsCurrent(
        makeStatus({
          id: 'claude-code',
          harnessId: 'claude-code',
          harnessName: 'Claude Code',
          package: {
            name: '@anthropic-ai/claude-agent-sdk',
            version: '0.3.314',
            installed: true,
            isSdk: true,
          },
          updateCheckedAt: 1_000,
          cli: {
            command: 'claude',
            installed: {
              path: '/winget/claude.exe',
              version: '2.1.332',
              variable: null,
              problem: null,
            },
            method: 'winget',
            update: null,
            checkable: false,
            newerVersion: null,
          },
        }),
      ),
    ).toBe(false)

    // Registry-backed uvx / archive harness (Minion Code)
    expect(
      readiness.showsCurrent(
        makeStatus({
          id: 'minion',
          harnessId: 'minion',
          harnessName: 'Minion Code',
          version: '0.1.45',
          cli: null,
          release: { version: '0.1.45', registry: true },
          updateCheckedAt: 1_000,
        }),
      ),
    ).toBe(true)
    expect(
      readiness.showsCurrent(
        makeStatus({
          id: 'minion',
          harnessId: 'minion',
          harnessName: 'Minion Code',
          version: '0.1.45',
          cli: null,
          release: { version: '0.1.45', registry: true },
          updateCheckedAt: null,
        }),
      ),
    ).toBe(false)

    // User-installed binary without remote check (Hermes / user Cursor)
    expect(
      readiness.showsCurrent(
        makeStatus({
          id: 'hermes',
          harnessId: 'hermes',
          harnessName: 'Hermes Agent',
          cli: null,
          release: null,
          updateCheckedAt: null,
        }),
      ),
    ).toBe(false)
  })
})

describe('Settings > Harnesses badge rendering', () => {
  it('renders Up to date for checked Antigravity, Update for outdated Antigravity, and nothing when unchecked', () => {
    const current = makeStatus()
    const unchecked = makeStatus({ updateCheckedAt: null })
    const outdated = makeStatus({
      version: '1.5.17',
      cli: {
        command: 'agy',
        installed: {
          path: '/Users/test/.local/bin/agy',
          version: '1.5.17',
          variable: null,
          problem: null,
        },
        method: 'script',
        update: { version: '1.5.18', command: 'agy update' },
        checkable: true,
        newerVersion: '1.5.18',
      },
    })
    const { section, render } = loadTestHarness([current])

    const currentHtml = render(createElement(section.HarnessListItem, { status: current }))
    expect(currentHtml).toContain('Up to date')
    expect(currentHtml).toContain('data-tone="ok"')

    const uncheckedHtml = render(createElement(section.HarnessListItem, { status: unchecked }))
    expect(uncheckedHtml).not.toContain('Up to date')

    const outdatedHtml = render(createElement(section.HarnessListItem, { status: outdated }))
    expect(outdatedHtml).toContain('1.5.18 is out')
    expect(outdatedHtml).toContain('Update')
    expect(outdatedHtml).not.toContain('Up to date')
  })

  it('renders an attention pill instead of Up to date when a newer version is known without an auto-update command', () => {
    const manualNewer = makeStatus({
      id: 'pi',
      harnessId: 'pi',
      harnessName: 'Pi',
      version: '0.81.0',
      cli: {
        command: 'pi',
        installed: {
          path: '/project/node_modules/.bin/pi',
          version: '0.81.0',
          variable: null,
          problem: null,
        },
        method: 'npm',
        update: null,
        checkable: true,
        newerVersion: '1.5.2',
      },
      updateCheckedAt: 1_000,
    })
    const { section, render } = loadTestHarness([manualNewer])

    const rowHtml = render(createElement(section.HarnessListItem, { status: manualNewer }))
    expect(rowHtml).toContain('1.5.2 is out')
    expect(rowHtml).not.toContain('Up to date')
    expect(rowHtml).not.toContain('>Update<')

    const pageHtml = render(createElement(section.HarnessPage, { harnessId: 'pi' }))
    expect(pageHtml).toContain('1.5.2 is out')
    expect(pageHtml).not.toContain('Up to date')
  })

  it('renders own-installer copy and no Up to date badge for uncheckable harnesses', () => {
    const wingetCodewhale = makeStatus({
      id: 'codewhale',
      harnessId: 'codewhale',
      harnessName: 'CodeWhale',
      version: '1.0.0',
      updateCheckedAt: null,
      cli: {
        command: 'codewhale',
        installed: {
          path: 'C:\\winget\\codewhale.exe',
          version: '1.0.0',
          variable: null,
          problem: null,
        },
        method: 'winget',
        update: null,
        checkable: false,
        newerVersion: null,
      },
    })
    const { section, render } = loadTestHarness([wingetCodewhale])

    const rowHtml = render(createElement(section.HarnessListItem, { status: wingetCodewhale }))
    expect(rowHtml).not.toContain('Up to date')

    const pageHtml = render(createElement(section.HarnessPage, { harnessId: 'codewhale' }))
    expect(pageHtml).toContain('Updated by its own installer, not by Kettu.')
    expect(pageHtml).not.toContain('Check for updates')
  })

  it('shows Check for updates for unchecked registry releases and counts newerVersion as pending', () => {
    const uncheckedRelease = makeStatus({
      id: 'minion',
      harnessId: 'minion',
      harnessName: 'Minion Code',
      version: '0.1.45',
      cli: null,
      release: { version: '0.1.45', registry: true },
      updateCheckedAt: null,
    })
    const { section, render } = loadTestHarness([uncheckedRelease])
    const actionsHtml = render(createElement(section.HarnessGroupActions))
    expect(actionsHtml).toContain('Check for updates')

    const manualNewer = makeStatus({
      version: '1.5.17',
      cli: {
        command: 'agy',
        installed: { path: '/custom/agy', version: '1.5.17', variable: null, problem: null },
        method: null,
        update: null,
        checkable: true,
        newerVersion: '1.5.18',
      },
      updateCheckedAt: Date.now(),
    })
    const { section: s2, render: r2, useAgentsStore } = loadTestHarness([manualNewer])
    useAgentsStore.setState({
      updateCheck: { running: false, finishedAt: Date.now(), error: null },
    })
    const html2 = r2(createElement(s2.HarnessGroupActions))
    expect(html2).not.toContain('all up to date')
  })
})
