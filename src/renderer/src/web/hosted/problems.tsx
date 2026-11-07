// Why the hosted client cannot reach its host now, as the relay said: a card over the app while
// the link is not connected, with a retry, the other hosts of the account, and another account when
// the host is signed in to one. The app's own states cover a connection that drops and comes back.

import type { RelayProblem } from '@shared/remote/hosts'
import type { HostLink } from '../link'
import { ProblemCard, type ProblemOptions, type ShownProblem } from './problem-card'

export type { ProblemOptions }

export function showProblems(options: ProblemOptions): {
  report(problem: RelayProblem | null): void
  follow(link: HostLink): void
} {
  let shown: ShownProblem = { problem: null, connected: false }
  let link: HostLink | null = null
  let mounted = false
  const listeners = new Set<() => void>()
  const set = (next: Partial<ShownProblem>): void => {
    shown = { ...shown, ...next }
    for (const listener of listeners) listener()
    if (!mounted && shown.problem && shown.problem !== 'signed_out') void mount()
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => shown,
  }
  const mount = async (): Promise<void> => {
    mounted = true
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.append(host)
    createRoot(host).render(
      <ProblemCard store={store} options={options} retry={() => link?.wake()} />,
    )
  }
  return {
    report: (problem) => set({ problem }),
    follow: (followed) => {
      link = followed
      followed.onState((state) => set({ connected: state.kind === 'connected' }))
    },
  }
}
