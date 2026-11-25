// Previewing a session's HTML file as a page, which this computer's agent host serves on the
// loopback address: in a tab of the session's browser, or in the default browser.

import { toast } from '@renderer/components/ui/toast'
import { revealSurface } from '@renderer/features/shell/open-surfaces'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { useBrowserStore } from '@renderer/stores/browser'
import { useSessionsStore } from '@renderer/stores/sessions'
import { toggleSidePane } from '@renderer/stores/view'

/** Whether `path`, relative to the session's folder, names an HTML file a page can show. */
export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path) && !/^(?:[\\/]|[a-z]:[\\/]|~)/i.test(path)
}

/**
 * Whether a preview is offered for files of `folder` in the session: only in the desktop app, for
 * a session of this computer that has not ended, since the page is served on its loopback address.
 */
export function useHtmlPreview(sessionId: string | null, folder: string | null): boolean {
  const open = useSessionsStore((s) => {
    const summary = sessionId ? s.byId[sessionId] : undefined
    return summary !== undefined && summary.archivedAt === null
  })
  return !isWeb && open && folder !== null && hostOfPath(folder) === null
}

/** The page's address; `path` is relative to the session's folder. */
function pageUrl(sessionId: string, path: string): Promise<string> {
  // The browser runs on this computer, so only this computer's host serves a page it reaches.
  return hostAt(null, 'files.preview', { sessionId, path })
}

function samePage(a: string | null, b: string): boolean {
  const left = a ? URL.parse(a) : null
  const right = URL.parse(b)
  return !!left && !!right && left.origin === right.origin && left.pathname === right.pathname
}

/** Shows the file's page in a tab of the session's browser, the one already open on it if any. */
export async function previewHtml(sessionId: string, path: string): Promise<void> {
  try {
    const url = await pageUrl(sessionId, path)
    const tabs = useBrowserStore.getState().bySession[sessionId]?.tabs ?? []
    const open = tabs.find((tab) => samePage(tab.url, url))
    if (open) {
      revealSurface(sessionId, 'page', open.id)
      return
    }
    if (!(await window.kettu.browser.newTab(sessionId))) {
      toast(i18n.t('files:htmlPreview.tooManyTabs'))
      return
    }
    await window.kettu.browser.navigate(sessionId, url)
    toggleSidePane(sessionId, 'browser', true)
  } catch (error) {
    toast(i18n.t('files:htmlPreview.failed', { error: errorMessage(error) }))
  }
}

/** Opens the file's page in the default browser, at the same address. */
export async function openHtmlInBrowser(sessionId: string, path: string): Promise<void> {
  try {
    const url = await pageUrl(sessionId, path)
    // Main hands the address of a window the page opens to the default browser.
    window.open(url, '_blank', 'noreferrer')
  } catch (error) {
    toast(i18n.t('files:htmlPreview.failed', { error: errorMessage(error) }))
  }
}
