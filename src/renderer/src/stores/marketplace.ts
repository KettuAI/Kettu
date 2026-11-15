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
import type { CommunityInstalled, CommunityItem, CommunityListing } from '@shared/market-community'
import type { PublishKind } from '@shared/market-publish'
import type { AgentId } from '@shared/thread'
import { errorMessage, host, type HostRequest } from '@renderer/lib/host'

/** How long the directory's Community and the installed items' standings are shown before a visit reads them again. */
const COMMUNITY_MS = 5 * 60_000

/** What a part of the Kettu Marketplace's directory is read for: a kind, a search, or both. */
export interface CommunityScope {
  kind?: PublishKind
  q?: string
}

export const communityScopeKey = (scope: CommunityScope): string =>
  `${scope.kind ?? 'all'}\0${scope.q ?? ''}`

/** The directory's pages read so far for one scope, appended in order. */
export interface CommunityPages {
  /** False while the host is not signed in to a Kettu account with Kettu's services on. */
  signedIn: boolean
  /** Public listings, most installed first, each once. */
  items: CommunityItem[]
  /** The account's own Only me listings, from the first page. */
  yours: CommunityItem[]
  /** The cursor of the next page; null on the last. */
  next: string | null
  /** The first page or a further one is on its way. */
  loading: boolean
  /** Why the first page, or the account's own listings, could not be read. */
  error: string | null
  /** Why the last further page could not be read; the rows already shown stay. */
  moreError: string | null
  /** When the first page was read. */
  at: number
}

/** A listing's page of the Kettu Marketplace: what the host said of it, or why it could not. */
export interface CommunityListingState {
  listing: CommunityListing | null
  error: string | null
}

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
  /** The Kettu Marketplace's directory, by `communityScopeKey`; a scope is absent until read. */
  communityPages: Record<string, CommunityPages>
  /** By listing id. */
  communityListings: Record<string, CommunityListingState>
  /** What was installed from the Kettu Marketplace and where each stands; null until read. */
  communityInstalled: CommunityInstalled | null
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
  /** Reads a scope's first page again, dropping the later ones. */
  loadCommunity(scope: CommunityScope, refresh?: boolean): Promise<void>
  /** Reads a scope's first page unless a fresh one is shown or on its way. */
  ensureCommunity(scope: CommunityScope): void
  /** Reads the page after the last one read, if there is one. */
  loadMoreCommunity(scope: CommunityScope): Promise<void>
  /** Forgets every search's pages. */
  clearCommunitySearch(): void
  loadCommunityListing(id: string, refresh?: boolean): Promise<void>
  loadCommunityInstalled(refresh?: boolean): Promise<void>
}

export type MarketplaceStoreHook = UseBoundStore<StoreApi<MarketplaceStore>>

export const detailsKey = (agentId: AgentId, pluginId: string): string => `${agentId}|${pluginId}`

/** The key of an install or change under way: an MCP server's, a plugin's or a skill's. */
export const busyKey = (kind: 'mcp' | 'plugin' | 'skill' | 'community', id: string): string =>
  `${kind}:${id}`

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
  // By scope key; a first page read voids any read of the same scope still on its way.
  const communityReads = new Map<string, number>()
  let installedRead = 0
  let installedAt = 0
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
    communityPages: {},
    communityListings: {},
    communityInstalled: null,
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
      s.ensureCommunity({})
      if (!s.communityInstalled || Date.now() - installedAt >= COMMUNITY_MS) {
        void s.loadCommunityInstalled()
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
    async loadCommunity(scope, refresh = false) {
      const key = communityScopeKey(scope)
      const id = (communityReads.get(key) ?? 0) + 1
      communityReads.set(key, id)
      const put = (pages: CommunityPages) =>
        set((s) => {
          const all = { ...s.communityPages, [key]: pages }
          // One search is kept at a time, the one typed last.
          if (scope.q) {
            for (const other of Object.keys(all)) {
              if (other !== key && !other.endsWith('\0')) delete all[other]
            }
          }
          return { communityPages: all }
        })
      const known = get().communityPages[key]
      put({
        signedIn: known?.signedIn ?? true,
        items: known?.items ?? [],
        yours: known?.yours ?? [],
        next: known?.next ?? null,
        loading: true,
        error: null,
        moreError: null,
        at: known?.at ?? 0,
      })
      try {
        const page = await request('market.community', {
          ...(scope.kind ? { kind: scope.kind } : {}),
          ...(scope.q ? { q: scope.q } : {}),
          ...(refresh ? { refresh } : {}),
        })
        if (communityReads.get(key) !== id) return
        put({
          signedIn: page.signedIn,
          items: page.items,
          yours: page.yours,
          next: page.next,
          loading: false,
          error: page.error,
          moreError: null,
          at: page.error ? 0 : Date.now(),
        })
        // A first page read again starts the section over at its first rows.
        set((s) => ({
          more: Object.fromEntries(
            Object.entries(s.more).filter(([section]) => !section.endsWith('community')),
          ),
        }))
      } catch (e) {
        if (communityReads.get(key) !== id) return
        put({ ...get().communityPages[key]!, loading: false, error: errorMessage(e), at: 0 })
      }
    },
    ensureCommunity(scope) {
      const known = get().communityPages[communityScopeKey(scope)]
      if (known?.loading) return
      if (known && !known.error && Date.now() - known.at < COMMUNITY_MS) return
      void get().loadCommunity(scope)
    },
    async loadMoreCommunity(scope) {
      const key = communityScopeKey(scope)
      const known = get().communityPages[key]
      if (!known || known.loading || !known.next) return
      const id = communityReads.get(key) ?? 0
      const update = (change: Partial<CommunityPages>) =>
        set((s) => {
          const pages = s.communityPages[key]
          return pages
            ? { communityPages: { ...s.communityPages, [key]: { ...pages, ...change } } }
            : {}
        })
      update({ loading: true, moreError: null })
      try {
        const page = await request('market.community', {
          ...(scope.kind ? { kind: scope.kind } : {}),
          ...(scope.q ? { q: scope.q } : {}),
          cursor: known.next,
        })
        if (communityReads.get(key) !== id) return
        const current = get().communityPages[key]
        if (!current) return
        if (page.error || !page.signedIn) {
          update({ loading: false, moreError: page.error ?? null })
          return
        }
        const seen = new Set(current.items.map((item) => item.id))
        update({
          items: [...current.items, ...page.items.filter((item) => !seen.has(item.id))],
          next: page.next,
          loading: false,
        })
      } catch (e) {
        if (communityReads.get(key) === id) update({ loading: false, moreError: errorMessage(e) })
      }
    },
    clearCommunitySearch() {
      const pages = get().communityPages
      const kept = Object.fromEntries(Object.entries(pages).filter(([key]) => key.endsWith('\0')))
      if (Object.keys(kept).length === Object.keys(pages).length) return
      for (const key of Object.keys(pages)) if (!(key in kept)) communityReads.delete(key)
      set({ communityPages: kept })
    },
    async loadCommunityListing(id, refresh = false) {
      const known = get().communityListings[id]
      if (known && !refresh && (known.listing || !known.error)) return
      const put = (state: CommunityListingState) =>
        set((s) => ({ communityListings: { ...s.communityListings, [id]: state } }))
      if (!known?.listing) put({ listing: null, error: null })
      try {
        put({ listing: await request('market.communityListing', { id }), error: null })
      } catch (e) {
        put({ listing: known?.listing ?? null, error: errorMessage(e) })
      }
    },
    async loadCommunityInstalled(refresh = false) {
      const id = ++installedRead
      try {
        const installed = await request('market.communityInstalled', refresh ? { refresh } : {})
        if (id !== installedRead) return
        set({ communityInstalled: installed })
        installedAt = Date.now()
      } catch (e) {
        // The rows then show no update; the reason goes to the console.
        console.warn(`Could not read what came from the Kettu Marketplace: ${errorMessage(e)}`)
      }
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
