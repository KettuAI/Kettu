import { create } from 'zustand'
import type { GitHubStarState } from '@shared/agent-host'
import { errorMessage, host } from '@renderer/lib/host'

export const KETTU_REPOSITORY_URL = 'https://github.com/KettuAI/Kettu'

/** How long a prompt shows its thanks before it leaves. */
const THANKS_MS = 2600

export type StarPhase = 'idle' | 'starring' | 'starred'

interface GitHubStarStore {
  /** This window's own host's record; null until it has answered. */
  state: GitHubStarState | null
  starring: boolean
  /** Bumps on each star made in this window, so its burst plays once. */
  burst: number
  /** The prompts that showed when a star was asked for here, kept to thank before they leave. */
  thanking: { card: boolean; line: boolean } | null
}

export const useGitHubStarStore = create<GitHubStarStore>(() => ({
  state: null,
  starring: false,
  burst: 0,
  thanking: null,
}))

export async function loadGitHubStar(): Promise<void> {
  try {
    receiveGitHubStar(await host('star.state', undefined))
  } catch (error) {
    // Without an answer no prompt shows, and Star still opens the repository page.
    console.warn(`Could not read the GitHub star state: ${errorMessage(error)}`)
  }
}

export function receiveGitHubStar(state: GitHubStarState): void {
  useGitHubStarStore.setState({ state })
}

export function useStarPhase(): StarPhase {
  return useGitHubStarStore((s) =>
    s.starring ? 'starring' : s.state?.starred ? 'starred' : 'idle',
  )
}

/** Whether a click opens the repository page, since gh cannot star on this host. */
export function useStarsInBrowser(): boolean {
  return useGitHubStarStore((s) => s.state?.gh === false)
}

function openRepository(): void {
  window.open(KETTU_REPOSITORY_URL, '_blank', 'noreferrer')
  void host('star.opened', undefined).catch((error: unknown) =>
    console.warn(`Could not record the opened repository page: ${errorMessage(error)}`),
  )
}

/**
 * Stars Kettu through the host's gh, or opens the repository page when gh cannot; resolves to
 * whether it starred.
 */
export async function starKettu(): Promise<boolean> {
  const { state, starring } = useGitHubStarStore.getState()
  if (starring || state?.starred) return false
  if (state?.gh === false) {
    openRepository()
    return false
  }
  useGitHubStarStore.setState({
    starring: true,
    thanking: { card: state?.card ?? false, line: state?.line ?? false },
  })
  const starred = await host('star.add', undefined).catch((error: unknown) => {
    console.warn(`Could not star the repository: ${errorMessage(error)}`)
    return false
  })
  if (!starred) {
    useGitHubStarStore.setState({ starring: false, thanking: null })
    openRepository()
    return false
  }
  useGitHubStarStore.setState((s) => ({
    starring: false,
    burst: s.burst + 1,
    state: s.state ? { ...s.state, starred: true, card: false, line: false } : s.state,
  }))
  setTimeout(() => useGitHubStarStore.setState({ thanking: null }), THANKS_MS)
  return true
}

/** The card or New session's line was closed: both leave. */
export function dismissGitHubStar(): void {
  useGitHubStarStore.setState((s) => ({
    state: s.state ? { ...s.state, card: false, line: false } : s.state,
  }))
  void host('star.dismiss', undefined).catch((error: unknown) => {
    console.warn(`Could not record the closed star prompt: ${errorMessage(error)}`)
    void loadGitHubStar()
  })
}
