// A routine's runs, newest first: what each did, how long it worked, and its session.

import { useEffect, useState } from 'react'
import { ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RoutineView, RunView } from '@shared/routines'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { ROW_SLOT, RoutineSection } from './fields'
import { runDuration, runStatus, runSummary, runsHint, runTime, runTrigger } from './model'
import { RunMark } from './run-mark'

const RUN_ROW = 'flex min-h-14.5 w-full items-center gap-3 rounded-lg px-2 py-2.25 text-left'

/**
 * The routine's history, 50 at a time with Show more. A run with a session opens it; a skipped
 * one, or one whose session was removed, is not a button.
 */
export function RunHistory({ routine }: { routine: RoutineView }) {
  const { t } = useTranslation('routines')
  const state = useRoutinesStore((s) => s.runs[routine.id])
  const now = useNow()
  const [initial] = useState(() => new Set(state?.items.map((run) => run.id) ?? []))

  useEffect(() => {
    if (!useRoutinesStore.getState().runs[routine.id]) {
      void useRoutinesStore.getState().loadRuns(routine.id)
    }
  }, [routine.id])

  let body
  if (!state || (state.loading && state.items.length === 0)) {
    body = (
      <ul aria-hidden>
        {[0, 1, 2].map((i) => (
          <li key={i} className={ROW_SLOT}>
            {/* Each row's fill reaches 8 px past the column on each side, as the list's do. */}
            <div className="-mx-2">
              <div className={RUN_ROW}>
                <span className="grid w-5 shrink-0 place-items-center">
                  <Skeleton className="size-3.5 rounded-full" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-36" />
                  <Skeleton className="h-2.5 w-1/2" />
                </span>
                <Skeleton className="mr-6.5 h-2.5 w-10" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    )
  } else if (state.error) {
    body = (
      <Alert variant="error" className="mt-3.5 has-data-[slot=alert-action]:pr-28">
        <CircleAlertIcon />
        <AlertTitle>{t('routine.runsFailed')}</AlertTitle>
        <AlertDescription>{state.error}</AlertDescription>
        <AlertAction className="top-1/2 right-3.5 -translate-y-1/2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void useRoutinesStore.getState().loadRuns(routine.id)}
          >
            {t('page.retry')}
          </Button>
        </AlertAction>
      </Alert>
    )
  } else if (state.items.length === 0) {
    body = (
      <p className="mt-3.5 text-ui text-secondary">
        {t('routine.noRuns')} <span className="text-tertiary">{runsHint(routine, now)}</span>
      </p>
    )
  } else {
    body = (
      <>
        <ul>
          {state.items.map((run) => (
            <li key={run.id} className={ROW_SLOT}>
              <div className="-mx-2">
                <RunRow run={run} now={now} fresh={!initial.has(run.id)} />
              </div>
            </li>
          ))}
        </ul>
        {state.older !== null && (
          <div className="mt-2 flex">
            <Button
              variant="quiet"
              size="sm"
              className="-ml-2"
              disabled={state.loading}
              onClick={() => void useRoutinesStore.getState().loadRuns(routine.id, true)}
            >
              {t('routine.showMore')}
            </Button>
          </div>
        )}
      </>
    )
  }

  return <RoutineSection title={t('routine.runs')}>{body}</RoutineSection>
}

function RunRow({ run, now, fresh }: { run: RunView; now: number; fresh: boolean }) {
  const live = useSessionsStore((s) => (run.sessionId ? s.byId[run.sessionId] : undefined))
  const session = run.session ?? live ?? null
  const time = runTime(run, now)
  const took = runDuration(run, now)
  const animation = fresh
    ? 'animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-slow) ease-out-quint'
    : undefined

  const body = (
    <>
      <span className="grid w-5 shrink-0 place-items-center">
        <RunMark status={run.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ui font-medium text-primary">
            {time ?? runStatus(run)}
          </span>
          <span className="shrink-0 text-xs text-tertiary">{runTrigger(run)}</span>
        </span>
        {time !== null && (
          <span className="mt-px truncate text-xs text-secondary">{runSummary(run)}</span>
        )}
      </span>
      {took && (
        <span className="shrink-0 font-mono text-meta whitespace-nowrap text-tertiary tabular">
          {took}
        </span>
      )}
      {/* Kept, unseen, in a row that opens nothing, so the durations line up. */}
      <ChevronRightIcon
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 text-icon opacity-0 transition-opacity duration-(--duration-fast)',
          session ? 'group-hover/run:opacity-100 group-focus-visible/run:opacity-100' : 'invisible',
        )}
      />
    </>
  )

  const open = () => {
    if (!session) return
    useSessionsStore.getState().upsert(session)
    openSession(session.id, session.projectPath)
  }

  if (!session) return <div className={cn(RUN_ROW, animation)}>{body}</div>
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        RUN_ROW,
        'group/run transition-colors duration-(--duration-fast) outline-none focus-ring hover:bg-hover',
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
