import { useSyncExternalStore } from 'react'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { RelayProblem } from '@shared/remote/hosts'
import { Button } from '@renderer/components/ui/button'
import type { HostedHost } from './hosts'

export interface ProblemOptions {
  name(): string
  others(): HostedHost[]
  open(id: string): void
  switchAccount(): void
}

export interface ShownProblem {
  problem: RelayProblem | null
  connected: boolean
}

/** The card itself, shown while the link is not connected and the relay said why. */
export function ProblemCard({
  store,
  options,
  retry,
}: {
  store: { subscribe(listener: () => void): () => void; get(): ShownProblem }
  options: ProblemOptions
  retry(): void
}) {
  const { t } = useTranslation('web')
  const { problem, connected } = useSyncExternalStore(store.subscribe, store.get)
  if (connected || !problem || problem === 'signed_out') return null
  const others = options.others()
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
      <div
        role="status"
        className="pointer-events-auto flex w-full max-w-md flex-col gap-3 rounded-xl bg-card p-4 text-primary shadow-card"
      >
        <div className="flex items-start gap-3">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            strokeWidth={1.9}
            className="mt-0.5 size-4 shrink-0 text-warning"
            aria-hidden
          />
          <p className="text-sm">{t(`hosted.problem.${problem}`, { name: options.name() })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={retry}>
            {t('hosted.problem.retry')}
          </Button>
          {problem === 'wrong_account' && (
            <Button size="sm" variant="ghost" onClick={options.switchAccount}>
              {t('hosted.switchAccount')}
            </Button>
          )}
          {others.map((host) => (
            <Button
              key={host.relay.id}
              size="sm"
              variant="ghost"
              onClick={() => options.open(host.relay.id)}
            >
              {host.name}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
