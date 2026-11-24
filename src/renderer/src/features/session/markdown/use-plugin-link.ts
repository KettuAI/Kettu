import { useContext, useEffect, useState, type RefObject } from 'react'
import type { PluginLinkCard } from '@shared/plugin-refs'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { sessionHost } from '@renderer/lib/host'
import { useLinkCard, useLinkMatch, type LinkMatch } from '@renderer/stores/plugin-refs'

/** A link a plugin knows, once its card has come. Until then, and when it never does, it is plain. */
export interface PluginLink {
  found: LinkMatch
  card: PluginLinkCard
}

/** What a plugin said when its card did not come, for the plain link to say. */
export interface PluginLinkFailure {
  plugin: string
  message: string
}

/**
 * Whether a link is one a plugin draws as a reference, and the card the plugin gave for it, or what
 * the plugin said when it gave none. The card is asked for the first time the link scrolls into
 * view, and never blocks the reply.
 */
export function usePluginLink(
  url: string,
  anchor: RefObject<HTMLElement | null>,
): { link: PluginLink | null; failure: PluginLinkFailure | null } {
  const sessionId = useContext(SessionIdContext)
  const hostId = sessionId ? sessionHost(sessionId) : null
  const found = useLinkMatch(hostId, url)
  const seen = useOnScreen(anchor, found !== null)
  const state = useLinkCard(hostId, found, url, seen)
  if (!found) return { link: null, failure: null }
  if (state?.status === 'ready') return { link: { found, card: state.card }, failure: null }
  // Only what the plugin itself said: a timeout or a dropped request has nothing of its own.
  const error = state?.status === 'failed' ? state.error : null
  const said = error?.code === 'failed' || error?.code === 'invalid' ? error.detail : undefined
  return { link: null, failure: said ? { plugin: found.source.title, message: said } : null }
}

/** Whether the element has been in view yet, which it stays once it has. */
function useOnScreen(target: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = target.current
    if (!enabled || seen || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled, seen, target])
  return seen
}
