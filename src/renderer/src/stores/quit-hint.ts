import { create } from 'zustand'

/** The first Cmd+Q's window: when a second press stops quitting, and how long it is in all. */
export interface QuitCountdown {
  expiresAt: number
  duration: number
}

/** A shown hint, with how far its countdown already ran when it reached the window, in ms. */
export interface QuitHintShown extends QuitCountdown {
  elapsed: number
}

interface QuitHintStore {
  shown: QuitHintShown | null
}

export const useQuitHintStore = create<QuitHintStore>()(() => ({ shown: null }))

let timer: ReturnType<typeof setTimeout> | undefined

/** Shows the hint until its deadline; null takes it away at once, as the second press does. */
export function showQuitHint(countdown: QuitCountdown | null): void {
  clearTimeout(timer)
  const left = countdown ? countdown.expiresAt - Date.now() : 0
  if (!countdown || left <= 0) {
    useQuitHintStore.setState({ shown: null })
    return
  }
  timer = setTimeout(() => showQuitHint(null), left)
  useQuitHintStore.setState({
    shown: { ...countdown, elapsed: Math.max(0, countdown.duration - left) },
  })
}
