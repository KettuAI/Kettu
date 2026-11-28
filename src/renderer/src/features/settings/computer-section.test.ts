import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { ComputerUseStatus } from '@shared/computer-use'
import type { HostInfo, HostSettingsPart } from '@shared/remote/host-admin'
import { hostSettingsPart } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'

const hostRequests = vi.hoisted(() => vi.fn())
const localUpdate = vi.hoisted(() => vi.fn())

function stubWindow(client: 'desktop' | 'web') {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  const neverSettle = new Promise(() => {})
  vi.stubGlobal('window', {
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
      computer: {
        status: vi.fn(async () => ({
          driver: true,
          accessibility: 'granted',
          screenRecording: 'not-determined',
          sessionType: null,
          desktop: null,
        })),
        requestPermission: vi.fn(async () => {}),
        appIcon: vi.fn(async () => null),
      },
      marketplace: {
        setKeys: vi.fn(() => neverSettle),
        setAgentEnv: vi.fn(() => neverSettle),
      },
    },
  })
}

describe('Computer use section read-only remote and editable local rendering', () => {
  afterAll(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  describe('desktop local & multi-host scope', () => {
    let i18nMod: typeof import('@renderer/lib/i18n')
    let hostScopeMod: typeof import('@renderer/stores/host-scope')
    let settingsStoreMod: typeof import('@renderer/stores/settings')
    let computerSectionMod: typeof import('./computer-section')
    let rowsMod: typeof import('./rows')

    beforeAll(async () => {
      vi.resetModules()
      stubWindow('desktop')
      ;[i18nMod, hostScopeMod, settingsStoreMod, computerSectionMod, rowsMod] = await Promise.all([
        import('@renderer/lib/i18n'),
        import('@renderer/stores/host-scope'),
        import('@renderer/stores/settings'),
        import('./computer-section'),
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
      void i18nMod.i18n.changeLanguage('en')
    })

    function renderSection(
      input: Parameters<typeof computerSectionMod.buildComputerUseSection>[0],
      scope: import('@renderer/stores/host-scope').HostScope,
    ): string {
      const section = computerSectionMod.buildComputerUseSection(input)
      return renderToStaticMarkup(
        createElement(
          hostScopeMod.HostScopeContext.Provider,
          { value: scope },
          createElement(
            'div',
            null,
            createElement('p', { 'data-page-desc': '' }, section.description),
            createElement(rowsMod.SectionBody, { section }),
            section.footer ?? null,
          ),
        ),
      )
    }

    it('renders read-only status, macOS permissions, shortcut, allowed apps and localized note without mutation buttons', () => {
      const remoteSettings: SettingsFile = structuredClone(DEFAULT_SETTINGS)
      remoteSettings.computerUse = {
        enabled: true,
        pauseOnUse: false,
        stopShortcut: 'Control+Alt+Command+K',
        allowedApps: [
          { id: 'com.apple.Safari', name: 'Safari' },
          { id: 'com.apple.Notes', name: 'Notes' },
        ],
      }
      const scopedSettings = create(() => ({
        settings: remoteSettings,
        loaded: true,
        update: vi.fn(),
      })) as unknown as typeof hostScopeMod.LOCAL_SCOPE.useSettingsStore
      const remoteScope: import('@renderer/stores/host-scope').HostScope = {
        ...hostScopeMod.LOCAL_SCOPE,
        hostId: 'remote-mac',
        useSettingsStore: scopedSettings,
      }
      const status: ComputerUseStatus = {
        driver: true,
        accessibility: 'granted',
        screenRecording: 'denied',
        sessionType: null,
        desktop: null,
      }

      const enHtml = renderSection(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          readOnly: true,
          support: 'supported',
          hostName: 'Studio Mac',
          hostParams: { context: 'web', host: 'Studio Mac' },
          targetPlatform: 'darwin',
          knownRemotePlatform: 'darwin',
          enabled: true,
          pauseOnUse: false,
          allowedApps: remoteSettings.computerUse.allowedApps,
          status,
          statusFailed: false,
          removeError: null,
          onReload: () => {},
          onRemoveApp: () => {},
        },
        remoteScope,
      )

      expect(enHtml).toContain('Let agents use Studio Mac')
      expect(enHtml).toContain('On')
      expect(enHtml).toContain('Off')
      expect(enHtml).toContain('Accessibility')
      expect(enHtml).toContain('Allowed')
      expect(enHtml).toContain('Screen Recording')
      expect(enHtml).toContain('Denied')
      expect(enHtml).toContain('Safari')
      expect(enHtml).toContain('com.apple.Safari')
      expect(enHtml).toContain('Notes')
      expect(enHtml).toContain('com.apple.Notes')
      expect(enHtml).toContain(
        'Computer use settings and permissions can only be changed on Studio Mac.',
      )
      // Strictly read-only: no switches, no grant/remove/edit buttons anywhere.
      expect(enHtml).not.toContain('<button')
      expect(enHtml).not.toContain('role="switch"')
      expect(enHtml).not.toContain('Allow…')
      expect(enHtml).not.toContain('Open System Settings')
      expect(enHtml).not.toContain('Remove')

      // Chinese localized read-only copy.
      void i18nMod.i18n.changeLanguage('zh-CN')
      const zhHtml = renderSection(
        {
          t: i18nMod.i18n.getFixedT('zh-CN', 'settings'),
          readOnly: true,
          support: 'supported',
          hostName: 'Studio Mac',
          hostParams: { context: 'web', host: 'Studio Mac' },
          targetPlatform: 'darwin',
          knownRemotePlatform: 'darwin',
          enabled: true,
          pauseOnUse: false,
          allowedApps: remoteSettings.computerUse.allowedApps,
          status: { ...status, screenRecording: 'not-determined' },
          statusFailed: false,
          removeError: null,
          onReload: () => {},
          onRemoveApp: () => {},
        },
        remoteScope,
      )
      expect(zhHtml).toContain('已开启')
      expect(zhHtml).toContain('已关闭')
      expect(zhHtml).toContain('已允许')
      expect(zhHtml).toContain('未允许')
      expect(zhHtml).toContain('Computer use 的设置和权限只能在 Studio Mac 上更改。')
      expect(zhHtml).not.toContain('<button')
    })

    it('renders unavailable cards for daemon hosts and older hosts without crashing', () => {
      const daemonHtml = renderSection(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          readOnly: true,
          support: 'unsupported',
          hostName: 'Build Box',
          hostParams: { context: 'web', host: 'Build Box' },
          targetPlatform: 'linux',
          knownRemotePlatform: 'linux',
          enabled: false,
          pauseOnUse: true,
          allowedApps: [],
          status: null,
          statusFailed: false,
          removeError: null,
          onReload: () => {},
          onRemoveApp: () => {},
        },
        hostScopeMod.LOCAL_SCOPE,
      )
      expect(daemonHtml).toContain('Computer use needs the desktop app')
      expect(daemonHtml).not.toContain('<button')

      const olderHtml = renderSection(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          readOnly: true,
          support: 'older',
          hostName: 'Old Mac',
          hostParams: { context: 'web', host: 'Old Mac' },
          targetPlatform: 'darwin',
          knownRemotePlatform: 'darwin',
          enabled: false,
          pauseOnUse: true,
          allowedApps: [],
          status: null,
          statusFailed: false,
          removeError: null,
          onReload: () => {},
          onRemoveApp: () => {},
        },
        hostScopeMod.LOCAL_SCOPE,
      )
      expect(olderHtml).toContain('Computer use state is not available')
      expect(olderHtml).not.toContain('<button')
    })

    it('keeps local desktop Computer use settings editable with switches, permission buttons and remove actions', () => {
      const localSettings = structuredClone(DEFAULT_SETTINGS)
      localSettings.computerUse = {
        enabled: true,
        pauseOnUse: true,
        stopShortcut: '',
        allowedApps: [{ id: 'com.apple.Safari', name: 'Safari' }],
      }
      settingsStoreMod.useSettingsStore.setState({ settings: localSettings, loaded: true })

      const localHtml = renderSection(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          readOnly: false,
          support: 'supported',
          hostName: '',
          hostParams: {},
          targetPlatform: 'darwin',
          knownRemotePlatform: null,
          enabled: true,
          pauseOnUse: true,
          allowedApps: localSettings.computerUse.allowedApps,
          status: {
            driver: true,
            accessibility: 'granted',
            screenRecording: 'not-determined',
            sessionType: null,
            desktop: null,
          },
          statusFailed: false,
          removeError: null,
          onReload: () => {},
          onRemoveApp: () => {},
        },
        hostScopeMod.LOCAL_SCOPE,
      )

      expect(localHtml).toContain('role="switch"')
      expect(localHtml).toContain('Allow…')
      expect(localHtml).toContain('Remove')
      expect(localHtml).toContain('Change the shortcut')
      expect(localHtml).not.toContain('can only be changed on')
    })

    it('syncs remote host computerUse in hostScope, routes computerStatus RPC, and rejects remote updates', async () => {
      const REMOTE_ID = 'remote-host-1597'
      const remoteFile = structuredClone(DEFAULT_SETTINGS)
      remoteFile.computerUse = {
        enabled: true,
        allowedApps: [{ id: 'com.apple.Xcode', name: 'Xcode' }],
        pauseOnUse: false,
        stopShortcut: 'Control+Alt+Command+X',
      }
      const remotePart: HostSettingsPart = hostSettingsPart(remoteFile)
      const remoteInfo: HostInfo = {
        name: 'Kettu',
        version: '0.1.26',
        system: 'macOS 15.4',
        userDataPath: '/tmp/remote',
        isPackaged: true,
        sharing: true,
        updates: true,
        remoteSwitch: true,
        remoteReset: true,
        thumbnails: true,
        computerUse: true,
      }
      const remoteStatus: ComputerUseStatus = {
        driver: true,
        accessibility: 'granted',
        screenRecording: 'granted',
        sessionType: null,
        desktop: null,
      }
      hostRequests.mockImplementation(async (_hostId: string, method: string) => {
        if (method === 'settings.get') return remotePart
        if (method === 'host.info') return remoteInfo
        if (method === 'computer.status') return remoteStatus
        if (method === 'agents.list') return []
        if (method === 'git.tools') {
          return {
            git: { state: 'ready', version: '2.45.0', path: '/usr/bin/git' },
            gh: { state: 'ready', version: '2.50.0', path: '/usr/bin/gh', account: null },
          }
        }
        return null
      })

      const scope = hostScopeMod.hostScope(REMOTE_ID)
      await Promise.resolve()
      await Promise.resolve()

      expect(scope.useSettingsStore.getState().settings.computerUse).toEqual(remoteFile.computerUse)
      expect(await scope.api.computerStatus()).toEqual(remoteStatus)

      // Attempting to mutate computerUse on a remote hostScope rejects and never leaks to local settings.
      await expect(
        scope.useSettingsStore.getState().update({ computerUse: { enabled: false } }),
      ).rejects.toThrow(/computerUse/)
      expect(localUpdate).not.toHaveBeenCalled()
    })

    it('renders read-only Windows, Linux and status-failed fallback states gracefully', () => {
      const windowsHtml = renderSection(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          readOnly: true,
          support: 'supported',
          hostName: 'Win PC',
          hostParams: { context: 'web', host: 'Win PC' },
          targetPlatform: 'win32',
          knownRemotePlatform: 'win32',
          enabled: false,
          pauseOnUse: true,
          allowedApps: [],
          status: {
            driver: true,
            accessibility: null,
            screenRecording: null,
            sessionType: null,
            desktop: null,
          },
          statusFailed: false,
          removeError: null,
          onReload: () => {},
          onRemoveApp: () => {},
        },
        hostScopeMod.LOCAL_SCOPE,
      )
      expect(windowsHtml).toContain('Nothing to allow')
      expect(windowsHtml).toContain('No apps yet')
      expect(windowsHtml).not.toContain('<button')

      const linuxFailedHtml = renderSection(
        {
          t: i18nMod.i18n.getFixedT('en', 'settings'),
          readOnly: true,
          support: 'supported',
          hostName: 'Ubuntu Box',
          hostParams: { context: 'web', host: 'Ubuntu Box' },
          targetPlatform: 'linux',
          knownRemotePlatform: 'linux',
          enabled: true,
          pauseOnUse: true,
          allowedApps: [],
          status: null,
          statusFailed: true,
          removeError: null,
          onReload: () => {},
          onRemoveApp: () => {},
        },
        hostScopeMod.LOCAL_SCOPE,
      )
      expect(linuxFailedHtml).toContain('Could not read permissions from Ubuntu Box.')
      expect(linuxFailedHtml).toContain('On')
      expect(linuxFailedHtml).not.toContain('<button')
    })
  })
})
