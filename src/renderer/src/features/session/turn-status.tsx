import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Spinner } from '@renderer/components/ui/spinner'
import { duration, tokens } from '@renderer/lib/format'
import { useThreadsStore } from '@renderer/stores/threads'
import { turnPhase, turnTokens } from './turn-phase'

/** The time since `since` in whole seconds, ticking on its own so nothing around it re-renders. */
function TurnClock({ since }: { since: number }) {
  useTranslation()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    // Just past each whole second, so a timer that fires late never skips one.
    const schedule = () => {
      const delay = 1000 - (Math.max(0, Date.now() - since) % 1000) + 5
      timer = setTimeout(() => {
        setNow(Date.now())
        schedule()
      }, delay)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [since])
  const elapsed = Math.max(0, now - since)
  return <span className="tabular">{duration(elapsed - (elapsed % 1000))}</span>
}

/**
 * The running turn's status, on the right of the row above the composer: how long it has run, its
 * tokens and its phase, with the attention dot in place of the spinner while it waits for you.
 */
export const TurnStatus = memo(function TurnStatus({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('session')
  const startedAt = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.turnStartedAt ?? null,
  )
  const added = useThreadsStore((s) => turnTokens(s.replicas[sessionId]?.state?.session))
  const { phase, count } = useThreadsStore(
    useShallow((s) => turnPhase(s.replicas[sessionId]?.state)),
  )
  const separator = (
    <span aria-hidden className="opacity-60">
      ·
    </span>
  )
  return (
    <div
      role="status"
      className="flex min-w-0 shrink-0 animate-in items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground animation-duration-(--duration-base) fade-in"
    >
      {phase === 'approval' ? (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-attention-dot ring-3 ring-attention-dot/16"
        />
      ) : (
        <Spinner aria-hidden className="size-3 shrink-0 text-info" />
      )}
      {/* Only the phase is announced; the clock and the count change too often to read out. */}
      {startedAt !== null && (
        <>
          <span aria-live="off">
            <TurnClock since={startedAt} />
          </span>
          {separator}
        </>
      )}
      {added !== null && (
        <>
          <span aria-live="off" className="tabular">
            {t('thread.tokens', { count: added, tokens: tokens(added) })}
          </span>
          {separator}
        </>
      )}
      <span
        key={phase}
        className="min-w-0 animate-in truncate animation-duration-(--duration-base) fade-in slide-in-from-bottom-1"
      >
        {t(`thread.phase.${phase}`, { count })}
      </span>
    </div>
  )
})
