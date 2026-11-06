import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ThreadState } from '@shared/thread'
import { duration, tokens } from '@renderer/lib/format'
import { useThreadsStore } from '@renderer/stores/threads'
import { TurnDots } from './turn-dots'
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

/** Whether the turn's latest entry is a message the agent is still writing. */
function writingNow(state: ThreadState | null | undefined): boolean {
  if (!state) return false
  for (let i = state.order.length - 1; i >= 0; i--) {
    const entry = state.byId[state.order[i]!]
    if (!entry || QUIET.has(entry.kind)) continue
    return entry.kind === 'agent' && entry.streaming
  }
  return false
}

// Entries that leave the reply's label in place under the message before them.
const QUIET = new Set(['plan', 'notice', 'git', 'artifact', 'subagent'])

/**
 * The running turn's status, the thread's last line at the left, where the reply will start: how
 * long it has run, its tokens and its phase, with the attention dot in place of the running dots
 * while it waits for you. While the agent writes a message, that message's own label carries the
 * turn, so this line steps aside: two turn marks never show at once.
 */
export const TurnStatus = memo(function TurnStatus({
  sessionId,
  afterSent,
}: {
  sessionId: string
  afterSent: boolean
}) {
  const { t } = useTranslation('session')
  const startedAt = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.turnStartedAt ?? null,
  )
  const added = useThreadsStore((s) => turnTokens(s.replicas[sessionId]?.state?.session))
  const { phase, count } = useThreadsStore(
    useShallow((s) => turnPhase(s.replicas[sessionId]?.state)),
  )
  const writing = useThreadsStore((s) => writingNow(s.replicas[sessionId]?.state))
  if (writing) return null
  const separator = <i aria-hidden>·</i>
  return (
    <div role="status" className="ks-status" data-after-sent={afterSent ? '' : undefined}>
      {phase === 'approval' ? (
        <span aria-hidden className="ks-status__attn" />
      ) : (
        <TurnDots phase={phase} />
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
