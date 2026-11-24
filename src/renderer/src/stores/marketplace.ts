import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { KettuApi } from '@shared/ipc'
import type { HostEvent } from '@shared/agent-host'
import type { InstalledKettuPlugin } from '@shared/plugins'
import {
  MARKET_KEPT_MS,
  type AgentOwnPlugins,
  type ConnectStart,
  type MarketCatalog,
  type MarketConnections,
  type MarketKeyState,
  type MarketKeysPatch,
  type MarketSearch,
  type MarketSkillRepository,
  type MarketSkills,
} from '@shared/marketplace'
import type { CommunityInstalled, CommunityItem, CommunityListing } from '@shared/market-community'
import type { PublishKind } from '@shared/market-publish'
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
  /** The Kettu plugins installed on the host; null until it answers. */
  plugins: InstalledKettuPlugin[] | null
  pluginsError: string | null
  /** The plugins the agents have of their own; null until the host answers. */
  ownPlugins: AgentOwnPlugins | null
  ownPluginsError: string | null
  ownPluginsLoading: boolean
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
  loadOwnPlugins(refresh?: boolean): Promise<void>
  loadPlugins(): Promise<void>
  /** A plugin as the host just changed it, in place of the one shown. */
  putPlugin(plugin: InstalledKettuPlugin): void
  removePlugin(pluginId: string): void
  /** A `cached` answer that lacks a repository, or holds an old one, has each read on its own. */
  loadSkills(refresh?: boolean, cached?: boolean): Promise<void>
  /** Reads one repository of the skills catalog into the skills shown, such as on Retry. */
  loadSkillRepository(id: string, refresh?: boolean): Promise<void>
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

/** The skills shown with one repository's as just read, in the catalog's order. */
function withRepository(skills: MarketSkills, read: MarketSkillRepository): MarketSkills {
  const repositories = (skills.repositories ?? []).map((r) =>
    r.id === read.repository.id ? read.repository : r,
  )
  const of = (id: string) => skills.catalog.filter((skill) => skill.id.startsWith(`${id}:`))
  const failed = repositories.filter((r) => r.error !== null)
  return {
    ...skills,
    repositories,
    catalog: repositories.flatMap((r) => (r.id === read.repository.id ? read.skills : of(r.id))),
    error: failed.length === 0 ? null : failed.map((r) => `${r.id}: ${r.error ?? ''}`).join('; '),
  }
}

/** The key of an install or change under way: an MCP server's, a skill's or a plugin's. */
export const busyKey = (kind: 'mcp' | 'skill' | 'community' | 'plugin', id: string): string =>
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
  let ownPluginsRead = 0
  let pluginsRead = 0
  let skillsRead = 0
  // By scope key; a first page read voids any read of the same scope still on its way.
  const communityReads = new Map<string, number>()
  // The search asked for last; an answer to an earlier one is dropped, never kept over it.
  let searchKey: string | null = null
  let installedRead = 0
  let installedAt = 0
  // When each list was last known to be within the host's keeping time.
  const readAt = { catalog: 0, skills: 0 }
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
    ownPlugins: null,
    ownPluginsError: null,
    ownPluginsLoading: false,
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
      if (!s.skillsLoading) {
        if (!s.skills) void s.loadSkills(false, true)
        else if (s.skills.error || old('skills')) void s.loadSkills()
      }
      if (s.plugins === null) void s.loadPlugins()
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
    async loadOwnPlugins(refresh = false) {
      const id = ++ownPluginsRead
      set({ ownPluginsLoading: true, ownPluginsError: null })
      try {
        const ownPlugins = await request('market.ownPlugins', refresh ? { refresh } : {})
        if (id === ownPluginsRead) set({ ownPlugins, ownPluginsLoading: false })
      } catch (e) {
        if (id === ownPluginsRead)
          set({ ownPluginsError: errorMessage(e), ownPluginsLoading: false })
      }
    },
    async loadPlugins() {
      const id = ++pluginsRead
      set({ pluginsError: null })
      try {
        const { plugins } = await request('plugins.list', undefined)
        if (id === pluginsRead) set({ plugins })
      } catch (e) {
        if (id === pluginsRead) set({ pluginsError: errorMessage(e) })
      }
    },
    putPlugin(plugin) {
      // A read under way would bring back what was there before this change.
      pluginsRead++
      set((s) => {
        const known = s.plugins ?? []
        const at = known.findIndex((item) => item.id === plugin.id)
        const plugins =
          at < 0 ? [...known, plugin] : known.map((item, i) => (i === at ? plugin : item))
        return {
          plugins: plugins.sort((a, b) => a.contents.title.localeCompare(b.contents.title)),
        }
      })
    },
    removePlugin(pluginId) {
      pluginsRead++
      set((s) => ({ plugins: s.plugins?.filter((item) => item.id !== pluginId) ?? s.plugins }))
    },
    async loadCommunity(scope, refresh = false) {
      const key = communityScopeKey(scope)
      const id = (communityReads.get(key) ?? 0) + 1
      communityReads.set(key, id)
      if (scope.q) searchKey = key
      const put = (pages: CommunityPages) =>
        set((s) => {
          if (scope.q && searchKey !== key) return {}
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
        if (communityReads.get(key) !== id || (scope.q && searchKey !== key)) return
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
        if (communityReads.get(key) !== id || (scope.q && searchKey !== key)) return
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
      searchKey = null
      // Counts only go up, so a read still on its way never matches one made after this.
      for (const [key, id] of communityReads) {
        if (!key.endsWith('\0')) communityReads.set(key, id + 1)
      }
      const pages = get().communityPages
      const kept = Object.fromEntries(Object.entries(pages).filter(([key]) => key.endsWith('\0')))
      if (Object.keys(kept).length === Object.keys(pages).length) return
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
        if (!skills.stale) {
          readAt.skills = Date.now()
          return
        }
        // Each repository is listed as soon as it is read, instead of once the slowest is.
        const behind = skills.repositories?.filter((r) => !r.read || r.stale)
        if (!behind) {
          void get().loadSkills()
          return
        }
        await Promise.all(behind.map((r) => get().loadSkillRepository(r.id)))
        if (id !== skillsRead) return
        set({ skillsLoading: false })
        readAt.skills = Date.now()
      } catch (e) {
        if (id === skillsRead) set({ skillsError: errorMessage(e), skillsLoading: false })
      }
    },
    async loadSkillRepository(repositoryId, refresh = false) {
      let read: MarketSkillRepository
      try {
        read = await request('market.skillRepository', {
          id: repositoryId,
          ...(refresh && { refresh }),
        })
      } catch (e) {
        const shown = get().skills?.repositories?.find((r) => r.id === repositoryId)
        if (!shown) return
        read = {
          repository: { ...shown, error: errorMessage(e) },
          skills: (get().skills?.catalog ?? []).filter((s) => s.id.startsWith(`${repositoryId}:`)),
        }
      }
      const skills = get().skills
      if (skills) set({ skills: withRepository(skills, read) })
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

/** The host says a plugin changed: a page that read them reads them again. */
export function marketPluginsChanged(store: MarketplaceStoreHook = useMarketplaceStore): void {
  const state = store.getState()
  if (state.plugins !== null) void state.loadPlugins()
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
