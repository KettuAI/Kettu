// A routine's runs, newest first: what each did, how long it worked, and its session.

import { useEffect, useState } from 'react'
import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Routine, RunView } from '@shared/routines'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { runDuration, runStatus, runSummary, runTime, runTrigger } from './model'
import { RunMark } from './run-mark'

/**
 * The routine's history, 50 at a time with Show more. A run with a session opens it; a skipped
 * one, or one whose session was removed, is not a button.
 */
export function RunHistory({ routine }: { routine: Routine }) {
  const { t } = useTranslation('routines')
  const state = useRoutinesStore((s) => s.runs[routine.id])
  const now = useNow()
  const [initial] = useState(() => new Set(state?.items.map((run) => run.id) ?? []))

  useEffect(() => {
    if (!useRoutinesStore.getState().runs[routine.id]) {
      void useRoutinesStore.getState().loadRuns(routine.id)
    }
  }, [routine.id])

  return (
    <section aria-label={t('routine.runs')} className="flex flex-col">
      <h2 className="px-1 text-xs font-medium text-tertiary">{t('routine.runs')}</h2>
      {!state || (state.loading && state.items.length === 0) ? (
        <div className="flex flex-col gap-1 pt-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : state.error ? (
        <Alert variant="error" className="mt-1">
          <CircleAlertIcon />
          <AlertTitle>{t('routine.runsFailed')}</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void useRoutinesStore.getState().loadRuns(routine.id)}
            >
              {t('page.retry')}
            </Button>
          </AlertAction>
        </Alert>
      ) : state.items.length === 0 ? (
        <p className="px-1 py-2 text-small text-secondary">{t('routine.noRuns')}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-px pt-1">
            {state.items.map((run) => (
              <li key={run.id}>
                <RunRow run={run} now={now} fresh={!initial.has(run.id)} />
              </li>
            ))}
          </ul>
          {state.older !== null && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={state.loading}
                onClick={() => void useRoutinesStore.getState().loadRuns(routine.id, true)}
              >
                {t('routine.showMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function RunRow({ run, now, fresh }: { run: RunView; now: number; fresh: boolean }) {
  const live = useSessionsStore((s) => (run.sessionId ? s.byId[run.sessionId] : undefined))
  const session = run.session ?? live ?? null
  const time = runTime(run, now)
  const trigger = runTrigger(run)
  const took = runDuration(run, now)
  const animation = fresh
    ? 'animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-slow) ease-out-quint'
    : undefined

  const body = (
    <>
      <RunMark status={run.status} className="mt-1" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-ui font-medium">{time ?? runStatus(run)}</span>
          {trigger && <span className="shrink-0 text-xs font-normal text-tertiary">{trigger}</span>}
        </span>
        {time !== null && (
          <span className="truncate text-xs text-secondary">{runSummary(run)}</span>
        )}
      </span>
      {took && (
        <span className="shrink-0 self-start pt-1 text-meta text-tertiary tabular">{took}</span>
      )}
    </>
  )

  const open = () => {
    if (!session) return
    useSessionsStore.getState().upsert(session)
    openSession(session.id, session.projectPath)
  }

  if (!session) {
    return (
      <div className={cn('flex items-start gap-2.5 rounded-lg px-2 py-2', animation)}>{body}</div>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-ring',
        animation,
      )}
    >
      {body}
    </button>
  )
}

/** A run's end, said to the page's live region while the page is shown. */
export function RunAnnouncements() {
  const { t } = useTranslation('routines')
  const ending = useRoutinesStore((s) => s.ending)
  return (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {ending ? t('run.announce', { name: ending.name, status: runStatus(ending.run) }) : ''}
    </span>
  )
}
