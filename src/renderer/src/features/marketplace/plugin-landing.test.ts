import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSection } from '@shared/settings-catalog'
import type { InstalledKettuPlugin } from '@shared/plugins'
import type { PluginSettingsSurface } from '@renderer/stores/plugin-surfaces'
import type { SessionView } from '@renderer/stores/view'

const REMOTE = 'host-remote-1'
const OTHER = 'host-remote-2'
const PLUGIN_ID = 'p0123456789ab'
const ONLINE = { state: 'online' as const, relay: 'https://relay.example', terminal: true as const }

function stubGlobals() {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  const neverSettle = new Promise(() => {})
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
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
      marketplace: {
        setKeys: vi.fn(() => neverSettle),
        setAgentEnv: vi.fn(() => neverSettle),
      },
      remote: {
        status: vi.fn(() => neverSettle),
        onChanged: () => () => {},
      },
      sharing: {
        status: vi.fn(() => neverSettle),
        onChanged: () => () => {},
      },
    },
  })
}

async function loadModules() {
  vi.resetModules()
  stubGlobals()
  const view = await import('@renderer/stores/view')
  const hostScope = await import('@renderer/stores/host-scope')
  const hosts = await import('@renderer/stores/hosts')
  const windowHost = await import('@renderer/stores/window-host')
  const hostSwitch = await import('@renderer/stores/host-switch')
  const hostSections = await import('@renderer/features/settings/host-sections')
  const landing = await import('./plugin-landing')
  const bootstrap = await import('@renderer/app/bootstrap')
  const history = await import('@renderer/app/history')
  const searchEntries = await import('@renderer/features/search/use-search-entries')
  return {
    view,
    hostScope,
    hosts,
    windowHost,
    hostSwitch,
    hostSections,
    landing,
    bootstrap,
    history,
    searchEntries,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opening a plugin page on its own host (#2635)', () => {
  it('opens a remote plugin page pinned to that host even while the window shows all hosts', async () => {
    const { view, hosts, windowHost, landing } = await loadModules()
    hosts.useHostsStore.setState({
      kept: [
        {
          id: REMOTE,
          name: 'DevBox',
          platform: 'linux',
          connection: ONLINE,
          lastOnlineAt: 1,
        },
      ],
    })
    // Window shows all hosts, so windowScope falls back to this computer (null).
    view.useViewStore.setState({ hostFilter: null })

    const from: SessionView = {
      kind: 'session',
      sessionId: 'sess-remote',
      projectPath: `host:${REMOTE}:/work/app`,
    }
    landing.openPluginPage(PLUGIN_ID, { setup: true, from, hostId: REMOTE })

    const main = view.useViewStore.getState().main
    expect(main).toEqual({
      kind: 'marketplace',
      item: `plugin:${PLUGIN_ID}`,
      tab: 'installed',
      hostId: REMOTE,
      from,
    })

    expect(windowHost.marketplaceScope(REMOTE).hostId).toBe(REMOTE)
    expect(windowHost.marketplaceScope(null).hostId).toBeNull()
    // Without an explicit hostId, follows the window host (local when showing all hosts).
    expect(windowHost.marketplaceScope(undefined).hostId).toBeNull()
  })

  it('keeps landings scoped to the target host so another host cannot consume them', async () => {
    const { landing } = await loadModules()
    landing.openPluginPage(PLUGIN_ID, { row: 'setting-token', hostId: REMOTE })

    expect(landing.pluginLandingFor(PLUGIN_ID, null)).toBeUndefined()
    expect(landing.pluginLandingFor(PLUGIN_ID, REMOTE)).toMatchObject({ row: 'setting-token' })

    // Taking from another host leaves the pending landing intact.
    landing.takePluginLanding(PLUGIN_ID, null)
    expect(landing.pluginLandingFor(PLUGIN_ID, REMOTE)).toMatchObject({ row: 'setting-token' })

    // Taking from the matching host consumes it.
    landing.takePluginLanding(PLUGIN_ID, REMOTE)
    expect(landing.pluginLandingFor(PLUGIN_ID, REMOTE)).toBeUndefined()
  })

  it('routes openCatalogRow for plugins and Settings rows to the given host', async () => {
    const { view, hostScope, hosts, landing } = await loadModules()
    hosts.useHostsStore.setState({
      kept: [
        {
          id: REMOTE,
          name: 'DevBox',
          platform: 'linux',
          connection: ONLINE,
          lastOnlineAt: 1,
        },
      ],
    })
    view.useViewStore.setState({ hostFilter: null })

    landing.openCatalogRow('marketplace', PLUGIN_ID, 'setting-apiKey', REMOTE)
    expect(view.useViewStore.getState().main).toMatchObject({
      kind: 'marketplace',
      item: `plugin:${PLUGIN_ID}`,
      hostId: REMOTE,
    })

    // Legacy thread section name "plugins" also targets the plugin's host.
    landing.openCatalogRow('plugins' as CatalogSection, PLUGIN_ID, 'setting-apiKey', REMOTE)
    expect(view.useViewStore.getState().main).toMatchObject({
      kind: 'marketplace',
      item: `plugin:${PLUGIN_ID}`,
      hostId: REMOTE,
    })

    // Non-plugin Settings row opened while Settings is closed keeps the target hostId.
    landing.openCatalogRow('agents', 'claude-code', 'favorite-models', REMOTE)
    expect(view.useViewStore.getState().settings).toMatchObject({
      open: true,
      section: 'agents',
      item: 'claude-code',
      row: 'favorite-models',
    })
    expect(hostScope.useSettingsHostStore.getState().hostId).toBe(REMOTE)
  })

  it('handles remote settings.open events in bootstrap instead of dropping them in hostScopeEvent', async () => {
    const { view, bootstrap } = await loadModules()
    bootstrap.onHostEvent(
      {
        type: 'settings.open',
        section: 'marketplace',
        item: PLUGIN_ID,
        row: 'setting-apiKey',
      },
      REMOTE,
    )

    expect(view.useViewStore.getState().main).toMatchObject({
      kind: 'marketplace',
      item: `plugin:${PLUGIN_ID}`,
      tab: 'installed',
      hostId: REMOTE,
    })
  })

  it('preserves a pinned host during in-Marketplace navigation and clears it on sidebar open or host switch', async () => {
    const { view, hosts, hostSwitch, history, landing } = await loadModules()
    hosts.useHostsStore.setState({
      kept: [
        {
          id: REMOTE,
          name: 'DevBox',
          platform: 'linux',
          connection: ONLINE,
          lastOnlineAt: 1,
        },
        {
          id: OTHER,
          name: 'BuildBox',
          platform: 'linux',
          connection: ONLINE,
          lastOnlineAt: 1,
        },
      ],
    })
    // Leave launch so history records transitions.
    view.openMarketplace()

    // Open same plugin on local then on remote: distinct viewKeys record a history step.
    view.openMarketplace({ item: `plugin:${PLUGIN_ID}`, tab: 'installed', hostId: null })
    view.openMarketplace({ item: `plugin:${PLUGIN_ID}`, tab: 'installed', hostId: REMOTE })
    expect(
      view.viewKey({ kind: 'marketplace', item: `plugin:${PLUGIN_ID}`, hostId: null }),
    ).not.toBe(view.viewKey({ kind: 'marketplace', item: `plugin:${PLUGIN_ID}`, hostId: REMOTE }))
    expect(view.useViewStore.getState().history.back.at(-1)?.place).toMatchObject({
      kind: 'marketplace',
      item: `plugin:${PLUGIN_ID}`,
      hostId: null,
    })

    // Going to the directory on REMOTE keeps REMOTE across tab switches, item opens and installs.
    view.openMarketplace({ tab: 'installed', hostId: REMOTE })
    view.setMarketplaceTab('plugins')
    expect(view.useViewStore.getState().main).toMatchObject({
      kind: 'marketplace',
      tab: 'plugins',
      hostId: REMOTE,
    })
    landing.landOnPlugin(
      {
        id: PLUGIN_ID,
        source: { kind: 'github', url: 'https://github.com/a/b' },
      } as InstalledKettuPlugin,
      REMOTE,
    )
    expect(view.useViewStore.getState().main).toMatchObject({
      kind: 'marketplace',
      item: `plugin:${PLUGIN_ID}`,
      hostId: REMOTE,
    })
    view.openMarketplace({ item: 'mcp:github', tab: 'plugins' })
    expect(view.useViewStore.getState().main).toMatchObject({
      kind: 'marketplace',
      item: 'mcp:github',
      tab: 'plugins',
      hostId: REMOTE,
    })

    // Switching the window host explicitly unpins Marketplace so it follows the chosen host.
    hostSwitch.switchHost(OTHER, false)
    expect(view.useViewStore.getState().main).toEqual({
      kind: 'marketplace',
      item: 'mcp:github',
      tab: 'plugins',
    })

    // Opening the Marketplace directory without a host clears any pinned host.
    view.openMarketplace({ item: `plugin:${PLUGIN_ID}`, tab: 'installed', hostId: REMOTE })
    view.openMarketplace()
    expect(view.useViewStore.getState().main).toEqual({ kind: 'marketplace' })

    // A history entry pointing to a removed host is skipped once hosts status is loaded.
    hosts.useHostsStore.setState({
      status: {
        self: { name: 'This Mac', platform: 'darwin', version: '0.1.0', model: '' },
        plainTextKey: false,
        keyFailed: false,
        hosts: [
          {
            id: OTHER,
            publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            name: 'BuildBox',
            platform: 'linux',
            version: '0.1.0',
            addresses: [],
            deviceName: 'This Mac',
            addedAt: 1,
            removed: false,
            connection: ONLINE,
            lastOnlineAt: 1,
          },
        ],
      },
    })
    expect(
      history.canShow({ kind: 'marketplace', item: `plugin:${PLUGIN_ID}`, hostId: REMOTE }),
    ).toBe(false)
    expect(
      history.canShow({ kind: 'marketplace', item: `plugin:${PLUGIN_ID}`, hostId: OTHER }),
    ).toBe(true)
  })

  it('builds Search plugin setting entries for all reachable hosts with distinct keys and target hostId', async () => {
    const { searchEntries } = await loadModules()
    const surface: PluginSettingsSurface = {
      pluginId: PLUGIN_ID,
      name: 'linear',
      title: 'Linear',
      titles: {},
      icon: null,
      settings: [{ key: 'apiKey', title: 'API key', type: 'secret', required: true }],
    }

    const entries = searchEntries.buildPluginSettingEntries({
      hostIds: [null, REMOTE],
      byHost: {
        '': { settings: [surface] },
        [REMOTE]: { settings: [surface] },
      },
      language: 'en',
      showHost: true,
      hostName: (id) => (id === null ? 'This Mac' : 'DevBox'),
      trailing: (plugin) => `${plugin} · Marketplace`,
    })

    expect(entries).toHaveLength(2)
    expect(entries[0]!.key).not.toBe(entries[1]!.key)
    expect(entries[0]!.kind === 'section' && 'pluginSetting' in entries[0]!).toBe(true)
    expect(entries[1]!.kind === 'section' && 'pluginSetting' in entries[1]!).toBe(true)
    if (entries[0]!.kind === 'section' && 'pluginSetting' in entries[0]!) {
      expect(entries[0]!.pluginSetting).toMatchObject({
        hostId: null,
        pluginId: PLUGIN_ID,
        row: 'setting-apiKey',
      })
    }
    if (entries[1]!.kind === 'section' && 'pluginSetting' in entries[1]!) {
      expect(entries[1]!.pluginSetting).toMatchObject({
        hostId: REMOTE,
        pluginId: PLUGIN_ID,
        row: 'setting-apiKey',
      })
    }
    expect(entries[1]!.trailing).toContain('DevBox')
    expect(entries[1]!.haystack).toContain('devbox')
  })
})
