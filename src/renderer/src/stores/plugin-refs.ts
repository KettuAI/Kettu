import { useEffect } from 'react'
import { create } from 'zustand'
import {
  matchLink,
  type PluginLinkCard,
  type PluginLinkDecl,
  type PluginRefSource,
} from '@shared/plugin-refs'
import type { PluginViewError } from '@shared/plugin-views'
import { errorMessage, hostAt } from '@renderer/lib/host'

/** What a link's lookup has come to: on its way, a card, or why there is none. */
export type LinkCardState =
  | { status: 'loading' }
  | { status: 'ready'; card: PluginLinkCard }
  | { status: 'failed'; error: PluginViewError }

interface PluginRefsStore {
  /** What each host's plugins declare for `@` and links, by host id, '' for this computer. */
  byHost: Record<string, readonly PluginRefSource[]>
  /** The cards looked up, by host, plugin, kind of link and address; kept while the window is. */
  cards: Record<string, LinkCardState>
}

export const usePluginRefsStore = create<PluginRefsStore>()(() => ({ byHost: {}, cards: {} }))

const NONE: readonly PluginRefSource[] = []
const keyOf = (hostId: string | null): string => hostId ?? ''
const cardKey = (hostId: string | null, pluginId: string, link: string, url: string): string =>
  `${keyOf(hostId)}\n${pluginId}\n${link}\n${url}`

const reading = new Map<string, Promise<void>>()

/**
 * Reads what a host's plugins declare again. A host that does not know the request, as an older
 * one does not, has none. The cards looked up are dropped when the declarations changed, since
 * they may belong to a plugin that is gone or off; a read that finds the same ones changes nothing.
 */
export function loadPluginRefs(hostId: string | null): Promise<void> {
  const key = keyOf(hostId)
  const running = reading.get(key)
  if (running) return running
  const read = hostAt(hostId, 'plugins.refs', undefined)
    .then(
      ({ plugins }) => plugins,
      () => NONE,
    )
    .then((plugins) => {
      const before = usePluginRefsStore.getState().byHost[key]
      if (before !== undefined && JSON.stringify(before) === JSON.stringify(plugins)) return
      usePluginRefsStore.setState((s) => ({
        byHost: { ...s.byHost, [key]: plugins },
        cards: Object.fromEntries(
          Object.entries(s.cards).filter(([name]) => !name.startsWith(`${key}\n`)),
        ),
      }))
    })
    .finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}

/** The plugins of a host that declare something, read once the first time anything asks. */
export function usePluginRefs(hostId: string | null): readonly PluginRefSource[] {
  const key = keyOf(hostId)
  const known = usePluginRefsStore((s) => s.byHost[key])
  useEffect(() => {
    if (known === undefined) void loadPluginRefs(hostId)
  }, [known, hostId])
  return known ?? NONE
}

/** The plugin and kind of link that name an address, when one does. */
export interface LinkMatch {
  source: PluginRefSource
  link: PluginLinkDecl
}

function findLink(sources: readonly PluginRefSource[], url: string): LinkMatch | null {
  for (const source of sources) {
    const found = matchLink(source.links, url)
    if (found) return { source, link: found.link }
  }
  return null
}

export function useLinkMatch(hostId: string | null, url: string): LinkMatch | null {
  return findLink(usePluginRefs(hostId), url)
}

const asking = new Set<string>()

/** Looks a link's card up, once for each address; a failed one is asked again by `retry`. */
function lookUp(hostId: string | null, found: LinkMatch, url: string, retry: boolean): void {
  const key = cardKey(hostId, found.source.pluginId, found.link.id, url)
  const state = usePluginRefsStore.getState().cards[key]
  if (asking.has(key) || (state !== undefined && !(retry && state.status === 'failed'))) return
  asking.add(key)
  const set = (next: LinkCardState) =>
    usePluginRefsStore.setState((s) => ({ cards: { ...s.cards, [key]: next } }))
  set({ status: 'loading' })
  hostAt(hostId, 'plugins.linkCard', {
    pluginId: found.source.pluginId,
    link: found.link.id,
    url,
  })
    .then(
      (result) =>
        result.ok ? { status: 'ready' as const, card: result.card } : failed(result.error),
      (error: unknown) => failed({ code: 'request_failed', detail: errorMessage(error) }),
    )
    .then(set)
    .finally(() => asking.delete(key))
}

function failed(error: PluginViewError): LinkCardState {
  return { status: 'failed', error }
}

/** What is known of a link's card; nothing is asked until `wanted`, as when the link is on screen. */
export function useLinkCard(
  hostId: string | null,
  found: LinkMatch | null,
  url: string,
  wanted: boolean,
): LinkCardState | null {
  const key = found ? cardKey(hostId, found.source.pluginId, found.link.id, url) : ''
  const state = usePluginRefsStore((s) => s.cards[key])
  useEffect(() => {
    if (wanted && found) lookUp(hostId, found, url, false)
  }, [wanted, found, hostId, url])
  return found ? (state ?? null) : null
}

/** Asks again for a card that did not come, as the hover card's Retry does. */
export function retryLinkCard(hostId: string | null, found: LinkMatch, url: string): void {
  lookUp(hostId, found, url, true)
}
