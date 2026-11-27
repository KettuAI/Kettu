import { useEffect, type ReactNode } from 'react'
import { loadSiteIcons } from '@renderer/stores/site-icons'
import { openSessionLink } from '../open-link'

/**
 * Opens a link chip's address as a reply's link opens: where the link settings send it, asking
 * through the global `LinkConfirmHost` when required.
 */
export function useLinkOpener(sessionId: string | null | undefined): {
  open: (url: string) => void
  dialog: ReactNode
} {
  const session = sessionId ?? null
  // Whether a site was opened before reads the icons Kettu's browser recorded.
  useEffect(loadSiteIcons, [])
  const open = (url: string) => {
    openSessionLink(url, session)
  }
  return { open, dialog: null }
}
