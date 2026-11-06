// A routine's runs beside its settings, newest first under its next run: what each did, how
// long, and its session.

import { useEffect, useState, type ReactNode } from 'react'
import { Alert02Icon, Clock01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RoutineView } from '@shared/routines'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { useNow } from '@renderer/lib/use-now'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { Notice } from './kit'
import {
  runDay,
  runDuration,
  runEntries,
  runStatus,
  runSummary,
  runsHint,
  runTime,
  runTone,
  runTrigger,
  untilTime,
  type RunEntry,
} from './model'
import { RunMark } from './run-mark'

/** The Runs card: its head and count, then its next run and its runs, or why there are none. */
export function RunsCard({ count, children }: { count?: number; children: ReactNode }) {
  const { t } = useTranslation('routines')
  return (
    <aside className="ui-sg-card k-runs" aria-label={t('routine.runs')}>
      <header className="k-runs__head">
        <b>{t('routine.runs')}</b>
        <span className="ui-as-section-head__count">{count ?? 0}</span>
      </header>
      {children}
    </aside>
  )
}

/** No runs yet, and what starts the first. */
export function RunsEmpty({ hint }: { hint: string }) {
  const { t } = useTranslation('routines')
  return (
    <div className="k-runs__empty">
      <b>{t('routine.noRunsTitle')}</b>
      <span>{hint}</span>
    </div>
  )
}

/** The next run, in the card's gray line. */
function NextRun({ at, now }: { at: number; now: number }) {
  const { t } = useTranslation('routines')
  return (
    <div className="k-runs__next">
      <Icon icon={Clock01Icon} size={14} />
      <span>{t('routine.next')}</span>
      <b className="k-num">{runDay(at, now)}</b>
      <small>{untilTime(at, now)}</small>
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
          <div key={i} aria-hidden className="k-run">
            <span className="k-run__mark">
              <span className="k-bone" style={{ width: 12, height: 12 }} />
            </span>
            <span className="k-run__body" style={{ gap: 8, paddingBlock: 4 }}>
              <span className="k-bone" style={{ width: 140 }} />
              <span className="k-bone" style={{ width: '75%', height: 8 }} />
            </span>
          </div>
        ))}
      </RunsCard>
    )
  }

  if (state.error) {
    return (
      <RunsCard count={routine.runs}>
        <div className="k-runs__error">
          <Notice
            tone="red"
            mark={<Icon icon={Alert02Icon} size={16} />}
            title={t('routine.runsFailed')}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void useRoutinesStore.getState().loadRuns(routine.id)}
              >
                {t('page.retry')}
              </Button>
            }
          >
            {state.error}
          </Notice>
        </div>
      </RunsCard>
    )
  }

  if (state.items.length === 0) {
    return (
      <RunsCard>
        {routine.nextRunAt !== null && <NextRun at={routine.nextRunAt} now={now} />}
        <RunsEmpty hint={runsHint(routine, now)} />
      </RunsCard>
    )
  }

  const activeId = routine.activeRun?.id
  return (
    <RunsCard count={routine.runs}>
      {routine.nextRunAt !== null && <NextRun at={routine.nextRunAt} now={now} />}
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
        <footer className="k-runs__foot">
          <span className="k-num">
            {t('routine.runsShown', { shown: state.items.length, total: routine.runs })}
          </span>
          <button
            type="button"
            className="k-rs__link"
            disabled={state.loading}
            onClick={() => void useRoutinesStore.getState().loadRuns(routine.id, true)}
          >
            {t('routine.showMore')}
          </button>
        </footer>
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
  const trigger = skipped > 1 ? t('run.skippedTimes', { count: skipped }) : runTrigger(run)

  const body = (
    <>
      <span className="k-run__mark">
        <RunMark status={run.status} />
      </span>
      <span className="k-run__body">
        <span className="k-run__top">
          <b>{time ?? runStatus(run)}</b>
          <span>
            {trigger}
            {took && ` · ${took}`}
          </span>
        </span>
        {time !== null && <span className="k-run__line">{runSummary(run)}</span>}
      </span>
    </>
  )

  const marks = {
    'data-tone': runTone(run.status),
    'data-active': active || undefined,
    'data-fresh': fresh || undefined,
  }
  if (!session)
    return (
      <div className="k-run" {...marks}>
        {body}
      </div>
    )

  const open = () => {
    useSessionsStore.getState().upsert(session)
    openSession(session.id, session.projectPath)
  }
  return (
    <button type="button" className="k-run" onClick={open} {...marks}>
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
