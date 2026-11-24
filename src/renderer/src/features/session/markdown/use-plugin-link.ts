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

/**
 * Whether a link is one a plugin draws as a reference, and the card the plugin gave for it. The
 * card is asked for the first time the link scrolls into view, and never blocks the reply.
 */
export function usePluginLink(
  url: string,
  anchor: RefObject<HTMLElement | null>,
): PluginLink | null {
  const sessionId = useContext(SessionIdContext)
  const hostId = sessionId ? sessionHost(sessionId) : null
  const found = useLinkMatch(hostId, url)
  const seen = useOnScreen(anchor, found !== null)
  const state = useLinkCard(hostId, found, url, seen)
  return found && state?.status === 'ready' ? { found, card: state.card } : null
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
