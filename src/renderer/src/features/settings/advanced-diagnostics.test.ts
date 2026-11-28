import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { DEBUG_OFF } from '@shared/debug'
import type { AppCommand } from '@shared/ipc'
import type { DiagnosticsStatus, HostAdminEvent, HostInfo } from '@shared/remote/host-admin'
import { hostSettingsPart } from '@shared/remote/host-admin'
import type { HostLink, LinkState } from '@shared/remote/link'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'

const hostRequests = vi.hoisted(() => vi.fn())
const localUpdate = vi.hoisted(() => vi.fn())

function stubWindow(client: 'desktop' | 'web') {
  const storage = new Map<string, string>()
  vi.stubGlobal('__KETTU_HOSTED__', false)
  vi.stubGlobal('__KETTU_ACCOUNT_URL__', '')
  vi.stubGlobal('__KETTU_RELAY_URL__', '')
  vi.stubGlobal('__KETTU_REGION_KEYS__', [])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    languages: ['en-US'],
  })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {
      toggleAttribute: () => {},
    },
  })
  const neverSettle = new Promise(() => {})
  vi.stubGlobal('window', {
    focus: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    kettu: {
      platform: 'darwin',
      client,
      systemLocale: 'en',
      hostPlatform: () => 'darwin',
      app: {
        getInfo: vi.fn(async () => ({
          name: 'Kettu',
          version: '0.1.33',
          system: 'macOS 15 arm64',
          userDataPath: '/Users/test/Library/Application Support/Kettu',
          logsPath: '/Users/test/Library/Logs/Kettu',
          isPackaged: true,
        })),
      },
      agents: {
        request: vi.fn(() => neverSettle),
        onEvent: () => () => {},
        onConnection: () => () => {},
      },
      hosts: {
        request: hostRequests,
        onChanged: () => () => {},
        onSession: () => () => {},
        status: vi.fn(() => neverSettle),
      },
      settings: {
        get: vi.fn(async () => structuredClone(DEFAULT_SETTINGS)),
        update: localUpdate,
        onChanged: () => () => {},
      },
      debug: {
        get: vi.fn(async () => DEBUG_OFF),
        restart: vi.fn(async () => {}),
        onChanged: () => () => {},
      },
      report: {
        recording: vi.fn(async () => null),
        record: vi.fn(async () => null),
        onRecording: () => () => {},
      },
      diagnostics: {
        clearVerbose: vi.fn(async () => {}),
        recordActions: vi.fn(),
      },
      shell: {
        showItem: vi.fn(async () => {}),
      },
      marketplace: {
        setKeys: vi.fn(() => neverSettle),
        setAgentEnv: vi.fn(() => neverSettle),
      },
    },
  })
}

function makeHostInfo(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    name: 'Kettu',
    version: '0.1.34',
    system: 'macOS 15 arm64',
    userDataPath: '/Users/studio/Library/Application Support/Kettu',
    logsPath: '/Users/studio/Library/Logs/Kettu',
    isPackaged: true,
    sharing: true,
    updates: true,
    remoteSwitch: true,
    remoteReset: true,
    thumbnails: true,
    diagnostics: true,
    ...overrides,
  }
}

describe('Remote diagnostics UI and webApi wiring', () => {
  afterAll(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  describe('Settings > Advanced diagnostics rendering across local, remote desktop, daemon, and older hosts', () => {
    let i18nMod: typeof import('@renderer/lib/i18n')
    let hostScopeMod: typeof import('@renderer/stores/host-scope')
    let hostsMod: typeof import('@renderer/stores/hosts')
    let settingsStoreMod: typeof import('@renderer/stores/settings')
    let sectionDefsMod: typeof import('./advanced-section')
    let rowsMod: typeof import('./rows')

    beforeAll(async () => {
      vi.resetModules()
      stubWindow('desktop')
      ;[i18nMod, hostScopeMod, hostsMod, settingsStoreMod, sectionDefsMod, rowsMod] =
        await Promise.all([
          import('@renderer/lib/i18n'),
          import('@renderer/stores/host-scope'),
          import('@renderer/stores/hosts'),
          import('@renderer/stores/settings'),
          import('./advanced-section'),
          import('./rows'),
        ])
    })

    beforeEach(() => {
      hostRequests.mockReset()
      localUpdate.mockReset()
      settingsStoreMod.useSettingsStore.setState({
        settings: structuredClone(DEFAULT_SETTINGS),
        loaded: true,
      })
      hostsMod.useHostsStore.setState({
        status: {
          self: { name: 'Laptop', platform: 'darwin', version: '0.1.34', model: 'Mac' },
          plainTextKey: false,
          keyFailed: false,
          hosts: [
            {
              id: 'remote-mac',
              name: 'Studio Mac',
              platform: 'darwin',
              version: '0.1.34',
              connection: { state: 'online', relay: 'https://relay.kettu.sh' },
              lastOnlineAt: Date.now(),
              addresses: [],
              ownRelay: null,
              ssh: null,
              device: { id: 'dev1', name: 'Laptop' },
            } as never,
          ],
        },
      })
      void i18nMod.i18n.changeLanguage('en')
    })

    function renderAdvanced(
      input: Parameters<typeof sectionDefsMod.buildAdvancedSection>[0],
      scope: import('@renderer/stores/host-scope').HostScope,
    ): { section: import('./model').SectionDef; html: string } {
      const section = sectionDefsMod.buildAdvancedSection(input)
      const html = renderToStaticMarkup(
        createElement(
          hostScopeMod.HostScopeContext.Provider,
          { value: scope },
          createElement(rowsMod.SectionBody, { section }),
        ),
      )
      return { section, html }
    }

    function remoteScopeFor(
      hostId: string | null,
      settingsFile: SettingsFile,
      info: HostInfo | null,
      diagnostics: DiagnosticsStatus | null,
    ): import('@renderer/stores/host-scope').HostScope {
      const scopedSettings = create(() => ({
        settings: settingsFile,
        loaded: true,
        update: vi.fn(),
      })) as unknown as typeof hostScopeMod.LOCAL_SCOPE.useSettingsStore
      const scopedInfo = create(() => ({ info }))
      const scopedDiagnostics = create(() => ({ status: diagnostics }))
      return {
        ...hostScopeMod.LOCAL_SCOPE,
        hostId,
        useSettingsStore: scopedSettings,
        useInfoStore: scopedInfo,
        useDiagnosticsStore: scopedDiagnostics,
      }
    }

    it('exposes recording, detailed records, and local-only debug mode note on a remote desktop host when debug is off', () => {
      const remoteSettings = structuredClone(DEFAULT_SETTINGS)
      const info = makeHostInfo({ diagnostics: true })
      const diagnostics: DiagnosticsStatus = {
        recording: null,
        debug: DEBUG_OFF,
        canRecord: true,
        canClearVerbose: true,
        canRestartNormally: true,
      }
      const scope = remoteScopeFor('remote-mac', remoteSettings, info, diagnostics)

      const { section, html } = renderAdvanced(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          onHost: { context: 'web', host: 'Studio Mac' },
          remote: true,
          info,
          diagnostics,
        },
        scope,
      )

      expect(section.rows.map((r) => r.id)).toContain('record-steps')
      expect(section.rows.map((r) => r.id)).toContain('detailed-records')
      expect(section.rows.map((r) => r.id)).toContain('debug-mode')
      expect(html).toContain('Start recording')
      expect(html).toContain('Delete records')
      expect(html).toContain('role="switch"')
      expect(html).toContain('Debug mode can only be turned on from Studio Mac.')
      // Turning debug mode ON stays strictly on the computer itself.
      expect(html).not.toContain('Restart in debug mode')

      // Chinese localization.
      void i18nMod.i18n.changeLanguage('zh-CN')
      const zh = renderAdvanced(
        {
          t: i18nMod.i18n.getFixedT('zh-CN', 'settings'),
          onHost: { context: 'web', host: 'Studio Mac' },
          remote: true,
          info,
          diagnostics,
        },
        scope,
      )
      expect(zh.html).toContain('调试模式只能在 Studio Mac 上打开。')
      expect(zh.html).not.toContain('以调试模式重启')
    })

    it('shows active recording stop action, open debug ports, and Restart normally on a remote desktop host', () => {
      const remoteSettings = structuredClone(DEFAULT_SETTINGS)
      remoteSettings.diagnostics.verboseUntil = Date.now() + 2 * 60 * 60 * 1000
      const info = makeHostInfo({ diagnostics: true })
      const diagnostics: DiagnosticsStatus = {
        recording: { startedAt: Date.now() - 12_000, endsAt: Date.now() + 1_788_000 },
        debug: {
          on: true,
          cdp: 9222,
          inspectors: [{ name: 'main', url: 'ws://127.0.0.1:9229/main' }],
          file: '/Users/studio/Library/Logs/Kettu/debug-ports.json',
        },
        canRecord: true,
        canClearVerbose: true,
        canRestartNormally: true,
      }
      const scope = remoteScopeFor('remote-mac', remoteSettings, info, diagnostics)

      const { html } = renderAdvanced(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          onHost: { context: 'web', host: 'Studio Mac' },
          remote: true,
          info,
          diagnostics,
        },
        scope,
      )

      expect(html).toContain('Stop and report')
      expect(html).toContain('Restart normally')
      expect(html).toContain('127.0.0.1:9222')
      expect(html).toContain('ws://127.0.0.1:9229/main')
      expect(html).not.toContain('Restart in debug mode')
    })

    it('omits desktop recording and normal restart on a daemon host while keeping detailed records and daemon debug ports visible', () => {
      const daemonSettings = structuredClone(DEFAULT_SETTINGS)
      const info = makeHostInfo({
        sharing: false,
        updates: false,
        computerUse: false,
        diagnostics: true,
      })
      const diagnostics: DiagnosticsStatus = {
        recording: null,
        debug: {
          on: true,
          cdp: null,
          inspectors: [{ name: 'daemon', url: 'ws://127.0.0.1:9230/daemon' }],
          file: '/var/log/kettu/debug-ports.json',
        },
        canRecord: false,
        canClearVerbose: true,
        canRestartNormally: false,
      }
      const scope = remoteScopeFor('remote-mac', daemonSettings, info, diagnostics)

      const { section, html } = renderAdvanced(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          onHost: { context: 'web', host: 'Studio Mac' },
          remote: true,
          info,
          diagnostics,
        },
        scope,
      )

      expect(section.rows.map((r) => r.id)).not.toContain('record-steps')
      expect(section.rows.map((r) => r.id)).toContain('detailed-records')
      expect(section.rows.map((r) => r.id)).toContain('debug-mode')
      expect(html).toContain('ws://127.0.0.1:9230/daemon')
      expect(html).toContain('Restart Kettu on Studio Mac to turn debug mode off.')
      expect(html).not.toContain('DevTools Protocol')
      expect(html).not.toContain('Restart normally')
      expect(html).not.toContain('Restart in debug mode')
    })

    it('hides diagnostics rows cleanly for older hosts before #1596', () => {
      const olderInfo = makeHostInfo({ diagnostics: undefined, logsPath: undefined })
      const scope = remoteScopeFor('remote-mac', structuredClone(DEFAULT_SETTINGS), olderInfo, null)

      const { section } = renderAdvanced(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          onHost: { context: 'web', host: 'Studio Mac' },
          remote: true,
          info: olderInfo,
          diagnostics: null,
        },
        scope,
      )

      expect(section.rows.map((r) => r.id)).toEqual([
        'proxy',
        'report',
        'data-folder',
        'remove-sessions',
      ])
    })

    it('keeps local desktop Restart in debug mode button available on the computer itself', () => {
      const localInfo = makeHostInfo({ diagnostics: true })
      const localDiagnostics: DiagnosticsStatus = {
        recording: null,
        debug: DEBUG_OFF,
        canRecord: true,
        canClearVerbose: true,
        canRestartNormally: true,
      }
      const scope = remoteScopeFor(
        null,
        structuredClone(DEFAULT_SETTINGS),
        localInfo,
        localDiagnostics,
      )

      const { html } = renderAdvanced(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          onHost: {},
          remote: false,
          info: localInfo,
          diagnostics: localDiagnostics,
        },
        scope,
      )

      expect(html).toContain('Restart in debug mode…')
    })
  })

  describe('webApi diagnostics bridge and safety boundaries', () => {
    let webApiMod: typeof import('@renderer/web/api')
    let webSettingsMod: typeof import('@renderer/web/settings')
    let debugStoreMod: typeof import('@renderer/stores/debug')
    let reportStoreMod: typeof import('@renderer/stores/report')
    let diagnosticsStoreMod: typeof import('@renderer/stores/diagnostics')
    let webHostStoreMod: typeof import('@renderer/stores/web-host')

    beforeAll(async () => {
      vi.resetModules()
      stubWindow('web')
      ;[
        webApiMod,
        webSettingsMod,
        debugStoreMod,
        reportStoreMod,
        diagnosticsStoreMod,
        webHostStoreMod,
      ] = await Promise.all([
        import('@renderer/web/api'),
        import('@renderer/web/settings'),
        import('@renderer/stores/debug'),
        import('@renderer/stores/report'),
        import('@renderer/stores/diagnostics'),
        import('@renderer/stores/web-host'),
      ])
    })

    function createFakeLink(
      info: HostInfo,
      initialDiagnostics: DiagnosticsStatus | null,
      extraHandlers: Record<string, (params: unknown) => unknown> = {},
    ) {
      const stateListeners = new Set<(state: LinkState) => void>()
      const adminListeners = new Set<(event: HostAdminEvent) => void>()
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method in extraHandlers) return extraHandlers[method]!(params)
        if (method === 'host.info') return info
        if (method === 'settings.get') return hostSettingsPart(DEFAULT_SETTINGS)
        if (method === 'diagnostics.status') {
          if (!initialDiagnostics) throw new Error('unexpected diagnostics.status call')
          return initialDiagnostics
        }
        if (method === 'diagnostics.clearVerbose') return null
        if (method === 'diagnostics.restartNormally') return null
        throw new Error(`Unexpected method: ${method}`)
      })
      const link = {
        state: { kind: 'connecting' } as LinkState,
        request,
        send: vi.fn(),
        wake: vi.fn(),
        onState: (listener: (state: LinkState) => void) => {
          stateListeners.add(listener)
          return () => {
            stateListeners.delete(listener)
          }
        },
        onAdminEvent: (listener: (event: HostAdminEvent) => void) => {
          adminListeners.add(listener)
          return () => {
            adminListeners.delete(listener)
          }
        },
        onHostEvent: () => () => {},
        onMessage: () => () => {},
      } as unknown as HostLink
      return {
        link,
        request,
        emitConnected: () => {
          const state = {
            kind: 'connected',
            welcome: {
              host: { name: 'Studio Mac', platform: 'darwin', version: info.version },
              device: { id: 'dev1', name: 'Browser' },
            },
          } as unknown as Extract<LinkState, { kind: 'connected' }>
          for (const listener of stateListeners) listener(state)
        },
        emitAdmin: (event: HostAdminEvent) => {
          for (const listener of adminListeners) listener(event)
        },
      }
    }

    it('wires diagnostics status, recording start/stop with report command, verbose cleanup, normal restart, and blocks debug=true', async () => {
      webHostStoreMod.useWebHostStore.setState({ info: null })
      diagnosticsStoreMod.receiveWebDiagnostics(null)

      const initialStatus: DiagnosticsStatus = {
        recording: null,
        debug: {
          on: true,
          cdp: 9222,
          inspectors: [{ name: 'main', url: 'ws://127.0.0.1:9229/main' }],
          file: null,
        },
        canRecord: true,
        canClearVerbose: true,
        canRestartNormally: true,
      }
      const recordingStatus: DiagnosticsStatus = {
        ...initialStatus,
        recording: { startedAt: 10_000, endsAt: 1_810_000 },
      }
      const stoppedStatus: DiagnosticsStatus = {
        ...initialStatus,
        recording: null,
      }
      const fake = createFakeLink(makeHostInfo({ diagnostics: true }), initialStatus, {
        'diagnostics.startRecording': () => recordingStatus,
        'diagnostics.stopRecording': () => ({
          status: stoppedStatus,
          span: { from: 10_000, to: 15_000 },
        }),
      })
      const webSettings = new webSettingsMod.WebSettings(null)
      const api = webApiMod.webApi(fake.link, webSettings, {
        id: 'host-1',
        address: null,
        known: { name: 'Studio Mac', deviceName: 'Browser' },
        forget: async () => {},
        storage: null,
      })

      const commands: AppCommand[] = []
      api.app.onCommand((command) => commands.push(command))

      // Reading debug status loads diagnostics.status and populates stores.
      expect(await api.debug.get()).toEqual(initialStatus.debug)
      expect(debugStoreMod.useDebugStore.getState().status.on).toBe(true)

      // Turning debug mode ON remotely is always rejected without contacting the host.
      await expect(api.debug.restart(true)).rejects.toMatchObject({ code: 'unknown_method' })
      expect(fake.request).not.toHaveBeenCalledWith(
        'diagnostics.restartNormally',
        expect.anything(),
      )

      // Restarting normally calls diagnostics.restartNormally.
      await api.debug.restart(false)
      expect(fake.request).toHaveBeenCalledWith('diagnostics.restartNormally', undefined)

      // Starting and stopping a recording syncs state and opens the report dialog with the span.
      expect(await api.report.record(true)).toEqual(recordingStatus.recording)
      expect(reportStoreMod.useReportStore.getState().recording).toEqual(recordingStatus.recording)
      expect(await api.report.record(false)).toBeNull()
      expect(reportStoreMod.useReportStore.getState().recording).toBeNull()
      expect(commands).toEqual([{ kind: 'report-problem', span: { from: 10_000, to: 15_000 } }])

      // Clearing detailed records forwards to diagnostics.clearVerbose.
      await api.diagnostics.clearVerbose()
      expect(fake.request).toHaveBeenCalledWith('diagnostics.clearVerbose', undefined)

      // Live diagnostics.changed events update debug and recording stores.
      fake.emitAdmin({
        type: 'diagnostics.changed',
        status: { ...initialStatus, debug: DEBUG_OFF, recording: { startedAt: 1, endsAt: 2 } },
      })
      expect(debugStoreMod.useDebugStore.getState().status.on).toBe(false)
      expect(reportStoreMod.useReportStore.getState().recording).toEqual({
        startedAt: 1,
        endsAt: 2,
      })
    })

    it('degrades without calling diagnostics.status when connected to an older host', async () => {
      webHostStoreMod.useWebHostStore.setState({ info: null })
      diagnosticsStoreMod.receiveWebDiagnostics(null)

      const olderInfo = makeHostInfo({ diagnostics: undefined })
      const fake = createFakeLink(olderInfo, null)
      const webSettings = new webSettingsMod.WebSettings(null)
      const api = webApiMod.webApi(fake.link, webSettings, {
        id: 'host-old',
        address: null,
        known: { name: 'Old Mac', deviceName: 'Browser' },
        forget: async () => {},
        storage: null,
      })

      expect(await api.debug.get()).toEqual(DEBUG_OFF)
      expect(await api.report.recording()).toBeNull()
      expect(fake.request).not.toHaveBeenCalledWith('diagnostics.status', expect.anything())
    })
  })
})
