import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { KettuApi } from '@shared/ipc'
import type {
  MarketCatalog,
  MarketKeyState,
  MarketKeysPatch,
  MarketPlugins,
  MarketSearch,
  MarketSkills,
  PluginDetails,
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
  /** The harnesses' plugins, installed ones and marketplaces; null until the host answers. */
  plugins: MarketPlugins | null
  pluginsError: string | null
  pluginsLoading: boolean
  /** By `detailsKey`. */
  details: Record<string, DetailsState>
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
  loadCatalog(refresh?: boolean): Promise<void>
  find(query: string): Promise<void>
  clearSearch(): void
  loadKeys(): Promise<void>
  setKeys(patch: MarketKeysPatch): Promise<void>
  loadPlugins(refresh?: boolean): Promise<void>
  loadDetails(agentId: AgentId, pluginId: string): Promise<void>
  loadSkills(refresh?: boolean): Promise<void>
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
  let pluginsRead = 0
  let skillsRead = 0
  return create<MarketplaceStore>()((set, get) => ({
    catalog: null,
    catalogError: null,
    catalogLoading: false,
    search: null,
    keys: null,
    keysError: null,
    plugins: null,
    pluginsError: null,
    pluginsLoading: false,
    details: {},
    skills: null,
    skillsError: null,
    skillsLoading: false,
    busy: [],
    query: '',
    more: {},
    async loadCatalog(refresh = false) {
      const id = ++catalogRead
      set({ catalogLoading: true, catalogError: null })
      try {
        const catalog = await request('market.catalog', refresh ? { refresh } : {})
        if (id === catalogRead) set({ catalog, catalogLoading: false })
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
    async loadPlugins(refresh = false) {
      const id = ++pluginsRead
      set({ pluginsLoading: true, pluginsError: null })
      try {
        const plugins = await request('market.plugins', refresh ? { refresh } : {})
        if (id === pluginsRead) set({ plugins, pluginsLoading: false })
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
    async loadSkills(refresh = false) {
      const id = ++skillsRead
      set({ skillsLoading: true, skillsError: null })
      try {
        const skills = await request('market.skills', refresh ? { refresh } : {})
        if (id === skillsRead) set({ skills, skillsLoading: false })
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
export function setBusy(key: string, busy: boolean): void {
  useMarketplaceStore.setState((s) => ({
    busy: busy ? [...s.busy.filter((x) => x !== key), key] : s.busy.filter((x) => x !== key),
  }))
}

/** The host says the keys changed: a page that read them reads them again. */
export function marketKeysChanged(): void {
  const store = useMarketplaceStore.getState()
  if (store.keys !== null) void store.loadKeys()
}

/** Changes the plugins the host last listed, as an install, uninstall or switch answered. */
export function updatePlugins(change: (plugins: MarketPlugins) => MarketPlugins): void {
  useMarketplaceStore.setState((s) => (s.plugins ? { plugins: change(s.plugins) } : s))
}
