import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import enReport from '@shared/locales/en/report.json'
import enSession from '@shared/locales/en/session.json'
import { hostSettingsPart, type HostSettingsPart } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { ProblemReportEntry as Entry } from '@shared/thread'
import { onHost } from '@renderer/lib/host-paths'

const REMOTE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REMOTE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const REMOTE_OLD = 'cccccccccccccccccccccccccccccccc'

const state = vi.hoisted(() => ({
  isWeb: false,
  entry: null as Entry | null,
  lastCardProps: null as null | {
    words: { allow: { session: string; always: string }; deny: string }
    request: (decision: 'session' | 'always' | 'deny') => Promise<void>
  },
  hostRpc: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  prepareMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  submitMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  reportSave: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  reportDiscard: vi.fn<(...args: unknown[]) => Promise<void>>(),
  hostsRequest: vi.fn<(hostId: string, method: string, params?: unknown) => Promise<unknown>>(),
}))

vi.mock(
  '@hugeicons/core-free-icons',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => (prop === '__esModule' ? true : prop === 'then' ? undefined : prop),
        has: (_target, prop) => prop !== 'then',
      },
    ),
)

// In renderToStaticMarkup (SSR), React reads Zustand's getInitialState instead of live getState.
// Wrap zustand's `create` so selector reads during static markup reflect current store state.
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>()
  const make = <T>(initializer: StateCreator<T, [], []>) => {
    const api = actual.createStore(initializer)
    const read = <U = T>(selector?: (state: T) => U): U =>
      selector ? selector(api.getState()) : (api.getState() as unknown as U)
    return Object.assign(read, api)
  }
  const create = <T>(initializer?: StateCreator<T, [], []>) =>
    initializer ? make(initializer) : (fn: StateCreator<T, [], []>) => make(fn)
  return { ...actual, create }
})

vi.mock('@renderer/lib/platform', () => ({
  get isWeb() {
    return state.isWeb
  },
  isHosted: false,
  isRelayPage: false,
  isMac: true,
  isWindows: false,
  platform: 'darwin',
  formatShortcut: (shortcut: string) => shortcut,
}))

vi.mock('@renderer/lib/action-log', () => ({
  recordAction: vi.fn(),
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: vi.fn(),
}))

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => state.hostRpc(...args),
  hostAt: async (_hostId: string | null, method: string) => (method === 'agents.list' ? [] : null),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('@renderer/features/report/report-flow', () => ({
  NOT_SUBMITTED: {
    too_large: 'notSubmitted.tooLarge',
    rate_limited: 'notSubmitted.rateLimited',
    unauthorized: 'notSubmitted.unauthorized',
    signed_out: 'notSubmitted.signedOut',
    network: 'notSubmitted.network',
    failed: 'notSubmitted.failed',
  },
  prepare: (...args: unknown[]) => state.prepareMock(...args),
  submit: (...args: unknown[]) => state.submitMock(...args),
}))

vi.mock('../use-thread', () => ({
  useEntry: () => state.entry,
  useEntryAnimation: () => '',
}))

vi.mock('./access-card', () => ({
  AccessCard: (props: {
    words: { allow: { session: string; always: string }; deny: string }
    request: (decision: 'session' | 'always' | 'deny') => Promise<void>
  }) => {
    state.lastCardProps = props
    return createElement('button', { type: 'button' }, props.words.allow.session)
  },
}))

const i18n = i18next.createInstance()

function makeEntry(): Entry {
  return {
    id: 'entry-1',
    kind: 'problem_report',
    title: 'Agent stalled on reconnect',
    details: 'The session stopped receiving patches after reconnect.',
    error: null,
    outcome: null,
    after: null,
    at: 1,
  }
}

function makeSession(id: string, projectPath: string): SessionSummary {
  return {
    id,
    agentId: 'codex',
    projectPath,
    title: 'Test session',
    status: 'ready',
    attention: null,
    origin: 'user',
    parentId: null,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    acpSessionId: null,
    turnStartedAt: null,
    lastTurn: null,
    error: null,
    plan: null,
    routine: null,
    subagent: null,
    worktree: null,
  } as unknown as SessionSummary
}

function partWithCloud(enabled: boolean): HostSettingsPart {
  const file = structuredClone(DEFAULT_SETTINGS)
  file.cloud.enabled = enabled
  return hostSettingsPart(file)
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['session', 'report'],
    defaultNS: 'session',
    resources: { en: { session: enSession, report: enReport } },
    interpolation: { escapeValue: false },
  })
})

beforeEach(() => {
  state.isWeb = false
  state.entry = makeEntry()
  state.lastCardProps = null
  state.hostRpc.mockReset().mockResolvedValue(undefined)
  state.prepareMock.mockReset().mockResolvedValue({
    result: { ok: true, report: { id: 'rep-1', files: [], size: 128 } },
    ref: 'ref-1',
  })
  state.submitMock.mockReset().mockResolvedValue({
    ok: true,
    id: 'KR-123456',
    version: '0.1.30',
    system: 'macOS',
  })
  state.reportSave.mockReset().mockResolvedValue('/tmp/kettu-report.zip')
  state.reportDiscard.mockReset().mockResolvedValue(undefined)
  state.hostsRequest.mockReset().mockImplementation(async (hostId, method) => {
    if (method === 'settings.get') {
      if (hostId === REMOTE_A) return partWithCloud(false)
      if (hostId === REMOTE_B) return partWithCloud(true)
      const older = partWithCloud(true)
      delete older.cloud
      return older
    }
    if (method === 'host.info') return { sharing: false }
    if (method === 'remote.status') return null
    return undefined
  })

  vi.stubGlobal('window', {
    kettu: {
      platform: 'darwin',
      report: {
        save: (...args: unknown[]) => state.reportSave(...args),
        discard: (...args: unknown[]) => state.reportDiscard(...args),
      },
      hosts: {
        request: (hostId: string, method: string, params?: unknown) =>
          state.hostsRequest(hostId, method, params),
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProblemReportEntry target-host cloud.enabled handling', () => {
  type Loaded = {
    ProblemReportEntry: typeof import('./problem-report-entry').ProblemReportEntry
    useSettingsStore: typeof import('@renderer/stores/settings').useSettingsStore
    useAccountStore: typeof import('@renderer/stores/account').useAccountStore
    useSessionsStore: typeof import('@renderer/stores/sessions').useSessionsStore
    hostScopeMod: typeof import('@renderer/stores/host-scope')
    useCloudOffHere: typeof import('@renderer/features/settings/use-cloud-off-here').useCloudOffHere
  }
  let mods: Loaded

  beforeAll(async () => {
    const [
      { ProblemReportEntry },
      { useSettingsStore },
      { useAccountStore },
      { useSessionsStore },
      hostScopeMod,
      { useCloudOffHere },
    ] = await Promise.all([
      import('./problem-report-entry'),
      import('@renderer/stores/settings'),
      import('@renderer/stores/account'),
      import('@renderer/stores/sessions'),
      import('@renderer/stores/host-scope'),
      import('@renderer/features/settings/use-cloud-off-here'),
    ])
    mods = {
      ProblemReportEntry,
      useSettingsStore,
      useAccountStore,
      useSessionsStore,
      hostScopeMod,
      useCloudOffHere,
    }
  }, 30_000)

  function renderCard(sessionId: string): string {
    return renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(mods.ProblemReportEntry, {
          sessionId,
          entryId: 'entry-1',
          agentName: 'Codex',
        }),
      ),
    )
  }

  it('offers Save locally in the web client when the connected host has cloud disabled, and Send when enabled', async () => {
    state.isWeb = true
    const { useSettingsStore, useAccountStore, useSessionsStore } = mods

    useAccountStore.setState({ status: { state: 'signed-out', reason: null, failure: null } })
    useSessionsStore.setState({ byId: { 'web-s1': makeSession('web-s1', '/repo') } })

    // Host has cloud.enabled === false (propagated via WebSettings into useSettingsStore).
    const hostOff = structuredClone(DEFAULT_SETTINGS)
    hostOff.cloud.enabled = false
    useSettingsStore.setState({ settings: hostOff, loaded: true })

    expect(renderCard('web-s1')).toContain('Save locally')
    await state.lastCardProps!.request('session')
    expect(state.reportSave).toHaveBeenCalledWith('rep-1')
    expect(state.submitMock).not.toHaveBeenCalled()
    expect(state.hostRpc).toHaveBeenCalledWith('sessions.answerReport', {
      sessionId: 'web-s1',
      entryId: 'entry-1',
      outcome: { kind: 'saved' },
    })

    // Host switches cloud.enabled back to true: card switches to Send to Kettu.
    state.reportSave.mockClear()
    state.hostRpc.mockClear()
    const hostOn = structuredClone(DEFAULT_SETTINGS)
    hostOn.cloud.enabled = true
    useSettingsStore.setState({ settings: hostOn, loaded: true })

    expect(renderCard('web-s1')).toContain('Send to Kettu')
    await state.lastCardProps!.request('session')
    expect(state.submitMock).toHaveBeenCalledTimes(1)
    expect(state.reportSave).not.toHaveBeenCalled()
    expect(state.hostRpc).toHaveBeenCalledWith('sessions.answerReport', {
      sessionId: 'web-s1',
      entryId: 'entry-1',
      outcome: { kind: 'sent', reportId: 'KR-123456' },
    })
  })

  it('uses the remote host cloud.enabled on desktop rather than the local computer setting and updates live', async () => {
    state.isWeb = false
    const { useSettingsStore, useAccountStore, useSessionsStore, hostScopeMod, useCloudOffHere } =
      mods

    // Local desktop has cloud enabled and is signed in.
    const localOn = structuredClone(DEFAULT_SETTINGS)
    localOn.cloud.enabled = true
    useSettingsStore.setState({ settings: localOn, loaded: true })
    useAccountStore.setState({
      status: {
        state: 'signed-in',
        account: { id: 'acct-1', email: 'me@example.com', name: 'Me', avatarUrl: null },
        subscription: 'active',
        manageUrl: null,
      } as never,
    })

    // Session on REMOTE_A (cloud off), REMOTE_B (cloud on), and REMOTE_OLD (omits cloud).
    useSessionsStore.setState({
      byId: {
        'remote-a-s1': makeSession('remote-a-s1', onHost(REMOTE_A, '/srv/app')),
        'remote-b-s1': makeSession('remote-b-s1', onHost(REMOTE_B, '/srv/app')),
        'remote-old-s1': makeSession('remote-old-s1', onHost(REMOTE_OLD, '/srv/app')),
      },
    })

    // Initialize scopes and wait for settings.get to settle.
    hostScopeMod.hostScope(REMOTE_A)
    hostScopeMod.hostScope(REMOTE_B)
    hostScopeMod.hostScope(REMOTE_OLD)
    await flushMicrotasks()

    // REMOTE_A has cloud off -> Save locally, even though local desktop is signed in with cloud on.
    expect(renderCard('remote-a-s1')).toContain('Save locally')
    await state.lastCardProps!.request('session')
    expect(state.reportSave).toHaveBeenCalledWith('rep-1')
    expect(state.submitMock).not.toHaveBeenCalled()

    // REMOTE_OLD omits cloud -> backward-compatible default of on -> Send to Kettu.
    expect(renderCard('remote-old-s1')).toContain('Send to Kettu')

    // Local desktop turns cloud off, while REMOTE_B still has cloud on -> REMOTE_B stays Send to Kettu.
    const localOff = structuredClone(DEFAULT_SETTINGS)
    localOff.cloud.enabled = false
    useSettingsStore.setState({ settings: localOff, loaded: true })
    expect(renderCard('remote-b-s1')).toContain('Send to Kettu')

    // useCloudOffHere reflects each scoped host independently.
    function Probe() {
      return createElement('span', null, String(useCloudOffHere()))
    }
    const probeScope = (scope: ReturnType<typeof hostScopeMod.hostScope>) =>
      renderToStaticMarkup(
        createElement(
          hostScopeMod.HostScopeContext.Provider,
          { value: scope },
          createElement(Probe),
        ),
      )
    expect(probeScope(hostScopeMod.LOCAL_SCOPE)).toBe('<span>true</span>')
    expect(probeScope(hostScopeMod.hostScope(REMOTE_A))).toBe('<span>true</span>')
    expect(probeScope(hostScopeMod.hostScope(REMOTE_B))).toBe('<span>false</span>')

    // Live settings.changed from REMOTE_B turning cloud off flips both the card and scope hook.
    hostScopeMod.hostScopeEvent(REMOTE_B, {
      type: 'settings.changed',
      settings: partWithCloud(false),
    })
    expect(renderCard('remote-b-s1')).toContain('Save locally')
    expect(probeScope(hostScopeMod.hostScope(REMOTE_B))).toBe('<span>true</span>')
  })
})
