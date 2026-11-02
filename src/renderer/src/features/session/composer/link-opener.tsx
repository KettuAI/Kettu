import { useState, type ReactNode } from 'react'
import { isWeb } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import { toggleSidePane } from '@renderer/stores/view'
import { LinkConfirm } from '../link-confirm'
import { asksBeforeOpening } from '../link-open'

/**
 * Opens a link chip's address: a local one in the session's browser, any other in the system
 * browser after the confirmation a reply's link asks for. `dialog` is that confirmation.
 */
export function useLinkOpener(
  sessionId: string | null | undefined,
  projectPath: string | null,
): { open: (url: string, local: boolean) => void; dialog: ReactNode } {
  const [confirming, setConfirming] = useState<string | null>(null)
  const open = (url: string, local: boolean) => {
    if (local && !isWeb && sessionId && projectPath) {
      void window.kettu.browser.navigate(sessionId, url)
      toggleSidePane(projectPath, 'browser', true)
      return
    }
    const { confirmLinks } = useSettingsStore.getState().settings.thread
    if (asksBeforeOpening(url, confirmLinks)) setConfirming(url)
    else window.open(url, '_blank', 'noreferrer')
  }
  const dialog = confirming && (
    <LinkConfirm
      url={confirming}
      isOpen
      onClose={() => setConfirming(null)}
      onConfirm={() => window.open(confirming, '_blank', 'noreferrer')}
    />
  )
  return { open, dialog }
}
