import { useState, type ReactNode } from 'react'
import type { LinkDestination } from '@shared/settings'
import { isWeb } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import { iconFor, useSiteIconsStore } from '@renderer/stores/site-icons'
import { LinkConfirm } from '../link-confirm'
import { planLinkOpen } from '../link-open'
import { openLinkIn, rememberDestination } from '../open-link'

/**
 * Opens a link chip's address as a reply's link opens: where the link settings send it, asking
 * first where they say to. `dialog` is that confirmation.
 */
export function useLinkOpener(sessionId: string | null | undefined): {
  open: (url: string) => void
  dialog: ReactNode
} {
  const session = sessionId ?? null
  const context = { session: session !== null && !isWeb }
  // The dialog's run: a new key each time, so its choices start afresh.
  const [ask, setAsk] = useState<{
    key: number
    url: string
    destination: LinkDestination
    open: boolean
  }>()
  const open = (url: string) => {
    const prefs = useSettingsStore.getState().settings.thread
    const known = iconFor(useSiteIconsStore.getState().sites, url) !== undefined
    const plan = planLinkOpen(url, prefs, context, known, false)
    if (plan.ask) {
      setAsk((last) => ({
        key: (last?.key ?? 0) + 1,
        url,
        destination: plan.destination,
        open: true,
      }))
    } else {
      openLinkIn(url, plan.destination, session)
    }
  }
  const dialog = ask && (
    <LinkConfirm
      key={ask.key}
      url={ask.url}
      open={ask.open}
      destination={ask.destination}
      sessionId={context.session ? session : null}
      onClose={() => setAsk((last) => last && { ...last, open: false })}
      onOpen={(destination, remember) => {
        if (remember) rememberDestination(ask.url, destination)
        openLinkIn(ask.url, destination, session)
      }}
    />
  )
  return { open, dialog }
}
