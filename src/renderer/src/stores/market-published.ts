// Marketplace › Published of each host: whether the host's Kettu account shows the tab, and what
// it published, its drafts and where each came from, read again whenever the host says so.

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { MarketAccount, MarketPublished } from '@shared/market-publish'
import { errorCode, errorMessage, type HostRequest } from '@renderer/lib/host'

export interface PublishedStore {
  /** The host's account while it is signed in with Kettu's services on; undefined until read. */
  account: MarketAccount | null | undefined
  /** What the host last answered; null until it has. */
  published: MarketPublished | null
  /** Why the host could not be asked; what it answered before stays. */
  error: string | null
  loading: boolean
  /** Asks whether the tab shows. */
  loadAccount(): Promise<void>
  /** Reads the account, its listings and the drafts. */
  load(): Promise<void>
}

export type PublishedStoreHook = UseBoundStore<StoreApi<PublishedStore>>

function createPublishedStore(request: HostRequest): PublishedStoreHook {
  // Each read answers only if no later one of its kind started meanwhile.
  let accountRead = 0
  let read = 0
  return create<PublishedStore>()((set) => ({
    account: undefined,
    published: null,
    error: null,
    loading: false,
    async loadAccount() {
      const id = ++accountRead
      try {
        const { account } = await request('market.account', undefined)
        if (id === accountRead) set({ account })
      } catch (error) {
        // A host from before Published, or one away, shows no tab.
        if (id !== accountRead) return
        if (errorCode(error) === 'unknown_method') set({ account: null })
        else console.warn(`Could not read the Marketplace account: ${errorMessage(error)}`)
      }
    },
    async load() {
      const id = ++read
      accountRead++
      set({ loading: true, error: null })
      try {
        const published = await request('market.published', undefined)
        if (id === read) set({ published, account: published.account, loading: false })
      } catch (error) {
        if (id === read) set({ error: errorMessage(error), loading: false })
      }
    },
  }))
}

const stores = new Map<string | null, PublishedStoreHook>()

/** The Published store of a host, null being this computer, made on first use. */
export function publishedStore(hostId: string | null, request: HostRequest): PublishedStoreHook {
  let store = stores.get(hostId)
  if (!store) {
    store = createPublishedStore(request)
    stores.set(hostId, store)
  }
  return store
}

/**
 * The host says the account, the listings or the drafts changed: a store that read them reads
 * them again, one that only asked for the account asks again.
 */
export function marketPublishedChanged(hostId: string | null): void {
  const state = stores.get(hostId)?.getState()
  if (!state) return
  if (state.published !== null || state.loading) void state.load()
  else void state.loadAccount()
}
