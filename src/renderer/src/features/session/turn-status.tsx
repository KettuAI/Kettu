import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { duration, tokens } from '@renderer/lib/format'
import { useBrowserStore } from '@renderer/stores/browser'
import { useThreadsStore } from '@renderer/stores/threads'
import { TurnDots } from './turn-dots'
import { askedStep, turnPhase, turnTokens, writingId } from './turn-phase'

/** Phases in which the agent thinks or writes rather than works in the app it uses. */
const QUIET_PHASES = new Set(['thinking', 'writing', 'compacting', 'approval'])

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
 * The running turn's status, the thread's last line at the left, where the reply will start: how
 * long it has run, its tokens and its phase, with the attention dot in place of the running dots
 * while it waits for you: to answer, to do a step it asked for, or to hand back the page or the
 * app you took over. While the agent writes a message, that message's own label carries the
 * turn, so this line steps aside: two turn marks never show at once.
 */
export const TurnStatus = memo(function TurnStatus({
  sessionId,
  afterSent,
}: {
  sessionId: string
  afterSent: boolean
}) {
  const { t } = useTranslation(['session', 'control'])
  const startedAt = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.turnStartedAt ?? null,
  )
  const added = useThreadsStore((s) => turnTokens(s.replicas[sessionId]?.state?.session))
  const { phase, count } = useThreadsStore(
    useShallow((s) => turnPhase(s.replicas[sessionId]?.state)),
  )
  const writing = useThreadsStore((s) => writingId(s.replicas[sessionId]?.state) !== null)
  const asked = useThreadsStore((s) => askedStep(s.replicas[sessionId]?.state))
  // The session's page on this computer: the user holds it, or a call of the agent's acts on it.
  const page = useBrowserStore((s) => {
    const control = s.bySession[sessionId]?.control
    if (control?.kind === 'you') return 'you'
    return control?.kind === 'agent' && control.acting ? 'using' : null
  })
  // The app the session uses on its computer: the user holds it, or the agent works in it.
  const computer = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.computer ?? null)
  if (writing) return null
  const separator = <i aria-hidden>·</i>
  const app = computer?.app ?? null
  const appHeld = computer?.control === 'you'
  const appUsed = !!app && !appHeld && !QUIET_PHASES.has(phase)
  const waiting = phase === 'approval' || asked !== null || page === 'you' || appHeld
  const text = asked
    ? t(`control:status.asks.${asked}`)
    : page === 'you'
      ? t('control:status.you.tab')
      : appHeld
        ? t('control:status.you.app', { target: app ?? t('control:held.computer') })
        : page === 'using'
          ? t('control:status.using.browser')
          : appUsed
            ? t('control:status.using.app', { target: app })
            : t(`thread.phase.${phase}`, { count })
  return (
    <div role="status" className="ks-status" data-after-sent={afterSent ? '' : undefined}>
      {waiting ? <span aria-hidden className="ks-status__attn" /> : <TurnDots phase={phase} />}
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
        key={asked ?? page ?? (appHeld ? 'app-held' : appUsed ? 'app' : phase)}
        className="min-w-0 animate-in truncate animation-duration-(--duration-base) fade-in slide-in-from-bottom-1"
      >
        {text}
      </span>
    </div>
  )
})
