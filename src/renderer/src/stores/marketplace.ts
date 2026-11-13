import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { KettuApi } from '@shared/ipc'
import type { HostEvent } from '@shared/agent-host'
import {
  MARKET_KEPT_MS,
  type ConnectStart,
  type MarketCatalog,
  type MarketConnections,
  type MarketKeyState,
  type MarketKeysPatch,
  type MarketPlugins,
  type MarketSearch,
  type MarketSkills,
  type PluginDetails,
  type PluginLogo,
} from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { errorMessage, host, type HostRequest } from '@renderer/lib/host'

/** The registry's search shortest and longest query, as the host takes it. */
export const SEARCH_MIN = 3
export const SEARCH_MAX = 100

/** A search of the registry: the query it was for, then its answer or why there is none. */
export interface MarketSearchState {
  query: string
  result: MarketSearch | null
  error: string | null
}

/** A Connect under way or failed, as its popover shows it, by server id. */
export interface ConnectFlow {
  serverId: string
  /** Added to the settings by this Connect, so removed again if it does not finish. */
  fresh: boolean
  phase: 'starting' | 'waiting' | 'failed'
  start: ConnectStart | null
  error: string | null
}

export type ConnectionEvent = Extract<HostEvent, { type: 'market.connectionChanged' }>

/** What a plugin adds as one agent's harness reports it, or why it could not say. */
export interface DetailsState {
  details: PluginDetails | null
  error: string | null
}

export interface MarketplaceStore {
  /** The MCP catalog the host last answered with; null until it has. */
  catalog: MarketCatalog | null
  /** Why the host could not be asked for the catalog; the last one it gave stays. */
  catalogError: string | null
  catalogLoading: boolean
  search: MarketSearchState | null
  /** Which inputs of the servers Kettu keeps have a value; null until read. */
  keys: MarketKeyState | null
  keysError: string | null
  /** Where each OAuth server Kettu keeps stands with its sign-in; null until read. */
  connections: MarketConnections | null
  connectionsError: string | null
  /** By server id. */
  connecting: Record<string, ConnectFlow>
  /** The harnesses' plugins, installed ones and marketplaces; null until the host answers. */
  plugins: MarketPlugins | null
  pluginsError: string | null
  pluginsLoading: boolean
  /** By `detailsKey`. */
  details: Record<string, DetailsState>
  /** Codex plugins' own logos, by plugin id. */
  logos: Record<string, PluginLogo | 'loading'>
  /** The skills catalog and the agents' own skills; null until the host answers. */
  skills: MarketSkills | null
  skillsError: string | null
  skillsLoading: boolean
  /** What is being installed or changed, by `busyKey`. */
  busy: string[]
  /** What the directory's search field holds, kept while a listing shows. */
  query: string
  /** How many rows each section shows past its first six, by tab and section. */
  more: Record<string, number>
  /**
   * The page came into view: each list shows the host's copy at once, however old, and is read
   * again behind it when that copy, or the last read in this run, is past the host's keeping time.
   */
  visit(): void
  /** `cached` takes the host's copy, however old, and reads it again behind it if it is. */
  loadCatalog(refresh?: boolean, cached?: boolean): Promise<void>
  find(query: string): Promise<void>
  clearSearch(): void
  loadKeys(): Promise<void>
  setKeys(patch: MarketKeysPatch): Promise<void>
  loadConnections(): Promise<void>
  loadPlugins(refresh?: boolean, cached?: boolean): Promise<void>
  loadDetails(agentId: AgentId, pluginId: string): Promise<void>
  loadLogo(pluginId: string): Promise<void>
  loadSkills(refresh?: boolean, cached?: boolean): Promise<void>
}

export type MarketplaceStoreHook = UseBoundStore<StoreApi<MarketplaceStore>>

export const detailsKey = (agentId: AgentId, pluginId: string): string => `${agentId}|${pluginId}`

/** The key of an install or change under way: an MCP server's, a plugin's or a skill's. */
export const busyKey = (kind: 'mcp' | 'plugin' | 'skill', id: string): string => `${kind}:${id}`

/** The Marketplace of the host `request` reaches, whose keys `storeKeys` fills or clears. */
export function createMarketplaceStore(
  request: HostRequest,
  storeKeys: KettuApi['marketplace']['setKeys'],
): MarketplaceStoreHook {
  // Each read answers only if no later one of its kind started meanwhile.
  let catalogRead = 0
  let searchRead = 0
  let keysRead = 0
  let connectionsRead = 0
  let pluginsRead = 0
  let skillsRead = 0
  // When each list was last known to be within the host's keeping time.
  const readAt = { catalog: 0, plugins: 0, skills: 0 }
  const params = (refresh: boolean, cached: boolean) =>
    refresh ? { refresh } : cached ? { cached } : {}
  const old = (kind: keyof typeof readAt) => Date.now() - readAt[kind] >= MARKET_KEPT_MS[kind]
  return create<MarketplaceStore>()((set, get) => ({
    catalog: null,
    catalogError: null,
    catalogLoading: false,
    search: null,
    keys: null,
    keysError: null,
    connections: null,
    connectionsError: null,
    connecting: {},
    plugins: null,
    pluginsError: null,
    pluginsLoading: false,
    details: {},
    logos: {},
    skills: null,
    skillsError: null,
    skillsLoading: false,
    busy: [],
    query: '',
    more: {},
    visit() {
      const s = get()
      // A read that failed is tried again on each visit.
      if (!s.catalogLoading) {
        if (!s.catalog) void s.loadCatalog(false, true)
        else if (s.catalog.error || old('catalog')) void s.loadCatalog()
      }
      if (!s.pluginsLoading) {
        if (!s.plugins) void s.loadPlugins(false, true)
        else if (s.pluginsError || old('plugins')) void s.loadPlugins()
      }
      if (!s.skillsLoading) {
        if (!s.skills) void s.loadSkills(false, true)
        else if (s.skills.error || old('skills')) void s.loadSkills()
      }
    },
    async loadCatalog(refresh = false, cached = false) {
      const id = ++catalogRead
      set({ catalogLoading: true, catalogError: null })
      try {
        const catalog = await request('market.catalog', params(refresh, cached))
        if (id !== catalogRead) return
        set({ catalog, catalogLoading: !!catalog.stale })
        if (catalog.stale) void get().loadCatalog()
        else readAt.catalog = catalog.fetchedAt ?? Date.now()
      } catch (e) {
        if (id === catalogRead) set({ catalogError: errorMessage(e), catalogLoading: false })
      }
    },
    async find(query) {
      const id = ++searchRead
      set({ search: { query, result: null, error: null } })
      try {
        const result = await request('market.search', { query })
        if (id === searchRead) set({ search: { query, result, error: null } })
      } catch (e) {
        if (id === searchRead) set({ search: { query, result: null, error: errorMessage(e) } })
      }
    },
    clearSearch() {
      searchRead++
      if (get().search) set({ search: null })
    },
    async loadKeys() {
      const id = ++keysRead
      set({ keysError: null })
      try {
        const keys = await request('market.keys', undefined)
        if (id === keysRead) set({ keys })
      } catch (e) {
        if (id === keysRead) set({ keysError: errorMessage(e) })
      }
    },
    async setKeys(patch) {
      const keys = await storeKeys(patch)
      // A read under way would bring back what was there before this change.
      keysRead++
      set({ keys, keysError: null })
    },
    async loadConnections() {
      const id = ++connectionsRead
      set({ connectionsError: null })
      try {
        const connections = await request('market.connections', undefined)
        if (id === connectionsRead) set({ connections })
      } catch (e) {
        if (id === connectionsRead) set({ connectionsError: errorMessage(e) })
      }
    },
    async loadPlugins(refresh = false, cached = false) {
      const id = ++pluginsRead
      set({ pluginsLoading: true, pluginsError: null })
      try {
        const plugins = await request('market.plugins', params(refresh, cached))
        if (id !== pluginsRead) return
        set({ plugins, pluginsLoading: !!plugins.stale })
        if (plugins.stale) void get().loadPlugins()
        else readAt.plugins = Date.now()
      } catch (e) {
        if (id === pluginsRead) set({ pluginsError: errorMessage(e), pluginsLoading: false })
      }
    },
    async loadDetails(agentId, pluginId) {
      const key = detailsKey(agentId, pluginId)
      const known = get().details[key]
      if (known && (known.details || !known.error)) return
      set((s) => ({ details: { ...s.details, [key]: { details: null, error: null } } }))
      try {
        const details = await request('market.pluginDetails', { agentId, pluginId })
        set((s) => ({ details: { ...s.details, [key]: { details, error: null } } }))
      } catch (e) {
        set((s) => ({
          details: { ...s.details, [key]: { details: null, error: errorMessage(e) } },
        }))
      }
    },
    async loadLogo(pluginId) {
      if (get().logos[pluginId]) return
      set((s) => ({ logos: { ...s.logos, [pluginId]: 'loading' } }))
      let logo: PluginLogo
      try {
        logo = await request('market.pluginLogo', { pluginId })
      } catch (e) {
        // The tile falls back to the plugin's glyph; the reason goes to the console.
        console.warn(`Could not read the logo of ${pluginId}: ${errorMessage(e)}`)
        logo = { light: null, dark: null }
      }
      set((s) => ({ logos: { ...s.logos, [pluginId]: logo } }))
    },
    async loadSkills(refresh = false, cached = false) {
      const id = ++skillsRead
      set({ skillsLoading: true, skillsError: null })
      try {
        const skills = await request('market.skills', params(refresh, cached))
        if (id !== skillsRead) return
        set({ skills, skillsLoading: !!skills.stale })
        if (skills.stale) void get().loadSkills()
        else readAt.skills = Date.now()
      } catch (e) {
        if (id === skillsRead) set({ skillsError: errorMessage(e), skillsLoading: false })
      }
    },
  }))
}

export const useMarketplaceStore = createMarketplaceStore(host, (patch) =>
  window.kettu.marketplace.setKeys(patch),
)

/** Marks an install or change as under way, or done. */
export function setBusy(store: MarketplaceStoreHook, key: string, busy: boolean): void {
  store.setState((s) => ({
    busy: busy ? [...s.busy.filter((x) => x !== key), key] : s.busy.filter((x) => x !== key),
  }))
}

/** The host says the keys changed: a page that read them reads them again. */
export function marketKeysChanged(store: MarketplaceStoreHook = useMarketplaceStore): void {
  const state = store.getState()
  if (state.keys !== null) void state.loadKeys()
}

/** Changes the plugins the host last listed, as an install, uninstall or switch answered. */
export function updatePlugins(
  store: MarketplaceStoreHook,
  change: (plugins: MarketPlugins) => MarketPlugins,
): void {
  store.setState((s) => (s.plugins ? { plugins: change(s.plugins) } : s))
}

/** Shows a Connect's progress; null ends it. */
export function setConnectFlow(
  store: MarketplaceStoreHook,
  serverId: string,
  flow: ConnectFlow | null,
): void {
  store.setState((s) => {
    const connecting = { ...s.connecting }
    if (flow) connecting[serverId] = flow
    else delete connecting[serverId]
    return { connecting }
  })
}

// The Connects waiting for how their sign-in ends, by login id, and the ends that came before
// their Connect learned its id. Login ids are random, so every host's share one map.
const loginWaiters = new Map<string, (event: ConnectionEvent) => void>()
const earlyEnds = new Map<string, ConnectionEvent>()
const EARLY_ENDS_KEPT = 20

/** How the sign-in `loginId` ends, or null after `timeoutMs`. */
export function waitForLogin(loginId: string, timeoutMs: number): Promise<ConnectionEvent | null> {
  const early = earlyEnds.get(loginId)
  if (early) {
    earlyEnds.delete(loginId)
    return Promise.resolve(early)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      loginWaiters.delete(loginId)
      resolve(null)
    }, timeoutMs)
    loginWaiters.set(loginId, (event) => {
      clearTimeout(timer)
      loginWaiters.delete(loginId)
      resolve(event)
    })
  })
}

/** A server's sign-in changed: its state shows at once, and a Connect waiting for it ends. */
export function marketConnectionChanged(
  event: ConnectionEvent,
  store: MarketplaceStoreHook = useMarketplaceStore,
): void {
  store.setState((s) =>
    s.connections ? { connections: { ...s.connections, [event.serverId]: event.connection } } : s,
  )
  if (!event.loginId) return
  const waiter = loginWaiters.get(event.loginId)
  if (waiter) return waiter(event)
  earlyEnds.set(event.loginId, event)
  if (earlyEnds.size > EARLY_ENDS_KEPT) earlyEnds.delete(earlyEnds.keys().next().value!)
}
