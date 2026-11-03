// Opening a link where its plan sends it, which a reply's link and a prompt's link chip share.

import type { LinkDestination } from '@shared/settings'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSession, toggleSidePane, useViewStore } from '@renderer/stores/view'
import { linkSite, rememberSite } from './link-open'

/**
 * Opens a link in the default browser, or in the session's page in Kettu's browser, which the
 * side panel then shows for the session's project.
 */
export function openLinkIn(url: string, destination: LinkDestination, sessionId: string | null) {
  // Either place makes the site one opened from Kettu, which is not asked about as new again.
  window.kettu.browser
    .siteOpened(url)
    .catch((e: unknown) => console.warn(`Could not record the link's site: ${errorMessage(e)}`))
  const summary = sessionId ? useSessionsStore.getState().byId[sessionId] : undefined
  if (destination === 'session' && sessionId && summary) {
    const { main } = useViewStore.getState()
    if (main.kind !== 'session' || main.sessionId !== sessionId) {
      openSession(sessionId, summary.projectPath)
    }
    toggleSidePane(summary.projectPath, 'browser', true)
    window.kettu.browser
      .navigate(sessionId, url)
      .catch((e: unknown) => toast(i18n.t('session:link.openFailed', { error: errorMessage(e) })))
    return
  }
  // Main hands the address of a window the page opens to the default browser.
  window.open(url, '_blank', 'noreferrer')
}

/** Remembers where the link's site opens from now on, for the dialog's "Always open". */
export function rememberDestination(url: string, destination: LinkDestination): void {
  const site = linkSite(url)
  if (!site) return
  const { settings, update } = useSettingsStore.getState()
  update({
    thread: { alwaysOpenIn: rememberSite(settings.thread.alwaysOpenIn, site, destination) },
  }).catch((e: unknown) =>
    console.warn(`Could not remember where ${site} opens: ${errorMessage(e)}`),
  )
}
