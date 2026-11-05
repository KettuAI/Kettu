// A routine's runs, newest first under its next run: what each did, how long, and its session.

import { useEffect, useState, type ReactNode } from 'react'
import { CalendarIcon, CircleAlertIcon, HistoryIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RoutineView } from '@shared/routines'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { CARD_ROWS, GroupHeading } from './fields'
import {
  runDay,
  runDuration,
  runEntries,
  runStatus,
  runSummary,
  runsHint,
  runTime,
  runTrigger,
  untilTime,
  type RunEntry,
} from './model'
import { RunMark } from './run-mark'

const RUN_ROW = 'flex w-full items-start gap-2.75 px-4 py-3 text-left'

/** The mark's slot: as wide as an icon, as tall as the row's first line. */
const MARK_SLOT = 'grid h-5 w-4 shrink-0 place-items-center'

/** The Runs card: its heading and count over the card, empty or loading or listing. */
export function RunsCard({ count, children }: { count?: number; children: ReactNode }) {
  const { t } = useTranslation('routines')
  return (
    <section aria-label={t('routine.runs')}>
      <GroupHeading title={t('routine.runs')} hint={count ? String(count) : undefined} />
      <div className={cn('overflow-hidden rounded-card bg-card shadow-card', CARD_ROWS)}>
        {children}
      </div>
    </section>
  )
}

/** No runs yet, and what starts the first. */
export function RunsEmpty({ hint }: { hint: string }) {
  const { t } = useTranslation('routines')
  return (
    <div className="flex flex-col items-center px-6 pt-7 pb-7 text-center">
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-lg bg-subtle text-icon shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
      >
        <HistoryIcon className="size-4" />
      </span>
      <p className="mt-3 text-control font-semibold">{t('routine.noRunsTitle')}</p>
      <p className="mt-1 max-w-70 text-hint text-pretty text-tertiary">{hint}</p>
    </div>
  )
}

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

  if (!state || (state.loading && state.items.length === 0)) {
    return (
      <RunsCard count={routine.runs}>
        {[0, 1, 2].map((i) => (
          <div key={i} aria-hidden className={RUN_ROW}>
            <span className={MARK_SLOT}>
              <Skeleton className="size-3.5 rounded-full" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-2 py-1">
              <Skeleton className="h-3 w-36" />
              <Skeleton className="h-2.5 w-3/4" />
            </span>
          </div>
        ))}
      </RunsCard>
    )
  }

  if (state.error) {
    return (
      <RunsCard count={routine.runs}>
        <div className="p-2">
          <Alert variant="error" className="has-data-[slot=alert-action]:pr-28">
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
        </div>
      </RunsCard>
    )
  }

  if (state.items.length === 0) {
    return (
      <RunsCard>
        <RunsEmpty hint={runsHint(routine, now)} />
      </RunsCard>
    )
  }

  const activeId = routine.activeRun?.id
  return (
    <RunsCard count={routine.runs}>
      {routine.nextRunAt !== null && (
        <div className={RUN_ROW}>
          <span className={MARK_SLOT}>
            <CalendarIcon aria-hidden className="size-4 text-tertiary" />
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-control leading-5 font-medium text-secondary">
              {runDay(routine.nextRunAt, now)}
            </span>
            <span className="shrink-0 text-meta text-tertiary">{t('routine.next')}</span>
            <span className="ml-auto shrink-0 pl-2 text-meta text-tertiary">
              {untilTime(routine.nextRunAt, now)}
            </span>
          </span>
        </div>
      )}
      {runEntries(state.items).map((entry) => (
        <RunRow
          key={entry.run.id}
          entry={entry}
          now={now}
          active={entry.run.id === activeId}
          fresh={!initial.has(entry.run.id)}
        />
      ))}
      {state.older !== null && (
        <div className="flex items-center justify-between gap-3 py-2 pr-2.5 pl-4 text-hint text-tertiary">
          <span className="tabular">
            {t('routine.runsShown', { shown: state.items.length, total: routine.runs })}
          </span>
          <Button
            variant="quiet"
            size="sm"
            disabled={state.loading}
            onClick={() => void useRoutinesStore.getState().loadRuns(routine.id, true)}
          >
            {t('routine.showMore')}
          </Button>
        </div>
      )}
    </RunsCard>
  )
}

function RunRow({
  entry,
  now,
  active,
  fresh,
}: {
  entry: RunEntry
  now: number
  /** The run at work or waiting, which the card shows lit. */
  active: boolean
  fresh: boolean
}) {
  const { t } = useTranslation('routines')
  const { run, skipped } = entry
  const live = useSessionsStore((s) => (run.sessionId ? s.byId[run.sessionId] : undefined))
  const session = run.session ?? live ?? null
  const time = runTime(run, now)
  const took = runDuration(run, now)
  const failed = run.status === 'failed' || run.status === 'timed_out'
  const quiet =
    run.status === 'skipped' || run.status === 'cancelled' || run.status === 'interrupted'
  const animation = fresh
    ? 'animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-slow) ease-out-quint'
    : undefined

  const body = (
    <>
      <span className={MARK_SLOT}>
        <RunMark status={run.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-control leading-5 font-medium text-primary">
            {time ?? runStatus(run)}
          </span>
          <span className="shrink-0 text-meta text-tertiary">
            {skipped > 1 ? t('run.skippedTimes', { count: skipped }) : runTrigger(run)}
          </span>
          {took && (
            <span className="ml-auto shrink-0 pl-2 font-mono text-caption leading-5 whitespace-nowrap text-tertiary tabular">
              {took}
            </span>
          )}
        </span>
        {time !== null && (
          <span
            className={cn(
              'line-clamp-2 text-hint text-secondary',
              failed && 'text-danger',
              quiet && 'text-tertiary',
            )}
          >
            {runSummary(run)}
          </span>
        )}
      </span>
    </>
  )

  const lit = active && 'bg-control-on-tint'
  if (!session) return <div className={cn(RUN_ROW, lit, animation)}>{body}</div>

  const open = () => {
    useSessionsStore.getState().upsert(session)
    openSession(session.id, session.projectPath)
  }
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        RUN_ROW,
        'transition-colors duration-(--duration-fast) outline-none focus-ring focus-visible:-outline-offset-2',
        lit || 'hover:bg-hover',
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
