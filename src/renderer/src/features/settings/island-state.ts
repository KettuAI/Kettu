import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IslandState } from '@shared/island'

/** How the notch island runs, which its row's words follow. */
export function useIslandState(): IslandState {
  const [state, setState] = useState<IslandState>({ state: 'off' })
  useEffect(() => {
    let live = true
    const stop = window.kettu.island.onChanged(setState)
    void window.kettu.island.status().then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
      stop()
    }
  }, [])
  return state
}

/** The row's description: what the island does, or why it stopped. */
export function useIslandDescription(): string {
  const { t } = useTranslation('settings')
  const state = useIslandState()
  if (state.state !== 'failed') return t('notifications.island.description')
  return t(`notifications.island.failed.${state.reason}`)
}
