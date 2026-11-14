import { useEffect, useState } from 'react'
import type { ComputerOverlayApi, ComputerOverlayState } from '@shared/computer-overlay'
import { i18n } from '@renderer/lib/i18n'
import { FloatingLabel } from './floating-label'
import { WindowLight } from './window-light'

const api = window.kettu as unknown as ComputerOverlayApi

/** What main sends, applied to the page as the window's page applies the settings. */
function useOverlayState(): ComputerOverlayState | null {
  const [state, setState] = useState<ComputerOverlayState | null>(null)
  useEffect(
    () =>
      api.onState((next) => {
        const root = document.documentElement
        root.dataset.theme = next.dark ? 'dark' : 'light'
        root.dataset.reduceMotion = next.reduceMotion ? 'always' : 'system'
        root.lang = next.locale
        if (i18n.language !== next.locale) void i18n.changeLanguage(next.locale)
        setState(next)
      }),
    [],
  )
  return state
}

export function OverlayRoot() {
  const state = useOverlayState()
  if (!state) return null
  return api.part === 'light' ? (
    <WindowLight state={state} />
  ) : (
    <FloatingLabel state={state} api={api} />
  )
}
